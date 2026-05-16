import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { pruneDatedReports } from '../report-retention.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = process.env.ONE_PIECE_SNIPER_TEST_DIR || path.resolve(__dirname, '..', '..', '..');
const SCANNER_DIR = __dirname;
const REPORT_DIR = path.join(APP_DIR, 'reports', 'one-piece-hybrid');
const ACTIVE_PATH = path.join(SCANNER_DIR, 'candidates-active.json');
const ACTIVE_BACKUP_PATH = path.join(SCANNER_DIR, 'candidates-active.backup.json');
const ENRICH_SCRIPT_PATH = path.join(SCANNER_DIR, 'enrich-collectr-psa10.mjs');
const SETS_URL = 'https://app.getcollectr.com/sets/category/68';
const RAW_FLOOR = Number(process.env.COLLECTR_RAW_FLOOR || 15);
const SKIP_PSA10_ENRICH = /^(1|true|yes)$/i.test(String(process.env.SKIP_PSA10_ENRICH || ''));
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36';
const FETCH_RETRIES = Math.max(1, Number(process.env.COLLECTR_FETCH_RETRIES || 3));
const FETCH_RETRY_MS = Math.max(250, Number(process.env.COLLECTR_FETCH_RETRY_MS || 1000));
const execFileAsync = promisify(execFile);
const RETENTION_DAYS = 90;
const EXCLUDED_SET_PATTERNS = [
  /extra-booster-anime-25th-collection/i,
  /anime\s*25th\s*collection/i,
  /25th\s*(?:anniversary\s*)?collection/i,
];

