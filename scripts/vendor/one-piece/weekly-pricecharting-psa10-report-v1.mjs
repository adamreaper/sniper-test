import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { enrichRowsWithEbayCandidates } from './enrich-ebay-weekly-candidates.mjs';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = process.env.ONE_PIECE_SNIPER_TEST_DIR || path.resolve(__dirname, '..', '..', '..');
const SCANNER_DIR = __dirname;
const REPORT_DIR = path.join(APP_DIR, 'reports', 'one-piece-hybrid');
const DASHBOARD_DIR = process.env.ONE_PIECE_DASHBOARD_DIR || path.join(APP_DIR, 'data');
const DATE_STAMP = new Date().toISOString().slice(0, 10);
const RESULTS_JSON = path.join(REPORT_DIR, `pricecharting-psa10-scan-results-${DATE_STAMP}.json`);
const LLM_VISION_ENABLED = /^(1|true|yes|on)$/i.test(String(process.env.ONE_PIECE_ENABLE_LLM_VISION || process.env.ENABLE_LLM_VISION || ''));
const DASHBOARD_JSON = path.join(DASHBOARD_DIR, 'latest.json');
const DASHBOARD_TEST_JSON = path.join(DASHBOARD_DIR, 'latest-v2.json');
const WEEKLY_BASE_JSON = path.join(DASHBOARD_DIR, 'weekly-base.json');
const LIVE_BACKUP_JSON = path.join(DASHBOARD_DIR, 'latest.backup.json');
const SCAN_REPORT_MD = path.join(REPORT_DIR, `pricecharting-psa10-scan-results-${DATE_STAMP}.md`);
const EXCLUDED_SET_PATTERNS = [
  /extra-booster-anime-25th-collection/i,
  /anime\s*25th\s*collection/i,
  /25th\s*(?:anniversary\s*)?collection/i,
];

async function run(command, args, options = {}) {
  const { stdout, stderr } = await execFileAsync(command, args, {
    cwd: APP_DIR,
    windowsHide: true,
    maxBuffer: 50 * 1024 * 1024,
    ...options,
  });
  return { stdout: String(stdout || ''), stderr: String(stderr || '') };
}

function money(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : '$0.00';
}

function isExcludedSet(row) {
  const haystack = [row?.setSlug, row?.setName, row?.collectrSetUrl].filter(Boolean).join(' ');
  return EXCLUDED_SET_PATTERNS.some((pattern) => pattern.test(haystack));
}

async function syncDashboardRepo(dateStamp, rowCount) {
  const skipDashboardGit = /^(1|true|yes)$/i.test(String(process.env.NO_DASHBOARD_GIT || ''));
  if (skipDashboardGit) return `Dashboard git sync skipped for ${DASHBOARD_DIR}.`;
  const skipGitPush = /^(1|true|yes)$/i.test(String(process.env.SKIP_GIT_PUSH || ''));
  const status = await run('git', ['status', '--short'], { cwd: DASHBOARD_DIR });
  if (!status.stdout.trim()) return 'Dashboard repo already up to date.';

  await run('git', ['add', 'latest.json', 'latest-v2.json', 'weekly-base.json'], { cwd: DASHBOARD_DIR });
  const commit = await run('git', ['commit', '-m', `Update weekly PSA10 ROI data ${dateStamp}`], { cwd: DASHBOARD_DIR });
  if (skipGitPush) {
    return `Dashboard repo committed locally with ${rowCount} rows. ${commit.stdout.trim()}`;
  }
  await run('git', ['push', 'origin', 'master'], { cwd: DASHBOARD_DIR });
  return `Dashboard repo pushed with ${rowCount} rows. ${commit.stdout.trim()}`;
}

function countRowsWithEbayField(rows) {
  return rows.filter((row) => Array.isArray(row?.ebayCandidates)).length;
}

function countRowsWithEbayCandidates(rows) {
  return rows.filter((row) => Array.isArray(row?.ebayCandidates) && row.ebayCandidates.length).length;
}

