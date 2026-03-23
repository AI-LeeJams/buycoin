/* global console */
const fs = require('fs');
const { execSync } = require('child_process');

const RUNTIME_PATH = '.trader/ai-runtime.json';
const SETTINGS_PATH = '.trader/ai-settings.json';
const REPORT_PATH = '.trader/execution-kpi-report.jsonl';
const SUMMARY_PATH = '.trader/execution-kpi-summary.json';
const NOTE_PATH = '.trader/hotfix-2h-note.log';
const stamp = new Date().toISOString().replace(/[:.]/g,'').slice(0,15);
const FINAL_REPORT_PATH = `.trader/hotfix-2h-final-report-${stamp}.md`;

function now(){ return new Date().toISOString(); }
function kst(){ return new Date().toLocaleString('sv-SE',{timeZone:'Asia/Seoul'}).replace(' ','T') + '+09:00'; }
function readJson(path){ return JSON.parse(fs.readFileSync(path,'utf8')); }
function writeJson(path,obj){ fs.writeFileSync(path, JSON.stringify(obj,null,2)+'\n'); }
function appendNote(text){ fs.appendFileSync(NOTE_PATH, `[${kst()}] ${text}\n`); }
function sh(cmd){ return execSync(cmd,{encoding:'utf8',stdio:['ignore','pipe','pipe']}); }

function ensurePm2Online(){
  try {
    const list = JSON.parse(sh('pm2 jlist'));
    const p = list.find(x=>x.name==='buycoin');
    if (!p) { appendNote('WARN buycoin process missing in PM2 list'); return 'missing'; }
    const st = p.pm2_env?.status || 'unknown';
    if (st !== 'online') {
      appendNote(`WARN PM2 status=${st}, restart buycoin`);
      try {
        sh('pm2 restart buycoin');
      } catch (restartError) {
        appendNote(`ERROR pm2 restart failed: ${restartError.message}`);
      }
    }
    return st;
  } catch(e){ appendNote(`WARN pm2 check failed: ${e.message}`); return 'error'; }
}

function enforceDefaults(){
  const j = readJson(RUNTIME_PATH);
  j.execution = j.execution || {};
  j.execution.symbols = ['BTC_KRW','XRP_KRW','ETH_KRW','SOL_KRW'];
  j.execution.maxSymbolsPerWindow = 4;
  if (typeof j.execution.maxOrderAttemptsPerWindow !== 'number') j.execution.maxOrderAttemptsPerWindow = 3;
  j.decision = j.decision || {};
  j.decision.allowBuy = true;
  j.decision.allowSell = true;
  j.controls = j.controls || {};
  j.controls.killSwitch = false;
  j.updatedAt = now();
  writeJson(RUNTIME_PATH, j);
  appendNote('INIT defaults enforced (symbols 4종, attempts>=1 baseline=3, allowBuy/allowSell=true, killSwitch=false)');
}

function applyRule1(){
  const s = readJson(SETTINGS_PATH);
  const before = s?.strategy?.momentumEntryBps;
  if (typeof before === 'number') {
    const next = Math.max(2, before - 1);
    s.strategy.momentumEntryBps = next;
    s.updatedAt = now();
    writeJson(SETTINGS_PATH,s);
    appendNote(`RULE1 successful=0 2연속 -> momentumEntryBps ${before}=>${next}`);
  }
}

function applyRule2(){
  const r = readJson(RUNTIME_PATH);
  const before = r.execution.maxOrderAttemptsPerWindow ?? 3;
  r.execution.maxOrderAttemptsPerWindow = Math.max(1, before - 1);
  r.controls = r.controls || {}; r.controls.killSwitch = false; r.updatedAt = now();
  writeJson(RUNTIME_PATH,r);

  const s = readJson(SETTINGS_PATH);
  const removed=[];
  function strip(o,p=''){
    if (!o || typeof o!=='object') return;
    for (const k of Object.keys(o)){
      const full=p?`${p}.${k}`:k;
      if (/reject/i.test(k)){ delete o[k]; removed.push(full); continue; }
      strip(o[k],full);
    }
  }
  strip(s);
  s.updatedAt = now();
  writeJson(SETTINGS_PATH,s);
  appendNote(`RULE2 reject율>50% 2연속 -> maxOrderAttemptsPerWindow ${before}=>${r.execution.maxOrderAttemptsPerWindow}, removedRejectKeys=${removed.join(',')||'none'}`);
}

