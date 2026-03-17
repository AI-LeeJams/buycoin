#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="/Users/leejam/buycoin"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
LOCK_DIR="$ROOT_DIR/.trader/.optimize-lock"
LOG_DIR="$ROOT_DIR/.trader/cron-logs"
NOW="$(date -u +"%Y%m%d-%H%M%S")"
LOG_FILE="$LOG_DIR/optimizer-$NOW.log"

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
} >> "$LOG_FILE" 2>&1
exit "$status"
