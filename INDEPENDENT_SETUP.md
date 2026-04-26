# One Piece PSA 10 ROI Board Test

This copy is the independent version scaffold.

## What changed
- App name updated to `One Piece PSA 10 ROI Board Test`
- Frontend reads live data from `./data/` instead of repo-root JSON files
- Refresh flow can run without chat-agent involvement
- Git sync can be skipped entirely
- The copied `.git` folder and old root-level JSON payloads were moved into `archive/`

## Data flow
1. `scripts/refresh-data.sh`
   - runs the PriceCharting board refresh
   - runs the trade-plan generator
   - runs the lot scan
   - writes the app payloads into `one-piece-sniper-test/data/`
2. `scripts/serve-static.mjs`
   - serves the app locally on a port
   - serves JSON with `Cache-Control: no-store`
3. The app loads:
   - `data/latest.json`
   - `data/trade-plan.json`
   - `data/app-ready.json`

## Run it manually
```bash
bash /home/deck/.openclaw/workspace/one-piece-sniper-test/scripts/refresh-data.sh
node /home/deck/.openclaw/workspace/one-piece-sniper-test/scripts/serve-static.mjs
```
Then open:
- `http://localhost:8787`

## Local steady-state services
Install the user services:
```bash
bash /home/deck/.openclaw/workspace/one-piece-sniper-test/scripts/install-user-services.sh
```

That installs and starts:
- `one-piece-sniper-test-web.service`
- `one-piece-sniper-test-refresh.timer`
- `one-piece-sniper-test-refresh.service` (oneshot refresh job)

Current schedule:
- one full refresh every `1d` after the last successful run
- plus a boot catch-up after `5min`

Useful commands:
```bash
systemctl --user status one-piece-sniper-test-web.service
systemctl --user status one-piece-sniper-test-refresh.timer
journalctl --user -u one-piece-sniper-test-refresh.service -n 100 --no-pager
```

## Manual refresh endpoint
The local server exposes:
- `POST /api/refresh` — start a refresh in the background
- `GET /api/health` — app/runtime summary
- `GET /api/refresh-status` — last completed refresh payload
- `GET /api/logs/refresh` — refresh log output

The UI also has a `Refresh data` button wired to `POST /api/refresh`.

## GitHub auto-push
`refresh-data.sh` now auto-pushes refreshed data back to the repo by default after a successful run:
- `data/latest.json`
- `data/latest-v2.json`
- `data/weekly-base.json`
- `data/trade-plan.json`
- `data/app-ready.json`

You can disable that behavior by running with:
```bash
AUTO_PUSH_TO_GITHUB=0 bash /home/deck/.openclaw/workspace/one-piece-sniper-test/scripts/refresh-data.sh
```

## Run it without Jerome online
Use the installed systemd user timer, or fall back to cron if you prefer:
```bash
bash /home/deck/.openclaw/workspace/one-piece-sniper-test/scripts/refresh-data.sh
```
Example cron:
```cron
15 * * * * bash /home/deck/.openclaw/workspace/one-piece-sniper-test/scripts/refresh-data.sh >> /home/deck/.openclaw/workspace/logs/one-piece-sniper-test-refresh.log 2>&1
```

## Notes
- The refresh script sets `NO_DASHBOARD_GIT=1` and `SKIP_GIT_PUSH=1`, so it does not require repo pushes.
- The scanner code was updated so the dashboard output directory can be overridden with `ONE_PIECE_DASHBOARD_DIR`.
- If you later create a dedicated repo for this app, this copy is ready to be the base.
