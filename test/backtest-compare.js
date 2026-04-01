/**
 * 수정 전/후 파라미터 비교 백테스트
 *
 * 시뮬레이션 시나리오:
 *  1) 랜덤 워크 + 평균회귀 (일반 시장)
 *  2) 하락장 (급락 → 반등)
 *  3) 횡보장 (좁은 레인지)
 *  4) 상승 추세
 *
 * 각 시나리오에서 old(수정 전) vs new(수정 후) 파라미터 성능을 비교합니다.
 */

import { simulateRiskManagedMomentum } from "../src/engine/strategy-optimizer.js";

// ─── 캔들 생성 유틸 ───
function generateCandles(count, { startPrice = 100, volatility = 0.015, trend = 0, seed = 42 } = {}) {
  let rng = seed;
  function pseudoRandom() {
    rng = (rng * 16807 + 0) % 2147483647;
    return rng / 2147483647;
  }
  // Box-Muller 변환
  function normalRandom() {
    const u1 = pseudoRandom();
    const u2 = pseudoRandom();
    return Math.sqrt(-2 * Math.log(u1 || 0.0001)) * Math.cos(2 * Math.PI * u2);
  }

  const candles = [];
  let price = startPrice;
  const now = Date.now();

  for (let i = 0; i < count; i++) {
    const change = normalRandom() * volatility + trend;
    const open = price;
    const close = price * (1 + change);
    const high = Math.max(open, close) * (1 + pseudoRandom() * volatility * 0.5);
    const low = Math.min(open, close) * (1 - pseudoRandom() * volatility * 0.5);
    candles.push({
      timestamp: now - (count - i) * 15 * 60 * 1000,
      open,
      high: Math.max(high, open, close),
      low: Math.min(low, open, close),
      close: Math.max(close, 0.01),
      volume: 100 + pseudoRandom() * 900,
    });
    price = Math.max(close, 0.01);
  }
  return candles;
}

// ─── 시나리오 정의 ───
const SCENARIOS = [
  {
    name: "일반 시장 (평균회귀)",
    candles: generateCandles(500, { startPrice: 100_000, volatility: 0.012, trend: 0.0001, seed: 101 }),
  },
  {
    name: "하락장 (급락 → 반등)",
    candles: [
      ...generateCandles(200, { startPrice: 100_000, volatility: 0.008, trend: -0.003, seed: 202 }),
      ...generateCandles(150, { startPrice: 50_000, volatility: 0.025, trend: 0.004, seed: 303 }),
      ...generateCandles(150, { startPrice: 70_000, volatility: 0.015, trend: 0.001, seed: 404 }),
    ],
  },
  {
    name: "횡보장 (좁은 레인지)",
    candles: generateCandles(500, { startPrice: 100_000, volatility: 0.005, trend: 0, seed: 505 }),
  },
  {
    name: "상승 추세",
    candles: generateCandles(500, { startPrice: 100_000, volatility: 0.01, trend: 0.002, seed: 606 }),
  },
];

// ─── 파라미터 정의 ───
const OLD_PARAMS = {
  name: "mean_reversion",
  meanLookback: 20,
  meanEntryBps: 60,
  meanExitBps: 10,       // 수정 전: 너무 낮음
  candleInterval: "15m",
  candleCount: 180,
};

const NEW_PARAMS = {
  name: "mean_reversion",
  meanLookback: 20,
  meanEntryBps: 60,
  meanExitBps: 25,       // 수정 후: 상향 조정
  candleInterval: "15m",
  candleCount: 180,
};

const SIM_CONFIG = {
  interval: "15m",
  initialCashKrw: 1_000_000,
  baseOrderAmountKrw: 12_000,
  minOrderNotionalKrw: 5_000,
  feeBps: 5,
  simulatedSlippageBps: 12,
  autoSellEnabled: true,
};

// ─── 실행 ───
console.log("═══════════════════════════════════════════════════════════════");
console.log("     수정 전/후 전략 파라미터 비교 백테스트 결과");
console.log("═══════════════════════════════════════════════════════════════");
console.log(`  OLD: meanExitBps=${OLD_PARAMS.meanExitBps}, NEW: meanExitBps=${NEW_PARAMS.meanExitBps}`);
console.log(`  공통: meanEntryBps=${OLD_PARAMS.meanEntryBps}, lookback=${OLD_PARAMS.meanLookback}`);
console.log(`  수수료=${SIM_CONFIG.feeBps}bps, 슬리피지=${SIM_CONFIG.simulatedSlippageBps}bps`);
console.log(`  초기자금=${(SIM_CONFIG.initialCashKrw/10000).toFixed(0)}만원, 주문단위=${(SIM_CONFIG.baseOrderAmountKrw/10000).toFixed(1)}만원`);
console.log("═══════════════════════════════════════════════════════════════\n");

const summary = [];

