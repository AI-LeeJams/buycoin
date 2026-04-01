import test from "node:test";
import assert from "node:assert/strict";
import { optimizeTradingStrategies, simulateRiskManagedMomentum } from "../src/engine/strategy-optimizer.js";
import { pickRuntimeSymbols } from "../src/app/optimize.js";

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
