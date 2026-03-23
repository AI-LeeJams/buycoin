#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="/Users/leejam/buycoin"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
LOCK_DIR="$ROOT_DIR/.trader/.optimize-lock"
LOG_DIR="$ROOT_DIR/.trader/cron-logs"
NOW="$(date -u +"%Y%m%d-%H%M%S")"
LOG_FILE="$LOG_DIR/optimizer-$NOW.log"
DIAG_FILE="$ROOT_DIR/.trader/operator-diagnostics.jsonl"

mkdir -p "$LOG_DIR"

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] skip: optimizer already running"
  exit 0
fi
trap 'rmdir "$LOCK_DIR"' EXIT

cd "$ROOT_DIR"
{
  echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] start adaptive-policy-tick(pre)"
  set +e
  "$NODE_BIN" ./scripts/adaptive_policy_tick.cjs
  pre_tick_status=$?
  set -e
  echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] end adaptive-policy-tick(pre) exit=${pre_tick_status}"

  echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] start optimize"
  set +e
  "$NODE_BIN" ./src/app/optimize.js
  status=$?
  set -e
  echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] end optimize exit=${status}"

  echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] start adaptive-policy-tick(post-verify)"
  set +e
  tick_json=$("$NODE_BIN" ./scripts/adaptive_policy_tick.cjs)
  post_tick_status=$?
  set -e
  echo "$tick_json"
  echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] end adaptive-policy-tick(post-verify) exit=${post_tick_status}"

  drift=$(
    TICK_JSON="$tick_json" python3 - <<'PY'
import json, os
raw=os.environ.get('TICK_JSON','{}')
try:
    d=json.loads(raw)
    print('1' if d.get('settingsDrift') else '0')
except Exception:
    print('1')
PY
  )

  if [ "$drift" = "1" ]; then
    echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] post-verify drift detected, re-running tick once"
    set +e
    retry_json=$("$NODE_BIN" ./scripts/adaptive_policy_tick.cjs)
    retry_status=$?
    set -e
    echo "$retry_json"
    echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] retry adaptive-policy-tick exit=${retry_status}"
  fi

  echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] write operator diagnostic snapshot"
  TICK_JSON="$tick_json" ROOT_DIR="$ROOT_DIR" python3 - <<'PY'
import json, os, pathlib, datetime
root = pathlib.Path(os.environ.get('ROOT_DIR', '.'))
tick_raw = os.environ.get('TICK_JSON', '{}')
try:
    tick = json.loads(tick_raw)
except Exception:
    tick = {}

def read_json(path, default):
    try:
        return json.loads(path.read_text())
    except Exception:
        return default

state = read_json(root / '.trader' / 'state.json', {})
stable = read_json(root / '.trader' / 'stability-monitor.json', {})

risk_events = state.get('riskEvents') or []
reject_counts = {}
for ev in risk_events[-300:]:
    if ev.get('type') != 'order_rejected':
        continue
    reasons = ev.get('reasons') or []
    if reasons:
        for r in reasons:
            key = str((r.get('rule') or 'unknown')).upper()
            reject_counts[key] = reject_counts.get(key, 0) + 1
    else:
        key = str((ev.get('reason') or 'unknown')).upper()
        reject_counts[key] = reject_counts.get(key, 0) + 1

reject_top = sorted(reject_counts.items(), key=lambda x: x[1], reverse=True)[:5]

payload = {
    'ts': datetime.datetime.utcnow().replace(microsecond=0).isoformat() + 'Z',
    'policyHash': tick.get('policyHash'),
    'settingsPolicyHash': tick.get('settingsPolicyHash'),
    'settingsDrift': tick.get('settingsDrift'),
    'attempted': tick.get('attempted'),
    'successful': tick.get('successful'),
    'rejected': tick.get('rejected'),
    'successRate': tick.get('successRate'),
    'rejectRate': tick.get('rejectRate'),
    'equityKrw': tick.get('equityKrw'),
    'dayPnlPct': tick.get('dayPnlPct'),
    'gateReasons': tick.get('gateReasons') or [],
    'applied': tick.get('applied') or {},
    'stability': {
        'duplicateGuardHits': (stable or {}).get('duplicateGuardHits'),
        'killSwitch': (stable or {}).get('killSwitch'),
    },
    'rejectTop': reject_top,
}

out = root / '.trader' / 'operator-diagnostics.jsonl'
out.parent.mkdir(parents=True, exist_ok=True)
with out.open('a', encoding='utf-8') as f:
    f.write(json.dumps(payload, ensure_ascii=False) + '\n')
print(json.dumps({'diagnostic_written': str(out)}))
PY
} >> "$LOG_FILE" 2>&1
exit "$status"
