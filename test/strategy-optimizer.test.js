import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { optimizeTradingStrategies, simulateRiskManagedMomentum } from "../src/engine/strategy-optimizer.js";
import { pickRuntimeSymbols, resolveOptimizerSymbols, summarizeRuntimeSupport } from "../src/app/optimize.js";
import { loadConfig } from "../src/config/defaults.js";

function makeCandles({ startPrice = 1000, count = 160, slope = 1, noise = 0.3 }) {
  const candles = [];
  let price = startPrice;
  for (let i = 0; i < count; i += 1) {
    const wave = Math.sin(i / 7) * noise * startPrice * 0.01;
    price = Math.max(1, price + slope + wave);
    candles.push({
      timestamp: i + 1,
      close: price,
      high: price,
      low: price,
    });
  }
  return candles;
}

function withFinalShock(candles, shockPct) {
  return candles.map((row, index) => {
    if (index !== candles.length - 1) {
      return row;
    }
    const close = Math.max(1, row.close * (1 + shockPct));
    return {
      ...row,
      close,
      high: close,
      low: close,
    };
  });
}

function makeLateReversalCandles() {
  const candles = [];
  let price = 1000;
  for (let i = 0; i < 200; i += 1) {
    price += i < 150 ? -1.2 + Math.sin(i / 4) * 3 : 6 + Math.sin(i / 3) * 1.5;
    price = Math.max(50, price);
    candles.push({
      timestamp: i + 1,
      close: price,
      high: price,
      low: price,
    });
  }
  return candles;
}

test("simulateRiskManagedMomentum returns metrics", () => {
  const result = simulateRiskManagedMomentum({
    candles: makeCandles({ startPrice: 1000, slope: 2 }),
    strategy: {
      momentumLookback: 24,
      volatilityLookback: 72,
      momentumEntryBps: 12,
      momentumExitBps: 8,
      targetVolatilityPct: 0.35,
      riskManagedMinMultiplier: 0.4,
      riskManagedMaxMultiplier: 1.8,
    },
    initialCashKrw: 1_000_000,
    baseOrderAmountKrw: 20_000,
    minOrderNotionalKrw: 5_000,
    feeBps: 5,
  });

  assert.equal(result.ok, true);
  assert.equal(Number.isFinite(result.metrics.totalReturnPct), true);
  assert.equal(Number.isFinite(result.metrics.tradeCount), true);
});

test("optimizeTradingStrategies ranks and selects the best strategy candidate", () => {
  const strong = makeCandles({ startPrice: 1000, slope: 3 });
  const weak = makeCandles({ startPrice: 1000, slope: -1.2, noise: 0.8 });
  const result = optimizeTradingStrategies({
    candlesBySymbol: {
      BTC_KRW: strong,
      ETH_KRW: weak,
    },
    strategyBase: {
      autoSellEnabled: true,
      baseOrderAmountKrw: 10_000,
    },
    constraints: {
      maxDrawdownPctLimit: 30,
      minTrades: 2,
      minWinRatePct: 20,
      minProfitFactor: 0.8,
      minReturnPct: -100,
    },
    simulation: {
      interval: "15m",
      initialCashKrw: 1_000_000,
      baseOrderAmountKrw: 10_000,
      minOrderNotionalKrw: 5_000,
      feeBps: 5,
      autoSellEnabled: true,
    },
    gridConfig: {
      strategyNames: ["risk_managed_momentum", "breakout", "mean_reversion"],
      momentumLookbacks: [24, 36],
      volatilityLookbacks: [72],
      entryBpsCandidates: [10, 14],
      exitBpsCandidates: [6, 8],
      targetVolatilityPctCandidates: [0.35],
      rmMinMultiplierCandidates: [0.4],
      rmMaxMultiplierCandidates: [1.8],
      breakoutLookbacks: [16],
      breakoutBufferBpsCandidates: [0, 5],
      meanLookbacks: [16],
      meanEntryBpsCandidates: [40],
      meanExitBpsCandidates: [12],
    },
  });

  assert.equal(result.evaluatedSymbols, 2);
  assert.equal(result.evaluatedCandidates > 0, true);
  assert.equal(result.strategyNames.includes("mean_reversion"), true);
  assert.equal(result.ranked.some((row) => row.strategy.name === "mean_reversion"), true);
  assert.equal(Boolean(result.best), true);
  assert.equal(result.ranked[0].score >= result.ranked.at(-1).score, true);
});

