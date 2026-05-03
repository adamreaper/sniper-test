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
const SNAPSHOT_PATH = path.join(DATA_DIR, 'meta-flips-snapshots.json');
const OVERRIDES_PATH = path.join(DATA_DIR, 'meta-flips-overrides.json');
const API_URL = process.env.OP_LEADERBOARD_CARD_POPULARITY_URL || 'https://op-leaderboard.com/api/card-popularity';
const MAX_ROWS = Math.max(12, Number(process.env.ONE_PIECE_META_MAX_ROWS || 60));
const MIN_USAGE_PERCENT = Math.max(0, Number(process.env.ONE_PIECE_META_MIN_USAGE_PERCENT || 35));
const EUR_TO_USD = Number(process.env.ONE_PIECE_META_EUR_TO_USD || 1.08);
const SNAPSHOT_LIMIT = Math.max(7, Number(process.env.ONE_PIECE_META_SNAPSHOT_LIMIT || 45));
const PSA10_GRADING_COST = Number(process.env.ONE_PIECE_META_GRADING_COST || 33);
const PSA10_HAIRCUT = Number(process.env.ONE_PIECE_META_PSA10_HAIRCUT || 0.88);
const UNDERMARKET_THRESHOLD = Number(process.env.ONE_PIECE_META_UNDERMARKET_THRESHOLD || 0.85);

