import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = process.env.ONE_PIECE_SNIPER_TEST_DIR || path.resolve(__dirname, '..');
const DATA_DIR = path.join(APP_DIR, 'data');
const ACTIVE_PATH = process.env.ONE_PIECE_ACTIVE_POOL_PATH || path.join(APP_DIR, 'scripts', 'vendor', 'one-piece', 'candidates-active.json');
const LATEST_PATH = path.join(DATA_DIR, 'latest.json');
const OUT_PATH = path.join(DATA_DIR, 'meta-flips.json');
const API_URL = process.env.OP_LEADERBOARD_CARD_POPULARITY_URL || 'https://op-leaderboard.com/api/card-popularity';
const MAX_ROWS = Math.max(8, Number(process.env.ONE_PIECE_META_MAX_ROWS || 30));
const MIN_USAGE_PERCENT = Math.max(0, Number(process.env.ONE_PIECE_META_MIN_USAGE_PERCENT || 35));
const EUR_TO_USD = Number(process.env.ONE_PIECE_META_EUR_TO_USD || 1.08);

const MANUAL_WATCHLIST = [
  {
    code: 'OP14-112',
    name: 'Boa Hancock (Alternate Art)',
    setName: "The Azure Sea's Seven",
    angle: 'Grading + character demand',
    action: 'grade_candidate',
    tier: 'HOT',
    targetBuyPrice: 78,
    maxBuyPrice: 85,
    rawMarket: 89.95,
    psa10Market: 274.95,
    whyItMatters: 'Strong raw-to-PSA10 spread and Nate already found one around $78. Treat clean copies as grading candidates.',
    mainRisk: 'Only works if the card is truly clean; do not chase damaged/edge-worn copies.',
    priceChartingUrl: 'https://www.pricecharting.com/game/one-piece-azure-sea%27s-seven/boa-hancock-alternate-art-op14-112',
  },
  {
    code: 'OP14-031',
    name: 'Nami',
    setName: "The Azure Sea's Seven",
    angle: 'Cheap grading lottery',
    action: 'condition_watch',
    tier: 'WATCH',
    targetBuyPrice: 4,
    maxBuyPrice: 6,
    rawMarket: 4.99,
    psa10Market: 94,
    whyItMatters: 'Cheap raw entry with surprisingly strong PSA 10 comps. This is exactly the type the grading sniper can miss because of prefilters.',
    mainRisk: 'Small cards only make sense if copies are flawless and batched with other submissions.',
    priceChartingUrl: 'https://www.pricecharting.com/game/one-piece-azure-sea%27s-seven/nami-op14-031',
  }
];

