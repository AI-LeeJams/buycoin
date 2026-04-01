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

function roundNum(value, digits = 4) {
  if (!Number.isFinite(Number(value))) {
    return null;
  }
  const scale = 10 ** digits;
  return Math.round(Number(value) * scale) / scale;
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
    await fs.unlink(tempFile).catch(() => {});
    throw error;
  }
}

async function acquireOptimizeLock(lockFile, ttlSec = 900, logger = defaultLogger) {
  const lockPath = lockFile || path.join(process.cwd(), ".trader", "optimize.lock");
  const lockTtlMs = Math.max(1_000, Math.floor(Number(ttlSec) * 1_000));
  await fs.mkdir(path.dirname(lockPath), { recursive: true });

  while (true) {
    try {
      await fs.writeFile(lockPath, JSON.stringify({
        pid: process.pid,
        startedAt: nowIso(),
        script: "optimize.js",
      }), { encoding: "utf8", flag: "wx" });
      return { acquired: true, lockPath };
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }

      try {
        const stats = await fs.stat(lockPath);
        if (stats.mtimeMs + lockTtlMs >= Date.now()) {
          return {
            acquired: false,
            lockPath,
            reason: "busy",
          };
        }
      } catch (statError) {
        if (statError.code !== "ENOENT") {
          throw statError;
        }
      }

      logger.warn("optimize lock recovered as stale; removing", { lockPath });
      await fs.unlink(lockPath).catch(() => {});
    }
  }
}

async function releaseOptimizeLock(lockPath) {
  if (!lockPath) {
    return;
  }
  await fs.unlink(lockPath).catch(() => {});
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
      grossEdgeBps: roundNum(candidate.metrics?.grossEdgeBps, 4),
      netEdgeBps: roundNum(candidate.metrics?.netEdgeBps, 4),
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

export function pickRuntimeSymbols(optimization, runtimeConfig) {
  const best = optimization?.best;
  if (!best) {
    return [];
  }

  const ranked = Array.isArray(optimization.safeRanked) && optimization.safeRanked.length > 0
    ? optimization.safeRanked
    : Array.isArray(optimization.ranked)
      ? optimization.ranked
      : [];

  const bestPerSymbol = [];
  const seenSymbols = new Set();
  for (const candidate of ranked) {
    const symbol = normalizeSymbol(candidate?.symbol);
    if (!symbol || seenSymbols.has(symbol)) {
      continue;
    }
    seenSymbols.add(symbol);
    bestPerSymbol.push(candidate);
  }

  const bestScore = Number(best.score || 0);
  const maxScoreGap = Math.max(0, Number(runtimeConfig.optimizer?.maxSymbolScoreGap || 0));
  const maxSymbols = Math.max(1, Number(runtimeConfig.optimizer?.maxLiveSymbols || 1));

  return bestPerSymbol
    .filter((candidate) => Number(candidate.score || -Infinity) >= bestScore - maxScoreGap)
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
    .map((candidate) => normalizeSymbol(candidate.symbol))
    .filter(Boolean)
    .slice(0, maxSymbols);
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
  return Array.isArray(refresh.data.symbols)
    ? refresh.data.symbols.map((item) => normalizeSymbol(item)).filter(Boolean)
    : [];
}

async function resolveOptimizerSymbols(config, logger) {
  const fallbackSymbols = Array.isArray(config?.optimizer?.symbols)
    ? config.optimizer.symbols.map((item) => normalizeSymbol(item)).filter(Boolean)
    : [];

  try {
    const universeSymbols = await loadMarketUniverseSymbols(config, logger);
    const merged = Array.from(new Set([...universeSymbols, ...fallbackSymbols]));
    if (merged.length > 0) {
      return merged;
    }
  } catch (error) {
    logger.warn("optimizer failed to load market-universe snapshot; fallback to configured symbols", {
      error: error.message,
    });
  }

  return fallbackSymbols;
}

async function fetchCandlesBySymbol(config, logger, symbols) {
  const client = new BithumbClient(config, logger);
  const marketData = new MarketDataService(config, client);
  const requestedCandleCount = Math.max(1, Number(config.optimizer?.candleCount || 200));
  const fetchCandleCount = Math.min(200, requestedCandleCount);
  const minHistoryCandles = Math.max(
    30,
    Math.min(fetchCandleCount, Number(config.optimizer?.minHistoryCandles || requestedCandleCount)),
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
          fetchErrors.push({ symbol, message: listingAge.reason || "insufficient_listing_age" });
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
        fetchErrors.push({ symbol, message: `insufficient_history:${candles.length} < ${minHistoryCandles}` });
        continue;
      }
      candlesBySymbol[symbol] = candles;
    } catch (error) {
      fetchErrors.push({ symbol, message: error.message });
    }
  }
  return { candlesBySymbol, fetchErrors };
}

export async function optimizeAndApplyBest({
  config = null,
  logger = defaultLogger,
  apply = false,
} = {}) {
  const runtimeConfig = config || loadConfig(process.env);
  if (!runtimeConfig.optimizer?.enabled) {
    return {
      ok: false,
      error: { message: "optimizer_disabled" },
    };
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
      minExpectancyKrw: runtimeConfig.optimizer.minExpectancyKrw,
      minNetEdgeBps: runtimeConfig.optimizer.minNetEdgeBps,
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
    mode: "research_only",
    appliesToLive: false,
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

  return {
    ok: true,
    data: {
      reportFile: runtimeConfig.optimizer.reportFile,
      applied: false,
      applyRequested: Boolean(apply),
      applyResult: null,
      best: report.best,
      top: report.top,
      selectedSymbols,
      strategyNames: report.strategyNames,
      riskSummary: report.riskSummary,
      note: "research_only_report",
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
    });
    process.exitCode = 0;
    return;
  }

  try {
    const result = await optimizeAndApplyBest({
      config,
      logger: defaultLogger,
      apply: false,
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
      applied: false,
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

const __filename = fileURLToPath(import.meta.url);
const isPM2 = "pm_id" in process.env;
const isDirectRun =
  isPM2 ||
  (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename));
if (isDirectRun) {
  process.on("unhandledRejection", (reason) => {
    defaultLogger.error("optimizer unhandled promise rejection", {
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
    process.exit(1);
  });

  process.on("uncaughtException", (error) => {
    defaultLogger.error("optimizer uncaught exception", {
      message: error.message,
      stack: error.stack,
    });
    process.exit(1);
  });

  main().catch((error) => {
    defaultLogger.error("optimizer fatal error", {
      message: error.message,
      stack: error.stack,
    });
    process.exit(1);
  });
}
