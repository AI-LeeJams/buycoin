#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "../config/env-loader.js";
import { loadConfig, normalizeSymbol } from "../config/defaults.js";
import { TradingSystem } from "../core/trading-system.js";
import { CuratedMarketUniverse } from "../core/market-universe.js";
import { BithumbClient } from "../exchange/bithumb-client.js";
import { HttpAuditLog } from "../lib/http-audit-log.js";
import { logger } from "../lib/output.js";
import { StrategySettingsSource } from "./strategy-settings.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asNumber(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeOptionalSymbolList(symbols = []) {
  if (!Array.isArray(symbols)) {
    return [];
  }
  return Array.from(new Set(
    symbols
      .map((item) => normalizeSymbol(String(item || "").trim()))
      .filter(Boolean),
  ));
}

function buildExecutionPlans({
  requestedSymbols = [],
  protectedSymbols = [],
  maxSymbolsPerWindow = 1,
} = {}) {
  const requested = normalizeOptionalSymbolList(requestedSymbols).slice(0, Math.max(1, maxSymbolsPerWindow));
  const protectedOnly = normalizeOptionalSymbolList(protectedSymbols)
    .filter((symbol) => !requested.includes(symbol));

  return [
    ...protectedOnly.map((symbol) => ({
      symbol,
      role: "protected_exit_only",
      executionPolicy: {
        allowBuy: false,
        allowSell: true,
        note: "protected_symbol_exit_only",
      },
    })),
    ...requested.map((symbol) => ({
      symbol,
      role: "entry_and_exit",
      executionPolicy: null,
    })),
  ];
}

async function ensureLiveAccountPreflight(trader) {
  const accounts = await trader.accountList();
  if (!accounts.ok) {
    throw new Error(`Live preflight failed: ${accounts.error?.message || "account_list failed"}`);
  }

  logger.info("live preflight passed", {
    accountCount: accounts.data.count,
    cashKrw: Math.round(accounts.data.metrics.cashAvailableKrw || accounts.data.metrics.cashKrw || 0),
    exposureKrw: Math.round(accounts.data.metrics.exposureKrw || 0),
  });
}

function ensureLiveCredentials(config) {
  if (!config.exchange.accessKey || !config.exchange.secretKey) {
    throw new Error("Live mode requires BITHUMB_ACCESS_KEY and BITHUMB_SECRET_KEY");
  }
}

async function resolveProtectedSymbols(trader) {
  if (!trader || typeof trader.listHeldSymbols !== "function") {
    return [];
  }
  try {
    return normalizeOptionalSymbolList(await trader.listHeldSymbols());
  } catch {
    return [];
  }
}

function resolveExecutionFromSettings(runtimeConfig, snapshot) {
  const configExecution = runtimeConfig.execution || {};
  const snapshotExecution = snapshot?.execution && typeof snapshot.execution === "object"
    ? snapshot.execution
    : {};
  const symbol = normalizeSymbol(snapshotExecution.symbol || configExecution.symbol || runtimeConfig.strategy.defaultSymbol);

  return {
    enabled: snapshotExecution.enabled === undefined
      ? Boolean(configExecution.enabled)
      : Boolean(snapshotExecution.enabled),
    symbol,
    symbols: [symbol],
    orderAmountKrw: Number(snapshotExecution.orderAmountKrw ?? configExecution.orderAmountKrw ?? runtimeConfig.strategy.baseOrderAmountKrw),
    windowSec: Number(snapshotExecution.windowSec ?? configExecution.windowSec ?? 300),
    cooldownSec: Number(snapshotExecution.cooldownSec ?? configExecution.cooldownSec ?? 30),
    maxSymbolsPerWindow: 1,
    maxOrderAttemptsPerWindow: 1,
    dryRun: Boolean(configExecution.dryRun === true),
  };
}

async function syncManualPause({ trader, snapshot, currentStatus }) {
  const pauseEntries = snapshot?.controls?.pauseEntries;
  if (pauseEntries === true && typeof trader.setEntryBlock === "function") {
    await trader.setEntryBlock(true, {
      reason: "manual_pause_entries",
      source: "manual_pause_entries",
      manual: true,
    });
    return typeof trader.status === "function" ? trader.status() : currentStatus;
  }

  if (pauseEntries === false && typeof trader.clearEntryBlock === "function") {
    await trader.clearEntryBlock("manual_pause_entries");
    return typeof trader.status === "function" ? trader.status() : currentStatus;
  }

  return currentStatus;
}

