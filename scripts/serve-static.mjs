import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.ONE_PIECE_SNIPER_TEST_DIR || path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8787);
const DATA_DIR = path.join(ROOT, 'data');
const LOG_DIR = path.join(ROOT, 'logs');
const STATE_DIR = path.join(ROOT, 'state');
const REFRESH_SCRIPT = path.join(ROOT, 'scripts', 'refresh-data.sh');
const REFRESH_STATUS = path.join(DATA_DIR, 'refresh-status.json');
const REFRESH_LOCK = path.join(STATE_DIR, 'refresh.lockfile');
const SIGNAL_OUTCOMES = path.join(DATA_DIR, 'signal-outcomes.json');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
};

async function readJsonSafe(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

async function isRefreshRunning() {
  if (!(await exists(REFRESH_LOCK))) return false;
  const probe = spawnSync('bash', ['-lc', `exec 9>${shellQuote(REFRESH_LOCK)}; flock -n 9`], {
    stdio: 'ignore',
  });
  return probe.status !== 0;
}

function safePath(urlPath) {
  const clean = decodeURIComponent((urlPath || '/').split('?')[0]);
  const rel = clean === '/' ? 'index.html' : clean.replace(/^\/+/, '');
  const full = path.resolve(ROOT, rel);
  if (!full.startsWith(path.resolve(ROOT))) throw new Error('Forbidden');
  return full;
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload, null, 2));
}

async function refreshMeta() {
  const [status, latest, tradePlan, outcomes, refreshRunning] = await Promise.all([
    readJsonSafe(REFRESH_STATUS, {}),
    readJsonSafe(path.join(DATA_DIR, 'latest.json'), {}),
    readJsonSafe(path.join(DATA_DIR, 'trade-plan.json'), {}),
    readJsonSafe(SIGNAL_OUTCOMES, {}),
    isRefreshRunning(),
  ]);
  return {
    ok: Boolean(status?.ok ?? false),
    refreshRunning,
    lastRefresh: status || null,
    generatedAt: latest?.generatedAt || null,
    qualifiedCount: Number(latest?.qualifiedCount || 0),
    rowsWithEbayCandidates: Number(latest?.rowsWithEbayCandidates || 0),
    reviewRows: Array.isArray(tradePlan?.reviewQueue) ? tradePlan.reviewQueue.map((row) => row.code) : [],
    manualReviewCount: Number(tradePlan?.summary?.manualReviewCount || 0),
    reviewedCount: Array.isArray(outcomes?.entries) ? outcomes.entries.filter((entry) => entry.outcomeStatus && entry.outcomeStatus !== 'unreviewed').length : 0,
  };
}

function triggerRefresh() {
  const child = spawn('bash', [REFRESH_SCRIPT], {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      ONE_PIECE_SNIPER_TEST_DIR: ROOT,
      AUTO_PUSH_TO_GITHUB: '0',
    },
  });
  child.unref();
  return child.pid;
}

const server = http.createServer(async (req, res) => {
  try {
    const method = req.method || 'GET';
    const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);

    if (method === 'GET' && url.pathname === '/api/health') {
      return sendJson(res, 200, await refreshMeta());
    }

    if (method === 'GET' && url.pathname === '/api/refresh-status') {
      return sendJson(res, 200, await readJsonSafe(REFRESH_STATUS, { ok: false, missing: true }));
    }

    if ((method === 'POST' || method === 'GET') && url.pathname === '/api/refresh') {
      if (await isRefreshRunning()) {
        return sendJson(res, 409, {
          ok: false,
          message: 'Refresh already running',
          meta: await refreshMeta(),
        });
      }
      const pid = triggerRefresh();
      return sendJson(res, 202, {
        ok: true,
        message: 'Refresh started',
        pid,
        meta: await refreshMeta(),
      });
    }

    if (method === 'GET' && url.pathname === '/api/logs/refresh') {
      const logPath = path.join(LOG_DIR, 'refresh.log');
      const body = await fs.readFile(logPath, 'utf8').catch(() => 'No refresh log yet.');
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      return res.end(body);
    }

    if (method === 'GET' && url.pathname === '/api/signal-outcomes') {
      return sendJson(res, 200, await readJsonSafe(SIGNAL_OUTCOMES, { entries: [] }));
    }

    if (method === 'POST' && url.pathname === '/api/signal-outcomes') {
      const raw = await readBody(req);
      const payload = JSON.parse(raw || '{}');
      const current = await readJsonSafe(SIGNAL_OUTCOMES, { entries: [] });
      const currentEntries = Array.isArray(current?.entries) ? current.entries : [];
      const nextEntry = payload?.entry;
      if (!nextEntry?.code) return sendJson(res, 400, { ok: false, message: 'Missing entry.code' });
      const nextEntries = currentEntries.filter((entry) => entry.code !== nextEntry.code);
      nextEntries.push({
        ...nextEntry,
        lastReviewedAt: nextEntry.lastReviewedAt || new Date().toISOString(),
      });
      const nextPayload = {
        generatedAt: new Date().toISOString(),
        instructions: current?.instructions || {
          purpose: 'Manual review ledger for sniper-test signals.',
          outcomeStatusOptions: ['unreviewed', 'checked', 'bought', 'missed', 'rejected'],
          outcomeTagExamples: ['found_real_opportunity', 'overpriced', 'fake_spread', 'low_liquidity', 'not_clean_enough']
        },
        entries: nextEntries.sort((a, b) => String(a.code).localeCompare(String(b.code)))
      };
      await fs.writeFile(SIGNAL_OUTCOMES, `${JSON.stringify(nextPayload, null, 2)}\n`, 'utf8');
      return sendJson(res, 200, { ok: true, entry: nextEntry, reviewedCount: nextEntries.filter((entry) => entry.outcomeStatus && entry.outcomeStatus !== 'unreviewed').length });
    }

    const filePath = safePath(url.pathname);
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.json' ? 'no-store' : 'public, max-age=300',
    });
    res.end(data);
  } catch (error) {
    res.writeHead(error.message === 'Forbidden' ? 403 : 404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(error.message === 'Forbidden' ? 'Forbidden' : 'Not found');
  }
});

await fs.mkdir(DATA_DIR, { recursive: true });
await fs.mkdir(LOG_DIR, { recursive: true });
await fs.mkdir(STATE_DIR, { recursive: true });

server.listen(PORT, () => {
  console.log(`One Piece Sniper serving ${ROOT} on http://0.0.0.0:${PORT}`);
});