async function loadExistingDashboardPayload() {
  const candidates = [DASHBOARD_JSON, LIVE_BACKUP_JSON];
  try {
    const archiveDirs = [path.join(DASHBOARD_DIR, 'archive'), path.join(path.dirname(DASHBOARD_DIR), 'archive')];
    for (const archiveDir of archiveDirs) {
      const entries = await fs.readdir(archiveDir, { withFileTypes: true }).catch(() => []);
      const archived = entries
        .filter((entry) => entry.isDirectory() && entry.name.startsWith('root-layout-'))
        .map((entry) => path.join(archiveDir, entry.name, 'latest.json'))
        .sort()
        .reverse();
      candidates.push(...archived);
    }
  } catch {
    // ignore archive lookup failures
  }

  let fallback = null;
  for (const candidate of candidates) {
    try {
      const payload = JSON.parse(await fs.readFile(candidate, 'utf8'));
      if (!fallback) fallback = payload;
      const rows = Array.isArray(payload?.rows) ? payload.rows : [];
      const lastSeen = Array.isArray(payload?.lastSeenReviewRows) ? payload.lastSeenReviewRows : [];
      const hasReviewHistory = rows.some((row) => Array.isArray(row?.reviewCandidates) && row.reviewCandidates.length)
        || rows.some((row) => Array.isArray(row?.lastSeenReviewCandidates) && row.lastSeenReviewCandidates.length)
        || lastSeen.length > 0;
      if (hasReviewHistory) return payload;
    } catch {
      // keep going
    }
  }
  return fallback;
}

function buildLastSeenReviewRows(currentRows, previousPayload) {
  const previousRows = Array.isArray(previousPayload?.rows) ? previousPayload.rows : [];
  const previousLastSeen = Array.isArray(previousPayload?.lastSeenReviewRows) ? previousPayload.lastSeenReviewRows : [];
  const currentByCode = new Map((Array.isArray(currentRows) ? currentRows : []).map((row) => [row.code, row]));
  const stale = [];
  const seenCodes = new Set();

  for (const prevRow of [...previousRows, ...previousLastSeen]) {
    const priorCandidates = Array.isArray(prevRow?.reviewCandidates) && prevRow.reviewCandidates.length
      ? prevRow.reviewCandidates
      : (Array.isArray(prevRow?.lastSeenReviewCandidates) && prevRow.lastSeenReviewCandidates.length ? prevRow.lastSeenReviewCandidates : []);
    if (!priorCandidates.length) continue;

    const currentRow = currentByCode.get(prevRow.code);
    if (Array.isArray(currentRow?.reviewCandidates) && currentRow.reviewCandidates.length) continue;

    if (seenCodes.has(prevRow.code)) continue;
    seenCodes.add(prevRow.code);
    stale.push({
      code: currentRow?.code || prevRow.code,
      name: currentRow?.name || prevRow.name,
      setName: currentRow?.setName || prevRow.setName,
      productId: currentRow?.productId || prevRow.productId || '',
      roiPercent: Number(currentRow?.roiPercent ?? prevRow.roiPercent ?? 0),
      rawMarket: Number(currentRow?.rawMarket ?? prevRow.rawMarket ?? 0),
      psa10Market: Number(currentRow?.psa10Market ?? prevRow.psa10Market ?? 0),
      lastSeenAt: prevRow.lastReviewSeenAt || previousPayload?.generatedAt || null,
      lastSeenReviewCandidates: priorCandidates,
    });
  }

  return stale.filter((row) => !isExcludedSet(row));
}

async function backupLiveDashboard() {
  try {
    const current = await fs.readFile(DASHBOARD_JSON, 'utf8');
    await fs.writeFile(LIVE_BACKUP_JSON, current, 'utf8');
    return LIVE_BACKUP_JSON;
  } catch {
    return null;
  }
}

async function loadFallbackRows() {
  const candidates = [WEEKLY_BASE_JSON, DASHBOARD_JSON, DASHBOARD_TEST_JSON];
  for (const candidate of candidates) {
    try {
      const raw = JSON.parse(await fs.readFile(candidate, 'utf8'));
      const rows = Array.isArray(raw?.rows) ? raw.rows : [];
      if (!rows.length) continue;
      if (raw?.dateStamp && raw.dateStamp !== DATE_STAMP) continue;
      return { rows, source: candidate, dateStamp: raw?.dateStamp || null };
    } catch {
      // keep looking
    }
  }
  return null;
}

