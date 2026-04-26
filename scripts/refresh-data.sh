#!/usr/bin/env bash
set -euo pipefail

WORKSPACE="${OPENCLAW_WORKSPACE:-/home/deck/.openclaw/workspace}"
APP_DIR="${ONE_PIECE_SNIPER_TEST_DIR:-$WORKSPACE/one-piece-sniper-test}"
DATA_DIR="$APP_DIR/data"
NODE_BIN="${NODE_BIN:-/home/deck/.nvm/versions/node/v24.15.0/bin/node}"
export PATH="$(dirname "$NODE_BIN"):${PATH:-/usr/bin:/bin}"
STATE_DIR="$APP_DIR/state"
LOG_DIR="$APP_DIR/logs"
LOCK_DIR="$STATE_DIR/refresh.lock"
STATUS_PATH="$DATA_DIR/refresh-status.json"
LOG_PATH="$LOG_DIR/refresh.log"
AUTO_PUSH_TO_GITHUB="${AUTO_PUSH_TO_GITHUB:-1}"
GIT_REMOTE_NAME="${GIT_REMOTE_NAME:-origin}"
GIT_BRANCH_NAME="${GIT_BRANCH_NAME:-main}"
SSH_KEY_PATH="${SSH_KEY_PATH:-$HOME/.ssh/id_ed25519_sniper_test}"
export GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -i $SSH_KEY_PATH -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes}"

export OPENCLAW_WORKSPACE="$WORKSPACE"
export ONE_PIECE_DASHBOARD_DIR="$DATA_DIR"
export NO_DASHBOARD_GIT=1
export SKIP_GIT_PUSH=1

mkdir -p "$DATA_DIR" "$STATE_DIR" "$LOG_DIR"

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "Refresh already running; lock exists at $LOCK_DIR" >&2
  exit 17
fi

STARTED_AT="$(date -Iseconds)"
cleanup() {
  local exit_code=$?
  local finished_at
  finished_at="$(date -Iseconds)"
  STARTED_AT="$STARTED_AT" \
  FINISHED_AT="$finished_at" \
  EXIT_CODE="$exit_code" \
  DATA_DIR="$DATA_DIR" \
  LOG_PATH="$LOG_PATH" \
  STATUS_PATH="$STATUS_PATH" \
  python3 - <<'PY'
import json
import os
from pathlib import Path
exit_code = int(os.environ['EXIT_CODE'])
payload = {
  "startedAt": os.environ['STARTED_AT'],
  "finishedAt": os.environ['FINISHED_AT'],
  "ok": exit_code == 0,
  "exitCode": exit_code,
  "dataDir": os.environ['DATA_DIR'],
  "logPath": os.environ['LOG_PATH'],
}
Path(os.environ['STATUS_PATH']).write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
PY
  rmdir "$LOCK_DIR" 2>/dev/null || true
}
trap cleanup EXIT

{
  echo "[$(date -Iseconds)] Refresh start"
  cd "$WORKSPACE"
  "$NODE_BIN" "$WORKSPACE/scanners/one-piece/weekly-pricecharting-psa10-report-v1.mjs"
  "$NODE_BIN" "$WORKSPACE/scanners/one-piece/generate-trade-plan.mjs"
  "$NODE_BIN" "$WORKSPACE/scanners/one-piece-lots/ebay-one-piece-lot-scan.mjs"
  cp "$WORKSPACE/reports/one-piece-lots/app-ready.json" "$DATA_DIR/app-ready.json"

  if [[ "$AUTO_PUSH_TO_GITHUB" == "1" ]]; then
    cd "$APP_DIR"
    git add data/latest.json data/latest-v2.json data/weekly-base.json data/trade-plan.json data/app-ready.json
    if ! git diff --cached --quiet; then
      git commit -m "Refresh sniper test data $(date +%F' '%H:%M)"
      git pull --rebase "$GIT_REMOTE_NAME" "$GIT_BRANCH_NAME"
      git push "$GIT_REMOTE_NAME" "$GIT_BRANCH_NAME"
      echo "[$(date -Iseconds)] Git push complete"
    else
      echo "[$(date -Iseconds)] No Git-tracked data changes to push"
    fi
  else
    echo "[$(date -Iseconds)] AUTO_PUSH_TO_GITHUB disabled"
  fi

  echo "[$(date -Iseconds)] Refresh complete"
} >> "$LOG_PATH" 2>&1

echo "Independent sniper test data refreshed into $DATA_DIR"
