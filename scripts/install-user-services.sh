#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${ONE_PIECE_SNIPER_TEST_DIR:-$(cd -- "$SCRIPT_DIR/.." && pwd)}"
UNIT_DST="$HOME/.config/systemd/user"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"

if [[ -z "$NODE_BIN" ]]; then
  echo "node not found in PATH; set NODE_BIN explicitly" >&2
  exit 2
fi

mkdir -p "$UNIT_DST"

cat > "$UNIT_DST/one-piece-sniper-test-web.service" <<EOF
[Unit]
Description=One Piece Sniper Test web app
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=ONE_PIECE_SNIPER_TEST_DIR=$APP_DIR
Environment=PORT=8787
WorkingDirectory=$APP_DIR
Environment=NODE_BIN=$NODE_BIN
Environment=PATH=$(dirname "$NODE_BIN"):/usr/bin:/bin
ExecStart=$NODE_BIN $APP_DIR/scripts/serve-static.mjs
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF

cat > "$UNIT_DST/one-piece-sniper-test-refresh.service" <<EOF
[Unit]
Description=Refresh One Piece Sniper Test data
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
Environment=ONE_PIECE_SNIPER_TEST_DIR=$APP_DIR
Environment=NODE_BIN=$NODE_BIN
Environment=PATH=$(dirname "$NODE_BIN"):/usr/bin:/bin
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/bash $APP_DIR/scripts/refresh-data.sh
EOF

cp "$APP_DIR/systemd/one-piece-sniper-test-refresh.timer" "$UNIT_DST/"
systemctl --user daemon-reload
systemctl --user enable --now one-piece-sniper-test-web.service
systemctl --user enable --now one-piece-sniper-test-refresh.timer
systemctl --user start one-piece-sniper-test-refresh.service

echo "Installed user services to $UNIT_DST"
systemctl --user --no-pager --full status one-piece-sniper-test-web.service one-piece-sniper-test-refresh.timer --lines=0 || true