function money(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function round2(value) {
  return Math.round(money(value) * 100) / 100;
}

function stripTags(value) {
  return String(value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function fetchPopularityHtml() {
  const response = await fetch(API_URL, {
    headers: {
      'Accept': 'text/html,application/xhtml+xml,application/json',
      'HX-Request': 'true',
      'User-Agent': 'Mozilla/5.0 (compatible; OnePieceMetaFlipScanner/1.0)',
    }
  });
  if (!response.ok) throw new Error(`OP Leaderboard request failed (${response.status})`);
  return response.text();
}

function parsePopularity(html) {
  const blocks = String(html || '').split('<div class="card-grid-item">').slice(1);
  const rows = [];
  for (const block of blocks) {
    const code = block.match(/card_id=((?:OP|EB|ST|P)\d{2,}-\d{3})/i)?.[1]?.toUpperCase()
      || block.match(/\/((?:OP|EB|ST|P)\d{2,}-\d{3})\.webp/i)?.[1]?.toUpperCase();
    if (!code) continue;
    const imageUrl = decodeHtml(block.match(/<img[^>]+src="([^"]+)"/i)?.[1] || '');
    const altName = decodeHtml(block.match(/<img[^>]+alt="([^"]+)"/i)?.[1] || '');
    const h3Name = decodeHtml(stripTags(block.match(/<h3[^>]*>(.*?)<\/h3>/is)?.[1] || ''));
    const name = h3Name || altName || code;
    const priceText = decodeHtml(stripTags(block.match(/<span[^>]*whitespace-nowrap[^>]*>(.*?)<\/span>/is)?.[1] || ''));
    const eurPrice = money(priceText.replace(/[^0-9.,-]/g, '').replace(',', '.'));
    const usageText = decodeHtml(stripTags(block.match(/<span[^>]*text-white text-sm ml-5[^>]*>(.*?)<\/span>/is)?.[1] || ''));
    const usagePercent = money(usageText.replace(/[^0-9.]/g, ''));
    if (usagePercent < MIN_USAGE_PERCENT) continue;
    rows.push({
      code,
      name,
      imageUrl,
      usagePercent: round2(usagePercent),
      leaderboardEurPrice: round2(eurPrice),
      leaderboardUsdPrice: round2(eurPrice * EUR_TO_USD),
    });
  }
  const seen = new Set();
  return rows.filter((row) => {
    const key = `${row.code}::${row.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeName(value) {
  return String(value || '').toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
}

function isPremiumVariantName(value) {
  return /alternate|parallel|manga|\bsp\b|super alternate|wanted poster|treasure rare|anniversary/i.test(String(value || ''));
}

function chooseActiveCard(meta, activeCards) {
  const sameCode = activeCards.filter((card) => card.code === meta.code);
  if (!sameCode.length) return null;
  const metaName = normalizeName(meta.name);
  const metaPremium = isPremiumVariantName(meta.name);
  const scored = sameCode.map((card) => {
    const cardName = normalizeName(card.name);
    const cardPremium = isPremiumVariantName(card.name);
    let score = 0;
    if (!metaPremium && cardPremium) score -= 20;
    if (cardName === metaName) score += 10;
    if (cardName.includes(metaName) || metaName.includes(cardName)) score += 5;
    score += Math.min(3, money(card.rawMarket) / 50);
    return { card, score };
  }).sort((a, b) => b.score - a.score || money(b.card.rawMarket) - money(a.card.rawMarket));
  return scored[0]?.score >= 5 ? scored[0].card : null;
}

function chooseGradingRow(meta, gradingRows) {
  const sameCode = gradingRows.filter((row) => row.code === meta.code);
  if (!sameCode.length) return null;
  const metaName = normalizeName(meta.name);
  const metaPremium = isPremiumVariantName(meta.name);
  const best = sameCode.map((row) => {
    const rowName = normalizeName(row.name);
    const rowPremium = isPremiumVariantName(row.name);
    let score = 0;
    if (!metaPremium && rowPremium) score -= 20;
    if (rowName === metaName) score += 8;
    if (rowName.includes(metaName) || metaName.includes(rowName)) score += 4;
    score += Math.min(4, money(row.roiPercent) / 100);
    return { row, score };
  }).sort((a, b) => b.score - a.score || money(b.row.roiPercent) - money(a.row.roiPercent))[0];
  return best?.score >= 4 ? best.row : null;
}

function classify(row) {
  const raw = money(row.rawMarket);
  const usage = money(row.usagePercent);
  const psa10 = money(row.psa10Market);
  const roi = raw > 0 && psa10 > 0 ? ((psa10 * 0.88 - (raw + 33)) / (raw + 33)) * 100 : null;
  const spreadGood = roi != null && roi >= 80;

  if (row.manualTier) return row.manualTier;
  if (spreadGood && raw >= 15) return 'HOT';
  if (usage >= 70) return 'HOT';
  if (usage >= 45) return 'WATCH';
  return 'WATCH';
}

function buildAction(row) {
  const raw = money(row.rawMarket);
  const usage = money(row.usagePercent);
  const psa10 = money(row.psa10Market);
  const roi = raw > 0 && psa10 > 0 ? ((psa10 * 0.88 - (raw + 33)) / (raw + 33)) * 100 : null;
  if (row.manualAction) return row.manualAction;
  if (roi != null && roi >= 80) return raw <= 10 ? 'condition_watch' : 'grade_candidate';
  if (raw <= 8 && usage >= 45) return 'bundle_flip';
  if (usage >= 70) return 'raw_flip';
  return 'watch';
}

function buildGeneratedRow(meta, activeCard, gradingRow) {
  const rawMarket = round2(money(activeCard?.rawMarket) || money(gradingRow?.rawMarket) || meta.leaderboardUsdPrice);
  const psa10Market = round2(money(gradingRow?.psa10Market));
  const usage = round2(meta.usagePercent);
  const provisional = {
    code: meta.code,
    name: activeCard?.name || gradingRow?.name || meta.name,
    setName: activeCard?.setName || gradingRow?.setName || 'Meta / OP Leaderboard',
    usagePercent: usage,
    rawMarket,
    psa10Market,
    imageUrl: meta.imageUrl || gradingRow?.priceChartingImageUrl || gradingRow?.collectrImageUrl || activeCard?.collectrImageUrl || '',
    priceChartingUrl: safePriceChartingUrl({ ...meta, name: activeCard?.name || gradingRow?.name || meta.name }, gradingRow?.priceChartingUrl) || '',
    collectrLink: activeCard?.collectrLink || gradingRow?.collectrLink || '',
    leaderboardEurPrice: meta.leaderboardEurPrice,
  };
  const action = buildAction(provisional);
  const tier = classify(provisional);
  const targetBuyPrice = round2(rawMarket * (action === 'grade_candidate' ? 0.85 : 0.75));
  const maxBuyPrice = round2(rawMarket * (action === 'grade_candidate' ? 0.95 : 0.85));
  const angle = action === 'grade_candidate' ? 'Meta + grading spread'
    : action === 'condition_watch' ? 'Cheap condition/grading watch'
    : action === 'bundle_flip' ? 'Deck core bundle piece'
    : usage >= 70 ? 'High-usage raw staple'
    : 'Meta usage watch';
  const whyItMatters = action === 'grade_candidate'
    ? `Auto-picked: ${usage}% usage signal plus a PSA 10 spread that may clear grading friction.`
    : action === 'bundle_flip'
      ? `Auto-picked: ${usage}% usage signal and cheap raw entry make this better as a playset/core bundle piece than a solo card.`
      : `Auto-picked from OP Leaderboard usage at ${usage}%; watch for raw movement, under-market listings, and bundle demand.`;
  const mainRisk = action === 'grade_candidate'
    ? 'Verify English/Japanese variant matching, PSA 10 sales depth, and card condition before buying.'
    : 'Meta demand can cool quickly; avoid paying market unless you have a clear resale/bundle angle.';

  return {
    ...provisional,
    tier,
    angle,
    action,
    targetBuyPrice,
    maxBuyPrice,
    whyItMatters,
    mainRisk,
    source: 'op-leaderboard-auto',
  };
}

function previousLooksCompatible(row, prev) {
  if (!prev || prev.code !== row.code) return false;
  const rowPremium = isPremiumVariantName(row.name);
  const prevPremium = isPremiumVariantName(prev.name);
  if (rowPremium !== prevPremium) return false;
  const rowName = normalizeName(row.name);
  const prevName = normalizeName(prev.name);
  const first = rowName.split(' ')[0] || '';
  return Boolean(first) && (prevName.includes(first) || rowName.includes(prevName.split(' ')[0] || ''));
}

function safePriceChartingUrl(row, candidateUrl = '') {
  const url = String(candidateUrl || '');
  if (!url) return '';
  if (!isPremiumVariantName(row.name) && /alternate|manga|sp-|\bsp\b|super-alternate|wanted-poster/i.test(url)) return '';
  return url;
}

function mergeManual(row, previousRows) {
  const prev = previousRows.find((item) => previousLooksCompatible(row, item));
  return {
    ...row,
    priceChartingUrl: safePriceChartingUrl(row, row.priceChartingUrl) || safePriceChartingUrl(row, prev?.priceChartingUrl) || '',
    imageUrl: row.imageUrl || prev?.imageUrl || '',
  };
}

async function run() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const [activeCards, latestPayload, previousPayload] = await Promise.all([
    readJson(ACTIVE_PATH, []),
    readJson(LATEST_PATH, { rows: [] }),
    readJson(OUT_PATH, { rows: [] }),
  ]);
  const previousRows = Array.isArray(previousPayload?.rows) ? previousPayload.rows : [];

  const html = await fetchPopularityHtml();
  const popularity = parsePopularity(html);
  if (!popularity.length) throw new Error('OP Leaderboard returned no parseable card popularity rows.');

  const gradingRows = Array.isArray(latestPayload?.rows) ? latestPayload.rows : [];
  const generated = popularity.map((meta) => buildGeneratedRow(meta, chooseActiveCard(meta, activeCards), chooseGradingRow(meta, gradingRows)));

  const byKey = new Map();
  for (const row of generated) {
    byKey.set(`${row.code}::${normalizeName(row.name)}`, mergeManual(row, previousRows));
  }
  for (const manual of MANUAL_WATCHLIST) {
    const prior = previousRows.find((row) => row.code === manual.code) || {};
    const activeCard = chooseActiveCard(manual, activeCards);
    const gradingRow = chooseGradingRow(manual, gradingRows);
    const imageUrl = prior.imageUrl || gradingRow?.priceChartingImageUrl || gradingRow?.collectrImageUrl || activeCard?.collectrImageUrl || '';
    byKey.set(`${manual.code}::${normalizeName(manual.name)}`, {
      ...manual,
      manualTier: manual.tier,
      manualAction: manual.action,
      usagePercent: generated.find((row) => row.code === manual.code)?.usagePercent ?? manual.usagePercent ?? null,
      rawMarket: round2(manual.rawMarket || activeCard?.rawMarket || gradingRow?.rawMarket),
      psa10Market: round2(manual.psa10Market || gradingRow?.psa10Market),
      imageUrl,
      collectrLink: activeCard?.collectrLink || gradingRow?.collectrLink || prior.collectrLink || '',
      source: 'manual-watchlist',
    });
  }

  const rows = Array.from(byKey.values())
    .filter((row) => money(row.rawMarket) > 0 || money(row.usagePercent) >= MIN_USAGE_PERCENT)
    .sort((a, b) => {
      const tierRank = { HOT: 0, WATCH: 1, AVOID: 2 };
      return (tierRank[a.tier] ?? 9) - (tierRank[b.tier] ?? 9)
        || money(b.usagePercent) - money(a.usagePercent)
        || money(b.psa10Market) - money(a.psa10Market)
        || a.code.localeCompare(b.code);
    })
    .slice(0, MAX_ROWS);

  const payload = {
    generatedAt: new Date().toISOString(),
    source: 'Auto-generated from OP Leaderboard card popularity, active Collectr pool, current grading board, and a small manual watchlist.',
    rules: 'Meta/raw board ignores PSA 10 comp gate. It ranks playability, usage spike, raw liquidity, bundle potential, and grading side-upside separately.',
    filters: {
      minUsagePercent: MIN_USAGE_PERCENT,
      maxRows: MAX_ROWS,
      eurToUsd: EUR_TO_USD,
      leaderboardUrl: API_URL,
      manualWatchlistCount: MANUAL_WATCHLIST.length,
    },
    counts: {
      leaderboardRowsParsed: popularity.length,
      generatedRows: generated.length,
      publishedRows: rows.length,
      hot: rows.filter((row) => row.tier === 'HOT').length,
      watch: rows.filter((row) => row.tier === 'WATCH').length,
      avoid: rows.filter((row) => row.tier === 'AVOID').length,
    },
    rows,
  };

  await fs.writeFile(OUT_PATH, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  console.log(`Generated ${rows.length} meta/raw flip rows at ${OUT_PATH}`);
}

run().catch((error) => {
  console.error(error?.stack || error?.message || error);
  process.exit(1);
});