function money(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function round2(value) {
  return Math.round(money(value) * 100) / 100;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
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
      'User-Agent': 'Mozilla/5.0 (compatible; OnePieceMetaFlipScanner/2.0)',
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
    const key = `${row.code}::${normalizeName(row.name)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeName(value) {
  return String(value || '').toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
}

function rowKey(row) {
  return `${row.code}::${normalizeName(row.name).split(' ').slice(0, 4).join(' ')}`;
}

function isPremiumVariantName(value) {
  return /alternate|parallel|manga|\bsp\b|super alternate|wanted poster|treasure rare|anniversary/i.test(String(value || ''));
}

function isRecentSet(code) {
  const match = String(code || '').match(/^(OP|EB)(\d{2})-/i);
  if (!match) return false;
  const n = Number(match[2]);
  return match[1].toUpperCase() === 'OP' ? n >= 14 : n >= 4;
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

function safePriceChartingUrl(row, candidateUrl = '') {
  const url = String(candidateUrl || '');
  if (!url) return '';
  if (!isPremiumVariantName(row.name) && /alternate|manga|sp-|\bsp\b|super-alternate|wanted-poster/i.test(url)) return '';
  return url;
}

function previousLooksCompatible(row, prev) {
  if (!prev || prev.code !== row.code) return false;
  if (isPremiumVariantName(row.name) !== isPremiumVariantName(prev.name)) return false;
  const rowName = normalizeName(row.name);
  const prevName = normalizeName(prev.name);
  const first = rowName.split(' ')[0] || '';
  return Boolean(first) && (prevName.includes(first) || rowName.includes(prevName.split(' ')[0] || ''));
}

function findPrevious(row, previousRows) {
  return previousRows.find((item) => previousLooksCompatible(row, item)) || null;
}

function gradingRoi(rawMarket, psa10Market) {
  const raw = money(rawMarket);
  const psa = money(psa10Market);
  if (raw <= 0 || psa <= 0) return null;
  return ((psa * PSA10_HAIRCUT - (raw + PSA10_GRADING_COST)) / (raw + PSA10_GRADING_COST)) * 100;
}

function computeUsageDelta(row, previousRows, snapshots) {
  const prev = findPrevious(row, previousRows);
  if (prev?.usagePercent != null) return round2(money(row.usagePercent) - money(prev.usagePercent));
  const previousSnapshots = Array.isArray(snapshots?.snapshots) ? snapshots.snapshots.slice().reverse() : [];
  for (const snap of previousSnapshots) {
    const card = Array.isArray(snap.cards) ? snap.cards.find((item) => item.code === row.code && normalizeName(item.name).split(' ')[0] === normalizeName(row.name).split(' ')[0]) : null;
    if (card?.usagePercent != null) return round2(money(row.usagePercent) - money(card.usagePercent));
  }
  return 0;
}

function computeRawDelta(row, previousRows) {
  const prev = findPrevious(row, previousRows);
  if (!prev || !money(prev.rawMarket) || !money(row.rawMarket)) return 0;
  return round2(((money(row.rawMarket) - money(prev.rawMarket)) / money(prev.rawMarket)) * 100);
}

function computeScores(row) {
  const usage = money(row.usagePercent);
  const usageDelta = money(row.usageDeltaPercent);
  const raw = money(row.rawMarket);
  const psa10 = money(row.psa10Market);
  const roi = gradingRoi(raw, psa10);
  const reference = Math.max(money(row.leaderboardUsdPrice), money(row.collectrRawMarket), raw);
  const discountPercent = reference > 0 && raw > 0 ? ((reference - raw) / reference) * 100 : 0;
  const metaUsageScore = clamp((usage / 90) * 25, 0, 25);
  const usageDeltaScore = clamp(usageDelta * 2, -15, 20);
  const rawDiscountScore = clamp(discountPercent / 2, 0, 18);
  const bundleFitScore = raw > 0 && raw <= 8 && usage >= 45 ? 18 : raw <= 20 && usage >= 60 ? 10 : 0;
  const gradingSpreadScore = roi == null ? 0 : clamp((roi - 40) / 4, 0, 25);
  const liquidityScore = clamp((usage / 100) * 8 + Math.min(8, money(row.psa10SalesCount) * 2), 0, 16);
  const reprintRiskPenalty = isRecentSet(row.code) && raw >= 25 && !isPremiumVariantName(row.name) ? 8 : isRecentSet(row.code) && raw >= 80 ? 6 : 0;
  const conditionRiskPenalty = (isPremiumVariantName(row.name) && raw >= 75 ? 5 : 0) + (roi != null && money(row.psa10SalesCount) > 0 && money(row.psa10SalesCount) < 3 ? 6 : 0);
  const rawSpikeScore = money(row.rawDeltaPercent) >= 20 ? 10 : money(row.rawDeltaPercent) >= 10 ? 5 : 0;
  const total = clamp(metaUsageScore + usageDeltaScore + rawDiscountScore + bundleFitScore + gradingSpreadScore + liquidityScore + rawSpikeScore - reprintRiskPenalty - conditionRiskPenalty, 0, 100);
  return {
    total: Math.round(total),
    metaUsageScore: round2(metaUsageScore),
    usageDeltaScore: round2(usageDeltaScore),
    rawDiscountScore: round2(rawDiscountScore),
    bundleFitScore: round2(bundleFitScore),
    gradingSpreadScore: round2(gradingSpreadScore),
    liquidityScore: round2(liquidityScore),
    rawSpikeScore: round2(rawSpikeScore),
    reprintRiskPenalty: round2(reprintRiskPenalty),
    conditionRiskPenalty: round2(conditionRiskPenalty),
    gradingRoiPercent: roi == null ? null : round2(roi),
    rawDiscountPercent: round2(discountPercent),
  };
}

function deriveSignals(row) {
  const scores = row.scores || {};
  const signals = [];
  if (money(row.usagePercent) >= 70 || money(scores.metaUsageScore) >= 20) signals.push('meta_momentum');
  if (money(row.usageDeltaPercent) >= 8) signals.push('usage_delta_spike');
  if (money(row.rawDeltaPercent) >= 20) signals.push('raw_price_spike');
  if (money(row.rawMarket) <= 8 && money(row.usagePercent) >= 45) signals.push('deck_core_bundle');
  if (money(scores.gradingRoiPercent) >= 80) signals.push(money(row.rawMarket) <= 10 ? 'condition_grading_queue' : 'grading_candidate');
  if (money(scores.rawDiscountPercent) >= (1 - UNDERMARKET_THRESHOLD) * 100) signals.push('under_market_watch');
  if (money(scores.reprintRiskPenalty) >= 8) signals.push('reprint_risk');
  if ((money(row.usageDeltaPercent) <= -8 && money(row.rawMarket) >= 20) || (money(row.rawDeltaPercent) >= 25 && money(row.usageDeltaPercent) <= 0)) signals.push('exit_watch');
  if (!signals.length) signals.push('watch');
  return signals;
}

function deriveActionAndTier(row) {
  const signals = row.signalTypes || [];
  const score = money(row.score);
  if (signals.includes('exit_watch')) return { action: 'exit_watch', tier: 'AVOID', angle: 'Exit / risk watch' };
  if (signals.includes('grading_candidate')) return { action: 'grade_candidate', tier: score >= 55 ? 'HOT' : 'WATCH', angle: 'Meta + grading spread' };
  if (signals.includes('condition_grading_queue')) return { action: 'condition_watch', tier: 'WATCH', angle: 'Cheap condition/grading queue' };
  if (signals.includes('deck_core_bundle')) return { action: 'bundle_flip', tier: score >= 45 ? 'HOT' : 'WATCH', angle: 'Deck-core bundle scanner' };
  if (signals.includes('under_market_watch') || signals.includes('meta_momentum')) return { action: 'raw_flip', tier: score >= 45 ? 'HOT' : 'WATCH', angle: 'Meta/raw flip scanner' };
  return { action: 'watch', tier: score >= 50 ? 'HOT' : 'WATCH', angle: 'Meta movement watch' };
}

function explainRow(row) {
  const bits = [];
  if (money(row.usagePercent)) bits.push(`${round2(row.usagePercent)}% usage`);
  if (money(row.usageDeltaPercent)) bits.push(`${money(row.usageDeltaPercent) > 0 ? '+' : ''}${round2(row.usageDeltaPercent)} usage delta`);
  if (row.scores?.gradingRoiPercent != null) bits.push(`${round2(row.scores.gradingRoiPercent)}% grading ROI`);
  if (money(row.scores?.rawDiscountPercent) >= 10) bits.push(`${round2(row.scores.rawDiscountPercent)}% raw discount signal`);
  if (row.signalTypes?.includes('deck_core_bundle')) bits.push('fits playset/core bundle logic');
  if (row.signalTypes?.includes('reprint_risk')) bits.push('reprint-risk penalty applied');
  return bits.length ? `Rule-picked: ${bits.join(' • ')}.` : 'Rule-picked by repeatable meta/raw scanner.';
}

function riskRow(row) {
  if (row.signalTypes?.includes('exit_watch')) return 'Exit/watch signal: price moved faster than usage or usage is fading.';
  if (row.signalTypes?.includes('reprint_risk')) return 'Reprint/rotation risk is elevated; do not overpay and prefer faster exits.';
  if (row.action === 'grade_candidate' || row.action === 'condition_watch') return 'Only grade clean copies and batch submissions to reduce per-card shipping/friction.';
  if (row.action === 'bundle_flip') return 'Single-card margins are tiny; edge comes from playsets, cores, and fast turns.';
  return 'Meta demand can cool quickly; buy under market and avoid stale inventory.';
}

function targetPrices(row) {
  const raw = money(row.rawMarket);
  if (row.action === 'grade_candidate') return { targetBuyPrice: round2(raw * 0.85), maxBuyPrice: round2(raw * 0.95) };
  if (row.action === 'condition_watch') return { targetBuyPrice: round2(raw * 0.80), maxBuyPrice: round2(raw * 0.90) };
  if (row.action === 'bundle_flip') return { targetBuyPrice: round2(raw * 0.75), maxBuyPrice: round2(raw * 0.85) };
  if (row.action === 'exit_watch') return { targetBuyPrice: 0, maxBuyPrice: 0 };
  return { targetBuyPrice: round2(raw * 0.75), maxBuyPrice: round2(raw * 0.85) };
}

function hydrateRow(base, previousRows, snapshots) {
  const previous = findPrevious(base, previousRows);
  const row = {
    ...base,
    usageDeltaPercent: computeUsageDelta(base, previousRows, snapshots),
    rawDeltaPercent: computeRawDelta(base, previousRows),
    lastSeenScore: previous?.score ?? null,
    priceChartingUrl: safePriceChartingUrl(base, base.priceChartingUrl) || safePriceChartingUrl(base, previous?.priceChartingUrl) || '',
    imageUrl: base.imageUrl || previous?.imageUrl || '',
  };
  row.scores = computeScores(row);
  row.score = row.scores.total;
  row.signalTypes = deriveSignals(row);
  const derived = deriveActionAndTier(row);
  Object.assign(row, derived, targetPrices({ ...row, ...derived }));
  row.whyItMatters = explainRow(row);
  row.mainRisk = riskRow(row);
  return row;
}

function buildPopularityRow(meta, activeCard, gradingRow) {
  const rawMarket = round2(money(activeCard?.rawMarket) || money(gradingRow?.rawMarket) || meta.leaderboardUsdPrice);
  return {
    code: meta.code,
    name: activeCard?.name || gradingRow?.name || meta.name,
    setName: activeCard?.setName || gradingRow?.setName || 'Meta / OP Leaderboard',
    usagePercent: round2(meta.usagePercent),
    rawMarket,
    collectrRawMarket: round2(money(activeCard?.rawMarket)),
    leaderboardEurPrice: meta.leaderboardEurPrice,
    leaderboardUsdPrice: meta.leaderboardUsdPrice,
    psa10Market: round2(money(gradingRow?.psa10Market)),
    psa10SalesCount: Number(gradingRow?.psa10SalesCount || 0),
    imageUrl: meta.imageUrl || gradingRow?.priceChartingImageUrl || gradingRow?.collectrImageUrl || activeCard?.collectrImageUrl || '',
    priceChartingUrl: safePriceChartingUrl({ ...meta, name: activeCard?.name || gradingRow?.name || meta.name }, gradingRow?.priceChartingUrl) || '',
    collectrLink: activeCard?.collectrLink || gradingRow?.collectrLink || '',
    source: 'op-leaderboard-auto',
  };
}

function buildGradingOnlyRows(gradingRows) {
  return gradingRows
    .filter((row) => money(row.rawMarket) > 0 && money(row.psa10Market) > 0 && (money(row.roiPercent) >= 80 || (money(row.rawMarket) <= 10 && gradingRoi(row.rawMarket, row.psa10Market) >= 50)))
    .map((row) => ({
      code: row.code,
      name: row.name,
      setName: row.setName,
      usagePercent: null,
      rawMarket: round2(row.rawMarket),
      collectrRawMarket: round2(row.collectrRawMarket),
      leaderboardEurPrice: null,
      leaderboardUsdPrice: null,
      psa10Market: round2(row.psa10Market),
      psa10SalesCount: Number(row.psa10SalesCount || 0),
      imageUrl: row.priceChartingImageUrl || row.collectrImageUrl || '',
      priceChartingUrl: row.priceChartingUrl || '',
      collectrLink: row.collectrLink || '',
      source: 'grading-board-auto',
    }));
}

async function writeSnapshots(popularity, rows) {
  const current = await readJson(SNAPSHOT_PATH, { snapshots: [] });
  const snapshots = Array.isArray(current?.snapshots) ? current.snapshots : [];
  snapshots.push({
    generatedAt: new Date().toISOString(),
    cards: rows.map((row) => ({
      code: row.code,
      name: row.name,
      usagePercent: row.usagePercent,
      rawMarket: row.rawMarket,
      score: row.score,
      action: row.action,
      tier: row.tier,
    })),
    leaderboardCards: popularity.map((row) => ({ code: row.code, name: row.name, usagePercent: row.usagePercent, leaderboardEurPrice: row.leaderboardEurPrice })),
  });
  await fs.writeFile(SNAPSHOT_PATH, JSON.stringify({ snapshots: snapshots.slice(-SNAPSHOT_LIMIT) }, null, 2) + '\n', 'utf8');
}

function applyOverrides(rows, overrides) {
  const disabled = new Set(Array.isArray(overrides?.disabledCodes) ? overrides.disabledCodes.map(String) : []);
  const modifiers = Array.isArray(overrides?.modifiers) ? overrides.modifiers : [];
  return rows
    .filter((row) => !disabled.has(row.code))
    .map((row) => {
      const mod = modifiers.find((item) => item.code === row.code && (!item.nameContains || normalizeName(row.name).includes(normalizeName(item.nameContains))));
      if (!mod) return row;
      return {
        ...row,
        score: clamp(money(row.score) + money(mod.scoreDelta), 0, 100),
        tier: mod.tier || row.tier,
        action: mod.action || row.action,
        overrideNote: mod.note || 'Manual modifier applied.',
      };
    });
}

async function run() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const [activeCards, latestPayload, previousPayload, snapshotsPayload, overridesPayload] = await Promise.all([
    readJson(ACTIVE_PATH, []),
    readJson(LATEST_PATH, { rows: [] }),
    readJson(OUT_PATH, { rows: [] }),
    readJson(SNAPSHOT_PATH, { snapshots: [] }),
    readJson(OVERRIDES_PATH, {}),
  ]);
  const previousRows = Array.isArray(previousPayload?.rows) ? previousPayload.rows : [];
  const gradingRows = Array.isArray(latestPayload?.rows) ? latestPayload.rows : [];

  const html = await fetchPopularityHtml();
  const popularity = parsePopularity(html);
  if (!popularity.length) throw new Error('OP Leaderboard returned no parseable card popularity rows.');

  const generated = popularity.map((meta) => buildPopularityRow(meta, chooseActiveCard(meta, activeCards), chooseGradingRow(meta, gradingRows)));
  const gradingOnly = buildGradingOnlyRows(gradingRows);

  const byKey = new Map();
  for (const row of [...generated, ...gradingOnly]) {
    const hydrated = hydrateRow(row, previousRows, snapshotsPayload);
    const key = rowKey(hydrated);
    const existing = byKey.get(key);
    if (!existing || money(hydrated.score) > money(existing.score)) byKey.set(key, hydrated);
  }

  const rows = applyOverrides(Array.from(byKey.values()), overridesPayload)
    .filter((row) => money(row.rawMarket) > 0 || money(row.usagePercent) >= MIN_USAGE_PERCENT)
    .sort((a, b) => money(b.score) - money(a.score) || money(b.usagePercent) - money(a.usagePercent) || money(b.psa10Market) - money(a.psa10Market) || a.code.localeCompare(b.code))
    .slice(0, MAX_ROWS);

  await writeSnapshots(popularity, rows);

  const payload = {
    generatedAt: new Date().toISOString(),
    source: 'Auto-generated from OP Leaderboard card popularity, active Collectr pool, current grading board, snapshot deltas, and optional override modifiers.',
    rules: 'Repeatable scoring engine: meta usage, usage delta, raw discount, bundle fit, grading spread, liquidity, raw spike, reprint risk, condition risk. No hard-picked published rows are required.',
    filters: {
      minUsagePercent: MIN_USAGE_PERCENT,
      maxRows: MAX_ROWS,
      eurToUsd: EUR_TO_USD,
      leaderboardUrl: API_URL,
      snapshotLimit: SNAPSHOT_LIMIT,
      overridesPath: OVERRIDES_PATH,
    },
    counts: {
      leaderboardRowsParsed: popularity.length,
      generatedRows: generated.length,
      gradingOnlyRows: gradingOnly.length,
      publishedRows: rows.length,
      hot: rows.filter((row) => row.tier === 'HOT').length,
      watch: rows.filter((row) => row.tier === 'WATCH').length,
      avoid: rows.filter((row) => row.tier === 'AVOID').length,
      bundleFlip: rows.filter((row) => row.action === 'bundle_flip').length,
      gradingCandidates: rows.filter((row) => row.action === 'grade_candidate' || row.action === 'condition_watch').length,
      exitWatch: rows.filter((row) => row.action === 'exit_watch').length,
    },
    boardTypes: {
      deckCoreBundleScanner: rows.filter((row) => row.signalTypes.includes('deck_core_bundle')).length,
      reprintRiskWarnings: rows.filter((row) => row.signalTypes.includes('reprint_risk')).length,
      underMarketWatch: rows.filter((row) => row.signalTypes.includes('under_market_watch')).length,
      conditionGradingQueue: rows.filter((row) => row.signalTypes.includes('condition_grading_queue') || row.signalTypes.includes('grading_candidate')).length,
      metaMovementDelta: rows.filter((row) => money(row.usageDeltaPercent) !== 0).length,
      exitBoard: rows.filter((row) => row.signalTypes.includes('exit_watch')).length,
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