function money(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function encodePathSegment(value) {
  return encodeURIComponent(String(value || '')).replace(/%2F/g, '/');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchHtml(url, attempt = 1) {
  const response = await fetch(url, {
    headers: {
      'Accept': 'text/html,application/xhtml+xml',
      'User-Agent': USER_AGENT,
    }
  });
  if (response.ok) return response.text();
  if (attempt < FETCH_RETRIES && (response.status >= 500 || response.status === 403 || response.status === 429)) {
    await sleep(FETCH_RETRY_MS * attempt);
    return fetchHtml(url, attempt + 1);
  }
  throw new Error(`Collectr request failed (${response.status}) for ${url}`);
}

function extractEscapedJsonArray(html, marker) {
  const markerIndex = html.indexOf(marker);
  if (markerIndex === -1) return [];
  const start = html.indexOf('[', markerIndex + marker.length);
  if (start === -1) return [];

  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;

  for (let i = start; i < html.length; i += 1) {
    const ch = html[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '[') depth += 1;
    if (ch === ']') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }

  if (end === -1) return [];
  const raw = html.slice(start, end + 1).replace(/\\"/g, '"');
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function extractCollectrSets(html) {
  return extractEscapedJsonArray(html, '\\"sets\\":')
    .filter((setInfo) => setInfo?.catalog_group_id && setInfo?.web_slug_group)
    .sort((a, b) => Number(b.set_order_number || 0) - Number(a.set_order_number || 0));
}

function extractCollectrProducts(html) {
  return extractEscapedJsonArray(html, '\\"pages\\\":[{\\\"data\\\":')
    .filter((product) => product?.catalog_category === '68' && product?.product_id);
}

function normalizeCardCode(product) {
  const code = String(product?.card_number || '').trim().toUpperCase();
  return /^(?:OP|ST|P|EB)\d{2,}-\d{3}$/i.test(code) ? code : '';
}

function buildCollectrProductLink(product) {
  const productId = String(product?.product_id || '').trim();
  if (productId) {
    return `https://app.getcollectr.com/explore/product/${encodeURIComponent(productId)}`;
  }

  const query = [product.card_number, product.product_name].filter(Boolean).join(' ').trim();
  const url = new URL('https://app.getcollectr.com/');
  if (query) url.searchParams.set('query', query);
  return url.toString();
}

function buildSetUrl(setInfo) {
  return `https://app.getcollectr.com/sets/category/68/${encodePathSegment(setInfo.web_slug_group)}?cardType=cards&groupId=${encodeURIComponent(String(setInfo.catalog_group_id || ''))}&sortType=price&sortOrder=desc`;
}

function isExcludedSet(setInfoOrCard) {
  const haystack = [
    setInfoOrCard?.web_slug_group,
    setInfoOrCard?.catalog_group_name,
    setInfoOrCard?.catalog_group,
    setInfoOrCard?.setSlug,
    setInfoOrCard?.setName,
    setInfoOrCard?.collectrSetUrl,
  ].filter(Boolean).join(' ');
  return EXCLUDED_SET_PATTERNS.some((pattern) => pattern.test(haystack));
}

async function loadCollectrUniverse() {
  const setsHtml = await fetchHtml(SETS_URL);
  const sets = extractCollectrSets(setsHtml);
  const cards = [];

  for (const setInfo of sets) {
    if (isExcludedSet(setInfo)) continue;
    const html = await fetchHtml(buildSetUrl(setInfo));
    const products = extractCollectrProducts(html);
    for (const product of products) {
      const code = normalizeCardCode(product);
      const rawMarket = money(product.latest_price);
      if (!code || rawMarket < RAW_FLOOR || !product.is_card) continue;
      cards.push({
        code,
        name: String(product.product_name || '').replace(/\s+/g, ' ').trim() || code,
        setName: String(product.catalog_group || setInfo.catalog_group_name || '').trim(),
        setSlug: setInfo.web_slug_group,
        setOrder: Number(setInfo.set_order_number || 0),
        setGroupId: String(setInfo.catalog_group_id || ''),
        productId: String(product.product_id || ''),
        rarity: String(product.rarity || '').trim(),
        productSubType: String(product.product_sub_type || '').trim(),
        rawMarket: Math.round(rawMarket * 100) / 100,
        olderRawMarket: Math.round(money(product.older_market_price) * 100) / 100,
        rawDiff: Math.round(money(product.market_price_diff) * 100) / 100,
        rawDiffPercent: Math.round(Number(product.market_price_percentage_diff || 0) * 100) / 100,
        collectrLink: buildCollectrProductLink(product),
        collectrSetUrl: buildSetUrl(setInfo),
      });
    }
  }

  const deduped = Array.from(new Map(cards.filter((card) => !isExcludedSet(card)).map((card) => [`${card.code}::${card.name}::${card.setName}`, card])).values())
    .sort((a, b) => b.rawMarket - a.rawMarket || a.code.localeCompare(b.code));

  return { sets, cards: deduped };
}

async function enrichCollectrPsa10() {
  const { stdout } = await execFileAsync('node', [ENRICH_SCRIPT_PATH], {
    cwd: APP_DIR,
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024,
    env: {
      ...process.env,
      ONE_PIECE_SNIPER_TEST_DIR: APP_DIR,
    },
  });
  return String(stdout || '').trim();
}

async function readExistingActivePool() {
  try {
    const raw = await fs.readFile(ACTIVE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function backupExistingActivePool() {
  try {
    const raw = await fs.readFile(ACTIVE_PATH, 'utf8');
    await fs.writeFile(ACTIVE_BACKUP_PATH, raw, 'utf8');
    return true;
  } catch {
    return false;
  }
}

async function run() {
  await fs.mkdir(REPORT_DIR, { recursive: true });
  const previousCards = await readExistingActivePool();
  const { sets, cards } = await loadCollectrUniverse();

  if (!sets.length || !cards.length) {
    throw new Error(`Collectr refresh returned no data. sets=${sets.length} cards=${cards.length}. Existing active pool kept at ${previousCards.length} cards.`);
  }

  await backupExistingActivePool();
  await fs.writeFile(ACTIVE_PATH, JSON.stringify(cards, null, 2), 'utf8');
  const enrichOutput = SKIP_PSA10_ENRICH
    ? 'Skipped via SKIP_PSA10_ENRICH.'
    : await enrichCollectrPsa10();

  const now = new Date();
  const lines = [];
  lines.push('# One Piece Collectr Universe Refresh');
  lines.push(`Generated: ${now.toISOString()}`);
  lines.push(`Collectr sets scanned: ${sets.length}`);
  lines.push(`Cards kept at raw floor $${RAW_FLOOR.toFixed(2)}+: ${cards.length}`);
  lines.push(`Previous active pool size: ${previousCards.length}`);
  lines.push(`Active pool backup: ${ACTIVE_BACKUP_PATH}`);
  lines.push('');
  lines.push('## Sets scanned');
  for (const setInfo of sets) {
    lines.push(`- ${setInfo.catalog_group_name} (${setInfo.number_of_cards_in_group} cards)`);
  }
  lines.push('');
  lines.push('## Universe snapshot');
  for (const card of cards.slice(0, 80)) {
    lines.push(`- ${card.code} | ${card.name} | ${card.setName} | raw ${card.rawMarket.toFixed(2)} | ${card.collectrLink}`);
  }

  const reportPath = path.join(REPORT_DIR, `pool-refresh-${now.toISOString().slice(0, 10)}.md`);
  await fs.writeFile(reportPath, lines.join('\n'), 'utf8');
  await pruneDatedReports({
    dir: REPORT_DIR,
    prefix: 'pool-refresh-',
    extensions: ['.md'],
    retentionDays: RETENTION_DAYS,
    now,
  });

  console.log([
    'One Piece Collectr universe refresh complete.',
    `Report: ${reportPath}`,
    `Active pool written: ${ACTIVE_PATH}`,
    `Active pool backup: ${ACTIVE_BACKUP_PATH}`,
    `Previous active pool size: ${previousCards.length}`,
    `Sets scanned: ${sets.length}`,
    `Cards kept at $${RAW_FLOOR.toFixed(2)} raw or higher: ${cards.length}`,
    '',
    'Collectr PSA 10 enrichment:',
    enrichOutput,
  ].join('\n'));
}

run().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});