test("optimizeTradingStrategies records current signal and prefers buy-ready candidates", () => {
  const base = makeCandles({ startPrice: 1000, count: 160, slope: 0.1, noise: 0.05 });
  const buyReady = withFinalShock(base, -0.08);
  const sellReady = withFinalShock(base, 0.08);

  const result = optimizeTradingStrategies({
    candlesBySymbol: {
      BUY_KRW: buyReady,
      SELL_KRW: sellReady,
    },
    strategyBase: {
      autoSellEnabled: true,
      baseOrderAmountKrw: 10_000,
    },
    constraints: {
      maxDrawdownPctLimit: 50,
      minTrades: 0,
      minWinRatePct: 0,
      minProfitFactor: 0,
      minReturnPct: -100,
      walkForwardEnabled: false,
    },
    simulation: {
      interval: "15m",
      initialCashKrw: 1_000_000,
      baseOrderAmountKrw: 10_000,
      minOrderNotionalKrw: 5_000,
      feeBps: 5,
      autoSellEnabled: true,
    },
    gridConfig: {
      strategyNames: ["mean_reversion"],
      meanLookbacks: [16],
      meanEntryBpsCandidates: [40],
      meanExitBpsCandidates: [0],
    },
  });

  const buyRow = result.ranked.find((row) => row.symbol === "BUY_KRW");
  const sellRow = result.ranked.find((row) => row.symbol === "SELL_KRW");

  assert.equal(buyRow?.currentSignal?.action, "BUY");
  assert.equal(sellRow?.currentSignal?.action, "SELL");
  assert.equal(result.best?.symbol, "BUY_KRW");
  assert.equal(buyRow.score > sellRow.score, true);
});

test("optimizer rejects candidates whose net edge is wiped out by slippage", () => {
  const slowTrend = makeCandles({ startPrice: 1000, count: 160, slope: 0.35, noise: 0.02 });
  const result = optimizeTradingStrategies({
    candlesBySymbol: {
      BTC_KRW: slowTrend,
    },
    strategyBase: {
      autoSellEnabled: true,
      baseOrderAmountKrw: 10_000,
    },
    constraints: {
      maxDrawdownPctLimit: 50,
      minTrades: 0,
      minWinRatePct: 0,
      minProfitFactor: 0,
      minReturnPct: -100,
      minExpectancyKrw: -100000,
      minNetEdgeBps: 1,
      walkForwardEnabled: false,
    },
    simulation: {
      interval: "15m",
      initialCashKrw: 1_000_000,
      baseOrderAmountKrw: 10_000,
      minOrderNotionalKrw: 5_000,
      feeBps: 5,
      simulatedSlippageBps: 40,
      autoSellEnabled: true,
    },
    gridConfig: {
      strategyNames: ["risk_managed_momentum"],
      momentumLookbacks: [24],
      volatilityLookbacks: [72],
      entryBpsCandidates: [10],
      exitBpsCandidates: [6],
      targetVolatilityPctCandidates: [0.35],
      rmMinMultiplierCandidates: [0.4],
      rmMaxMultiplierCandidates: [1.8],
    },
  });

  assert.equal(result.ranked.length > 0, true);
  assert.equal(result.ranked.every((row) => row.safety.checks.minNetEdge === false), true);
  assert.equal(result.safeRanked.length, 0);
});

test("optimizer rejects candidates with negative walk-forward average return", () => {
  const result = optimizeTradingStrategies({
    candlesBySymbol: {
      BTC_KRW: makeLateReversalCandles(),
    },
    strategyBase: {
      autoSellEnabled: true,
      baseOrderAmountKrw: 10_000,
    },
    constraints: {
      maxDrawdownPctLimit: 80,
      minTrades: 0,
      minWinRatePct: 0,
      minProfitFactor: 0,
      minReturnPct: -100,
      minExpectancyKrw: -100000,
      minNetEdgeBps: -100000,
      minWalkForwardFoldCount: 3,
      minWalkForwardPassRate: 0,
      minWalkForwardScore: -999999,
      minWalkForwardAverageReturnPct: 0,
      minWalkForwardAverageWinRatePct: 0,
      minWalkForwardAverageExpectancyKrw: -100000,
    },
    simulation: {
      interval: "15m",
      initialCashKrw: 1_000_000,
      baseOrderAmountKrw: 10_000,
      minOrderNotionalKrw: 5_000,
      feeBps: 5,
      simulatedSlippageBps: 12,
      autoSellEnabled: true,
    },
    gridConfig: {
      strategyNames: ["mean_reversion"],
      meanLookbacks: [16],
      meanEntryBpsCandidates: [60],
      meanExitBpsCandidates: [12],
    },
    walkForward: {
      enabled: true,
      minScore: -999999,
      minFoldCount: 3,
      minPassRate: 0,
      trainWindow: 80,
      testWindow: 40,
      stepWindow: 30,
      maxFolds: 0,
      scoreWeight: 0.25,
    },
  });

  assert.equal(result.ranked.length > 0, true);
  assert.equal(result.ranked[0].walkForward?.metrics?.averageReturnPct < 0, true);
  assert.equal(result.ranked[0].safety.checks.walkForward, false);
  assert.equal(result.safeRanked.length, 0);
});

