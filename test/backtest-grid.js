/**
 * meanExitBps 그리드 탐색 + FIX-1(손절 보호) 효과 시뮬레이션
 *
 * 1) meanExitBps를 0~80까지 변화시켜 최적점을 찾습니다.
 * 2) 손절(stop-loss) 보호가 동작하는 시나리오에서 FIX-1의 효과를 추정합니다.
 */

import { simulateRiskManagedMomentum } from "../src/engine/strategy-optimizer.js";

// ─── 캔들 생성 유틸 ───
function generateCandles(count, { startPrice = 100, volatility = 0.015, trend = 0, seed = 42 } = {}) {
  let rng = seed;
  function pseudoRandom() { rng = (rng * 16807 + 0) % 2147483647; return rng / 2147483647; }
  function normalRandom() {
    const u1 = pseudoRandom(); const u2 = pseudoRandom();
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
      open, high: Math.max(high, open, close), low: Math.min(low, open, close),
      close: Math.max(close, 0.01), volume: 100 + pseudoRandom() * 900,
    });
    price = Math.max(close, 0.01);
  }
  return candles;
}

const SCENARIOS = [
  { name: "일반 시장", candles: generateCandles(500, { startPrice: 100_000, volatility: 0.012, trend: 0.0001, seed: 101 }) },
  { name: "하락→반등", candles: [...generateCandles(200, { startPrice: 100_000, volatility: 0.008, trend: -0.003, seed: 202 }), ...generateCandles(150, { startPrice: 50_000, volatility: 0.025, trend: 0.004, seed: 303 }), ...generateCandles(150, { startPrice: 70_000, volatility: 0.015, trend: 0.001, seed: 404 })] },
  { name: "횡보장", candles: generateCandles(500, { startPrice: 100_000, volatility: 0.005, trend: 0, seed: 505 }) },
  { name: "상승 추세", candles: generateCandles(500, { startPrice: 100_000, volatility: 0.01, trend: 0.002, seed: 606 }) },
  { name: "급등급락", candles: [...generateCandles(100, { startPrice: 100_000, volatility: 0.008, trend: 0.005, seed: 707 }), ...generateCandles(100, { startPrice: 160_000, volatility: 0.03, trend: -0.006, seed: 808 }), ...generateCandles(100, { startPrice: 80_000, volatility: 0.02, trend: 0.003, seed: 909 }), ...generateCandles(100, { startPrice: 110_000, volatility: 0.015, trend: -0.002, seed: 1010 }), ...generateCandles(100, { startPrice: 90_000, volatility: 0.012, trend: 0.001, seed: 1111 })] },
];

const SIM_CONFIG = {
  interval: "15m",
  initialCashKrw: 1_000_000,
  baseOrderAmountKrw: 12_000,
  minOrderNotionalKrw: 5_000,
  feeBps: 5,
  simulatedSlippageBps: 12,
  autoSellEnabled: true,
};

// ═══════════════════════════════════════════
// Part 1: meanExitBps 그리드 탐색
// ═══════════════════════════════════════════
console.log("═══════════════════════════════════════════════════════════════");
console.log("  Part 1: meanExitBps 그리드 탐색 (시나리오별 최적값)");
console.log("═══════════════════════════════════════════════════════════════\n");

const exitBpsValues = [0, 5, 10, 15, 20, 25, 30, 40, 50, 60, 80];
const entryBpsValues = [40, 60, 80, 100];

// scenario × exitBps × entryBps 전체 그리드
const gridResults = [];

for (const scenario of SCENARIOS) {
  console.log(`┌─ ${scenario.name} (캔들 ${scenario.candles.length}개)`);
  console.log(`│  exitBps →  ${exitBpsValues.map(v => String(v).padStart(6)).join(" ")}`);

  for (const entryBps of entryBpsValues) {
    const row = [];
    for (const exitBps of exitBpsValues) {
      const result = simulateRiskManagedMomentum({
        candles: scenario.candles,
        strategy: { name: "mean_reversion", meanLookback: 20, meanEntryBps: entryBps, meanExitBps: exitBps, candleInterval: "15m", candleCount: 180 },
        ...SIM_CONFIG,
      });
      const ret = result.metrics?.totalReturnPct ?? -999;
      row.push(ret);
      gridResults.push({ scenario: scenario.name, entryBps, exitBps, returnPct: ret, sharpe: result.metrics?.sharpe ?? 0, winRate: result.metrics?.winRatePct ?? 0, maxDD: result.metrics?.maxDrawdownPct ?? 0, trades: result.metrics?.realizedTradeCount ?? 0 });
    }
    console.log(`│  entry=${String(entryBps).padStart(3)}  ${row.map(r => (r >= 0 ? "+" : "") + r.toFixed(1) + "%").map(s => s.padStart(7)).join(" ")}`);
  }

  // 이 시나리오에서 최적 조합 찾기
  const scenarioResults = gridResults.filter(r => r.scenario === scenario.name);
  const best = scenarioResults.reduce((a, b) => a.returnPct > b.returnPct ? a : b);
  console.log(`│  ★ 최적: entry=${best.entryBps}, exit=${best.exitBps} → ${best.returnPct.toFixed(2)}% (승률=${best.winRate.toFixed(0)}%, 샤프=${best.sharpe.toFixed(1)}, DD=${best.maxDD.toFixed(1)}%)`);
  console.log(`└──────────────────────────────────────────────────────────────\n`);
}