async function syncRiskEntryBlock({ trader, runtimeConfig, executionStatus, executionDryRun }) {
  if (executionDryRun || typeof trader.evaluateMarkToMarket !== "function") {
    return executionStatus;
  }

  const mtmState = await trader.evaluateMarkToMarket();
  const dailyPnlKrw = asNumber(mtmState?.data?.dailyPnlKrw, null);
  const totalUnrealizedPnlPct = asNumber(mtmState?.data?.totalUnrealizedPnlPct, null);
  const positionCount = asNumber(mtmState?.data?.positionCount, 0) || 0;
  const maxMtmDailyLossKrw = asNumber(runtimeConfig.risk?.maxMtmDailyLossKrw, null);
  const maxOpenLossPct = asNumber(runtimeConfig.execution?.kpiMonitorMaxOpenLossPct, null);

  if (
    Number.isFinite(maxMtmDailyLossKrw)
    && maxMtmDailyLossKrw > 0
    && Number.isFinite(dailyPnlKrw)
    && dailyPnlKrw <= -Math.abs(maxMtmDailyLossKrw)
    && typeof trader.setEntryBlock === "function"
  ) {
    await trader.setEntryBlock(true, {
      reason: "max_mtm_daily_loss",
      source: "max_mtm_daily_loss",
      manual: false,
      tradeDate: null,
    });
    return typeof trader.status === "function" ? trader.status() : executionStatus;
  }

  if (
    Number.isFinite(maxOpenLossPct)
    && positionCount > 0
    && Number.isFinite(totalUnrealizedPnlPct)
    && totalUnrealizedPnlPct <= maxOpenLossPct
    && typeof trader.setEntryBlock === "function"
  ) {
    await trader.setEntryBlock(true, {
      reason: "kpi_monitor",
      source: "kpi_monitor",
      manual: false,
      tradeDate: null,
    });
    return typeof trader.status === "function" ? trader.status() : executionStatus;
  }

  if (typeof trader.clearEntryBlock === "function") {
    await trader.clearEntryBlock("kpi_monitor");
  }
  return typeof trader.status === "function" ? trader.status() : executionStatus;
}

function aggregateWindowResults(results = []) {
  return results.reduce((acc, row) => {
    if (!row?.ok) {
      acc.failed += 1;
      return acc;
    }
    acc.tickCount += Number(row.data?.tickCount || 0);
    acc.buySignals += Number(row.data?.buySignals || 0);
    acc.sellSignals += Number(row.data?.sellSignals || 0);
    acc.attemptedOrders += Number(row.data?.attemptedOrders || 0);
    acc.successfulOrders += Number(row.data?.successfulOrders || 0);
    return acc;
  }, {
    failed: 0,
    tickCount: 0,
    buySignals: 0,
    sellSignals: 0,
    attemptedOrders: 0,
    successfulOrders: 0,
  });
}

