#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${ONE_PIECE_SNIPER_TEST_DIR:-/home/deck/.openclaw/workspace/one-piece-sniper-test}"
UNIT_SRC="$APP_DIR/systemd"
UNIT_DST="$HOME/.config/systemd/user"

mkdir -p "$UNIT_DST"
cp "$UNIT_SRC"/*.service "$UNIT_SRC"/*.timer "$UNIT_DST"/
systemctl --user daemon-reload
systemctl --user enable --now one-piece-sniper-test-web.service
systemctl --user enable --now one-piece-sniper-test-refresh.timer
systemctl --user start one-piece-sniper-test-refresh.service

echo "Installed user services to $UNIT_DST"
systemctl --user --no-pager --full status one-piece-sniper-test-web.service one-piece-sniper-test-refresh.timer --lines=0 || true
