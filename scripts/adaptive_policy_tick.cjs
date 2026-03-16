#!/usr/bin/env node
const fs = require('fs');
const { execSync } = require('child_process');
const crypto = require('crypto');
const process = globalThis.process;

const ROOT = '/Users/leejam/buycoin';
const TRADER = `${ROOT}/.trader`;
const RUNTIME = `${TRADER}/ai-runtime.json`;
const KPI = `${TRADER}/execution-kpi-summary.json`;
const UNIVERSE = `${TRADER}/market-universe.json`;
const STATE = `${TRADER}/state.json`;
const AI_SETTINGS = `${TRADER}/ai-settings.json`;
const POLICY_STATE = `${TRADER}/adaptive-policy-state.json`;
const QUALITY_COMPARE = `${TRADER}/quality-compare.json`;
const STABILITY_MONITOR = `${TRADER}/stability-monitor.json`;

const CORE = ['BTC_KRW', 'ETH_KRW', 'XRP_KRW', 'SOL_KRW'];
const BLACKLIST = new Set(['ENSO_KRW', 'USDT_KRW']);
const MIN_SELLABLE_ORDER_KRW = 20000;
const CASH_RESERVE_KRW = 2000;

function readJson(p, fallback = null) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function writeJson(p, obj) { fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n'); }
function writeJsonAtomic(p, obj) {
  const dir = require('path').dirname(p);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, p);
}
function n(v, d = 0) { const x = Number(v); return Number.isFinite(x) ? x : d; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function changePct(c) {
  return n(c.change24hPct, n(c.changePct24h, n(c.signedChangeRate, 0) * 100));
}

function volume24h(c) {
  return n(c.volume24hKrw, n(c.turnover24hKrw, n(c.accTradePrice24h, n(c.notional24h, 0))));
}

function getMarketTone(universe) {
  const cs = Array.isArray(universe?.candidates) ? universe.candidates : [];
  if (!cs.length) return { tone: 'neutral', avg: 0, up: 0, down: 0 };
  const ch = cs.map(changePct);
  const avg = ch.reduce((a, b) => a + b, 0) / ch.length;
  const up = ch.filter((x) => x > 0.4).length;
  const down = ch.filter((x) => x < -0.4).length;
  const tone = avg >= 1.2 && up > down ? 'risk_on' : avg <= -1.0 && down > up ? 'risk_off' : 'neutral';
  return { tone, avg, up, down };
}

function rankScore(c) {
  const ch = changePct(c);
  const vol = volume24h(c);
  // volume field can be empty/zero in current snapshots -> keep momentum-only fallback alive.
  const volScore = vol > 0 ? Math.log10(vol) : 0;
  return ch * 0.75 + volScore * 0.25;
}

function buildUniversePicks(universe, tone) {
  const cs = Array.isArray(universe?.candidates) ? universe.candidates : [];
  const filtered = cs
    .filter((c) => c && c.symbol && !BLACKLIST.has(c.symbol))
    .filter((c) => String(c.symbol).endsWith('_KRW'))
    .map((c) => ({
      symbol: c.symbol,
      ch: changePct(c),
      vol: volume24h(c),
      score: rankScore(c),
    }))
    .filter((x) => tone === 'risk_off' ? x.ch > -1.5 : true)
    .sort((a, b) => b.score - a.score);

  const extras = filtered
    .map((x) => x.symbol)
    .filter((s) => !CORE.includes(s))
    .slice(0, 6);

  const symbols = [...CORE, ...extras];
  return symbols.slice(0, 10);
}

function pickConfigByTone(tone) {
  if (tone === 'risk_on') {
    return { attempts: 3, maxSymbols: 5, order: 20000, multiplier: 1.0, regime: 'risk_on' };
  }
  if (tone === 'risk_off') {
    return { attempts: 1, maxSymbols: 3, order: 10000, multiplier: 0.8, regime: 'risk_off' };
  }
  return { attempts: 2, maxSymbols: 4, order: 20000, multiplier: 0.95, regime: 'neutral' };
}

function snapshotForCompare(runtimeObj) {
  return JSON.stringify({
    execution: runtimeObj.execution,
    decision: runtimeObj.decision,
    overlay: {
      multiplier: runtimeObj.overlay?.multiplier,
      regime: runtimeObj.overlay?.regime,
      score: runtimeObj.overlay?.score,
    },
    controls: runtimeObj.controls,
  });
}

function extractPolicyComparable(source = {}) {
  return {
    execution: {
      orderAmountKrw: source?.execution?.orderAmountKrw,
      symbols: Array.isArray(source?.execution?.symbols) ? source.execution.symbols : [],
      maxSymbolsPerWindow: source?.execution?.maxSymbolsPerWindow,
      maxOrderAttemptsPerWindow: source?.execution?.maxOrderAttemptsPerWindow,
    },
    decision: {
      mode: source?.decision?.mode,
      allowBuy: source?.decision?.allowBuy,
      allowSell: source?.decision?.allowSell,
      forceAction: source?.decision?.forceAction,
      forceAmountKrw: source?.decision?.forceAmountKrw,
      forceOnce: source?.decision?.forceOnce,
    },
    overlay: {
      multiplier: source?.overlay?.multiplier,
      regime: source?.overlay?.regime,
      score: source?.overlay?.score,
    },
    controls: {
      killSwitch: source?.controls?.killSwitch,
    },
  };
}

function policyHash(policyObj = {}) {
  const text = JSON.stringify(policyObj || {});
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function ymd(d = new Date()) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function isTightening(prevRuntime = {}, nextRuntime = {}) {
  const prev = prevRuntime || {};
  const next = nextRuntime || {};
  const pExec = prev.execution || {};
  const nExec = next.execution || {};
  const pDec = prev.decision || {};
  const nDec = next.decision || {};

  return (
    (nDec.allowBuy === false && pDec.allowBuy !== false)
    || n(pExec.orderAmountKrw, 0) > n(nExec.orderAmountKrw, 0)
    || n(pExec.maxOrderAttemptsPerWindow, 99) > n(nExec.maxOrderAttemptsPerWindow, 99)
    || n(pExec.maxSymbolsPerWindow, 99) > n(nExec.maxSymbolsPerWindow, 99)
    || (next.controls?.killSwitch === true && prev.controls?.killSwitch !== true)
  );
}

function krwBalance(state) {
  const snaps = Array.isArray(state?.balancesSnapshot) ? state.balancesSnapshot : [];
  const latest = snaps.length > 0 ? snaps[snaps.length - 1] : null;
  const items = Array.isArray(latest?.items) ? latest.items : [];
  for (const it of items) {
    if (String(it?.currency || '').toUpperCase() !== 'KRW') continue;
    return n(it.balance, 0) + n(it.locked, 0);
  }
  return 0;
}

function estimateEquityKrw(state, universe) {
  const snaps = Array.isArray(state?.balancesSnapshot) ? state.balancesSnapshot : [];
  const latest = snaps.length > 0 ? snaps[snaps.length - 1] : null;
  const items = Array.isArray(latest?.items) ? latest.items : [];
  const candidates = Array.isArray(universe?.candidates) ? universe.candidates : [];
  const prices = new Map(candidates.map((c) => [String(c?.symbol || ''), n(c?.lastPrice, 0)]));

  let total = 0;
  for (const it of items) {
    const cur = String(it?.currency || '').toUpperCase();
    const qty = n(it?.balance, 0) + n(it?.locked, 0);
    if (!cur || qty <= 0) continue;
    if (cur === 'KRW') {
      total += qty;
      continue;
    }
    const sym = `${cur}_KRW`;
    const px = prices.get(sym) || n(it?.avgBuyPrice, 0);
    total += qty * Math.max(px, 0);
  }
  return total;
}

function cleanupTmpFiles(dirPath, maxAgeMs = 6 * 60 * 60 * 1000) {
  try {
    const now = Date.now();
    for (const name of fs.readdirSync(dirPath)) {
      if (!name.endsWith('.tmp')) continue;
      const p = `${dirPath}/${name}`;
      const st = fs.statSync(p);
      if (now - st.mtimeMs > maxAgeMs) {
        fs.unlinkSync(p);
      }
    }
  } catch {
    // best effort cleanup
  }
}

function recentCashRejectCount(state, limit = 40) {
  const ev = Array.isArray(state?.riskEvents) ? state.riskEvents : [];
  let count = 0;
  for (const e of ev.slice(-limit)) {
    if (e?.type !== 'order_rejected') continue;
    const reasons = Array.isArray(e?.reasons) ? e.reasons : [];
    if (reasons.length === 0) {
      if (String(e?.reason || '').toUpperCase() === 'INSUFFICIENT_CASH') count += 1;
      continue;
    }
    for (const r of reasons) {
      if (String(r?.rule || '').toUpperCase() === 'INSUFFICIENT_CASH') count += 1;
    }
  }
  return count;
}

function recentDuplicateGuardCount(state, limit = 120) {
  const ev = Array.isArray(state?.riskEvents) ? state.riskEvents : [];
  let count = 0;
  for (const e of ev.slice(-limit)) {
    if (e?.type !== 'order_rejected') continue;
    const reasons = Array.isArray(e?.reasons) ? e.reasons : [];
    for (const r of reasons) {
      if (String(r?.rule || '').toUpperCase() === 'DUPLICATE_ORDER_WINDOW') count += 1;
    }
  }
  return count;
}

function buildQualitySnapshot({ attempted, successful, rejected, tradeCount, expectancyKrw, realizedPnlKrw, totalFeeKrw }) {
  const successRate = attempted > 0 ? successful / attempted : 0;
  const rejectRate = attempted > 0 ? rejected / attempted : 0;
  return {
    sampledAt: new Date().toISOString(),
    attempted,
    successful,
    rejected,
    successRate,
    rejectRate,
    tradeCount,
    expectancyKrw,
    realizedPnlKrw,
    totalFeeKrw,
  };
}

function buildQualityDelta(prev, cur) {
  if (!prev) return null;
  return {
    attemptedDelta: n(cur.attempted, 0) - n(prev.attempted, 0),
    successRateDeltaPct: Math.round((n(cur.successRate, 0) - n(prev.successRate, 0)) * 10000) / 100,
    rejectRateDeltaPct: Math.round((n(cur.rejectRate, 0) - n(prev.rejectRate, 0)) * 10000) / 100,
    expectancyDeltaKrw: Math.round(n(cur.expectancyKrw, 0) - n(prev.expectancyKrw, 0)),
    realizedPnlDeltaKrw: Math.round(n(cur.realizedPnlKrw, 0) - n(prev.realizedPnlKrw, 0)),
    feeDeltaKrw: Math.round(n(cur.totalFeeKrw, 0) - n(prev.totalFeeKrw, 0)),
  };
}

function stabilitySnapshot(state, settingsDrift) {
  const ev = Array.isArray(state?.riskEvents) ? state.riskEvents : [];
  let duplicateGuardHits = 0;
  for (const e of ev.slice(-200)) {
    if (e?.type !== 'order_rejected') continue;
    const reasons = Array.isArray(e?.reasons) ? e.reasons : [];
    for (const r of reasons) {
      if (String(r?.rule || '').toUpperCase() === 'DUPLICATE_ORDER_WINDOW') {
        duplicateGuardHits += 1;
      }
    }
  }

  const aiOverrideConsumedCount = Object.keys(state?.settings?.aiOverrideConsumed || {}).length;
  const killSwitch = Boolean(state?.settings?.killSwitch);
  const killSwitchReason = state?.settings?.killSwitchReason || null;

  return {
    sampledAt: new Date().toISOString(),
    settingsDrift,
    duplicateGuardHits,
    aiOverrideConsumedCount,
    killSwitch,
    killSwitchReason,
  };
}

function main() {
  const runtime = readJson(RUNTIME, {});
  const prevComparable = snapshotForCompare(runtime || {});

  const kpi = readJson(KPI, {});
  const universe = readJson(UNIVERSE, {});
  const state = readJson(STATE, {});

  cleanupTmpFiles(TRADER);

  const s = kpi?.summary || {};
  const attempted = n(s?.orders?.attempted, 0);
  const successful = n(s?.orders?.successful, 0);
  const rejected = Math.max(0, attempted - successful);
  const successRate = attempted > 0 ? successful / attempted : 0;
  const rejectRate = attempted > 0 ? rejected / attempted : 0;
  const tradeCount = n(s?.realized?.tradeCount, 0);
  const expectancyKrw = n(s?.realized?.expectancyKrw, 0);
  const totalFeeKrw = n(s?.fills?.totalFeeKrw, 0);
  const realizedPnlKrw = n(s?.realized?.realizedPnlKrw, 0);

  const m = getMarketTone(universe);
  const base = pickConfigByTone(m.tone);

  let symbols = buildUniversePicks(universe, m.tone);
  let attempts = base.attempts;
  let maxSymbols = base.maxSymbols;
  let order = base.order;
  let multiplier = base.multiplier;
  let allowBuy;

  // Profit-first baseline: keep participation unless hard risk conditions trigger.
  attempts = Math.max(attempts, 2);
  maxSymbols = Math.max(maxSymbols, 4);
  order = Math.max(order, 20000);
  multiplier = Math.max(multiplier, 1.0);
  const regime = base.regime;
  const gateReasons = [];

  if (attempted === 0) {
    attempts = Math.max(attempts, 3);
    maxSymbols = Math.max(maxSymbols, 5);
    order = Math.max(order, 20000);
    multiplier = Math.max(multiplier, 1.0);
    gateReasons.push('no_activity_open_path');
  }

  if (attempted > 0 && rejectRate > 0.6) {
    attempts = Math.max(1, attempts - 1);
    order = MIN_SELLABLE_ORDER_KRW;
    gateReasons.push('high_reject_rate_throttle');
  }

  if (attempted > 0 && successRate >= 0.5 && m.tone === 'risk_on') {
    order = 20000;
    attempts = clamp(attempts, 2, 3);
    gateReasons.push('risk_on_quality_expand');
  }

  // Profit-quality guard: if expectancy turns negative with enough samples, cut buy risk.
  if (tradeCount >= 3 && expectancyKrw < 0) {
    attempts = 1;
    maxSymbols = 3;
    order = MIN_SELLABLE_ORDER_KRW;
    multiplier = Math.min(multiplier, 0.9);
    gateReasons.push('negative_expectancy_throttle');
  }

  // Realized-loss guard: prevent immediate re-entry churn when realized loss is already negative.
  if (tradeCount >= 2 && realizedPnlKrw < 0) {
    attempts = 1;
    maxSymbols = 3;
    order = MIN_SELLABLE_ORDER_KRW;
    multiplier = Math.min(multiplier, 0.85);
    gateReasons.push('realized_loss_throttle');
  }

  // Fee-drag guard: low tradeCount but already high fees -> suppress churn.
  if (tradeCount < 3 && totalFeeKrw >= 150) {
    attempts = 1;
    order = MIN_SELLABLE_ORDER_KRW;
    multiplier = Math.min(multiplier, 0.9);
    gateReasons.push('fee_drag_throttle');
  }

  // Rejection-wall guard: lots of attempts but almost no fills means execution quality collapse.
  if (attempted >= 5 && rejectRate >= 0.8) {
    attempts = 1;
    order = MIN_SELLABLE_ORDER_KRW;
    maxSymbols = 3;
    gateReasons.push('rejection_wall_throttle');
  }

  // Cash-aware safety: prevent repeated insufficient-cash loops.
  const krw = krwBalance(state);
  const cashRejects = recentCashRejectCount(state, 40);
  const duplicateRejects = recentDuplicateGuardCount(state, 120);
  if (krw < (MIN_SELLABLE_ORDER_KRW + CASH_RESERVE_KRW)) {
    order = MIN_SELLABLE_ORDER_KRW;
    attempts = 1;
    maxSymbols = 2;
    allowBuy = false;
    gateReasons.push('low_cash_hard_block_buy');
  } else if (cashRejects >= 8 && krw < 40000) {
    order = MIN_SELLABLE_ORDER_KRW;
    attempts = 1;
    maxSymbols = 2;
    allowBuy = false;
    gateReasons.push('cash_reject_loop_block_buy');
  } else {
    allowBuy = true;
    gateReasons.push('buy_allowed_profit_first');
  }

  // Liquidity-aware throttle even in profit-first mode.
  if (allowBuy && krw < 80000) {
    order = MIN_SELLABLE_ORDER_KRW;
    attempts = 1;
    maxSymbols = Math.min(maxSymbols, 2);
    gateReasons.push('low_cash_soft_throttle');
  }

  if (duplicateRejects >= 5) {
    attempts = 1;
    maxSymbols = Math.min(maxSymbols, 2);
    gateReasons.push('duplicate_guard_throttle');
  }

  const policyState = readJson(POLICY_STATE, {});
  const nowMs = Date.now();
  const today = ymd(new Date());
  const equityKrw = estimateEquityKrw(state, universe);
  const dayStateBase = policyState?.day === today
    ? policyState
    : { day: today, applyCount: 0, dayStartEquityKrw: equityKrw, dayPeakEquityKrw: equityKrw, lockTriggered: false, lossStreakTicks: 0 };
  let dayStartEquityKrw = n(dayStateBase.dayStartEquityKrw, n(dayStateBase.dayStartKrw, equityKrw || 1));
  if (dayStartEquityKrw <= 0) dayStartEquityKrw = equityKrw || 1;
  // Baseline sanity reset: if baseline is stale/too small, avoid false huge PnL lock.
  if (dayStartEquityKrw > 0 && equityKrw > 0 && (equityKrw / dayStartEquityKrw) >= 1.8) {
    dayStartEquityKrw = equityKrw;
  }
  const dayPeakEquityKrw = Math.max(n(dayStateBase.dayPeakEquityKrw, n(dayStateBase.dayPeakKrw, equityKrw)), equityKrw);
  const dayPnlPct = dayStartEquityKrw > 0 ? ((equityKrw - dayStartEquityKrw) / dayStartEquityKrw) * 100 : 0;
  const dayFromPeakPct = dayPeakEquityKrw > 0 ? ((equityKrw - dayPeakEquityKrw) / dayPeakEquityKrw) * 100 : 0;

  // Profit-lock rules (capital preservation first).
  if (dayPnlPct >= 5.0) {
    attempts = Math.min(attempts, 1);
    maxSymbols = Math.min(maxSymbols, 3);
    order = Math.min(order, MIN_SELLABLE_ORDER_KRW);
    gateReasons.push('profit_lock_soft');
  }
  if (dayStateBase.lockTriggered === true && dayFromPeakPct <= -1.0) {
    attempts = 1;
    maxSymbols = 3;
    order = 10000;
    gateReasons.push('profit_roundtrip_throttle');
  }

  // Re-entry cooldown after recent profitable sells (symbol-level lockout).
  const doneOrders = (Array.isArray(state?.orders) ? state.orders : []).filter((o) => String(o?.state || '').toUpperCase() === 'DONE');
  const nowIsoMs = Date.now();
  const cooldownMs = 2 * 60 * 60 * 1000;
  const cooledSymbols = new Set();
  for (const o of doneOrders.slice(-40)) {
    if (String(o?.side || '').toLowerCase() !== 'sell') continue;
    const ts = Date.parse(o?.placedAt || o?.createdAt || '');
    if (!Number.isFinite(ts) || nowIsoMs - ts > cooldownMs) continue;
    if (n(o?.amountKrw, 0) > 0) cooledSymbols.add(String(o?.symbol || ''));
  }
  if (cooledSymbols.size > 0) {
    const before = symbols.length;
    symbols = symbols.filter((s) => !cooledSymbols.has(s));
    if (symbols.length < before) {
      gateReasons.push('post_profit_symbol_cooldown');
    }
    if (symbols.length === 0) {
      symbols = CORE.slice(0, 2);
    }
  }

  // Loss streak tick guard (if realized pnl delta keeps dropping, cool down one window).
  const prevQuality = policyState?.lastQuality || null;
  const realizedDelta = prevQuality ? (realizedPnlKrw - n(prevQuality.realizedPnlKrw, 0)) : 0;
  let lossStreakTicks = n(dayStateBase.lossStreakTicks, 0);
  if (realizedDelta < 0) lossStreakTicks += 1;
  else if (realizedDelta > 0) lossStreakTicks = 0;
  if (lossStreakTicks >= 2) {
    attempts = 1;
    gateReasons.push('loss_streak_cooldown');
  }

  // Keep total symbol list and per-window execution count decoupled for safety.
  maxSymbols = clamp(maxSymbols, 3, 5);
  order = Math.max(order, MIN_SELLABLE_ORDER_KRW);

  // Final buy-sellability guard: never buy if available KRW cannot support sellable order size.
  if (allowBuy && krw < (order + CASH_RESERVE_KRW)) {
    allowBuy = false;
    gateReasons.push('final_sellability_block_buy');
  }

  runtime.version = 1;
  runtime.updatedAt = new Date().toISOString();
  runtime.execution = {
    orderAmountKrw: order,
    symbols,
    maxSymbolsPerWindow: maxSymbols,
    maxOrderAttemptsPerWindow: attempts,
  };
  runtime.decision = {
    mode: 'filter',
    allowBuy,
    allowSell: true,
    forceAction: null,
    forceAmountKrw: null,
    forceOnce: true,
    symbols: {},
  };
  runtime.overlay = {
    multiplier,
    regime,
    score: Number((m.avg / 10).toFixed(2)),
    note: `${runtime.updatedAt} adaptive tick: tone=${m.tone}, avg=${m.avg.toFixed(2)}, attempted=${attempted}, successRate=${(successRate * 100).toFixed(1)}%, rejectRate=${(rejectRate * 100).toFixed(1)}%, tradeCount=${tradeCount}, expectancyKrw=${Math.round(expectancyKrw)}, feeKrw=${Math.round(totalFeeKrw)}, realizedPnlKrw=${Math.round(realizedPnlKrw)}, krw=${Math.round(krw)}, cashRejects=${cashRejects}, duplicateRejects=${duplicateRejects}, reasons=${gateReasons.join('|')}, symbols=${symbols.join(',')}`,
  };
  runtime.controls = { killSwitch: false };

  const nextComparable = snapshotForCompare(runtime);
  const changed = prevComparable !== nextComparable;

  const minObserveMs = Math.max(600000, n(runtime.execution?.windowSec, 300) * 1000 * 2); // >=10m or 2 windows
  const lastAppliedAtMs = n(policyState?.lastAppliedAtMs, 0);
  const elapsedMs = lastAppliedAtMs > 0 ? nowMs - lastAppliedAtMs : Number.POSITIVE_INFINITY;
  const tightening = isTightening(readJson(RUNTIME, {}), runtime);
  const dayState = policyState?.day === today
    ? { day: today, applyCount: n(policyState?.applyCount, 0) }
    : { day: today, applyCount: 0 };

  let throttled = false;
  const dailyLimit = 8;

  const aiSettings = readJson(AI_SETTINGS, {});
  const runtimePolicyComparable = extractPolicyComparable(runtime);
  const aiPolicyComparable = extractPolicyComparable(aiSettings);
  const runtimePolicyHash = policyHash(runtimePolicyComparable);
  const aiPolicyHash = policyHash(aiPolicyComparable);
  const settingsDrift = runtimePolicyHash !== aiPolicyHash;

  if (changed) {
    if (!tightening && elapsedMs < minObserveMs) {
      throttled = true;
    }
    if (!tightening && dayState.applyCount >= dailyLimit) {
      throttled = true;
    }
  }

  const shouldApplyRuntime = changed && !throttled;
  const shouldSyncSettings = shouldApplyRuntime || (!changed && settingsDrift);

  if (shouldApplyRuntime) {
    writeJson(RUNTIME, runtime);
    execSync(`${ROOT}/scripts/run-optimize-cron.sh`, { stdio: 'ignore' });
  }

  if (shouldSyncSettings) {
    const nextSettings = {
      ...(aiSettings && typeof aiSettings === 'object' ? aiSettings : {}),
      version: 1,
      updatedAt: new Date().toISOString(),
      execution: {
        ...(aiSettings?.execution || {}),
        ...runtime.execution,
        enabled: true,
        symbol: Array.isArray(runtime.execution?.symbols) && runtime.execution.symbols.length > 0
          ? runtime.execution.symbols[0]
          : (aiSettings?.execution?.symbol || 'BTC_KRW'),
      },
      decision: {
        ...(aiSettings?.decision || {}),
        ...runtime.decision,
      },
      overlay: {
        ...(aiSettings?.overlay || {}),
        ...runtime.overlay,
      },
      controls: {
        ...(aiSettings?.controls || {}),
        ...runtime.controls,
      },
    };
    writeJsonAtomic(AI_SETTINGS, nextSettings);
    execSync('pm2 restart buycoin', { stdio: 'ignore' });
  }

  const qualitySnapshot = buildQualitySnapshot({
    attempted,
    successful,
    rejected,
    tradeCount,
    expectancyKrw,
    realizedPnlKrw,
    totalFeeKrw,
  });
  const previousQuality = policyState?.lastQuality || null;
  const qualityDelta = buildQualityDelta(previousQuality, qualitySnapshot);

  const lockTriggered = dayPnlPct >= 5.0;

  writeJson(POLICY_STATE, {
    day: today,
    applyCount: shouldApplyRuntime ? (dayState.applyCount + 1) : dayState.applyCount,
    lastAppliedAtMs: shouldApplyRuntime ? nowMs : lastAppliedAtMs,
    dayStartEquityKrw,
    dayPeakEquityKrw,
    dayPnlPct,
    dayFromPeakPct,
    lockTriggered,
    lossStreakTicks,
    policyHash: runtimePolicyHash,
    aiPolicyHash,
    gateReasons,
    lastQuality: qualitySnapshot,
  });

  writeJson(QUALITY_COMPARE, {
    sampledAt: qualitySnapshot.sampledAt,
    policyHash: runtimePolicyHash,
    previous: previousQuality,
    current: qualitySnapshot,
    delta: qualityDelta,
    gateReasons,
  });

  const stability = stabilitySnapshot(state, settingsDrift);
  writeJson(STABILITY_MONITOR, {
    ...stability,
    policyHash: runtimePolicyHash,
    settingsPolicyHash: aiPolicyHash,
  });

  process.stdout.write(JSON.stringify({
    ok: true,
    changed,
    throttled,
    settingsDrift,
    syncedSettings: shouldSyncSettings,
    policyHash: runtimePolicyHash,
    settingsPolicyHash: aiPolicyHash,
    qualityDelta,
    gateReasons,
    stability,
    equityKrw,
    dayPnlPct,
    dayFromPeakPct,
    tone: m.tone,
    attempted,
    successful,
    rejected,
    successRate,
    rejectRate,
    applied: runtime.execution,
  }, null, 2));
}

main();