async function scanLooksBlocked() {
  try {
    const report = await fs.readFile(SCAN_REPORT_MD, 'utf8');
    return /Browser fallbacks:\s+\d+/i.test(report) || /Errors:\s+0/i.test(report);
  } catch {
    return false;
  }
}

async function main() {
  const skipRefresh = /^(1|true|yes)$/i.test(String(process.env.SKIP_COLLECTR_REFRESH || ''));
  const skipEbayScout = /^(1|true|yes)$/i.test(String(process.env.SKIP_EBAY_SCOUT || ''));
  const allowDegradedPublish = /^(1|true|yes)$/i.test(String(process.env.ALLOW_DEGRADED_PUBLISH || ''));

  let reusedExistingPool = false;
  if (!skipRefresh) {
    try {
      await run('node', [path.join(SCANNER_DIR, 'refresh-active-pool.mjs')], {
        env: {
          ...process.env,
          SKIP_PSA10_ENRICH: '1',
        },
      });
    } catch (error) {
      const hasExistingPool = await fs.readFile(path.join(SCANNER_DIR, 'candidates-active.json'), 'utf8')
        .then((raw) => Array.isArray(JSON.parse(raw)) && JSON.parse(raw).length > 0)
        .catch(() => false);
      if (!hasExistingPool) throw error;
      reusedExistingPool = true;
    }
  }

  await run('node', [path.join(SCANNER_DIR, 'scan-pricecharting-psa10.mjs')], {
    env: {
      ...process.env,
      PRICECHARTING_RAW_FLOOR: process.env.PRICECHARTING_RAW_FLOOR || '0',
      PRICECHARTING_MIN_ROI: process.env.PRICECHARTING_MIN_ROI || '0.8',
      PRICECHARTING_MIN_PSA10_SALES: process.env.PRICECHARTING_MIN_PSA10_SALES || '3',
      PRICECHARTING_SCAN_CONCURRENCY: process.env.PRICECHARTING_SCAN_CONCURRENCY || '2',
      PRICECHARTING_RATE_LIMIT_MS: process.env.PRICECHARTING_RATE_LIMIT_MS || '1200',
    },
  });

  let rows = JSON.parse(await fs.readFile(RESULTS_JSON, 'utf8'));
  if (Array.isArray(rows)) rows = rows.filter((row) => !isExcludedSet(row));
  let reusedExistingBoard = null;
  if (!Array.isArray(rows) || rows.length === 0) {
    const blocked = await scanLooksBlocked();
    const fallback = await loadFallbackRows();
    if (blocked && fallback) {
      rows = fallback.rows.filter((row) => !isExcludedSet(row));
      reusedExistingBoard = fallback.source;
    } else {
      throw new Error('Refusing to publish an empty dashboard payload.');
    }
  }

  await fs.mkdir(DASHBOARD_DIR, { recursive: true });
  await fs.writeFile(WEEKLY_BASE_JSON, JSON.stringify({
    generatedAt: new Date().toISOString(),
    dateStamp: DATE_STAMP,
    qualifiedCount: rows.length,
    reusedExistingBoard,
    rows,
  }, null, 2), 'utf8');

  const previousPayload = await loadExistingDashboardPayload();
  const enrichedRows = skipEbayScout ? rows : await enrichRowsWithEbayCandidates(rows);
  const rowsWithEbayField = countRowsWithEbayField(enrichedRows);
  const rowsWithEbayCandidates = countRowsWithEbayCandidates(enrichedRows);
  const lastSeenReviewRows = buildLastSeenReviewRows(enrichedRows, previousPayload);

  for (const row of enrichedRows) {
    row.lastReviewSeenAt = Array.isArray(row.reviewCandidates) && row.reviewCandidates.length
      ? new Date().toISOString()
      : (previousPayload?.rows || []).find((prev) => prev.code === row.code)?.lastReviewSeenAt || null;
  }

  if (skipEbayScout && !allowDegradedPublish) {
    throw new Error('Refusing degraded live publish because SKIP_EBAY_SCOUT is set. Set ALLOW_DEGRADED_PUBLISH=1 to override.');
  }

  if (!skipEbayScout && rowsWithEbayField === 0) {
    throw new Error('Refusing live publish because eBay enrichment produced no ebayCandidates fields.');
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    dateStamp: DATE_STAMP,
    filters: {
      source: LLM_VISION_ENABLED
        ? 'PriceCharting One Piece full-price guide (all languages) + eBay photo-enriched raw candidates'
        : 'PriceCharting One Piece full-price guide (all languages) + eBay raw candidates',
      llmVisionEnabled: LLM_VISION_ENABLED,
      gradingCostBase: 33,
      shippingCostBase: 33,
      gradingCostHighEnd: 79.99,
      gradingCostHighEndThreshold: 500,
      liquidityHaircut: 0.12,
      minRoiPercent: Number(process.env.PRICECHARTING_MIN_ROI || 0.8) * 100,
      minPsa10Sales: Number(process.env.PRICECHARTING_MIN_PSA10_SALES || 3),
      rawFloor: Number(process.env.PRICECHARTING_RAW_FLOOR || 0),
    },
    ebayScoutSkipped: skipEbayScout,
    publishMode: skipEbayScout ? 'degraded-no-ebay' : 'full',
    rowsWithEbayField,
    rowsWithEbayCandidates,
    weeklyBaseJson: './data/weekly-base.json',
    reusedExistingBoard,
    qualifiedCount: enrichedRows.length,
    lastSeenReviewRows,
    rows: enrichedRows,
  };

  await backupLiveDashboard();
  await fs.writeFile(DASHBOARD_JSON, JSON.stringify(payload, null, 2), 'utf8');
  await fs.writeFile(DASHBOARD_TEST_JSON, JSON.stringify({
    ...payload,
    filters: {
      ...payload.filters,
      testMode: true,
    },
  }, null, 2), 'utf8');

  const repoSync = await syncDashboardRepo(DATE_STAMP, enrichedRows.length);

  const lines = [];
  lines.push('Weekly One Piece raw to PSA 10 ROI scan is done.');
  lines.push('');
  lines.push('Filters: PriceCharting One Piece pages (all languages), no raw floor, grading cost $33 under $500 / $79.99 at $500+, fixed shipping cost $33, 12% liquidity haircut, ROI >= 80%, PSA10 sales >= 3.');
  lines.push(`Qualified cards: ${enrichedRows.length}`);
  lines.push(`eBay scout skipped: ${skipEbayScout ? 'yes' : 'no'}`);
  lines.push(`Rows with eBay field: ${rowsWithEbayField}`);
  lines.push(`Rows with eBay candidates: ${rowsWithEbayCandidates}`);
  lines.push(`Weekly base JSON: ${WEEKLY_BASE_JSON}`);
  if (reusedExistingPool) lines.push('PriceCharting universe refresh fallback reused the existing active pool.');
  if (reusedExistingBoard) lines.push(`PriceCharting scan fallback reused existing board: ${reusedExistingBoard}`);
  lines.push(`Dashboard JSON: ${DASHBOARD_JSON}`);
  lines.push(`Dashboard publish: ${repoSync}`);
  lines.push('');

  enrichedRows.slice(0, 15).forEach((row, index) => {
    const candidateSummary = Array.isArray(row.ebayCandidates) && row.ebayCandidates.length
      ? ` | eBay: ${row.ebayCandidates.map((candidate) => `${money(candidate.total)} @ ${Number(candidate.photoScore?.score || 0).toFixed(0)}/100`).join(', ')}`
      : ' | eBay: no candidates';
    lines.push(`${index + 1}. ${row.code} ${row.name}, ROI ${Number(row.roiPercent).toFixed(2)}%, raw ${money(row.rawMarket)}, PSA10 ${money(row.psa10Market)}, sales ${Number(row.psa10SalesCount || 0)}${candidateSummary}`);
    lines.push(`${row.priceChartingUrl || row.collectrLink || ''}`);
  });

  console.log(lines.join('\n'));
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});
