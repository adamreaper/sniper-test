#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${ONE_PIECE_SNIPER_TEST_DIR:-$(cd -- "$SCRIPT_DIR/.." && pwd)}"
DATA_DIR="$APP_DIR/data"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
if [[ -z "$NODE_BIN" ]]; then
  echo "node not found in PATH; set NODE_BIN explicitly" >&2
  exit 2
fi
export PATH="$(dirname "$NODE_BIN"):${PATH:-/usr/bin:/bin}"
STATE_DIR="$APP_DIR/state"
LOG_DIR="$APP_DIR/logs"
LEGACY_LOCK_DIR="$STATE_DIR/refresh.lock"
LOCK_FILE="$STATE_DIR/refresh.lockfile"
STATUS_PATH="$DATA_DIR/refresh-status.json"
LOG_PATH="$LOG_DIR/refresh.log"
AUTO_PUSH_TO_GITHUB="${AUTO_PUSH_TO_GITHUB:-1}"
GIT_REMOTE_NAME="${GIT_REMOTE_NAME:-origin}"
GIT_BRANCH_NAME="${GIT_BRANCH_NAME:-main}"
SSH_KEY_PATH="${SSH_KEY_PATH:-$HOME/.ssh/id_ed25519_sniper_test}"
export GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -i $SSH_KEY_PATH -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes}"
PUBLISH_PATHS=(
  data/latest.json
  data/latest-v2.json
  data/weekly-base.json
  data/trade-plan.json
  data/signal-outcomes.json
  data/app-ready.json
  scripts/generate-trade-plan.mjs
  scripts/refresh-data.sh
  scripts/serve-static.mjs
  scripts/install-user-services.sh
  scripts/vendor
  index.html
  INDEPENDENT_SETUP.md
  manifest.webmanifest
  assets
)
TEMP_STASH_REF=""

export ONE_PIECE_SNIPER_TEST_DIR="$APP_DIR"
export ONE_PIECE_DASHBOARD_DIR="$DATA_DIR"
export NO_DASHBOARD_GIT=1
export SKIP_GIT_PUSH=1

SINGLES_SCRIPT="${ONE_PIECE_SINGLES_SCRIPT:-$APP_DIR/scripts/vendor/one-piece/weekly-pricecharting-psa10-report-v1.mjs}"
LOTS_SCRIPT="${ONE_PIECE_LOTS_SCRIPT:-$APP_DIR/scripts/vendor/one-piece-lots/ebay-one-piece-lot-scan.mjs}"
LOTS_APP_READY_PATH="${ONE_PIECE_LOTS_APP_READY_PATH:-$APP_DIR/reports/one-piece-lots/app-ready.json}"

mkdir -p "$DATA_DIR" "$STATE_DIR" "$LOG_DIR"

if [[ -d "$LEGACY_LOCK_DIR" ]]; then
  rmdir "$LEGACY_LOCK_DIR" 2>/dev/null || true
fi

exec {LOCK_FD}>"$LOCK_FILE"
if ! flock -n "$LOCK_FD"; then
  echo "Refresh already running; lock held at $LOCK_FILE" >&2
  exit 17
fi

STARTED_AT="$(date -Iseconds)"
cleanup() {
  local exit_code=$?
  local finished_at
  finished_at="$(date -Iseconds)"

  if [[ -n "$TEMP_STASH_REF" ]]; then
    if git -C "$APP_DIR" stash pop --index --quiet "$TEMP_STASH_REF"; then
      echo "[$finished_at] Restored temporary git stash $TEMP_STASH_REF" >> "$LOG_PATH" 2>&1 || true
    else
      echo "[$finished_at] WARNING: failed to restore temporary git stash $TEMP_STASH_REF" >> "$LOG_PATH" 2>&1 || true
    fi
  fi

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
}
trap cleanup EXIT

{
  echo "[$(date -Iseconds)] Refresh start"
  cd "$APP_DIR"
  "$NODE_BIN" "$SINGLES_SCRIPT"
  "$NODE_BIN" "$APP_DIR/scripts/generate-trade-plan.mjs"
  "$NODE_BIN" "$LOTS_SCRIPT"
  cp "$LOTS_APP_READY_PATH" "$DATA_DIR/app-ready.json"

  if [[ "$AUTO_PUSH_TO_GITHUB" == "1" ]]; then
    cd "$APP_DIR"
    git add "${PUBLISH_PATHS[@]}"
    if ! git diff --cached --quiet; then
      git commit -m "Refresh sniper test data $(date +%F' '%H:%M)"

      if ! git diff --quiet || [[ -n "$(git ls-files --others --exclude-standard)" ]]; then
        git stash push --include-untracked --message "sniper-test-refresh-temp-$(date +%s)" >/dev/null
        TEMP_STASH_REF="stash@{0}"
        echo "[$(date -Iseconds)] Temporarily stashed non-publish changes before sync"
      fi

      git pull --rebase "$GIT_REMOTE_NAME" "$GIT_BRANCH_NAME"
      git push "$GIT_REMOTE_NAME" "$GIT_BRANCH_NAME"
      echo "[$(date -Iseconds)] Git push complete"
    else
      echo "[$(date -Iseconds)] No publishable board changes to push"
    fi
  else
    echo "[$(date -Iseconds)] AUTO_PUSH_TO_GITHUB disabled"
  fi

  echo "[$(date -Iseconds)] Refresh complete"
} >> "$LOG_PATH" 2>&1

echo "Independent sniper test data refreshed into $DATA_DIR"
