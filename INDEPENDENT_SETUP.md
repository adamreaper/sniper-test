# One Piece Sniper

This copy is the independent official app scaffold.

## What changed
- App name updated to `One Piece Sniper`
- Frontend reads live data from `./data/` instead of repo-root JSON files
- Refresh flow can run without chat-agent involvement
- Git sync can be skipped entirely
- The copied `.git` folder and old root-level JSON payloads were moved into `archive/`
- Refresh now defaults to repo-local vendored scanner scripts under `scripts/vendor/`

## Data flow
1. `scripts/refresh-data.sh`
   - runs the PriceCharting board refresh
   - runs the trade-plan generator
   - runs the lot scan
   - writes the app payloads into `./data/`
2. `scripts/serve-static.mjs`
   - serves the app locally on a port
   - serves JSON with `Cache-Control: no-store`
3. The app loads:
   - `data/latest.json`
   - `data/trade-plan.json`
   - `data/app-ready.json`

Current board thresholds:
- raw floor: `none`
- ROI floor: `80%`
- minimum PSA 10 sales: `3`

## Run it manually
```bash
cd /path/to/one-piece-sniper-test
bash ./scripts/refresh-data.sh
node ./scripts/serve-static.mjs
```
Then open:
- `http://localhost:8787`

## Credentials
Put any needed API credentials in repo-local `.env.local` if you want the vendored helper scripts to use them.
That includes things like eBay and OpenAI keys used by the scanner helpers.

LLM photo scoring is now opt-in. To enable the OpenAI listing-photo pass, set:
```bash
ONE_PIECE_ENABLE_LLM_VISION=1
```
If you leave that flag unset, the scanner stays fully non-LLM for photo scoring even if an OpenAI key exists.

## Local steady-state services
Install the user services:
```bash
cd /path/to/one-piece-sniper-test
bash ./scripts/install-user-services.sh
```

That installs and starts:
- `one-piece-sniper-test-web.service`
- `one-piece-sniper-test-refresh.timer`
- `one-piece-sniper-test-refresh.service` (oneshot refresh job)

The service filenames stay on the legacy `sniper-test` naming for compatibility, but they now run the official app.

Current schedule:
- one full refresh every day at `5:45 AM`
- `Persistent=true` means if the machine was off at that time, systemd will run the missed refresh shortly after login/startup

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
`refresh-data.sh` auto-pushes refreshed data back to the repo by default after a successful run:
- `data/latest.json`
- `data/latest-v2.json`
- `data/weekly-base.json`
- `data/trade-plan.json`
- `data/app-ready.json`

You can disable that behavior by running with:
```bash
AUTO_PUSH_TO_GITHUB=0 bash ./scripts/refresh-data.sh
```

## Run it without Jerome online
Use the installed systemd user timer, or fall back to cron if you prefer:
```bash
bash ./scripts/refresh-data.sh
```
Example cron:
```cron
15 * * * * cd /path/to/one-piece-sniper-test && bash ./scripts/refresh-data.sh >> ./logs/one-piece-sniper-test-refresh.log 2>&1
```

## Notes
- The refresh script sets `NO_DASHBOARD_GIT=1` and `SKIP_GIT_PUSH=1`, so it does not require repo pushes inside the vendored scanner flow.
- The dashboard output directory can still be overridden with `ONE_PIECE_DASHBOARD_DIR`.
- If you later move this repo, the scripts now derive paths from the repo itself instead of assuming the OpenClaw workspace layout.