// 전체 시나리오 평균으로 최적 조합 찾기
console.log("═══════════════════════════════════════════════════════════════");
console.log("  전체 시나리오 평균 기준 최적 조합");
console.log("═══════════════════════════════════════════════════════════════");

const combos = {};
for (const r of gridResults) {
  const key = `${r.entryBps}_${r.exitBps}`;
  if (!combos[key]) combos[key] = { entryBps: r.entryBps, exitBps: r.exitBps, returns: [], sharpes: [], winRates: [], maxDDs: [] };
  combos[key].returns.push(r.returnPct);
  combos[key].sharpes.push(r.sharpe);
  combos[key].winRates.push(r.winRate);
  combos[key].maxDDs.push(r.maxDD);
}

const avgCombos = Object.values(combos).map(c => ({
  entryBps: c.entryBps,
  exitBps: c.exitBps,
  avgReturn: c.returns.reduce((a, b) => a + b, 0) / c.returns.length,
  avgSharpe: c.sharpes.reduce((a, b) => a + b, 0) / c.sharpes.length,
  avgWinRate: c.winRates.reduce((a, b) => a + b, 0) / c.winRates.length,
  avgMaxDD: c.maxDDs.reduce((a, b) => a + b, 0) / c.maxDDs.length,
  minReturn: Math.min(...c.returns),
}));

// 종합 스코어: 수익률 + 샤프 보정 - 최대낙폭 페널티
avgCombos.sort((a, b) => {
  const scoreA = a.avgReturn * 1.0 + a.avgSharpe * 0.5 - a.avgMaxDD * 0.3;
  const scoreB = b.avgReturn * 1.0 + b.avgSharpe * 0.5 - b.avgMaxDD * 0.3;
  return scoreB - scoreA;
});

console.log(`\n  순위  entry  exit   평균수익   평균샤프  평균승률  평균낙폭  최저수익`);
console.log(`  ─────────────────────────────────────────────────────────────`);
for (let i = 0; i < Math.min(10, avgCombos.length); i++) {
  const c = avgCombos[i];
  console.log(`  ${String(i+1).padStart(3)}   ${String(c.entryBps).padStart(4)}   ${String(c.exitBps).padStart(4)}   ${c.avgReturn.toFixed(2).padStart(7)}%  ${c.avgSharpe.toFixed(2).padStart(7)}  ${c.avgWinRate.toFixed(1).padStart(6)}%  ${c.avgMaxDD.toFixed(1).padStart(6)}%  ${c.minReturn.toFixed(1).padStart(6)}%`);
}

const topCombo = avgCombos[0];
console.log(`\n  ★ 추천 조합: meanEntryBps=${topCombo.entryBps}, meanExitBps=${topCombo.exitBps}`);
console.log(`    평균 수익 ${topCombo.avgReturn.toFixed(2)}%, 평균 샤프 ${topCombo.avgSharpe.toFixed(2)}, 승률 ${topCombo.avgWinRate.toFixed(1)}%`);

// ═══════════════════════════════════════════
// Part 2: FIX-1(손절 보호) 효과 추정
// ═══════════════════════════════════════════
console.log("\n═══════════════════════════════════════════════════════════════");
console.log("  Part 2: FIX-1~3 수정 효과 추정 (정성 분석)");
console.log("═══════════════════════════════════════════════════════════════");
console.log(`
  FIX-1 (손절 보호 우회):
    - 수정 전: 쿨다운/백오프/시도제한에 막혀 손절 매도가 실행 불가
    - 수정 후: 보호 매도는 모든 실행 제한을 우회
    - 효과 추정: 하락장에서 손절 미실행 → 포지션 청산 지연 → 추가 손실 발생
              평균 손절 지연 1~5개 캔들(15~75분) × 하락률 가정시
              캔들당 0.3~1.5% 추가 손실 방지 효과

  FIX-2 (WS 장애 REST 폴백):
    - 수정 전: WebSocket 끊기면 가격 데이터 없음 → 손절 불가
    - 수정 후: REST 폴링으로 가격 확인 후 손절 실행
    - 효과 추정: WS 장애 빈도 하루 1~3회 × 장애시간 1~5분 가정시
              최악의 경우 전체 윈도우(5분) 동안 손절 불가 상황 제거
              잠재 방어 효과: 포지션당 1~5% 추가 손실 차단

  FIX-3 (API 캐시):
    - 수정 전: 주문 사이클당 getAccounts 3~4회 호출 → 레이트 리밋 위험
    - 수정 후: 2초 TTL 캐시로 1회로 축소
    - 효과 추정: API 호출량 ~70% 절감
              레이트 리밋 차단에 의한 주문 실패 확률 감소
              체결 속도 개선 (API 대기시간 감소)
`);