function applyRule3(){
  const r = readJson(RUNTIME_PATH);
  r.overlay = r.overlay || {};
  const before = typeof r.overlay.multiplier==='number' ? r.overlay.multiplier : 1;
  const next = Math.max(0.4, +(before-0.1).toFixed(2));
  r.overlay.multiplier = next;
  r.decision = r.decision || {}; r.decision.allowBuy = true;
  r.controls = r.controls || {}; r.controls.killSwitch = false;
  r.updatedAt = now();
  writeJson(RUNTIME_PATH,r);
  appendNote(`RULE3 realizedPnL 악화 3연속 -> multiplier ${before}=>${next}`);
}

function main(){
  appendNote('START 2h hotfix watchdog (retro over latest 24 windows)');
  enforceDefaults();
  const pm2Status = ensurePm2Online();

  const lines = fs.readFileSync(REPORT_PATH,'utf8').trim().split(/\n+/).filter(Boolean);
  const last24 = lines.slice(-24).map(l=>JSON.parse(l));

  let zero=0, reject=0, pnlDown=0, prevPnl=null;
  const hist=[];
  for (const k of last24){
    const orders = k.summary?.orders || {};
    const realized = k.summary?.realized || {};
    const attempted = Number(orders.attempted||0);
    const successful = Number(orders.successful||0);
    const failed = Math.max(0, attempted-successful);
    const rejRate = attempted>0 ? failed/attempted : 0;
    const pnl = Number(realized.realizedPnlKrw||0);

    zero = (successful===0) ? zero+1 : 0;
    reject = (rejRate>0.5) ? reject+1 : 0;
    pnlDown = (prevPnl!==null && pnl<prevPnl) ? pnlDown+1 : 0;

    if (zero>=2){ applyRule1(); zero=0; }
    if (reject>=2){ applyRule2(); reject=0; }
    if (pnlDown>=3){ applyRule3(); pnlDown=0; }

    hist.push({w:k.window,attempted,successful,failed,rejRate,pnl,sampledAt:k.sampledAt});
    prevPnl = pnl;
  }

  const finalKpi = readJson(SUMMARY_PATH);
  const o = finalKpi.summary?.orders || {};
  const r = finalKpi.summary?.realized || {};
  const attempted=Number(o.attempted||0), successful=Number(o.successful||0), failed=Math.max(0,attempted-successful);
  const successRate = attempted? (successful/attempted*100).toFixed(1):'0.0';
  const failRate = attempted? (failed/attempted*100).toFixed(1):'0.0';
  const last3 = hist.slice(-3).map(x=>`- w${x.w} (${x.sampledAt}): 시도 ${x.attempted}, 성공 ${x.successful}, 실패 ${x.failed}, 손익 ${x.pnl}`).join('\n') || '- 데이터 없음';
  const market = readJson('.trader/market-universe.json');
  const xState = market?.meta?.updatedAt || market?.updatedAt || 'unknown';

  const report = `# buycoin 2시간 핫픽스 운용 최종 보고\n\n- 시각: ${kst()}\n- PM2 buycoin 상태: ${pm2Status}\n- 시장요약: BTC/XRP/ETH/SOL 4심볼 운용, 체결 회복 우선 핫픽스 모드\n- X수집상태: market-universe updatedAt=${xState}\n- 운용판단: killSwitch=false 유지, buy/sell 허용 유지\n\n## KPI\n- 시도/성공/실패: ${attempted}/${successful}/${failed}\n- 성공률/실패율: ${successRate}% / ${failRate}%\n- 기준손익(realizedPnlKrw): ${Number(r.realizedPnlKrw||0)}\n- 최근거래3건(윈도우):\n${last3}\n\n## 변경/근거\n- 상세 노트: ${NOTE_PATH}\n- 스냅샷: ${RUNTIME_PATH}, ${SETTINGS_PATH}, ${SUMMARY_PATH}\n`;
  fs.writeFileSync(FINAL_REPORT_PATH, report);
  appendNote(`END 2h hotfix watchdog complete. report=${FINAL_REPORT_PATH}`);
  console.log(FINAL_REPORT_PATH);
}

main();
