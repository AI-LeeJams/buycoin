import { normalizeSymbol } from "../config/defaults.js";
import { createSignalEngine } from "./signal-engine.js";

function asNumber(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asPositiveInt(value, fallback) {
  const parsed = asNumber(value, fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.max(1, Math.floor(parsed));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function stddev(values = []) {
  if (!Array.isArray(values) || values.length === 0) {
    return 0;
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(Math.max(0, variance));
}

function normalizeCandles(candles = []) {
  if (!Array.isArray(candles)) {
    return [];
  }
  const rows = candles
    .map((row, index) => {
      const tsDirect = asNumber(row?.timestamp, null);
      const tsUtc = Date.parse(row?.candleTimeUtc || "");
      const tsKst = Date.parse(row?.candleTimeKst || "");
      const timestamp = tsDirect ?? (Number.isFinite(tsUtc) ? tsUtc : Number.isFinite(tsKst) ? tsKst : index + 1);
      const close = asNumber(row?.close, null);
      const high = asNumber(row?.high, close);
      const low = asNumber(row?.low, close);
      return {
        timestamp,
        close,
        high,
        low,
      };
    })
    .filter((row) => row.close !== null && row.close > 0 && row.high !== null && row.high > 0 && row.low !== null && row.low > 0);

  rows.sort((a, b) => a.timestamp - b.timestamp);
  return rows;
}

function evaluateCurrentSignal(candles = [], strategy = {}) {
  const rows = normalizeCandles(candles);
  if (rows.length === 0) {
    return {
      action: "HOLD",
      reason: "insufficient_candles",
      metrics: {
        candleCount: 0,
      },
    };
  }

  const engine = createSignalEngine({
    strategy: {
      ...strategy,
    },
  });
  const signal = engine.evaluate(rows);
  return {
    action: String(signal?.action || "HOLD").toUpperCase(),
    reason: signal?.reason || null,
    metrics: signal?.metrics || {},
  };
}

function safeMean(values = []) {
  if (!Array.isArray(values) || values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function buildWalkForwardFolds(totalCount, config = {}) {
  const trainWindow = asPositiveInt(config.trainWindow, 80);
  const testWindow = asPositiveInt(config.testWindow, 40);
  const stepWindow = asPositiveInt(config.stepWindow, 30);
  const maxFolds = asPositiveInt(config.maxFolds, 0);

  const folds = [];
  if (!trainWindow || !testWindow || !stepWindow || totalCount < trainWindow + testWindow) {
    return folds;
  }

  for (let testStart = trainWindow; testStart + testWindow <= totalCount; testStart += stepWindow) {
    if (maxFolds > 0 && folds.length >= maxFolds) {
      break;
    }
    folds.push({
      trainStart: 0,
      trainEnd: testStart,
      testStart,
      testEnd: Math.min(totalCount, testStart + testWindow),
      trainWindow: testStart,
      testWindow: Math.min(totalCount - testStart, testWindow),
    });
  }
  return folds;
}

function parseIntervalMinutes(interval) {
  const token = String(interval || "15m").trim().toLowerCase();
  if (token === "day") {
    return 1440;
  }
  if (token === "week") {
    return 7 * 1440;
  }
  if (token === "month") {
    return 30 * 1440;
  }
  const match = token.match(/^(\d+)m$/);
  if (match) {
    const value = Number(match[1]);
    return Number.isFinite(value) && value > 0 ? value : 15;
  }
  return 15;
}

function maxDrawdownPct(equityCurve = []) {
  if (!Array.isArray(equityCurve) || equityCurve.length === 0) {
    return 0;
  }
  let peak = equityCurve[0];
  let maxDrawdown = 0;
  for (const equity of equityCurve) {
    if (equity > peak) {
      peak = equity;
    }
    if (peak > 0) {
      const drawdown = (peak - equity) / peak;
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
      }
    }
  }
  return maxDrawdown * 100;
}

function buildMomentumGrid(config = {}) {
  const momentumLookbacks = Array.isArray(config.momentumLookbacks) && config.momentumLookbacks.length > 0
    ? config.momentumLookbacks
    : [24, 36, 48, 72];
  const volatilityLookbacks = Array.isArray(config.volatilityLookbacks) && config.volatilityLookbacks.length > 0
    ? config.volatilityLookbacks
    : [72, 96, 120, 144];
  const entryBpsCandidates = Array.isArray(config.entryBpsCandidates) && config.entryBpsCandidates.length > 0
    ? config.entryBpsCandidates
    : [8, 10, 12, 16, 20, 24];
  const exitBpsCandidates = Array.isArray(config.exitBpsCandidates) && config.exitBpsCandidates.length > 0
    ? config.exitBpsCandidates
    : [6, 10, 14, 20];
  const targetVolatilityPctCandidates =
    Array.isArray(config.targetVolatilityPctCandidates) && config.targetVolatilityPctCandidates.length > 0
      ? config.targetVolatilityPctCandidates
      : [0.35, 0.5];
  const rmMinMultiplierCandidates =
    Array.isArray(config.rmMinMultiplierCandidates) && config.rmMinMultiplierCandidates.length > 0
      ? config.rmMinMultiplierCandidates
      : [0.4];
  const rmMaxMultiplierCandidates =
    Array.isArray(config.rmMaxMultiplierCandidates) && config.rmMaxMultiplierCandidates.length > 0
      ? config.rmMaxMultiplierCandidates
      : [1.6, 1.8];

  const grid = [];
  for (const momentumLookback of momentumLookbacks) {
    for (const volatilityLookback of volatilityLookbacks) {
      if (volatilityLookback <= momentumLookback) {
        continue;
      }
      for (const entryBps of entryBpsCandidates) {
        for (const exitBps of exitBpsCandidates) {
          if (exitBps > entryBps * 1.25) {
            continue;
          }
          for (const targetVolatilityPct of targetVolatilityPctCandidates) {
            for (const riskManagedMinMultiplier of rmMinMultiplierCandidates) {
              for (const riskManagedMaxMultiplier of rmMaxMultiplierCandidates) {
                if (riskManagedMaxMultiplier < riskManagedMinMultiplier) {
                  continue;
                }
                grid.push({
                  momentumLookback,
                  volatilityLookback,
                  momentumEntryBps: entryBps,
                  momentumExitBps: exitBps,
                  targetVolatilityPct,
                  riskManagedMinMultiplier,
                  riskManagedMaxMultiplier,
                });
              }
            }
          }
        }
      }
    }
  }
  return grid;
}

function buildBreakoutGrid(config = {}) {
  const breakoutLookbacks = Array.isArray(config.breakoutLookbacks) && config.breakoutLookbacks.length > 0
    ? config.breakoutLookbacks
    : [12, 16, 20, 24, 30];
  const breakoutBufferBpsCandidates = Array.isArray(config.breakoutBufferBpsCandidates) && config.breakoutBufferBpsCandidates.length > 0
    ? config.breakoutBufferBpsCandidates
    : [0, 3, 5, 8, 12];

  const grid = [];
  for (const breakoutLookback of breakoutLookbacks) {
    for (const breakoutBufferBps of breakoutBufferBpsCandidates) {
      grid.push({
        breakoutLookback,
        breakoutBufferBps,
      });
    }
  }
  return grid;
}

function buildMeanReversionGrid(config = {}) {
  const meanReversionLookbacks = Array.isArray(config.meanLookbacks) && config.meanLookbacks.length > 0
    ? config.meanLookbacks
    : Array.isArray(config.meanReversionLookbacks) && config.meanReversionLookbacks.length > 0
      ? config.meanReversionLookbacks
    : [12, 16, 20, 30];
  const entryDeviationBpsCandidates =
    Array.isArray(config.meanEntryBpsCandidates) && config.meanEntryBpsCandidates.length > 0
      ? config.meanEntryBpsCandidates
      : Array.isArray(config.meanReversionEntryDeviationBpsCandidates) && config.meanReversionEntryDeviationBpsCandidates.length > 0
        ? config.meanReversionEntryDeviationBpsCandidates
      : [40, 60, 80, 120];
  const exitDeviationBpsCandidates =
    Array.isArray(config.meanExitBpsCandidates) && config.meanExitBpsCandidates.length > 0
      ? config.meanExitBpsCandidates
      : Array.isArray(config.meanReversionExitDeviationBpsCandidates) && config.meanReversionExitDeviationBpsCandidates.length > 0
        ? config.meanReversionExitDeviationBpsCandidates
      : [12, 20, 30, 40];

  const grid = [];
  for (const meanReversionLookback of meanReversionLookbacks) {
    for (const meanReversionEntryBps of entryDeviationBpsCandidates) {
      for (const meanReversionExitBps of exitDeviationBpsCandidates) {
        if (meanReversionExitBps >= meanReversionEntryBps) {
          continue;
        }
        grid.push({
          meanLookback: meanReversionLookback,
          meanEntryBps: meanReversionEntryBps,
          meanExitBps: meanReversionExitBps,
        });
      }
    }
  }
  return grid;
}

function normalizeStrategyName(value) {
  return String(value || "").trim().toLowerCase();
}

function resolveStrategyNames(gridConfig = {}) {
  const defaultNames = ["risk_managed_momentum", "breakout", "mean_reversion"];
  const requested = Array.isArray(gridConfig.strategyNames) && gridConfig.strategyNames.length > 0
    ? gridConfig.strategyNames
    : defaultNames;
  const names = requested
    .map((item) => normalizeStrategyName(item))
    .filter((item) => defaultNames.includes(item));
  return names.length > 0 ? Array.from(new Set(names)) : defaultNames;
}

function buildStrategyGrid(strategyName, gridConfig = {}) {
  if (strategyName === "breakout") {
    return buildBreakoutGrid(gridConfig);
  }
  if (strategyName === "mean_reversion") {
    return buildMeanReversionGrid(gridConfig);
  }
  return buildMomentumGrid(gridConfig);
}

function scoreCandidate(metrics) {
  const totalReturnPct = asNumber(metrics.totalReturnPct, 0) ?? 0;
  const maxDdPct = asNumber(metrics.maxDrawdownPct, 0) ?? 0;
  const sharpe = asNumber(metrics.sharpe, 0) ?? 0;
  const profitFactor = Math.min(5, Math.max(0, asNumber(metrics.profitFactor, 0) ?? 0));
  const winRatePct = asNumber(metrics.winRatePct, 0) ?? 0;
  const tradeCount = asNumber(metrics.tradeCount, 0) ?? 0;
  const currentSignalAction = String(metrics.currentSignalAction || "").trim().toUpperCase();

  // Keep return-first, but demote thinly-traded candidates and symbols that are
  // already in a SELL state at the time we are selecting live symbols.
  const inactivityPenalty = tradeCount < 8 ? (8 - tradeCount) * 2 : 0;
  const currentSignalBias =
    currentSignalAction === "BUY" ? 28
      : currentSignalAction === "HOLD" ? 4
        : currentSignalAction === "SELL" ? -12
          : 0;

  return totalReturnPct * 1.3
    + sharpe * 2.5
    + profitFactor * 2
    + winRatePct * 0.08
    - maxDdPct * 1.2
    - inactivityPenalty
    + currentSignalBias;
}

function safetyCheck(metrics, constraints = {}) {
  const maxDrawdownPctLimit = asNumber(constraints.maxDrawdownPctLimit, 12) ?? 12;
  const minTrades = asNumber(constraints.minTrades, 4) ?? 4;
  const minWinRatePct = asNumber(constraints.minWinRatePct, 45) ?? 45;
  const minProfitFactor = asNumber(constraints.minProfitFactor, 1.05) ?? 1.05;
  const minReturnPct = asNumber(constraints.minReturnPct, 0) ?? 0;
  const minExpectancyKrw = asNumber(constraints.minExpectancyKrw, -999999) ?? -999999;
  const minNetEdgeBps = asNumber(constraints.minNetEdgeBps, -999999) ?? -999999;
  const minWalkForwardScore = asNumber(constraints.minWalkForwardScore, -999999);
  const minWalkForwardFoldCount = asPositiveInt(constraints.minWalkForwardFoldCount, 0);
  const minWalkForwardPassRate = asNumber(constraints.minWalkForwardPassRate, 0);
  const walkForwardEnabled = constraints.walkForwardEnabled === true;

  const checks = {
    maxDrawdown: (asNumber(metrics.maxDrawdownPct, 9999) ?? 9999) <= maxDrawdownPctLimit,
    minTrades: (asNumber(metrics.tradeCount, 0) ?? 0) >= minTrades,
    minWinRate: (asNumber(metrics.winRatePct, 0) ?? 0) >= minWinRatePct,
    minProfitFactor: (asNumber(metrics.profitFactor, 0) ?? 0) >= minProfitFactor,
    minReturn: (asNumber(metrics.totalReturnPct, -9999) ?? -9999) >= minReturnPct,
    minExpectancy: (asNumber(metrics.expectancyKrw, -999999) ?? -999999) >= minExpectancyKrw,
    minNetEdge: (asNumber(metrics.netEdgeBps, -999999) ?? -999999) >= minNetEdgeBps,
    walkForward: walkForwardEnabled
      ? (asNumber(metrics.walkForwardScore, -999999) >= minWalkForwardScore
        && (asNumber(metrics.walkForwardFoldCount, 0) ?? 0) >= minWalkForwardFoldCount
        && (asNumber(metrics.walkForwardPassRate, 0) ?? 0) >= minWalkForwardPassRate)
      : true,
  };

  const safe = Object.values(checks).every(Boolean);
  return { safe, checks };
}

function simulateStrategyPerformance({
  candles = [],
  strategy = {},
  interval = "15m",
  initialCashKrw = 1_000_000,
  baseOrderAmountKrw = 20_000,
  minOrderNotionalKrw = 20_000,
  feeBps = 5,
  autoSellEnabled = true,
  simulatedSlippageBps = 0,
} = {}) {
  const rows = normalizeCandles(candles);
  if (rows.length < 30) {
    return {
      ok: false,
      error: "insufficient_candles",
      metrics: null,
    };
  }

  const feeRate = Math.max(0, (asNumber(feeBps, 0) ?? 0) / 10_000);
  const engine = createSignalEngine({
    strategy: {
      ...strategy,
    },
  });

  let cash = Math.max(1, asNumber(initialCashKrw, 1_000_000) ?? 1_000_000);
  let qty = 0;
  let avgCost = 0;
  let turnoverKrw = 0;
  let buyCount = 0;
  let sellCount = 0;
  let winCount = 0;
  let lossCount = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let totalFeeKrw = 0;
  let totalSlippageBps = 0;
  let maxSlippageBps = 0;
  let slippageSampleCount = 0;

  const equityCurve = [];
  let maxExposureKrw = 0;

  for (let index = 0; index < rows.length; index += 1) {
    const current = rows[index];
    const partial = rows.slice(0, index + 1).map((row) => ({
      timestamp: row.timestamp,
      high: row.high,
      low: row.low,
      close: row.close,
    }));
    const signal = engine.evaluate(partial);

    const riskMultiplier = asNumber(signal?.metrics?.riskMultiplier, 1) ?? 1;
    const normalizedRiskMultiplier = clamp(riskMultiplier, 0.2, 3);
    const desiredOrderAmount = Math.max(
      1,
      Math.round((asNumber(baseOrderAmountKrw, 20_000) ?? 20_000) * normalizedRiskMultiplier),
    );
    const slippageRate = (asNumber(simulatedSlippageBps, 0) ?? 0) / 10_000;

    if (signal.action === "BUY") {
      let spend = Math.min(desiredOrderAmount, cash);
      if (spend >= minOrderNotionalKrw) {
        const execPrice = current.close * (1 + slippageRate);
        const grossQty = spend / execPrice;
        const netQty = grossQty * (1 - feeRate);
        if (netQty > 0) {
          const slippageBps = Math.abs((execPrice - current.close) / current.close) * 10_000;
          totalSlippageBps += slippageBps;
          slippageSampleCount += 1;
          maxSlippageBps = Math.max(maxSlippageBps, slippageBps);
          const totalCostBefore = avgCost * qty;
          qty += netQty;
          avgCost = qty > 0 ? (totalCostBefore + spend) / qty : 0;
          totalFeeKrw += spend * feeRate;
          cash = Math.max(0, cash - spend);
          turnoverKrw += spend;
          buyCount += 1;
        }
      }
    } else if (autoSellEnabled && signal.action === "SELL" && qty > 0) {
      const holdingNotional = qty * current.close;
      let sellNotional = Math.min(desiredOrderAmount, holdingNotional);
      if (sellNotional >= minOrderNotionalKrw) {
        const execPrice = current.close * (1 - slippageRate);
        let sellQty = sellNotional / execPrice;
        if (sellQty > qty) {
          sellQty = qty;
          sellNotional = qty * current.close;
        }
        if (sellQty > 0) {
          const slippageBps = Math.abs((execPrice - current.close) / current.close) * 10_000;
          totalSlippageBps += slippageBps;
          slippageSampleCount += 1;
          maxSlippageBps = Math.max(maxSlippageBps, slippageBps);
          const proceeds = sellQty * execPrice * (1 - feeRate);
          totalFeeKrw += sellQty * execPrice * feeRate;
          const costBasis = avgCost * sellQty;
          const realized = proceeds - costBasis;
          if (realized >= 0) {
            grossProfit += realized;
            winCount += 1;
          } else {
            grossLoss += realized;
            lossCount += 1;
          }
          qty = Math.max(0, qty - sellQty);
          if (qty === 0) {
            avgCost = 0;
          }
          cash += proceeds;
          turnoverKrw += sellNotional;
          sellCount += 1;
        }
      }
    }

    const exposure = qty * current.close;
    if (exposure > maxExposureKrw) {
      maxExposureKrw = exposure;
    }
    const equity = cash + exposure;
    equityCurve.push(equity);
  }

  const lastPrice = rows.at(-1)?.close ?? 0;
  const finalEquity = cash + qty * lastPrice * (1 - feeRate);
  if (equityCurve.length > 0) {
    equityCurve[equityCurve.length - 1] = finalEquity;
  }

  const periodicReturns = [];
  for (let i = 1; i < equityCurve.length; i += 1) {
    const prev = equityCurve[i - 1];
    const curr = equityCurve[i];
    if (prev > 0 && curr > 0) {
      periodicReturns.push(curr / prev - 1);
    }
  }
  const retMean = periodicReturns.length > 0
    ? periodicReturns.reduce((sum, value) => sum + value, 0) / periodicReturns.length
    : 0;
  const retStd = stddev(periodicReturns);
  const intervalMinutes = parseIntervalMinutes(interval);
  const periodsPerYear = Math.max(1, Math.floor((365 * 24 * 60) / intervalMinutes));
  const sharpe = retStd > 0 ? (retMean / retStd) * Math.sqrt(periodsPerYear) : 0;
  const grossLossAbs = Math.abs(grossLoss);
  const profitFactor = grossLossAbs > 0 ? grossProfit / grossLossAbs : grossProfit > 0 ? 99 : 1;
  const realizedTradeCount = sellCount;
  const realizedPnl = grossProfit + grossLoss;
  const expectancyKrw = realizedTradeCount > 0 ? realizedPnl / realizedTradeCount : 0;
  const expectancyPct = realizedTradeCount > 0
    ? (expectancyKrw / (asNumber(initialCashKrw, 1_000_000) ?? 1_000_000)) * 100
    : 0;
  const avgRoundTripNotionalKrw = realizedTradeCount > 0 ? turnoverKrw / realizedTradeCount : 0;
  const grossEdgeBps = avgRoundTripNotionalKrw > 0 ? (expectancyKrw / avgRoundTripNotionalKrw) * 10_000 : 0;
  const roundTripFeeAndSlipBps = (feeRate * 10_000 * 2) + ((asNumber(simulatedSlippageBps, 0) ?? 0) * 2);
  const netEdgeBps = grossEdgeBps - roundTripFeeAndSlipBps;

  const metrics = {
    initialCashKrw: asNumber(initialCashKrw, 1_000_000) ?? 1_000_000,
    finalEquityKrw: finalEquity,
    totalReturnPct: ((finalEquity / (asNumber(initialCashKrw, 1_000_000) ?? 1_000_000)) - 1) * 100,
    maxDrawdownPct: maxDrawdownPct(equityCurve),
    sharpe,
    volatilityPct: retStd * 100,
    turnoverKrw,
    tradeCount: buyCount + sellCount,
    realizedTradeCount,
    expectancyKrw,
    expectancyPct,
    grossEdgeBps,
    netEdgeBps,
    buyCount,
    sellCount,
    winRatePct: winCount + lossCount > 0 ? (winCount / (winCount + lossCount)) * 100 : 0,
    profitFactor,
    grossProfitKrw: grossProfit,
    grossLossKrw: grossLoss,
    totalFeeKrw,
    avgSlippageBps: slippageSampleCount > 0 ? totalSlippageBps / slippageSampleCount : 0,
    maxSlippageBps,
    maxExposureKrw,
    openQty: qty,
    lastPrice,
  };

  return {
    ok: true,
    metrics,
  };
}

export function simulateRiskManagedMomentum(args = {}) {
  return simulateStrategyPerformance(args);
}

export function simulateWalkForwardRiskManagedMomentum({
  candles = [],
  strategy = {},
  interval = "15m",
  initialCashKrw = 1_000_000,
  baseOrderAmountKrw = 20_000,
  minOrderNotionalKrw = 20_000,
  feeBps = 5,
  autoSellEnabled = true,
  simulatedSlippageBps = 0,
  walkForward = {},
} = {}) {
  const rows = normalizeCandles(candles);
  const trainWindow = asPositiveInt(walkForward.trainWindow, 80);
  const testWindow = asPositiveInt(walkForward.testWindow, 40);
  const stepWindow = asPositiveInt(walkForward.stepWindow, 30);
  const maxFolds = asPositiveInt(walkForward.maxFolds, 0);

  if (rows.length < trainWindow + testWindow || !trainWindow || !testWindow || !stepWindow) {
    return {
      ok: false,
      error: "insufficient_candles_for_walk_forward",
      metrics: null,
      folds: [],
    };
  }

  const folds = buildWalkForwardFolds(rows.length, {
    trainWindow,
    testWindow,
    stepWindow,
    maxFolds,
  });
  if (folds.length < 2) {
    return {
      ok: false,
      error: "insufficient_walk_forward_folds",
      metrics: null,
      folds,
    };
  }

  const foldRows = [];
  for (const fold of folds) {
    const train = rows.slice(0, fold.trainEnd);
    const test = rows.slice(fold.testStart, fold.testEnd);
    const testResult = simulateStrategyPerformance({
      candles: test,
      strategy,
      interval,
      initialCashKrw,
      baseOrderAmountKrw,
      minOrderNotionalKrw,
      feeBps,
      autoSellEnabled,
      simulatedSlippageBps,
    });

    if (!testResult.ok) {
      continue;
    }

    foldRows.push({
      trainWindow: train.length,
      testWindow: test.length,
      metrics: testResult.metrics,
      train: {
        start: fold.trainStart,
        end: fold.trainEnd,
      },
      test: {
        start: fold.testStart,
        end: fold.testEnd,
      },
      // retained for traceability in logs
      trainSamples: train.length,
      testSamples: test.length,
    });
  }

  if (foldRows.length === 0) {
    return {
      ok: false,
      error: "walk_forward_validation_failed",
      metrics: null,
      folds,
    };
  }

  const foldReturns = foldRows.map((row) => row.metrics.totalReturnPct);
  const foldWinRates = foldRows.map((row) => row.metrics.winRatePct);
  const foldFee = foldRows.map((row) => row.metrics.totalFeeKrw);
  const foldTrades = foldRows.map((row) => row.metrics.realizedTradeCount || 0);
  const foldSlippage = foldRows.map((row) => row.metrics.avgSlippageBps || 0);
  const foldMaxSlippage = foldRows.map((row) => row.metrics.maxSlippageBps || 0);

  const averageReturnPct = safeMean(foldReturns);
  const averageWinRatePct = safeMean(foldWinRates);
  const averageFeeKrw = safeMean(foldFee);
  const averageTrades = safeMean(foldTrades);
  const minReturnPct = Math.min(...foldReturns);
  const maxReturnPct = Math.max(...foldReturns);
  const returnStdPct = stddev(foldReturns);
  const passRate = foldRows.filter((row) => (row.metrics.totalReturnPct ?? -999) >= 0).length / foldRows.length;
  const score = averageReturnPct - returnStdPct * 0.8 + averageWinRatePct * 0.1 + passRate * 10;

  return {
    ok: true,
    metrics: {
      foldCount: foldRows.length,
      averageReturnPct,
      averageWinRatePct,
      averageFeeKrw,
      averageTrades,
      averageSlippageBps: safeMean(foldSlippage),
      maxSlippageBps: foldMaxSlippage.length > 0 ? Math.max(...foldMaxSlippage) : 0,
      minReturnPct,
      maxReturnPct,
      returnStdPct,
      passRate,
      score,
      walkForwardEnabled: true,
    },
    folds: foldRows,
  };
}

function optimizeStrategies({
  candlesBySymbol = {},
  strategyBase = {},
  constraints = {},
  simulation = {},
  gridConfig = {},
  walkForward = {},
} = {}) {
  const strategyNames = resolveStrategyNames(gridConfig);
  const strategyGrids = new Map(
    strategyNames.map((strategyName) => [strategyName, buildStrategyGrid(strategyName, gridConfig)]),
  );
  const ranked = [];
  const symbols = Object.keys(candlesBySymbol).map((item) => normalizeSymbol(item));
  const walkForwardEnabled = walkForward.enabled === true;
  const walkForwardConfig = {
    enabled: walkForwardEnabled,
    trainWindow: asPositiveInt(walkForward.trainWindow, 80),
    testWindow: asPositiveInt(walkForward.testWindow, 40),
    stepWindow: asPositiveInt(walkForward.stepWindow, 30),
    maxFolds: asPositiveInt(walkForward.maxFolds, 0),
    scoreWeight: asNumber(walkForward.scoreWeight, 0.25),
    minScore: asNumber(walkForward.minScore, -999999),
  };

  for (const symbol of symbols) {
    const candles = normalizeCandles(candlesBySymbol[symbol] || []);
    if (candles.length < 30) {
      continue;
    }

    for (const strategyName of strategyNames) {
      const grid = strategyGrids.get(strategyName) || [];
      for (const candidate of grid) {
        const strategy = {
          ...strategyBase,
          ...candidate,
          name: strategyName,
        };

        const simulationResult = simulateStrategyPerformance({
          candles,
          strategy,
          interval: simulation.interval,
          initialCashKrw: simulation.initialCashKrw,
          baseOrderAmountKrw: simulation.baseOrderAmountKrw,
          minOrderNotionalKrw: simulation.minOrderNotionalKrw,
          feeBps: simulation.feeBps,
          simulatedSlippageBps: simulation.simulatedSlippageBps,
          autoSellEnabled: simulation.autoSellEnabled,
        });
        if (!simulationResult.ok) {
          continue;
        }

        const walkForwardResult = walkForwardEnabled
          ? simulateWalkForwardRiskManagedMomentum({
            candles,
            strategy,
            interval: simulation.interval,
            initialCashKrw: simulation.initialCashKrw,
            baseOrderAmountKrw: simulation.baseOrderAmountKrw,
            minOrderNotionalKrw: simulation.minOrderNotionalKrw,
            feeBps: simulation.feeBps,
            simulatedSlippageBps: simulation.simulatedSlippageBps,
            autoSellEnabled: simulation.autoSellEnabled,
            walkForward: walkForwardConfig,
          })
          : null;

        const walkForwardScore = walkForwardEnabled
          ? walkForwardResult?.ok ? walkForwardResult.metrics?.score || 0 : -999999
          : 0;
        const currentSignal = evaluateCurrentSignal(candles, strategy);
        const score = scoreCandidate({
          ...simulationResult.metrics,
          currentSignalAction: currentSignal.action,
          walkForwardScore,
        }) + walkForwardScore * (walkForwardConfig.scoreWeight || 0.25);

        const safety = safetyCheck(
          {
            ...simulationResult.metrics,
            walkForwardScore,
            walkForwardFoldCount: walkForwardResult?.metrics?.foldCount || 0,
            walkForwardPassRate: walkForwardResult?.metrics?.passRate || 0,
          },
          {
            ...constraints,
            walkForwardEnabled,
            minWalkForwardScore: walkForwardConfig.minScore,
            minWalkForwardFoldCount: walkForward.minFoldCount,
            minWalkForwardPassRate: walkForward.minPassRate,
          },
        );
        ranked.push({
          symbol,
          strategy,
          strategyName,
          metrics: simulationResult.metrics,
          currentSignal,
          walkForward: walkForwardResult
            ? {
                ok: walkForwardResult.ok,
                error: walkForwardResult.error || null,
                metrics: walkForwardResult.metrics,
                folds: walkForwardResult.folds,
              }
            : null,
          safety,
          score,
        });
      }
    }
  }

  ranked.sort((a, b) => {
    if (a.safety.safe !== b.safety.safe) {
      return a.safety.safe ? -1 : 1;
    }
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return (b.metrics.totalReturnPct || 0) - (a.metrics.totalReturnPct || 0);
  });

  const safeRanked = ranked.filter((row) => row.safety.safe);
  const best = safeRanked[0] || ranked[0] || null;
  const gridSize = Array.from(strategyGrids.values()).reduce((sum, grid) => sum + grid.length, 0);

  return {
    best,
    ranked,
    safeRanked,
    strategyNames,
    walkForwardConfig,
    evaluatedSymbols: symbols.length,
    evaluatedCandidates: ranked.length,
    gridSize,
    constraints: {
      maxDrawdownPctLimit: asNumber(constraints.maxDrawdownPctLimit, 12) ?? 12,
      minTrades: asNumber(constraints.minTrades, 4) ?? 4,
      minWinRatePct: asNumber(constraints.minWinRatePct, 45) ?? 45,
      minProfitFactor: asNumber(constraints.minProfitFactor, 1.05) ?? 1.05,
      minReturnPct: asNumber(constraints.minReturnPct, 0) ?? 0,
      minExpectancyKrw: asNumber(constraints.minExpectancyKrw, -999999) ?? -999999,
      minNetEdgeBps: asNumber(constraints.minNetEdgeBps, -999999) ?? -999999,
      walkForwardEnabled: walkForward.enabled === true,
      walkForwardMinScore: asNumber(walkForward.minScore, -999999) ?? -999999,
      walkForwardMinFoldCount: asPositiveInt(walkForward.minFoldCount, 3),
      walkForwardMinPassRate: asNumber(walkForward.minPassRate, 0.5) ?? 0.5,
      walkForwardConfig: {
        enabled: walkForward.enabled === true,
        trainWindow: asPositiveInt(walkForward.trainWindow, 80),
        testWindow: asPositiveInt(walkForward.testWindow, 40),
        stepWindow: asPositiveInt(walkForward.stepWindow, 30),
        maxFolds: asPositiveInt(walkForward.maxFolds, 0),
        scoreWeight: asNumber(walkForward.scoreWeight, 0.25),
      },
    },
  };
}

export function optimizeTradingStrategies(args = {}) {
  return optimizeStrategies(args);
}

export function optimizeRiskManagedMomentum(args = {}) {
  return optimizeStrategies(args);
}