for (const scenario of SCENARIOS) {
  const oldResult = simulateRiskManagedMomentum({
    candles: scenario.candles,
    strategy: OLD_PARAMS,
    ...SIM_CONFIG,
  });

  const newResult = simulateRiskManagedMomentum({
    candles: scenario.candles,
    strategy: NEW_PARAMS,
    ...SIM_CONFIG,
  });

  const om = oldResult.metrics;
  const nm = newResult.metrics;

  console.log(`┌─ 시나리오: ${scenario.name} (캔들 ${scenario.candles.length}개)`);
  console.log(`│`);
  console.log(`│  지표                    수정 전(OLD)     수정 후(NEW)     변화`);
  console.log(`│  ─────────────────────────────────────────────────────────────`);

  const rows = [
    ["총 수익률(%)",      om?.totalReturnPct,   nm?.totalReturnPct,   "%p"],
    ["최종 자산(원)",      om?.finalEquityKrw,   nm?.finalEquityKrw,   "원"],
    ["최대 낙폭(%)",       om?.maxDrawdownPct,   nm?.maxDrawdownPct,   "%p"],
    ["샤프 비율",          om?.sharpe,           nm?.sharpe,           ""],
    ["승률(%)",            om?.winRatePct,       nm?.winRatePct,       "%p"],
    ["수익 팩터",          om?.profitFactor,     nm?.profitFactor,     ""],
    ["기대수익(원/거래)",  om?.expectancyKrw,    nm?.expectancyKrw,    "원"],
    ["순 엣지(bps)",       om?.netEdgeBps,       nm?.netEdgeBps,       "bps"],
    ["매수 횟수",          om?.buyCount,         nm?.buyCount,         "회"],
    ["매도 횟수",          om?.sellCount,        nm?.sellCount,        "회"],
    ["총 수수료(원)",      om?.totalFeeKrw,      nm?.totalFeeKrw,      "원"],
  ];

  for (const [label, oldVal, newVal, unit] of rows) {
    if (oldVal == null || newVal == null) continue;
    const ov = typeof oldVal === "number" ? oldVal : 0;
    const nv = typeof newVal === "number" ? newVal : 0;
    const diff = nv - ov;
    const diffStr = diff >= 0 ? `+${diff.toFixed(2)}` : diff.toFixed(2);
    const arrow = diff > 0 ? "↑" : diff < 0 ? "↓" : "─";
    const ovStr = ov.toFixed(2).padStart(12);
    const nvStr = nv.toFixed(2).padStart(12);
    console.log(`│  ${label.padEnd(20)} ${ovStr}     ${nvStr}     ${arrow} ${diffStr}${unit}`);
  }

  console.log(`└──────────────────────────────────────────────────────────────\n`);

  summary.push({
    scenario: scenario.name,
    oldReturn: om?.totalReturnPct ?? 0,
    newReturn: nm?.totalReturnPct ?? 0,
    oldSharpe: om?.sharpe ?? 0,
    newSharpe: nm?.sharpe ?? 0,
    oldWinRate: om?.winRatePct ?? 0,
    newWinRate: nm?.winRatePct ?? 0,
    oldMaxDD: om?.maxDrawdownPct ?? 0,
    newMaxDD: nm?.maxDrawdownPct ?? 0,
  });
}

// ─── 종합 요약 ───
console.log("═══════════════════════════════════════════════════════════════");
console.log("                         종합 요약");
console.log("═══════════════════════════════════════════════════════════════");

const avgOldReturn = summary.reduce((s, r) => s + r.oldReturn, 0) / summary.length;
const avgNewReturn = summary.reduce((s, r) => s + r.newReturn, 0) / summary.length;
const avgOldSharpe = summary.reduce((s, r) => s + r.oldSharpe, 0) / summary.length;
const avgNewSharpe = summary.reduce((s, r) => s + r.newSharpe, 0) / summary.length;
const avgOldWinRate = summary.reduce((s, r) => s + r.oldWinRate, 0) / summary.length;
const avgNewWinRate = summary.reduce((s, r) => s + r.newWinRate, 0) / summary.length;
const avgOldDD = summary.reduce((s, r) => s + r.oldMaxDD, 0) / summary.length;
const avgNewDD = summary.reduce((s, r) => s + r.newMaxDD, 0) / summary.length;

console.log(`  평균 수익률:  OLD ${avgOldReturn.toFixed(2)}%  →  NEW ${avgNewReturn.toFixed(2)}%  (${(avgNewReturn - avgOldReturn) >= 0 ? "+" : ""}${(avgNewReturn - avgOldReturn).toFixed(2)}%p)`);
console.log(`  평균 샤프:    OLD ${avgOldSharpe.toFixed(2)}   →  NEW ${avgNewSharpe.toFixed(2)}   (${(avgNewSharpe - avgOldSharpe) >= 0 ? "+" : ""}${(avgNewSharpe - avgOldSharpe).toFixed(2)})`);
console.log(`  평균 승률:    OLD ${avgOldWinRate.toFixed(1)}%  →  NEW ${avgNewWinRate.toFixed(1)}%  (${(avgNewWinRate - avgOldWinRate) >= 0 ? "+" : ""}${(avgNewWinRate - avgOldWinRate).toFixed(1)}%p)`);
console.log(`  평균 낙폭:    OLD ${avgOldDD.toFixed(2)}%  →  NEW ${avgNewDD.toFixed(2)}%  (${(avgNewDD - avgOldDD) >= 0 ? "+" : ""}${(avgNewDD - avgOldDD).toFixed(2)}%p)`);

const improvedCount = summary.filter(r => r.newReturn > r.oldReturn).length;
console.log(`\n  시나리오 ${summary.length}개 중 ${improvedCount}개에서 수익률 개선`);

// 리스크 경고
console.log("\n─── 리스크 경고 ───");
console.log("  ⚠ 본 결과는 합성 시뮬레이션 데이터 기반이며 실제 시장과 다릅니다.");
console.log("  ⚠ 과거 성과가 미래 수익을 보장하지 않습니다.");
console.log("  ⚠ 실제 거래에서는 유동성, 체결 지연, 호가 갭 등 추가 비용이 발생합니다.");
console.log("  ⚠ 투자는 본인의 판단과 책임 하에 이루어져야 합니다.");
console.log("═══════════════════════════════════════════════════════════════");