export async function runExecutionService({
  system = null,
  config = null,
  stopAfterWindows = 0,
  marketUniverseService = null,
} = {}) {
  const runtimeConfig = config || loadConfig(process.env);
  const executionDryRun = Boolean(runtimeConfig.execution?.dryRun === true);
  const auditLog = system
    ? null
    : new HttpAuditLog(runtimeConfig.runtime.httpAuditFile, logger, {
        enabled: runtimeConfig.runtime.httpAuditEnabled,
        maxBytes: runtimeConfig.runtime.httpAuditMaxBytes,
        pruneRatio: runtimeConfig.runtime.httpAuditPruneRatio,
        checkEvery: runtimeConfig.runtime.httpAuditCheckEvery,
      });

  if (auditLog) {
    await auditLog.init();
  }

  const trader = system || new TradingSystem(runtimeConfig, {
    logger,
    exchangeClient: new BithumbClient(runtimeConfig, logger, {
      onRequestEvent: auditLog ? (event) => auditLog.write(event) : null,
    }),
  });
  const strategySettings = new StrategySettingsSource(runtimeConfig, logger);
  const marketUniverse = marketUniverseService || new CuratedMarketUniverse(runtimeConfig, logger, trader.marketData);

  try {
    await trader.init();
    await strategySettings.init();
    await marketUniverse.init();

    if (!system && !executionDryRun) {
      ensureLiveCredentials(runtimeConfig);
      await ensureLiveAccountPreflight(trader);
    }

    if (!runtimeConfig.execution?.enabled) {
      logger.info("execution service is disabled by config", {
        executionEnabled: false,
      });
      return {
        ok: true,
        windows: 0,
        stoppedBy: "disabled",
      };
    }

    let windows = 0;
    let stoppedBy = null;
    let stopRequested = false;

    const onSignal = (signal) => {
      stopRequested = true;
      stoppedBy = signal;
    };

    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);

    logger.info("execution service started", {
      mode: executionDryRun ? "dry_run" : "live",
      profile: runtimeConfig.tradingProfile?.name || null,
      symbol: runtimeConfig.execution.symbol,
      orderAmountKrw: runtimeConfig.execution.orderAmountKrw,
      windowSec: runtimeConfig.execution.windowSec,
      cooldownSec: runtimeConfig.execution.cooldownSec,
      maxSymbolsPerWindow: 1,
      maxOrderAttemptsPerWindow: 1,
      strategy: runtimeConfig.strategy.name,
      strategySettingsFile: strategySettings.settingsFile,
      marketUniverseEnabled: marketUniverse.enabled,
    });

    await marketUniverse.maybeRefresh({ force: true, reason: "startup" }).catch(() => {});

    while (!stopRequested) {
      windows += 1;

      const settingsSnapshot = await strategySettings.read();
      const effectiveExecution = resolveExecutionFromSettings(runtimeConfig, settingsSnapshot);

      if (!effectiveExecution.enabled) {
        logger.warn("execution window skipped by settings", {
          window: windows,
          source: settingsSnapshot.source,
        });
      } else {
        let executionStatus = typeof trader.status === "function"
          ? await trader.status()
          : {
            data: {
              entryBlocked: false,
              entryBlockReason: null,
              entryBlockSource: null,
              entryBlockAt: null,
              entryBlockTradeDate: null,
            },
          };

        executionStatus = await syncManualPause({
          trader,
          snapshot: settingsSnapshot,
          currentStatus: executionStatus,
        });

        executionStatus = await syncRiskEntryBlock({
          trader,
          runtimeConfig,
          executionStatus,
          executionDryRun,
        });

        const protectedSymbols = await resolveProtectedSymbols(trader);
        let requestedSymbols = effectiveExecution.symbols.slice(0, 1);

        if (marketUniverse.enabled && typeof marketUniverse.filterSymbols === "function") {
          const filtered = marketUniverse.filterSymbols(requestedSymbols);
          requestedSymbols = Array.isArray(filtered?.symbols) ? filtered.symbols : requestedSymbols;
        }

        if (executionStatus?.data?.entryBlocked) {
          requestedSymbols = [];
          logger.warn("execution running in entry-block mode", {
            window: windows,
            reason: executionStatus.data.entryBlockReason || "unknown",
            source: executionStatus.data.entryBlockSource || null,
          });
        }

        const plans = buildExecutionPlans({
          requestedSymbols,
          protectedSymbols,
          maxSymbolsPerWindow: effectiveExecution.maxSymbolsPerWindow,
        });

        const results = [];
        for (const plan of plans) {
          const result = await trader.runStrategyRealtime({
            symbol: plan.symbol,
            amount: effectiveExecution.orderAmountKrw,
            durationSec: effectiveExecution.windowSec,
            cooldownSec: plan.role === "protected_exit_only" ? 0 : effectiveExecution.cooldownSec,
            dryRun: effectiveExecution.dryRun,
            executionPolicy: plan.executionPolicy,
            maxOrderAttemptsPerWindow: effectiveExecution.maxOrderAttemptsPerWindow,
            targetConcurrentSymbols: 1,
          });
          results.push(result);
        }

        const summary = aggregateWindowResults(results);
        if (!runtimeConfig.execution.logOnlyOnActivity
          || summary.tickCount > 0
          || summary.attemptedOrders > 0
          || summary.failed > 0) {
          logger.info("execution window completed", {
            window: windows,
            symbols: plans.map((plan) => plan.symbol),
            entryBlocked: Boolean(executionStatus?.data?.entryBlocked),
            tickCount: summary.tickCount,
            buySignals: summary.buySignals,
            sellSignals: summary.sellSignals,
            attemptedOrders: summary.attemptedOrders,
            successfulOrders: summary.successfulOrders,
            failedRuns: summary.failed,
          });
        }
      }

      if (stopAfterWindows > 0 && windows >= stopAfterWindows) {
        stoppedBy = "window_limit";
        break;
      }

      await marketUniverse.maybeRefresh({ reason: "periodic" }).catch(() => {});
      await sleep(Math.max(0, Number(runtimeConfig.execution?.restartDelayMs || 1000)));
    }

    return {
      ok: true,
      windows,
      stoppedBy: stoppedBy || "signal",
    };
  } finally {
    if (auditLog) {
      await auditLog.flush().catch(() => {});
    }
  }
}

async function main() {
  await loadEnvFile(process.env.TRADER_ENV_FILE || ".env");
  await runExecutionService();
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  main().catch((error) => {
    logger.error("execution service fatal error", {
      message: error.message,
    });
    process.exitCode = 1;
  });
}
