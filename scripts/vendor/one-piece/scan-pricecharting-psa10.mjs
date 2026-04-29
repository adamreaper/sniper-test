import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { pruneDatedReports } from '../report-retention.mjs';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = process.env.ONE_PIECE_SNIPER_TEST_DIR || path.resolve(__dirname, '..', '..', '..');
const SCANNER_DIR = __dirname;
const REPORT_DIR = path.join(APP_DIR, 'reports', 'one-piece-hybrid');
const CACHE_DIR = path.join(REPORT_DIR, 'pricecharting-cache');
const PAGE_CACHE_DIR = path.join(CACHE_DIR, 'pages');
const MATCH_CACHE_PATH = path.join(CACHE_DIR, 'match-cache.json');
const ACTIVE_PATH = path.join(SCANNER_DIR, 'candidates-active.json');
const DATE_STAMP = new Date().toISOString().slice(0, 10);
const OUT_PATH = path.join(REPORT_DIR, `pricecharting-psa10-scan-results-${DATE_STAMP}.json`);
const REPORT_PATH = path.join(REPORT_DIR, `pricecharting-psa10-scan-results-${DATE_STAMP}.md`);
const RETENTION_DAYS = 90;

const RAW_FLOOR = Number(process.env.PRICECHARTING_RAW_FLOOR || 100);
const PREFILTER_RAW_FLOOR = Number(process.env.PRICECHARTING_PREFILTER_RAW_FLOOR || 80);
const BASE_GRADING_COST = Number(process.env.PRICECHARTING_GRADING_COST || 33);
const HIGH_END_GRADING_THRESHOLD = Number(process.env.PRICECHARTING_HIGH_END_GRADING_THRESHOLD || 500);
const HIGH_END_GRADING_COST = Number(process.env.PRICECHARTING_HIGH_END_GRADING_COST || 79.99);
const LIQUIDITY_HAIRCUT = Number(process.env.PRICECHARTING_LIQUIDITY_HAIRCUT || 0.88);
const MIN_ROI = Number(process.env.PRICECHARTING_MIN_ROI || 0.8);
const MIN_PSA10_SALES = Math.max(0, Number(process.env.PRICECHARTING_MIN_PSA10_SALES || 5));
const CONCURRENCY = Math.max(1, Number(process.env.PRICECHARTING_SCAN_CONCURRENCY || 2));
const RETRIES = Math.max(1, Number(process.env.PRICECHARTING_SCAN_RETRIES || 3));
const RETRY_MS = Math.max(250, Number(process.env.PRICECHARTING_SCAN_RETRY_MS || 800));
const RATE_LIMIT_MS = Math.max(0, Number(process.env.PRICECHARTING_RATE_LIMIT_MS || 900));
const PAGE_CACHE_HOURS = Math.max(1, Number(process.env.PRICECHARTING_PAGE_CACHE_HOURS || 168));
const MATCH_CACHE_HOURS = Math.max(1, Number(process.env.PRICECHARTING_MATCH_CACHE_HOURS || 720));
const MAX_CARDS = Math.max(0, Number(process.env.PRICECHARTING_SCAN_MAX_CARDS || 0));
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36';
const BROWSER_SESSION = process.env.PRICECHARTING_BROWSER_SESSION || 'pricecharting-psa10';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let lastRequestAt = 0;
async function paceRequests() {
  if (!RATE_LIMIT_MS) return;
  const now = Date.now();
  const waitMs = Math.max(0, lastRequestAt + RATE_LIMIT_MS - now);
  if (waitMs > 0) await sleep(waitMs);
  lastRequestAt = Date.now();
}