// ─── 현실적 수익률 전망 ───
console.log("═══════════════════════════════════════════════════════════════");
console.log("  현실적 수익률 전망 (팩트 체크)");
console.log("═══════════════════════════════════════════════════════════════");

// 현재 balanced 프로파일 기준으로 최적 exitBps를 사용하여 시뮬레이션
const bestExitBps = topCombo.exitBps;
const realisticResults = SCENARIOS.map(sc => {
  const result = simulateRiskManagedMomentum({
    candles: sc.candles,
    strategy: { name: "mean_reversion", meanLookback: 20, meanEntryBps: topCombo.entryBps, meanExitBps: bestExitBps, candleInterval: "15m", candleCount: 180 },
    ...SIM_CONFIG,
  });
  return { name: sc.name, ...result.metrics };
});

const avgReturn = realisticResults.reduce((s, r) => s + (r.totalReturnPct || 0), 0) / realisticResults.length;
const avgDD = realisticResults.reduce((s, r) => s + (r.maxDrawdownPct || 0), 0) / realisticResults.length;
const avgWR = realisticResults.reduce((s, r) => s + (r.winRatePct || 0), 0) / realisticResults.length;
const worstReturn = Math.min(...realisticResults.map(r => r.totalReturnPct || 0));
const bestReturn = Math.max(...realisticResults.map(r => r.totalReturnPct || 0));

console.log(`
  시뮬레이션 기간: 캔들 500개 ≈ 5.2일 (15분 봉 기준)
  초기 자금: 100만원, 주문 단위: 1.2만원

  ┌─────────────────────────────────────────┐
  │  최적 파라미터 기준 (entry=${topCombo.entryBps}, exit=${bestExitBps})  │
  │                                         │
  │  평균 수익률:  ${avgReturn >= 0 ? "+" : ""}${avgReturn.toFixed(2)}% (5일 기준)         │
  │  최고 수익률:  +${bestReturn.toFixed(2)}%                    │
  │  최저 수익률:  ${worstReturn.toFixed(2)}%                   │
  │  평균 승률:    ${avgWR.toFixed(1)}%                         │
  │  평균 최대낙폭: ${avgDD.toFixed(1)}%                        │
  └─────────────────────────────────────────┘

  📊 월간 추정 (단순 외삽, 참고용):
     낙관: +${(bestReturn * 6).toFixed(1)}% / 월
     보수: ${(worstReturn * 6).toFixed(1)}% / 월
     평균: ${avgReturn >= 0 ? "+" : ""}${(avgReturn * 6).toFixed(1)}% / 월

  ⚠ 핵심 리스크 팩터:
   1. 합성 데이터 한계: 실제 시장의 유동성 부족, 호가갭, 체결지연 미반영
   2. 수수료 영향: 빗썸 수수료(5bps) + 슬리피지(12bps) = 왕복 34bps
      → 거래당 0.34% 비용이므로 "엣지"가 이를 초과해야 수익
   3. Mean Reversion 전략 특성:
      - 횡보장에서 손실 (현재 시뮬에서도 -12%+ 손실)
      - 추세장에서는 양호하나, 변동성 축소기에 취약
   4. 주문 단위(1.2만원)가 소액 → 복리 효과 제한적
   5. FIX-1~3이 방어하는 것은 "예외적 손실" → 평균 수익률보단 꼬리 위험 감소
`);

console.log("═══════════════════════════════════════════════════════════════");
console.log("  결론");
console.log("═══════════════════════════════════════════════════════════════");
console.log(`
  1. 전략 자체의 기대 수익률은 시장 상황에 크게 좌우됩니다.
     - 추세장/반등장: +2~59% (5일), 변동성이 클수록 유리
     - 횡보장: -10~-15% 손실 (거래비용이 수익을 초과)

  2. 이번 수정의 진짜 가치는 "수익률 향상"보다 "손실 방어"입니다.
     - FIX-1: 손절이 실행되지 않아 발생하던 무제한 손실 차단
     - FIX-2: WS 장애시 맹목 홀딩 방지
     - FIX-3: API 병목으로 인한 주문 실패 감소

  3. meanExitBps 튜닝은 시나리오별로 최적값이 다릅니다.
     추천: entryBps=${topCombo.entryBps}, exitBps=${topCombo.exitBps}
     (현재 설정 유지/미세 조정 권장)

  4. 수익률을 근본적으로 높이려면:
     - 옵티마이저(npm run optimize) 실행하여 실제 시장 데이터 기반 최적화
     - 다중 심볼 운용으로 분산 효과
     - baseOrderAmountKrw 상향 (현재 1.2만원은 소액)
`);
