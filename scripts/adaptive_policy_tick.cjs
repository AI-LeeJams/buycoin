#!/usr/bin/env node
const fs = require('fs');
const { execSync } = require('child_process');

const ROOT = '/Users/leejam/buycoin';
const TRADER = `${ROOT}/.trader`;
const RUNTIME = `${TRADER}/ai-runtime.json`;
const KPI = `${TRADER}/execution-kpi-summary.json`;
const UNIVERSE = `${TRADER}/market-universe.json`;

function readJson(p, fallback = null) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function writeJson(p, obj) { fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n'); }
function n(v, d = 0) { const x = Number(v); return Number.isFinite(x) ? x : d; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function getMarketTone(universe) {
  const cs = Array.isArray(universe?.candidates) ? universe.candidates : [];
  if (!cs.length) return { tone: 'neutral', avg: 0, up: 0, down: 0 };
  const ch = cs.map(c => n(c.change24hPct, n(c.changePct24h, n(c.signedChangeRate, 0) * 100)));
  const avg = ch.reduce((a, b) => a + b, 0) / ch.length;
  const up = ch.filter(x => x > 0.4).length;
  const down = ch.filter(x => x < -0.4).length;
  const tone = avg >= 1.2 && up > down ? 'risk_on' : avg <= -1.0 && down > up ? 'risk_off' : 'neutral';
  return { tone, avg, up, down };
}

function main() {
  const runtime = readJson(RUNTIME, {});
  const kpi = readJson(KPI, {});
  const universe = readJson(UNIVERSE, {});

  const s = kpi?.summary || {};
  const attempted = n(s?.orders?.attempted, 0);
  const successful = n(s?.orders?.successful, 0);
  const rejected = Math.max(0, attempted - successful);
  const successRate = attempted > 0 ? successful / attempted : 0;
  const rejectRate = attempted > 0 ? rejected / attempted : 0;

  const m = getMarketTone(universe);

  // base profile by market tone
  let symbols = ['BTC_KRW', 'ETH_KRW', 'XRP_KRW', 'SOL_KRW'];
  let attempts = 2;
  let maxSymbols = 4;
  let order = 20000;
  let multiplier = 0.95;
  let allowBuy = true;
  let regime = 'neutral';

  if (m.tone === 'risk_on') {
    symbols = ['BTC_KRW', 'ETH_KRW', 'XRP_KRW', 'SOL_KRW'];
    attempts = 3;
    maxSymbols = 4;
    order = 20000;
    multiplier = 1.0;
    regime = 'risk_on';
  } else if (m.tone === 'risk_off') {
    symbols = ['BTC_KRW', 'ETH_KRW', 'XRP_KRW'];
    attempts = 1;
    maxSymbols = 3;
    order = 10000;
    multiplier = 0.8;
    regime = 'risk_off';
  }

  // execution quality feedback
  if (attempted === 0) {
    // not trading at all -> open path a bit
    attempts = Math.max(attempts, 3);
    allowBuy = true;
    multiplier = Math.max(multiplier, 0.95);
  }

  if (attempted > 0 && rejectRate > 0.6) {
    // too many rejects -> reduce attempts and size
    attempts = Math.max(1, attempts - 1);
    order = 10000;
  }

  if (attempted > 0 && successRate >= 0.5 && m.tone === 'risk_on') {
    // good fill quality in bullish regime
    order = 20000;
    attempts = clamp(attempts, 2, 3);
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
    note: `${runtime.updatedAt} adaptive tick: tone=${m.tone}, avg=${m.avg.toFixed(2)}, attempted=${attempted}, successRate=${(successRate*100).toFixed(1)}%, rejectRate=${(rejectRate*100).toFixed(1)}%`,
  };
  runtime.controls = { killSwitch: false };

  writeJson(RUNTIME, runtime);

  // apply
  execSync(`${ROOT}/scripts/run-optimize-cron.sh`, { stdio: 'ignore' });
  execSync('pm2 restart buycoin', { stdio: 'ignore' });

  process.stdout.write(JSON.stringify({ ok: true, tone: m.tone, attempted, successful, rejected, successRate, rejectRate, applied: runtime.execution }, null, 2));
}

main();
