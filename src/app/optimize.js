#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "../config/env-loader.js";
import { loadConfig, normalizeSymbol } from "../config/defaults.js";
import { BithumbClient } from "../exchange/bithumb-client.js";
import { logger as defaultLogger } from "../lib/output.js";
import { nowIso } from "../lib/time.js";
import { CuratedMarketUniverse } from "../core/market-universe.js";
import { MarketDataService } from "../core/market-data.js";
import { assessListingAge } from "../core/listing-age.js";
import { optimizeTradingStrategies } from "../engine/strategy-optimizer.js";
import { StrategySettingsSource } from "./strategy-settings.js";

function roundNum(value, digits = 4) {
  if (!Number.isFinite(Number(value))) {
    return null;
  }
  const scale = 10 ** digits;
  return Math.round(Number(value) * scale) / scale;
}

function asPositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.max(1, Math.floor(parsed));
}

function asPositiveNumber(value, fallback = null) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

async function writeJson(filePath, payload) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tempFile = path.join(
    dir,
    `${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  try {
    await fs.writeFile(tempFile, JSON.stringify(payload, null, 2), "utf8");
    await fs.rename(tempFile, filePath);
  } catch (error) {
    try {
      await fs.unlink(tempFile);
    } catch (cleanupError) {
      if (cleanupError.code !== "ENOENT") {
        error.cleanupError = cleanupError.message;
      }
    }
    throw error;
  }
}

async function loadStrategySettingsSafe(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return raw.trim() ? JSON.parse(raw) : {};
  } catch (error) {
    if (error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

async function acquireOptimizeLock(lockFile, ttlSec = 900, logger = defaultLogger) {
  const lockPath = lockFile || path.join(process.cwd(), ".trader", "optimize.lock");
  const lockTtlMs = Math.max(1_000, Math.floor(Number(ttlSec) * 1_000));
  await fs.mkdir(path.dirname(lockPath), { recursive: true });

  while (true) {
    const payload = JSON.stringify({
      pid: process.pid,
      startedAt: nowIso(),
      script: "optimize.js",
    });
    try {
      await fs.writeFile(lockPath, payload, { encoding: "utf8", flag: "wx" });
      return { acquired: true, lockPath };
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }

      const lockInfo = await fs.readFile(lockPath, "utf8").catch(() => null);
      let lockMeta = null;
      if (lockInfo) {
        try {
          lockMeta = JSON.parse(lockInfo);
        } catch {
          lockMeta = { malformed: true, raw: lockInfo.slice(0, 120) };
        }
      }

      const lockPid = Number(lockMeta?.pid);
      const lockPidAlive = Number.isFinite(lockPid) && lockPid > 0
        ? (() => {
          try {
            process.kill(lockPid, 0);
            return true;
          } catch (killError) {
            if (killError.code === "ESRCH") {
              return false;
            }
            if (killError.code === "EPERM") {
              return true;
            }
            return false;
          }
        })()
        : null;

      try {
        const stats = await fs.stat(lockPath);
        const stale = lockPidAlive === false || stats.mtimeMs + lockTtlMs < Date.now();
        if (!stale) {
          return {
            acquired: false,
            lockPath,
            reason: "busy",
            lockMeta,
          };
        }
      } catch (statError) {
        if (statError.code === "ENOENT") {
          continue;
        }
        throw statError;
      }

      logger.warn("optimize lock recovered as stale; removing", {
        lockPath,
        lockMeta,
      });
      await fs.unlink(lockPath).catch(() => {});
    }
  }
}

async function releaseOptimizeLock(lockPath) {
  if (!lockPath) {
    return;
  }
  try {
    const lockInfo = await fs.readFile(lockPath, "utf8").catch(() => null);
    let lockMeta = null;
    if (lockInfo) {
      try {
        lockMeta = JSON.parse(lockInfo);
      } catch {
        lockMeta = { malformed: true, raw: lockInfo.slice(0, 120) };
      }
    }

    const lockPid = Number(lockMeta?.pid);
    if (!Number.isFinite(lockPid) || lockPid === process.pid) {
      await fs.unlink(lockPath);
      return;
    }

    defaultLogger.warn("optimize lock owner mismatch; skip unlink", {
      lockPath,
      lockMeta,
    });
  } catch {
    // best effort cleanup
  }
}

function compressCandidate(candidate) {
  if (!candidate) {
    return null;
  }

  const walkForward = candidate.walkForward && candidate.walkForward.ok
    ? candidate.walkForward.metrics
    : null;

  return {
    symbol: candidate.symbol,
    strategy: candidate.strategy,
    score: roundNum(candidate.score, 4),
    safe: candidate.safety?.safe === true,
    checks: candidate.safety?.checks || {},
    currentSignal: candidate.currentSignal
      ? {
          action: candidate.currentSignal.action || null,
          reason: candidate.currentSignal.reason || null,
          metrics: {
            deviationBps: roundNum(candidate.currentSignal.metrics?.deviationBps, 4),
            volatilityPct: roundNum(candidate.currentSignal.metrics?.volatilityPct, 4),
          },
        }
      : null,
    metrics: {
      totalReturnPct: roundNum(candidate.metrics?.totalReturnPct, 4),
      maxDrawdownPct: roundNum(candidate.metrics?.maxDrawdownPct, 4),
      sharpe: roundNum(candidate.metrics?.sharpe, 4),
      expectancyKrw: roundNum(candidate.metrics?.expectancyKrw, 2),
      expectancyPct: roundNum(candidate.metrics?.expectancyPct, 4),
      totalFeeKrw: roundNum(candidate.metrics?.totalFeeKrw, 2),
      avgSlippageBps: roundNum(candidate.metrics?.avgSlippageBps, 4),
      maxSlippageBps: roundNum(candidate.metrics?.maxSlippageBps, 4),
      winRatePct: roundNum(candidate.metrics?.winRatePct, 4),
      profitFactor: roundNum(candidate.metrics?.profitFactor, 4),
      tradeCount: candidate.metrics?.tradeCount ?? 0,
      buyCount: candidate.metrics?.buyCount ?? 0,
      sellCount: candidate.metrics?.sellCount ?? 0,
      turnoverKrw: roundNum(candidate.metrics?.turnoverKrw, 2),
      finalEquityKrw: roundNum(candidate.metrics?.finalEquityKrw, 2),
      walkForward: walkForward
        ? {
            foldCount: walkForward.foldCount,
            averageReturnPct: roundNum(walkForward.averageReturnPct, 4),
            averageWinRatePct: roundNum(walkForward.averageWinRatePct, 4),
            averageSlippageBps: roundNum(walkForward.averageSlippageBps, 4),
            maxSlippageBps: roundNum(walkForward.maxSlippageBps, 4),
            passRate: roundNum(walkForward.passRate, 4),
            score: roundNum(walkForward.score, 4),
          }
        : null,
    },
  };
}

function isSameStrategy(left = {}, right = {}) {
  return JSON.stringify(left || {}) === JSON.stringify(right || {});
}

function pickRuntimeSymbols(optimization, runtimeConfig) {
  const best = optimization?.best;
  if (!best) {
    return [];
  }

  const ranked = Array.isArray(optimization.safeRanked) && optimization.safeRanked.length > 0
    ? optimization.safeRanked
    : Array.isArray(optimization.ranked)
      ? optimization.ranked
      : [];

  const actionPriority = (candidate) => {
    const action = String(candidate?.currentSignal?.action || "").trim().toUpperCase();
    if (action === "BUY") {
      return 2;
    }
    if (action === "HOLD") {
      return 1;
    }
    return 0;
  };

  const prioritized = ranked
    .filter((candidate) => isSameStrategy(candidate.strategy, best.strategy))
    .sort((a, b) => {
      const priorityDiff = actionPriority(b) - actionPriority(a);
      if (priorityDiff !== 0) {
        return priorityDiff;
      }
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return (b.metrics?.totalReturnPct || 0) - (a.metrics?.totalReturnPct || 0);
    });

  const matchingSymbols = [];
  for (const candidate of prioritized) {
    if (!matchingSymbols.includes(candidate.symbol)) {
      matchingSymbols.push(candidate.symbol);
    }
  }

  const fallbackSymbols = [best.symbol]
    .map((item) => normalizeSymbol(item))
    .filter(Boolean);
  for (const symbol of fallbackSymbols) {
    if (matchingSymbols.length === 0 && !matchingSymbols.includes(symbol)) {
      matchingSymbols.push(symbol);
    }
  }

  const maxSymbols = Math.max(1, Number(runtimeConfig.optimizer?.maxLiveSymbols || 1));
  return matchingSymbols.slice(0, maxSymbols);
}

async function loadMarketUniverseSymbols(config, logger) {
  const snapshotFile = config.marketUniverse?.snapshotFile;
  if (snapshotFile) {
    try {
      const raw = await fs.readFile(snapshotFile, "utf8");
      const parsed = raw.trim() ? JSON.parse(raw) : {};
      const symbols = Array.isArray(parsed?.symbols) ? parsed.symbols : [];
      const normalized = Array.from(new Set(symbols.map((item) => normalizeSymbol(item)).filter(Boolean)));
      if (normalized.length > 0) {
        return normalized;
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  if (!config.marketUniverse?.enabled) {
    return [];
  }

  const client = new BithumbClient(config, logger);
  const marketData = new MarketDataService(config, client);
  const universe = new CuratedMarketUniverse(config, logger, marketData);
  await universe.init();
  const refresh = await universe.maybeRefresh({ force: true, reason: "optimizer_bootstrap" });
  if (!refresh.ok || !refresh.data) {
    return [];
  }
  return Array.isArray(refresh.data.symbols) ? refresh.data.symbols.map((item) => normalizeSymbol(item)).filter(Boolean) : [];
}

async function resolveOptimizerSymbols(config, logger) {
  const fallbackSymbols = Array.isArray(config?.optimizer?.symbols)
    ? config.optimizer.symbols.map((item) => normalizeSymbol(item)).filter(Boolean)
    : [];

  try {
    const universeSymbols = await loadMarketUniverseSymbols(config, logger);
    const mergedSymbols = Array.from(new Set([...universeSymbols, ...fallbackSymbols]));
    if (mergedSymbols.length > 0) {
      logger.info("optimizer using configured market universe symbols", {
        count: mergedSymbols.length,
        symbols: mergedSymbols,
        source: config.marketUniverse?.snapshotFile || "optimizer_symbols",
      });
      return mergedSymbols;
    }
  } catch (error) {
    logger.warn("optimizer failed to load market-universe snapshot; fallback to configured symbols", {
      error: error.message,
    });
  }

  try {
    const source = new StrategySettingsSource(config, logger);
    await source.init();
    const current = await source.read();
    const runtimeSymbols = Array.isArray(current?.execution?.symbols)
      ? current.execution.symbols.map((item) => normalizeSymbol(item)).filter(Boolean)
      : [];
    if (runtimeSymbols.length > 0) {
      logger.info("optimizer using runtime strategy symbols as fallback", {
        count: runtimeSymbols.length,
        symbols: runtimeSymbols,
        source: current.source,
      });
      return runtimeSymbols;
    }
  } catch (error) {
    logger.warn("optimizer failed to load current strategy settings; fallback to optimizer config symbols", {
      error: error.message,
    });
  }

  return fallbackSymbols;
}

async function applyBestToStrategySettings(runtimeConfig, optimization, logger) {
  const source = new StrategySettingsSource(runtimeConfig, logger);
  await source.init();

  const current = await loadStrategySettingsSafe(runtimeConfig.strategySettings.settingsFile);
  const template = source.defaultTemplate();
  const best = optimization.best;
  const selectedSymbols = pickRuntimeSymbols(optimization, runtimeConfig);
  const runId = `${Date.now()}-${process.pid}`;
  const targetConcurrentSymbols = selectedSymbols.length > 0 ? selectedSymbols.length : 1;

  const next = {
    ...template,
    ...current,
    version: 1,
    updatedAt: nowIso(),
    meta: {
      ...(current.meta && typeof current.meta === "object" ? current.meta : {}),
      source: "optimizer",
      runId,
      evaluatedStrategies: optimization.strategyNames || [],
      bestSymbol: best.symbol,
    },
    execution: {
      ...template.execution,
      ...(current.execution || {}),
      enabled: true,
      symbol: selectedSymbols[0] || best.symbol || template.execution.symbol,
      symbols: selectedSymbols.length > 0
        ? selectedSymbols
        : [best.symbol || template.execution.symbol],
      orderAmountKrw: Math.max(
        1,
        Number(best.strategy?.baseOrderAmountKrw || runtimeConfig.optimizer.baseOrderAmountKrw || template.execution.orderAmountKrw),
      ),
      maxSymbolsPerWindow: targetConcurrentSymbols,
      maxOrderAttemptsPerWindow: Math.max(
        asPositiveInt(current?.execution?.maxOrderAttemptsPerWindow, template.execution.maxOrderAttemptsPerWindow),
        targetConcurrentSymbols,
      ),
    },
    strategy: {
      ...template.strategy,
      ...(current.strategy || {}),
      ...best.strategy,
      defaultSymbol: selectedSymbols[0] || best.symbol || template.strategy.defaultSymbol,
      candleInterval: runtimeConfig.optimizer.interval,
      candleCount: runtimeConfig.optimizer.candleCount,
    },
    controls: {
      ...template.controls,
      ...(current.controls || {}),
    },
  };

  if (targetConcurrentSymbols > 1) {
    const diversifiedCashUsagePct = Math.max(1, Math.floor(100 / targetConcurrentSymbols));
    next.strategy.cashUsagePct = Math.min(
      asPositiveNumber(next.strategy.cashUsagePct, 100),
      diversifiedCashUsagePct,
    );
  }

  await writeJson(runtimeConfig.strategySettings.settingsFile, next);
  return {
    settingsFile: runtimeConfig.strategySettings.settingsFile,
    appliedAt: next.updatedAt,
    symbols: next.execution.symbols,
    strategy: next.strategy.name,
  };
}

async function fetchCandlesBySymbol(config, logger, symbols) {
  const client = new BithumbClient(config, logger);
  const marketData = new MarketDataService(config, client);
  const requestedCandleCount = Math.max(1, Number(config.optimizer?.candleCount || 200));
  const fetchCandleCount = Math.min(200, requestedCandleCount);
  if (fetchCandleCount !== requestedCandleCount) {
    logger.warn("optimizer candle count capped to exchange limit", {
      requestedCandleCount,
      fetchCandleCount,
    });
  }
  const minHistoryCandles = Math.max(
    30,
    Math.min(
      fetchCandleCount,
      Number(config.optimizer?.minHistoryCandles || config.optimizer?.candleCount || 200),
    ),
  );
  const minListingAgeDays = Math.max(0, Number(config.optimizer?.minListingAgeDays || 0));

  const candlesBySymbol = {};
  const fetchErrors = [];
  for (const symbolRaw of symbols || []) {
    const symbol = normalizeSymbol(symbolRaw);
    try {
      if (minListingAgeDays > 0) {
        const listingAge = await assessListingAge({
          marketData,
          symbol,
          minListingAgeDays,
        });
        if (!listingAge.ok) {
          fetchErrors.push({
            symbol,
            message: listingAge.reason || "insufficient_listing_age",
          });
          logger.warn("optimizer skipped symbol with insufficient listing age", {
            symbol,
            minListingAgeDays,
            listingAgeDays: listingAge.listingAgeDays,
            interval: listingAge.interval,
            candleCount: listingAge.candleCount,
            oldestCandleAt: listingAge.oldestCandleAt,
            reason: listingAge.reason,
          });
          continue;
        }
      }

      const response = await marketData.getCandles({
        symbol,
        interval: config.optimizer.interval,
        count: fetchCandleCount,
      });
      const candles = Array.isArray(response.candles) ? response.candles : [];
      if (candles.length < minHistoryCandles) {
        fetchErrors.push({
          symbol,
          message: `insufficient_history:${candles.length} < ${minHistoryCandles}`,
        });
        logger.warn("optimizer skipped symbol with insufficient candle history", {
          symbol,
          interval: config.optimizer.interval,
          candleCount: candles.length,
          minHistoryCandles,
        });
        continue;
      }
      candlesBySymbol[symbol] = candles;
      logger.info("optimizer fetched candles", {
        symbol,
        interval: config.optimizer.interval,
        candleCount: candlesBySymbol[symbol].length,
      });
    } catch (error) {
      fetchErrors.push({
        symbol,
        message: error.message,
      });
      logger.warn("optimizer failed to fetch candles", {
        symbol,
        reason: error.message,
      });
    }
  }
  return { candlesBySymbol, fetchErrors };
}

export async function optimizeAndApplyBest({
  config = null,
  logger = defaultLogger,
  apply = true,
} = {}) {
  const runtimeConfig = config || loadConfig(process.env);
  if (!runtimeConfig.optimizer?.enabled) {
    return {
      ok: false,
      error: { message: "optimizer_disabled" },
    };
  }

  if (runtimeConfig.marketUniverse?.enabled) {
    try {
      const universe = new CuratedMarketUniverse(runtimeConfig, logger);
      await universe.init();
      await universe.maybeRefresh({ force: true, reason: "optimizer" });
    } catch (error) {
      logger.warn("optimizer failed to refresh market universe; continuing with fallback symbol sources", {
        error: error.message,
      });
    }
  }

  const optimizerSymbols = await resolveOptimizerSymbols(runtimeConfig, logger);
  const { candlesBySymbol, fetchErrors } = await fetchCandlesBySymbol(runtimeConfig, logger, optimizerSymbols);
  if (Object.keys(candlesBySymbol).length === 0) {
    return {
      ok: false,
      error: {
        message: "no_candle_data",
        details: fetchErrors,
      },
    };
  }

  const optimization = optimizeTradingStrategies({
    candlesBySymbol,
    strategyBase: {
      autoSellEnabled: runtimeConfig.strategy.autoSellEnabled !== false,
      baseOrderAmountKrw: runtimeConfig.optimizer.baseOrderAmountKrw,
    },
    constraints: {
      maxDrawdownPctLimit: runtimeConfig.optimizer.maxDrawdownPctLimit,
      minTrades: runtimeConfig.optimizer.minTrades,
      minWinRatePct: runtimeConfig.optimizer.minWinRatePct,
      minProfitFactor: runtimeConfig.optimizer.minProfitFactor,
      minReturnPct: runtimeConfig.optimizer.minReturnPct,
      minWalkForwardFoldCount: runtimeConfig.optimizer.walkForwardMinFoldCount,
      minWalkForwardPassRate: runtimeConfig.optimizer.walkForwardMinPassRate,
      minWalkForwardScore: runtimeConfig.optimizer.walkForwardMinScore,
    },
    simulation: {
      interval: runtimeConfig.optimizer.interval,
      initialCashKrw: runtimeConfig.optimizer.initialCashKrw,
      baseOrderAmountKrw: runtimeConfig.optimizer.baseOrderAmountKrw,
      minOrderNotionalKrw: runtimeConfig.optimizer.minOrderNotionalKrw,
      feeBps: runtimeConfig.optimizer.feeBps,
      simulatedSlippageBps: runtimeConfig.optimizer.backtestSlippageBps,
      autoSellEnabled: runtimeConfig.strategy.autoSellEnabled !== false,
    },
    gridConfig: {
      strategyNames: runtimeConfig.optimizer.strategies,
      momentumLookbacks: runtimeConfig.optimizer.momentumLookbacks,
      volatilityLookbacks: runtimeConfig.optimizer.volatilityLookbacks,
      entryBpsCandidates: runtimeConfig.optimizer.entryBpsCandidates,
      exitBpsCandidates: runtimeConfig.optimizer.exitBpsCandidates,
      breakoutLookbacks: runtimeConfig.optimizer.breakoutLookbacks,
      breakoutBufferBpsCandidates: runtimeConfig.optimizer.breakoutBufferBpsCandidates,
      meanLookbacks: runtimeConfig.optimizer.meanLookbacks,
      meanEntryBpsCandidates: runtimeConfig.optimizer.meanEntryBpsCandidates,
      meanExitBpsCandidates: runtimeConfig.optimizer.meanExitBpsCandidates,
      targetVolatilityPctCandidates: runtimeConfig.optimizer.targetVolatilityPctCandidates,
      rmMinMultiplierCandidates: runtimeConfig.optimizer.rmMinMultiplierCandidates,
      rmMaxMultiplierCandidates: runtimeConfig.optimizer.rmMaxMultiplierCandidates,
    },
    walkForward: {
      enabled: runtimeConfig.optimizer.walkForwardEnabled,
      minScore: runtimeConfig.optimizer.walkForwardMinScore,
      minFoldCount: runtimeConfig.optimizer.walkForwardMinFoldCount,
      minPassRate: runtimeConfig.optimizer.walkForwardMinPassRate,
      trainWindow: runtimeConfig.optimizer.walkForwardTrainWindow,
      testWindow: runtimeConfig.optimizer.walkForwardTestWindow,
      stepWindow: runtimeConfig.optimizer.walkForwardStepWindow,
      maxFolds: runtimeConfig.optimizer.walkForwardMaxFolds,
      scoreWeight: runtimeConfig.optimizer.walkForwardScoreWeight,
    },
  });

  if (!optimization.best) {
    return {
      ok: false,
      error: { message: "no_candidate" },
    };
  }

  const topN = Math.max(1, runtimeConfig.optimizer.topResults || 10);
  const evaluatedCandidates = Number(optimization.evaluatedCandidates || 0);
  const safeCandidates = Number(Array.isArray(optimization.safeRanked) ? optimization.safeRanked.length : 0);
  const safeRatio = evaluatedCandidates > 0 ? safeCandidates / evaluatedCandidates : 0;
  const selectedSymbols = pickRuntimeSymbols(optimization, runtimeConfig);

  const report = {
    generatedAt: nowIso(),
    source: "optimizer",
    mode: "live",
    interval: runtimeConfig.optimizer.interval,
    candleCount: runtimeConfig.optimizer.candleCount,
    strategyNames: optimization.strategyNames || [],
    symbols: Object.keys(candlesBySymbol),
    selectedSymbols,
    evaluatedSymbols: optimization.evaluatedSymbols,
    evaluatedCandidates: optimization.evaluatedCandidates,
    gridSize: optimization.gridSize,
    constraints: optimization.constraints,
    walkForward: optimization.walkForwardConfig || null,
    fetchErrors,
    riskSummary: {
      evaluatedSymbols: optimization.evaluatedSymbols,
      evaluatedCandidates,
      safeCandidates,
      safeRatio: roundNum(safeRatio, 4),
      walkForwardEnabled: runtimeConfig.optimizer.walkForwardEnabled,
    },
    best: compressCandidate(optimization.best),
    top: optimization.ranked.slice(0, topN).map(compressCandidate),
  };

  await writeJson(runtimeConfig.optimizer.reportFile, report);

  let applied = false;
  let applyResult = null;
  if (apply) {
    if (optimization.best?.safety?.safe !== true) {
      logger.warn("optimizer skipped apply: best candidate is not safe", {
        symbol: optimization.best?.symbol || null,
        checks: optimization.best?.safety?.checks || null,
        safeCandidates,
      });
    } else {
      applyResult = await applyBestToStrategySettings(runtimeConfig, optimization, logger);
      applied = true;
    }
  }

  return {
    ok: true,
    data: {
      reportFile: runtimeConfig.optimizer.reportFile,
      applied,
      applyResult,
      riskSummary: report.riskSummary,
      best: report.best,
      top: report.top,
      selectedSymbols,
      strategyNames: report.strategyNames,
    },
  };
}

async function main() {
  await loadEnvFile(process.env.TRADER_ENV_FILE || ".env");
  const config = loadConfig(process.env);
  const lock = await acquireOptimizeLock(
    config.optimizer.lockFile,
    config.optimizer.lockTtlSec,
    defaultLogger,
  );
  if (!lock.acquired) {
    defaultLogger.warn("optimizer run skipped by lock guard", {
      reason: lock.reason || "unknown",
      lockPath: lock.lockPath,
      lockMeta: lock.lockMeta || null,
    });
    process.exitCode = 0;
    return;
  }

  try {
    const result = await optimizeAndApplyBest({
      config,
      logger: defaultLogger,
      apply: config.optimizer.applyToStrategySettings !== false,
    });

    if (!result.ok) {
      defaultLogger.error("optimizer failed", {
        message: result.error?.message || "unknown",
        details: result.error?.details || null,
      });
      process.exitCode = 1;
      return;
    }

    defaultLogger.info("optimizer completed", {
      reportFile: result.data.reportFile,
      applied: result.data.applied,
      symbol: result.data.best?.symbol || null,
      selectedSymbols: result.data.selectedSymbols || [],
      strategyNames: result.data.strategyNames || [],
      safeCandidates: result.data.riskSummary?.safeCandidates ?? null,
      safeRatioPct: result.data.riskSummary?.safeRatio != null
        ? roundNum(result.data.riskSummary.safeRatio * 100, 2)
        : null,
      returnPct: result.data.best?.metrics?.totalReturnPct ?? null,
      maxDrawdownPct: result.data.best?.metrics?.maxDrawdownPct ?? null,
      strategy: result.data.best?.strategy || null,
    });
  } finally {
    await releaseOptimizeLock(lock.lockPath);
  }
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  main().catch((error) => {
    defaultLogger.error("optimizer fatal error", { message: error.message });
    process.exitCode = 1;
  });
}
