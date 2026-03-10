#!/usr/bin/env node
const fs = require('fs');
const { execSync } = require('child_process');

const ROOT = '/Users/leejam/buycoin';
const TRADER = `${ROOT}/.trader`;
const RUNTIME = `${TRADER}/ai-runtime.json`;
const KPI = `${TRADER}/execution-kpi-summary.json`;
const UNIVERSE = `${TRADER}/market-universe.json`;
const STATE = `${TRADER}/state.json`;
const POLICY_STATE = `${TRADER}/adaptive-policy-state.json`;

const CORE = ['BTC_KRW', 'ETH_KRW', 'XRP_KRW', 'SOL_KRW'];
const BLACKLIST = new Set(['ENSO_KRW', 'USDT_KRW']);

function readJson(p, fallback = null) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function writeJson(p, obj) { fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n'); }
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
    .slice(0, 4);

  const symbols = [...CORE, ...extras];
  return symbols.slice(0, 8);
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

function recentCashRejectCount(state, limit = 120) {
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

function main() {
  const runtime = readJson(RUNTIME, {});
  const prevComparable = snapshotForCompare(runtime || {});

  const kpi = readJson(KPI, {});
  const universe = readJson(UNIVERSE, {});
  const state = readJson(STATE, {});

  const s = kpi?.summary || {};
  const attempted = n(s?.orders?.attempted, 0);
  const successful = n(s?.orders?.successful, 0);
  const rejected = Math.max(0, attempted - successful);
  const successRate = attempted > 0 ? successful / attempted : 0;
  const rejectRate = attempted > 0 ? rejected / attempted : 0;

  const m = getMarketTone(universe);
  const base = pickConfigByTone(m.tone);

  let symbols = buildUniversePicks(universe, m.tone);
  let attempts = base.attempts;
  let maxSymbols = base.maxSymbols;
  let order = base.order;
  let multiplier = base.multiplier;
  let allowBuy = true;
  const regime = base.regime;

  if (attempted === 0) {
    attempts = Math.max(attempts, 3);
    maxSymbols = Math.max(maxSymbols, 4);
    multiplier = Math.max(multiplier, 0.95);
  }

  if (attempted > 0 && rejectRate > 0.6) {
    attempts = Math.max(1, attempts - 1);
    order = 10000;
  }

  if (attempted > 0 && successRate >= 0.5 && m.tone === 'risk_on') {
    order = 20000;
    attempts = clamp(attempts, 2, 3);
  }

  // Cash-aware safety: prevent repeated insufficient-cash loops.
  const krw = krwBalance(state);
  const cashRejects = recentCashRejectCount(state, 120);
  if (krw < 30000 || cashRejects >= 8) {
    order = 10000;
    attempts = 1;
    maxSymbols = 3;
    allowBuy = false;
  }

  // Keep total symbol list and per-window execution count decoupled for safety.
  maxSymbols = clamp(maxSymbols, 3, 5);

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
    note: `${runtime.updatedAt} adaptive tick: tone=${m.tone}, avg=${m.avg.toFixed(2)}, attempted=${attempted}, successRate=${(successRate * 100).toFixed(1)}%, rejectRate=${(rejectRate * 100).toFixed(1)}%, krw=${Math.round(krw)}, cashRejects=${cashRejects}, symbols=${symbols.join(',')}`,
  };
  runtime.controls = { killSwitch: false };

  const nextComparable = snapshotForCompare(runtime);
  const changed = prevComparable !== nextComparable;

  const policyState = readJson(POLICY_STATE, {});
  const nowMs = Date.now();
  const today = ymd(new Date());
  const minObserveMs = Math.max(600000, n(runtime.execution?.windowSec, 300) * 1000 * 2); // >=10m or 2 windows
  const lastAppliedAtMs = n(policyState?.lastAppliedAtMs, 0);
  const elapsedMs = lastAppliedAtMs > 0 ? nowMs - lastAppliedAtMs : Number.POSITIVE_INFINITY;
  const tightening = isTightening(readJson(RUNTIME, {}), runtime);
  const dayState = policyState?.day === today
    ? { day: today, applyCount: n(policyState?.applyCount, 0) }
    : { day: today, applyCount: 0 };

  let throttled = false;
  const dailyLimit = 8;

  if (changed) {
    if (!tightening && elapsedMs < minObserveMs) {
      throttled = true;
    }
    if (!tightening && dayState.applyCount >= dailyLimit) {
      throttled = true;
    }

    if (!throttled) {
      writeJson(RUNTIME, runtime);
      execSync(`${ROOT}/scripts/run-optimize-cron.sh`, { stdio: 'ignore' });
      execSync('pm2 restart buycoin', { stdio: 'ignore' });
      writeJson(POLICY_STATE, {
        day: today,
        applyCount: dayState.applyCount + 1,
        lastAppliedAtMs: nowMs,
      });
    }
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    changed,
    throttled,
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