function money(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function formatMoney(value) {
  return `$${money(value).toFixed(2)}`;
}

const SHIPPING_COST = 33;

function gradingCostForRaw(rawMarket) {
  return money(rawMarket) >= HIGH_END_GRADING_THRESHOLD ? HIGH_END_GRADING_COST : BASE_GRADING_COST;
}

function normalizeToken(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function cardTokens(card) {
  const keywords = new Set();
  const normalizedName = normalizeToken(card.name);
  normalizedName.split(/\s+/).forEach((token) => {
    if (!token || token.length < 3) return;
    if (['piece', 'card', 'mint', 'rare'].includes(token)) return;
    keywords.add(token);
  });
  card.code.toLowerCase().split(/[^a-z0-9]+/).forEach((token) => token && keywords.add(token));
  return Array.from(keywords);
}

let browserLock = Promise.resolve();
let browserFallbackCount = 0;

async function browserFetchText(url) {
  browserFallbackCount += 1;
  const previous = browserLock;
  let release;
  browserLock = new Promise((resolve) => {
    release = resolve;
  });

  await previous;
  try {
    await execFileAsync('agent-browser', ['--session', BROWSER_SESSION, 'open', url], {
      cwd: APP_DIR,
      windowsHide: true,
      maxBuffer: 20 * 1024 * 1024,
    });
    const { stdout } = await execFileAsync('agent-browser', ['--session', BROWSER_SESSION, 'get', 'html', 'body'], {
      cwd: APP_DIR,
      windowsHide: true,
      maxBuffer: 20 * 1024 * 1024,
    });
    return String(stdout || '');
  } finally {
    release();
  }
}

async function fetchText(url, attempt = 1) {
  await paceRequests();
  const response = await fetch(url, {
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'User-Agent': USER_AGENT,
    },
  });

  if (response.ok) return response.text();

  if (response.status === 403) {
    return browserFetchText(url);
  }

  if (attempt < RETRIES && (response.status >= 500 || response.status === 429)) {
    await sleep(RETRY_MS * attempt);
    return fetchText(url, attempt + 1);
  }

  const body = await response.text().catch(() => '');
  throw new Error(`PriceCharting request failed (${response.status}) for ${url}: ${body.slice(0, 200)}`);
}

function extractSearchPaths(html) {
  const matches = [...html.matchAll(/https:\/\/www\.pricecharting\.com(\/game\/one-piece[^"'<>\s]+)/g)];
  const paths = [];
  for (const match of matches) {
    const candidate = String(match[1] || '').trim();
    if (!candidate.startsWith('/game/one-piece')) continue;
    if (!paths.includes(candidate)) paths.push(candidate);
  }
  return paths;
}

function scorePath(card, href) {
  const lowerHref = href.toLowerCase();
  let score = 0;
  if (lowerHref.includes(card.code.toLowerCase())) score += 100;
  if (lowerHref.includes('/game/one-piece-')) score += 15;
  if (lowerHref.includes('/game/one-piece-japanese-')) score += 12;

  const tokens = cardTokens(card);
  for (const token of tokens) {
    if (lowerHref.includes(token)) score += 4;
  }

  const normalizedName = normalizeToken(card.name);
  if (normalizedName.includes('manga') && lowerHref.includes('manga')) score += 12;
  if (normalizedName.includes('alternate art') && lowerHref.includes('alternate-art')) score += 10;
  if (normalizedName.includes('super alternate art') && lowerHref.includes('super-alternate-art')) score += 12;
  if (normalizedName.includes('3rd anniversary') && lowerHref.includes('3rd-anniversary')) score += 12;
  if (normalizedName.includes('gold') && lowerHref.includes('gold')) score += 8;
  if (normalizedName.includes('silver') && lowerHref.includes('silver')) score += 8;
  if (normalizedName.includes('sp') && lowerHref.includes('-sp-')) score += 6;
  if (normalizedName.includes('serial') && lowerHref.includes('serial')) score += 12;

  return score;
}

async function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function isFresh(isoString, maxHours) {
  const ts = Date.parse(String(isoString || ''));
  if (!Number.isFinite(ts)) return false;
  return (Date.now() - ts) <= maxHours * 60 * 60 * 1000;
}

async function loadMatchCache() {
  const cached = await readJsonIfPresent(MATCH_CACHE_PATH);
  return cached && typeof cached === 'object' ? cached : {};
}

async function saveMatchCache(cache) {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.writeFile(MATCH_CACHE_PATH, JSON.stringify(cache, null, 2), 'utf8');
}

function matchCacheKey(card) {
  return `${card.code}::${card.name}`;
}

async function findBestPriceChartingPath(card, matchCache) {
  const cacheKey = matchCacheKey(card);
  const cached = matchCache[cacheKey];
  if (cached?.href && isFresh(cached.cachedAt, MATCH_CACHE_HOURS)) {
    return { href: cached.href, score: Number(cached.score || 0), cached: true };
  }

  const query = encodeURIComponent(`${card.code} one piece`);
  const html = await fetchText(`https://www.pricecharting.com/search-products?type=prices&q=${query}`);
  const candidates = extractSearchPaths(html)
    .map((href) => ({ href, score: scorePath(card, href) }))
    .sort((a, b) => b.score - a.score || a.href.localeCompare(b.href));

  const best = candidates[0] || null;
  if (best) {
    matchCache[cacheKey] = {
      href: best.href,
      score: best.score,
      cachedAt: new Date().toISOString(),
    };
  }
  return best;
}

function parsePriceTable(html) {
  const idx = html.indexOf('id="full-prices"');
  if (idx === -1) return new Map();
  const end = html.indexOf('</table>', idx);
  if (end === -1) return new Map();
  const section = html.slice(idx, end);
  const map = new Map();
  for (const match of section.matchAll(/<tr>\s*<td>([^<]+)<\/td>\s*<td class="price js-price">([^<]+)<\/td>/g)) {
    const label = String(match[1] || '').trim();
    const rawPrice = String(match[2] || '').replace(/[$,\s]/g, '');
    const value = rawPrice === '-' ? 0 : Number(rawPrice);
    if (label) map.set(label, Number.isFinite(value) ? value : 0);
  }
  return map;
}

function parseCompletedSalesCounts(html) {
  const counts = new Map();
  for (const match of html.matchAll(/<option value="[^"]+">([^<(]+?) \((\d+)\)<\/option>/g)) {
    const label = String(match[1] || '').trim();
    const count = Number(match[2] || 0);
    counts.set(label, count);
  }
  return counts;
}

function parsePriceChartingImageUrl(html) {
  const urls = [];
  for (const match of html.matchAll(/https:\/\/storage\.googleapis\.com\/images\.pricecharting\.com\/[^"'\s<>()]+/g)) {
    const url = String(match[0] || '').trim();
    if (/\/(?:240|480|960|1200|1600)\.(?:jpg|jpeg|png|webp)(?:\?|$)/i.test(url)) {
      urls.push(url);
    }
  }
  if (!urls.length) return null;
  urls.sort((a, b) => {
    const aw = Number((a.match(/\/(\d+)\.(?:jpg|jpeg|png|webp)(?:\?|$)/i) || [])[1] || 0);
    const bw = Number((b.match(/\/(\d+)\.(?:jpg|jpeg|png|webp)(?:\?|$)/i) || [])[1] || 0);
    return bw - aw;
  });
  return urls[0];
}

function computeRow(card, pathMatch, table, counts, priceChartingImageUrl) {
  const rawMarket = money(table.get('Ungraded'));
  const psa10Market = money(table.get('PSA 10'));
  const gradingCost = gradingCostForRaw(rawMarket);
  const costBasis = rawMarket + gradingCost + SHIPPING_COST;
  const netPsa10Exit = psa10Market * LIQUIDITY_HAIRCUT;
  const profit = netPsa10Exit - costBasis;
  const roi = costBasis > 0 ? profit / costBasis : -1;

  return {
    code: card.code,
    name: card.name,
    setName: card.setName,
    productId: String(card.productId || ''),
    rarity: card.rarity || null,
    productSubType: card.productSubType || null,
    priceChartingPath: pathMatch.href,
    priceChartingUrl: `https://www.pricecharting.com${pathMatch.href}`,
    searchScore: pathMatch.score,
    rawMarket: Math.round(rawMarket * 100) / 100,
    psa10Market: Math.round(psa10Market * 100) / 100,
    netPsa10Exit: Math.round(netPsa10Exit * 100) / 100,
    gradingCost: Math.round(gradingCost * 100) / 100,
    shippingCost: Math.round(SHIPPING_COST * 100) / 100,
    costBasis: Math.round(costBasis * 100) / 100,
    profit: Math.round(profit * 100) / 100,
    roi: Math.round(roi * 10000) / 10000,
    roiPercent: Math.round(roi * 10000) / 100,
    psa10SalesCount: Number(counts.get('PSA 10') || 0),
    ungradedSalesCount: Number(counts.get('Ungraded') || 0),
    bgs10SalesCount: Number(counts.get('BGS 10') || 0),
    collectrRawMarket: money(card.rawMarket),
    collectrLink: card.collectrLink,
    collectrSetUrl: card.collectrSetUrl || null,
    priceChartingImageUrl: priceChartingImageUrl || null,
    collectrImageUrl: card.productId ? `https://public.getcollectr.com/public-assets/products/product_${card.productId}.jpg?optimizer=image&format=webp&width=1200&quality=80&strip=metadata` : null,
  };
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let index = 0;

  async function runner() {
    while (true) {
      const current = index;
      index += 1;
      if (current >= items.length) return;
      results[current] = await worker(items[current], current);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => runner()));
  return results;
}

function pageCachePath(card) {
  return path.join(PAGE_CACHE_DIR, `${card.code}.json`);
}

async function loadCachedPage(card) {
  const cached = await readJsonIfPresent(pageCachePath(card));
  if (!cached || !isFresh(cached.cachedAt, PAGE_CACHE_HOURS)) return null;
  return cached;
}

async function saveCachedPage(card, payload) {
  await fs.mkdir(PAGE_CACHE_DIR, { recursive: true });
  await fs.writeFile(pageCachePath(card), JSON.stringify({
    cachedAt: new Date().toISOString(),
    ...payload,
  }, null, 2), 'utf8');
}

async function getPageData(card, pathMatch) {
  const cached = await loadCachedPage(card);
  if (cached?.href === pathMatch.href && cached?.table && cached?.priceChartingImageUrl) {
    return {
      table: new Map(Object.entries(cached.table)),
      counts: new Map(Object.entries(cached.counts || {})),
      priceChartingImageUrl: cached.priceChartingImageUrl || null,
      fromCache: true,
    };
  }

  const html = await fetchText(`https://www.pricecharting.com${pathMatch.href}`);
  const table = parsePriceTable(html);
  const counts = parseCompletedSalesCounts(html);
  const priceChartingImageUrl = parsePriceChartingImageUrl(html);
  await saveCachedPage(card, {
    href: pathMatch.href,
    table: Object.fromEntries(table.entries()),
    counts: Object.fromEntries(counts.entries()),
    priceChartingImageUrl,
  });
  return { table, counts, priceChartingImageUrl, fromCache: false };
}

async function run() {
  await fs.mkdir(REPORT_DIR, { recursive: true });
  const matchCache = await loadMatchCache();
  const cards = JSON.parse(await fs.readFile(ACTIVE_PATH, 'utf8'));
  const filteredCards = cards
    .filter((card) => money(card.rawMarket) >= PREFILTER_RAW_FLOOR && card.code)
    .slice(0, MAX_CARDS > 0 ? MAX_CARDS : undefined);

  let matched = 0;
  let noMatch = 0;
  let parseMiss = 0;
  let errors = 0;
  let cacheHits = 0;
  let browserFallbacks = 0;
  const missLines = [];

  const scanned = await mapWithConcurrency(filteredCards, CONCURRENCY, async (card, idx) => {
    if ((idx + 1) % 20 === 0 || idx === 0) {
      console.log(`Checking ${idx + 1}/${filteredCards.length}: ${card.code} | ${card.name}`);
    }

    try {
      const pathMatch = await findBestPriceChartingPath(card, matchCache);
      if (!pathMatch || pathMatch.score < 100) {
        noMatch += 1;
        missLines.push(`- NO_MATCH | ${card.code} | ${card.name}`);
        return null;
      }

      const pageData = await getPageData(card, pathMatch);
      const table = pageData.table;
      if (!table.size || !table.has('Ungraded') || !table.has('PSA 10')) {
        parseMiss += 1;
        missLines.push(`- PARSE_MISS | ${card.code} | ${card.name} | ${pathMatch.href}`);
        return null;
      }

      const counts = pageData.counts;
      const row = computeRow(card, pathMatch, table, counts, pageData.priceChartingImageUrl || null);
      matched += 1;
      if (pathMatch.cached || pageData.fromCache) cacheHits += 1;

      if (row.rawMarket < RAW_FLOOR) {
        missLines.push(`- RAW_FILTERED | ${card.code} | ${card.name} | raw ${formatMoney(row.rawMarket)}`);
        return null;
      }

      if (row.psa10SalesCount < MIN_PSA10_SALES) {
        missLines.push(`- SALES_FILTERED | ${card.code} | ${card.name} | PSA10 sales ${row.psa10SalesCount}`);
        return null;
      }

      if (row.roi < MIN_ROI) {
        missLines.push(`- ROI_FILTERED | ${card.code} | ${card.name} | ROI ${row.roiPercent.toFixed(2)}% | raw ${formatMoney(row.rawMarket)} | PSA10 ${formatMoney(row.psa10Market)}`);
        return null;
      }

      return row;
    } catch (error) {
      errors += 1;
      missLines.push(`- ERROR | ${card.code} | ${card.name} | ${String(error.message || error)}`);
      return null;
    }
  });

  browserFallbacks = browserFallbackCount;
  const rows = scanned.filter(Boolean).sort((a, b) => b.roiPercent - a.roiPercent || a.code.localeCompare(b.code));
  await fs.writeFile(OUT_PATH, JSON.stringify(rows, null, 2), 'utf8');
  await saveMatchCache(matchCache);

  const reportLines = [
    '# PriceCharting PSA 10 scan results',
    `Generated: ${new Date().toISOString()}`,
    'Source: PriceCharting search + English card page full-price guide',
    `Raw floor: ${formatMoney(RAW_FLOOR)}`,
    `Prefilter raw floor (active pool): ${formatMoney(PREFILTER_RAW_FLOOR)}`,
    `Grading cost: ${formatMoney(BASE_GRADING_COST)} under ${formatMoney(HIGH_END_GRADING_THRESHOLD)}, ${formatMoney(HIGH_END_GRADING_COST)} at/above ${formatMoney(HIGH_END_GRADING_THRESHOLD)}`,
    `Liquidity haircut: ${(1 - LIQUIDITY_HAIRCUT) * 100}%`,
    `Min ROI: ${(MIN_ROI * 100).toFixed(2)}%`,
    `Min PSA10 sales: ${MIN_PSA10_SALES}`,
    `Cards scanned: ${filteredCards.length}`,
    `Qualified cards: ${rows.length}`,
    `Matched pages: ${matched}`,
    `Cache hits: ${cacheHits}`,
    `Browser fallbacks: ${browserFallbacks}`,
    `No search match: ${noMatch}`,
    `Parse misses: ${parseMiss}`,
    `Errors: ${errors}`,
    '',
    '## Qualified cards',
    ...rows.map((row) => `- ${row.code} | ${row.name} | raw ${formatMoney(row.rawMarket)} | PSA10 ${formatMoney(row.psa10Market)} | ROI ${row.roiPercent.toFixed(2)}% | sales PSA10 ${row.psa10SalesCount} | ${row.priceChartingUrl}`),
    '',
    '## Misses / filtered',
    ...missLines,
    '',
  ];

  await fs.writeFile(REPORT_PATH, reportLines.join('\n'), 'utf8');
  await pruneDatedReports({
    dir: REPORT_DIR,
    prefix: 'pricecharting-psa10-scan-results-',
    extensions: ['.json', '.md'],
    retentionDays: RETENTION_DAYS,
    now: new Date(),
  });

  console.log(`Done. Qualified=${rows.length} Matched=${matched} CacheHits=${cacheHits} BrowserFallbacks=${browserFallbacks} NoMatch=${noMatch} ParseMiss=${parseMiss} Errors=${errors}`);
  console.log(`JSON: ${OUT_PATH}`);
  console.log(`Report: ${REPORT_PATH}`);
}

run().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});