test("resolveOptimizerSymbols can ignore market-universe snapshots when pinned", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "buycoin-opt-"));
  const snapshotFile = path.join(tempDir, "market-universe.json");
  await fs.writeFile(snapshotFile, JSON.stringify({
    symbols: ["TAIKO_KRW", "BTC_KRW"],
  }), "utf8");

  const config = loadConfig({
    MARKET_UNIVERSE_FILE: snapshotFile,
    OPTIMIZER_SYMBOLS: "BTC_KRW,ETH_KRW",
    OPTIMIZER_USE_MARKET_UNIVERSE_SYMBOLS: "false",
  });

  const symbols = await resolveOptimizerSymbols(config, {
    warn() {},
  });

  assert.deepEqual(symbols, ["BTC_KRW", "ETH_KRW"]);

  await fs.rm(tempDir, { recursive: true, force: true });
});

test("pickRuntimeSymbols selects per-symbol best candidates within score gap", () => {
  const selected = pickRuntimeSymbols({
    best: {
      symbol: "BTC_KRW",
      score: 100,
    },
    safeRanked: [
      {
        symbol: "BTC_KRW",
        score: 100,
        currentSignal: { action: "BUY" },
        metrics: { totalReturnPct: 4 },
      },
      {
        symbol: "BTC_KRW",
        score: 96,
        currentSignal: { action: "HOLD" },
        metrics: { totalReturnPct: 3 },
      },
      {
        symbol: "ILV_KRW",
        score: 88,
        currentSignal: { action: "BUY" },
        metrics: { totalReturnPct: 2 },
      },
      {
        symbol: "ETH_KRW",
        score: 97,
        currentSignal: { action: "HOLD" },
        metrics: { totalReturnPct: 2.5 },
      },
    ],
  }, {
    optimizer: {
      maxLiveSymbols: 2,
      maxSymbolScoreGap: 5,
    },
  });

  assert.deepEqual(selected, ["BTC_KRW", "ETH_KRW"]);
});

test("summarizeRuntimeSupport reports exact runtime config safety separately from top symbol selection", () => {
  const summary = summarizeRuntimeSupport({
    ranked: [
      {
        symbol: "BTC_KRW",
        strategy: { name: "mean_reversion", meanLookback: 20, meanEntryBps: 80, meanExitBps: 5 },
        score: 42,
        safety: { safe: false, checks: { minNetEdge: false } },
        metrics: { totalReturnPct: -1, expectancyKrw: 50, netEdgeBps: -10 },
      },
      {
        symbol: "BTC_KRW",
        strategy: { name: "mean_reversion", meanLookback: 20, meanEntryBps: 80, meanExitBps: 15 },
        score: 55,
        safety: { safe: true, checks: {} },
        metrics: { totalReturnPct: 2, expectancyKrw: 180, netEdgeBps: 12 },
      },
      {
        symbol: "ETH_KRW",
        strategy: { name: "mean_reversion", meanLookback: 20, meanEntryBps: 80, meanExitBps: 5 },
        score: 88,
        safety: { safe: true, checks: {} },
        metrics: { totalReturnPct: 4, expectancyKrw: 220, netEdgeBps: 16 },
      },
    ],
    safeRanked: [
      {
        symbol: "BTC_KRW",
        strategy: { name: "mean_reversion", meanLookback: 20, meanEntryBps: 80, meanExitBps: 15 },
        score: 55,
        safety: { safe: true, checks: {} },
        metrics: { totalReturnPct: 2, expectancyKrw: 180, netEdgeBps: 12 },
      },
      {
        symbol: "ETH_KRW",
        strategy: { name: "mean_reversion", meanLookback: 20, meanEntryBps: 80, meanExitBps: 5 },
        score: 88,
        safety: { safe: true, checks: {} },
        metrics: { totalReturnPct: 4, expectancyKrw: 220, netEdgeBps: 16 },
      },
    ],
  }, {
    execution: { symbol: "BTC_KRW" },
    strategy: { name: "mean_reversion", meanLookback: 20, meanEntryBps: 80, meanExitBps: 5 },
  });

  assert.equal(summary.executionSymbol, "BTC_KRW");
  assert.equal(summary.strategyName, "mean_reversion");
  assert.equal(summary.currentConfigSafe, false);
  assert.equal(summary.symbolHasSafeCandidate, true);
  assert.equal(summary.currentConfig?.safe, false);
  assert.equal(summary.bestForExecutionSymbol?.safe, true);
  assert.equal(summary.bestSafeForExecutionSymbol?.safe, true);
});
