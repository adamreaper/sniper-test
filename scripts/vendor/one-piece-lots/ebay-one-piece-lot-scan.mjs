import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = process.env.ONE_PIECE_SNIPER_TEST_DIR || path.resolve(__dirname, '..', '..', '..');
const ENV_PATH = process.env.ONE_PIECE_SNIPER_ENV || path.join(APP_DIR, '.env.local');
const FALLBACK_ENV_PATHS = [
  path.join(APP_DIR, '..', 'psa-app', '.env.local'),
  '/home/deck/.openclaw/workspace/psa-app/.env.local',
];
const REPORT_DIR = path.join(APP_DIR, 'reports', 'one-piece-lots');
const DATE_STAMP = new Date().toISOString().slice(0, 10);
const OUT_JSON = path.join(REPORT_DIR, `one-piece-lot-scan-${DATE_STAMP}.json`);
const OUT_MD = path.join(REPORT_DIR, `one-piece-lot-scan-${DATE_STAMP}.md`);
const LATEST_JSON = path.join(REPORT_DIR, 'latest.json');
const LATEST_MD = path.join(REPORT_DIR, 'latest.md');
const APP_READY_JSON = path.join(REPORT_DIR, 'app-ready.json');
const APP_READY_MD = path.join(REPORT_DIR, 'app-ready.md');
const OUTCOMES_JSON = path.join(REPORT_DIR, 'outcomes.json');
const OUTCOMES_SUMMARY_JSON = path.join(REPORT_DIR, 'outcomes-summary.json');
const MARKETPLACE_ID = process.env.EBAY_MARKETPLACE_ID || 'EBAY_US';
const SEARCHES = [
  'one piece card lot',
  'one piece tcg lot',
  'one piece collection cards',
  'one piece bulk cards',
  'one piece cards mixed lot',
  'one piece 50 cards lot',
  'one piece 100 cards bulk',
];
const MAX_PER_QUERY = 30;
const TOP_RESULTS = 15;

let envLoaded = false;
let cachedToken = null;
let cachedExpiry = 0;

const IMAGE_REVIEW_FIXTURES = {
  '377037297915': {
    verdict: 'weak_evidence',
    confidence: 62,
    reason: 'Two featured sleeved cards are visible, but the photo still looks staged rather than proving a deep collection.',
  },
  '168289076652': {
    verdict: 'genuine_lot',
    confidence: 71,
    reason: 'Binder-page style storage and mixed foils look like a real personal collection, not a repack.',
  },
  '127711403000': {
    verdict: 'manufactured_bundle',
    confidence: 95,
    reason: 'Neatly sorted rows in a box look like organized bulk inventory, not hidden-value collection material.',
  },
  '127826949520': {
    verdict: 'manufactured_bundle',
    confidence: 93,
    reason: 'The shiny cards look deliberately staged on top of bulk to sell a prebuilt bundle.',
  },
  '397750015219': {
    verdict: 'weak_evidence',
    confidence: 55,
    reason: 'The spread could be real, but there is not enough visible depth to trust the upside.',
  },
  '227298089474': {
    verdict: 'manufactured_bundle',
    confidence: 90,
    reason: 'Uniform small stacks and display cards suggest curated bulk rather than a natural mixed lot.',
  },
};

function money(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function normalizeItemId(itemId) {
  const raw = String(itemId || '');
  return raw.includes('|') ? raw.split('|')[1] : raw;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function parseEnv(raw) {
  const env = {};
  for (const line of raw.split(/\r?\n/)) {
    if (!line || /^\s*#/.test(line)) continue;
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return env;
}

async function loadEnv() {
  if (envLoaded) return;
  const envPaths = [ENV_PATH, ...FALLBACK_ENV_PATHS];
  for (const envPath of envPaths) {
    let raw = '';
    try {
      raw = await fs.readFile(envPath, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      continue;
    }
    const env = parseEnv(raw);
    for (const [k, v] of Object.entries(env)) {
      if (!(k in process.env)) process.env[k] = v.replace(/^['\"]|['\"]$/g, '');
    }
    if (process.env.EBAY_CLIENT_ID && process.env.EBAY_CLIENT_SECRET) break;
  }
  envLoaded = true;
}

async function readJsonSafe(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function getEbayToken() {
  await loadEnv();
  const now = Date.now();
  if (cachedToken && now < cachedExpiry - 60_000) return cachedToken;
  const clientId = process.env.EBAY_CLIENT_ID;
  const clientSecret = process.env.EBAY_CLIENT_SECRET;
  const scope = process.env.EBAY_SCOPE || 'https://api.ebay.com/oauth/api_scope';
  if (!clientId || !clientSecret) throw new Error('Missing eBay credentials');
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const response = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      Authorization: `Basic ${auth}`,
    },
    body: `grant_type=client_credentials&scope=${encodeURIComponent(scope)}`,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    throw new Error(`eBay token request failed (${response.status})`);
  }
  cachedToken = data.access_token;
  cachedExpiry = now + (Number(data.expires_in || 7200) * 1000);
  return cachedToken;
}

async function ebayFetchJson(url) {
  const token = await getEbayToken();
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-EBAY-C-MARKETPLACE-ID': MARKETPLACE_ID,
      Accept: 'application/json',
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`eBay request failed (${response.status})`);
  }
  return data;
}

function normalizeSummary(item, query) {
  return {
    sourceQuery: query,
    itemId: item.itemId,
    title: item.title || 'Untitled',
    price: money(item.price?.value ?? item.currentBidPrice?.value),
    shipping: money(item.shippingOptions?.[0]?.shippingCost?.value),
    total: money(item.price?.value ?? item.currentBidPrice?.value) + money(item.shippingOptions?.[0]?.shippingCost?.value),
    itemWebUrl: item.itemWebUrl || null,
    imageUrl: item.image?.imageUrl || null,
    condition: item.condition || '',
    buyingOptions: item.buyingOptions || [],
    seller: item.seller || null,
  };
}

async function searchLots(query) {
  const url = new URL('https://api.ebay.com/buy/browse/v1/item_summary/search');
  url.searchParams.set('q', query);
  url.searchParams.set('limit', String(MAX_PER_QUERY));
  url.searchParams.set('sort', 'newlyListed');
  url.searchParams.set('filter', 'buyingOptions:{FIXED_PRICE|AUCTION},conditions:{USED},categoryIds:{183454}');
  const data = await ebayFetchJson(url);
  return Array.isArray(data.itemSummaries) ? data.itemSummaries.map((item) => normalizeSummary(item, query)) : [];
}

async function getItem(itemId) {
  return ebayFetchJson(`https://api.ebay.com/buy/browse/v1/item/${encodeURIComponent(itemId)}`);
}

function titleLower(listing) {
  return String(listing.title || '').toLowerCase();
}

function isLotLike(listing) {
  const t = titleLower(listing);
  const strongPositive = [' card lot', ' bulk', ' collection', ' mixed lot', ' assorted', ' random', ' lots ', ' 50 cards', ' 100 cards'];
  const weakPositive = [' cards', ' lot', ' mixed'];
  const negative = ['proxy', 'custom', 'reprint', 'graded', 'psa', 'bgs', 'cgc', 'single card', 'binder promo', 'premium card collection', 'starter deck', 'playmat', 'gift collection'];
  if (negative.some((token) => t.includes(token))) return false;
  const strongCount = strongPositive.filter((token) => t.includes(token)).length;
  const weakCount = weakPositive.filter((token) => t.includes(token)).length;
  const qtyMatch = t.match(/\b(\d{2,4})\+?\s*cards?\b/);
  return strongCount >= 1 || weakCount >= 2 || Boolean(qtyMatch);
}

function textBlob(listing, detail) {
  return `${listing.title || ''} ${detail?.shortDescription || ''} ${detail?.description || ''}`.toLowerCase();
}

function isJunkLot(listing, detail, cardCountGuess) {
  const t = textBlob(listing, detail);
  const negatives = [
    'binder promo',
    'seven warlords of the sea binder',
    'premium card collection',
    'official bandai sleeves',
    'card sleeves',
    'storage box',
    'deck box',
    'starter deck',
    '3 cards',
    '4 cards',
    '5 cards',
    '6 cards',
    '7 cards',
    '8 cards',
    '9 cards',
    '10 cards',
    'playset',
    'don!!',
    'guaranteed sr',
    'chance alt art',
    'mystery',
    'random pack',
    'bundle',
    'sealed bandai new',
    'pack fresh bundle',
    'gift collection',
    'promotion cards',
    'promo card',
    'repack',
  ];
  if (negatives.some((token) => t.includes(token))) return true;
  if (/\blot\*\d+\b/i.test(t) && cardCountGuess < 20) return true;
  if (/\bx\d+\b/i.test(t) && cardCountGuess < 20) return true;
  if (t.includes('binder') && !/(\d{2,4})\+?\s*cards?/.test(t) && !t.includes('collection')) return true;
  if (/guaranteed|chance|random|mystery/i.test(t) && !/auction|estate|collection/i.test(t)) return true;
  return false;
}

function guessListingType(listing) {
  const t = titleLower(listing);
  if (t.includes('binder')) return 'binder_lot';
  if (t.includes('collection')) return 'collection_lot';
  if (t.includes('bulk')) return 'bulk_lot';
  return 'mixed_lot';
}

function extractVisibleSignals(listing) {
  const t = titleLower(listing);
  const visibleHits = [];
  const scoreNotes = [];
  const add = (label, floorValue, confidence = 0.65) => visibleHits.push({ label, floorValue, confidence });
  if (t.includes('manga')) { add('manga signal', 120, 0.7); scoreNotes.push('title mentions manga'); }
  if (t.includes('sp')) { add('SP signal', 50, 0.6); scoreNotes.push('title mentions SP'); }
  if (t.includes('alternate art') || t.includes('alt art')) { add('alt-art signal', 35, 0.65); scoreNotes.push('title mentions alt art'); }
  if (t.includes('parallel')) { add('parallel signal', 20, 0.55); scoreNotes.push('title mentions parallel'); }
  if (t.includes('leader')) { add('leader signal', 8, 0.5); }
  const codeMatches = t.match(/\b(?:op|st|eb|p)\d{2,}-\d{3}\b/gi) || [];
  for (const code of codeMatches.slice(0, 4)) add(`specific card ${code.toUpperCase()}`, 12, 0.75);
  return { visibleHits, scoreNotes };
}

function estimateCardCount(listing, detail) {
  const t = textBlob(listing, detail);
  const exact = t.match(/(\d{1,4})\+?\s*(?:cards|card lot|card binder)/);
  if (exact) return Number(exact[1]);
  const lotCount = t.match(/\blot\s*of\s*(\d{1,4})\b/);
  if (lotCount) return Number(lotCount[1]);
  if (t.includes('binder collection')) return 120;
  if (t.includes('collection')) return 60;
  if (t.includes('bulk')) return 200;
  if (t.includes('binder')) return 40;
  if (t.includes('lot')) return 20;
  return 0;
}

function sellerWeaknessScore(listing, detail) {
  const t = titleLower(listing);
  let score = 0;
  if (t.includes('random') || t.includes('mixed') || t.includes('assorted')) score += 5;
  if (!/(manga|parallel|alternate art|sp|leader|op\d{2,}-\d{3})/i.test(t)) score += 4;
  const imageCount = 1 + (Array.isArray(detail?.additionalImages) ? detail.additionalImages.length : 0);
  if (imageCount >= 6) score += 2;
  if (String(detail?.shortDescription || '').trim().length < 30) score += 2;
  return clamp(score, 0, 15);
}

function hiddenValueScore(listingType, imageCount, cardCountGuess) {
  let score = 0;
  if (listingType === 'binder_lot') score += 6;
  if (listingType === 'collection_lot') score += 8;
  if (cardCountGuess >= 50) score += 6;
  if (cardCountGuess >= 100) score += 2;
  if (imageCount >= 6) score += 4;
  if (imageCount <= 1) score -= 4;
  return clamp(score, 0, 20);
}

function gradingUpsideScore(detail) {
  const imageCount = 1 + (Array.isArray(detail?.additionalImages) ? detail.additionalImages.length : 0);
  return clamp((imageCount - 1) * 1.5, 0, 10);
}

function liquidityScore(visibleHits) {
  const floor = visibleHits.reduce((sum, hit) => sum + hit.floorValue, 0);
  if (floor >= 120) return 9;
  if (floor >= 60) return 7;
  if (floor >= 25) return 5;
  return 3;
}

function frictionPenalty(listing, detail) {
  let penalty = 0;
  if (listing.shipping > 12) penalty += 4;
  if (listing.shipping > 20) penalty += 3;
  const sellerPct = Number(detail?.seller?.feedbackPercentage || listing?.seller?.feedbackPercentage || 0);
  if (sellerPct > 0 && sellerPct < 98) penalty += 3;
  if (listing.total > 250) penalty += 3;
  return clamp(penalty, 0, 15);
}

function recommendationFor(score) {
  if (score >= 80) return 'buy_now';
  if (score >= 65) return 'strong_review';
  if (score >= 50) return 'watch';
  return 'ignore';
}

function imageReviewFor(itemId) {
  const normalized = normalizeItemId(itemId);
  return IMAGE_REVIEW_FIXTURES[normalized] || null;
}

function hardGatesFor(row) {
  const gates = {
    imageVerdictOk: row.imageReview?.verdict !== 'manufactured_bundle',
    priceOk: row.total <= row.maxBuyPrice,
    evidenceOk: row.imageReview?.verdict === 'genuine_lot' || row.visibleFloorValue >= 25,
    shippingOk: row.shipping <= 12,
  };
  return { ...gates, passed: Object.values(gates).every(Boolean) };
}

function riskLevelFor(row) {
  let risk = 0;
  if (row.imageReview?.verdict === 'weak_evidence') risk += 2;
  if (row.imageReview?.verdict === 'manufactured_bundle') risk += 4;
  if (row.total > row.maxBuyPrice) risk += 2;
  if (row.shipping > 12) risk += 1;
  if (row.visibleFloorValue === 0) risk += 2;
  if (Number(row.seller?.feedbackPercentage || 100) < 98) risk += 1;
  if (risk >= 5) return 'high';
  if (risk >= 3) return 'medium';
  return 'low';
}

function topReasonsFor(row) {
  const reasons = [];
  if (row.imageReview?.verdict === 'genuine_lot') reasons.push('image review says genuine lot');
  if (row.visibleHits.length) reasons.push(`visible signals: ${row.visibleHits.map((hit) => hit.label).slice(0, 2).join(', ')}`);
  if (row.expectedValue > row.total) reasons.push(`expected spread ${Math.round(row.expectedValue - row.total)} over ask`);
  if (row.cardCountGuess >= 100) reasons.push(`large lot estimate around ${row.cardCountGuess} cards`);
  if (row.shipping === 0) reasons.push('free shipping');
  return reasons.slice(0, 3);
}

function topRisksFor(row) {
  const risks = [];
  if (row.imageReview?.verdict === 'weak_evidence') risks.push('photos still need manual confirmation');
  if (row.total > row.maxBuyPrice) risks.push('ask is above current max buy');
  if (row.visibleFloorValue === 0) risks.push('value depends on hidden hits, not visible proof');
  if (row.shipping > 12) risks.push('shipping eats margin');
  if (Number(row.seller?.feedbackPercentage || 100) < 98) risks.push('seller feedback is below 98%');
  return risks.slice(0, 3);
}

function scoreBreakdownFor(row) {
  return {
    profitScore: Math.round(clamp(((row.expectedValue - row.total) / Math.max(20, row.total)) * 40, 0, 100) * 10) / 10,
    confidenceScore: row.imageReview?.confidence || 50,
    evidenceScore: Math.round(clamp((row.visibleFloorValue / Math.max(20, row.total)) * 100, 0, 100) * 10) / 10,
    liquidityScore: Math.round(clamp((row.liquidityScore / 9) * 100, 0, 100) * 10) / 10,
    sellerQualityScore: Math.round(clamp(Number(row.seller?.feedbackPercentage || 97), 0, 100) * 10) / 10,
    junkRiskPenalty: Math.round(clamp((row.frictionPenalty + (row.imageReview?.verdict === 'manufactured_bundle' ? 12 : 0)) / 27 * 100, 0, 100) * 10) / 10,
  };
}

function summarizeOutcomes(outcomes) {
  const closed = outcomes.filter((row) => row.status === 'closed');
  const bought = outcomes.filter((row) => row.decision === 'bought');
  const realized = closed.filter((row) => Number.isFinite(Number(row.realizedProfit)));
  const avg = (items, selector) => items.length ? Math.round((items.reduce((sum, item) => sum + Number(selector(item) || 0), 0) / items.length) * 100) / 100 : 0;
  return {
    totalTracked: outcomes.length,
    totalBought: bought.length,
    totalClosed: closed.length,
    avgPredictedProfit: avg(outcomes, (row) => row.predictedProfit),
    avgRealizedProfit: avg(realized, (row) => row.realizedProfit),
    avgPredictionError: avg(realized, (row) => Math.abs(Number(row.realizedProfit || 0) - Number(row.predictedProfit || 0))),
    updatedAt: new Date().toISOString(),
  };
}

function scoreWithImageReview(baseScore, review) {
  if (!review) return baseScore;
  const delta = review.verdict === 'genuine_lot'
    ? 12
    : review.verdict === 'weak_evidence'
      ? -6
      : -18;
  return Math.round(clamp(baseScore + delta, 0, 100) * 10) / 10;
}

function appTierFor(row) {
  if (row.imageReview?.verdict === 'manufactured_bundle') return 'skip';
  if (row.imageReview?.verdict === 'genuine_lot' && row.appScore >= 45) return 'review';
  if (row.imageReview?.verdict === 'weak_evidence' && row.appScore >= 55) return 'watch';
  if (!row.imageReview && row.hardGates?.passed && row.riskLevel === 'low' && row.appScore >= 42) return 'review';
  if (!row.imageReview && row.hardGates?.priceOk && row.cardCountGuess >= 50 && row.appScore >= 30) return 'watch';
  return 'skip';
}

function uiNoteFor(row) {
  if (row.imageReview?.verdict === 'genuine_lot') return 'Real-lot signal from image check.';
  if (row.imageReview?.verdict === 'weak_evidence') return 'Possible lot, but photos still need manual review.';
  if (!row.imageReview && row.hardGates?.passed) return 'No image fixture yet; passes price/evidence/shipping gates, manually inspect photos before buying.';
  if (!row.imageReview && row.cardCountGuess >= 50) return 'Large lot watch; value depends on manual photo review.';
  return 'Low conviction lot.';
}

function buildLotAnalysis(listing, detail) {
  const listingType = guessListingType(listing);
  const blob = textBlob(listing, detail);
  const { visibleHits, scoreNotes } = extractVisibleSignals(listing);
  const visibleFloorValue = Math.round(visibleHits.reduce((sum, hit) => sum + hit.floorValue, 0) * 100) / 100;
  const imageCount = 1 + (Array.isArray(detail?.additionalImages) ? detail.additionalImages.length : 0);
  const cardCountGuess = estimateCardCount(listing, detail);
  const sellerWeakness = sellerWeaknessScore(listing, detail);
  const hiddenValue = hiddenValueScore(listingType, imageCount, cardCountGuess);
  const gradingUpside = gradingUpsideScore(detail);
  const liquidity = liquidityScore(visibleHits);
  const friction = frictionPenalty(listing, detail);
  const manufacturedBundlePenalty = /guaranteed|chance alt art|random pack|mystery|bundle/i.test(blob) ? 12 : 0;
  const sparseEvidencePenalty = visibleFloorValue === 0 && imageCount <= 2 ? 8 : 0;
  const priceDislocation = clamp(((visibleFloorValue - listing.total) / Math.max(20, listing.total)) * 20 + (cardCountGuess >= 50 ? 4 : 0), -10, 20);
  const expectedValue = Math.round((visibleFloorValue + (hiddenValue * 6) + (gradingUpside * 2) - manufacturedBundlePenalty) * 100) / 100;
  const upsideValue = Math.round((expectedValue + hiddenValue * 8 + gradingUpside * 3) * 100) / 100;
  const lotScore = Math.round(clamp((visibleFloorValue > 0 ? clamp(visibleFloorValue / 8, 0, 20) : 2) + hiddenValue + sellerWeakness + priceDislocation + liquidity + gradingUpside - friction - manufacturedBundlePenalty - sparseEvidencePenalty, 0, 100) * 10) / 10;
  const maxBuyPrice = Math.round((expectedValue * 0.72) * 100) / 100;
  const maxBidPrice = Math.round((expectedValue * 0.65) * 100) / 100;
  const flags = [];
  if (visibleFloorValue === 0) flags.push('low_visible_value');
  if (listing.shipping > 12) flags.push('high_shipping');
  if (cardCountGuess >= 50) flags.push('large_lot');
  if (listingType === 'binder_lot') flags.push('binder_hidden_value');
  if (priceDislocation > 8) flags.push('priced_below_visible_floor');
  const imageReview = imageReviewFor(listing.itemId);
  const appScore = scoreWithImageReview(lotScore, imageReview);
  const recommendation = recommendationFor(lotScore);
  const provisionalHardGates = hardGatesFor({ total: listing.total, maxBuyPrice, visibleFloorValue, shipping: listing.shipping, imageReview });
  const provisionalRiskLevel = riskLevelFor({ total: listing.total, maxBuyPrice, visibleFloorValue, shipping: listing.shipping, seller: detail?.seller || listing.seller, imageReview });
  const appTier = appTierFor({ appScore, imageReview, hardGates: provisionalHardGates, riskLevel: provisionalRiskLevel, cardCountGuess });
  const seller = detail?.seller ? {
    username: detail.seller.username || detail.seller.sellerUsername || null,
    feedbackPercentage: detail.seller.feedbackPercentage || listing.seller?.feedbackPercentage || null,
    feedbackScore: detail.seller.feedbackScore || listing.seller?.feedbackScore || null,
  } : listing.seller || null;
  const predictedProfit = Math.round((expectedValue - listing.total) * 100) / 100;
  const scoreBreakdown = scoreBreakdownFor({ total: listing.total, expectedValue, visibleFloorValue, liquidityScore: liquidity, frictionPenalty: friction, seller, imageReview });
  const riskLevel = provisionalRiskLevel;
  const topReasons = topReasonsFor({ expectedValue, total: listing.total, imageReview, visibleHits, cardCountGuess, shipping: listing.shipping });
  const topRisks = topRisksFor({ total: listing.total, maxBuyPrice, visibleFloorValue, shipping: listing.shipping, seller, imageReview });
  const hardGates = provisionalHardGates;
  return {
    ...listing,
    listingType,
    imageCount,
    cardCountGuess,
    visibleHits,
    visibleFloorValue,
    expectedValue,
    upsideValue,
    sellerWeaknessScore: sellerWeakness,
    hiddenValueScore: hiddenValue,
    priceDislocationScore: Math.round(priceDislocation * 10) / 10,
    liquidityScore: liquidity,
    gradingUpsideScore: gradingUpside,
    frictionPenalty: friction,
    lotScore,
    appScore,
    maxBuyPrice,
    maxBidPrice,
    recommendation,
    appTier,
    predictedProfit,
    scoreBreakdown,
    riskLevel,
    topReasons,
    topRisks,
    hardGates,
    uiNote: uiNoteFor({ appScore, imageReview, hardGates, cardCountGuess }),
    imageReview,
    scoreNotes,
    flags,
    seller,
  };
}

async function main() {
  await fs.mkdir(REPORT_DIR, { recursive: true });
  const outcomes = await readJsonSafe(OUTCOMES_JSON, []);
  const outcomesByItemId = new Map((Array.isArray(outcomes) ? outcomes : []).map((row) => [normalizeItemId(row.itemId || row.listingId), row]));
  const all = [];
  for (const query of SEARCHES) {
    const results = await searchLots(query).catch((error) => {
      console.warn(`lot search failed for ${query}: ${error?.message || error}`);
      return [];
    });
    all.push(...results.filter(isLotLike));
  }
  const deduped = Array.from(new Map(all.filter((item) => item.itemId).map((item) => [item.itemId, item])).values());

  const analyses = [];
  for (const listing of deduped) {
    const detail = await getItem(listing.itemId).catch(() => null);
    const analyzed = buildLotAnalysis(listing, detail || {});
    const lotWords = /(lot|bulk|collection|mixed|assorted|binder|cards)/i.test(analyzed.title);
    const repeatedSingles = analyzed.title.match(/lot\*\d+|x\d+|\bset of \d+/i);
    const strongLotSignal = analyzed.cardCountGuess >= 20 || /collection|bulk|\d{2,4}\+?\s*cards/i.test(textBlob(analyzed, detail || {}));
    const binderNeedsEvidence = analyzed.listingType !== 'binder_lot' || analyzed.cardCountGuess >= 40 || analyzed.imageCount >= 10;
    if (!lotWords) continue;
    if (isJunkLot(analyzed, detail || {}, analyzed.cardCountGuess)) continue;
    if (!strongLotSignal) continue;
    if (!binderNeedsEvidence) continue;
    if (repeatedSingles && analyzed.cardCountGuess < 20 && analyzed.visibleFloorValue < 40) continue;
    if (analyzed.lotScore < 18) continue;
    analyses.push(analyzed);
  }

  const ranked = analyses
    .filter((item) => item.total > 0)
    .sort((a, b) => b.appScore - a.appScore || b.expectedValue - a.expectedValue || a.total - b.total);

  const payload = {
    generatedAt: new Date().toISOString(),
    marketplace: MARKETPLACE_ID,
    searches: SEARCHES,
    listingCount: ranked.length,
    rows: ranked.slice(0, TOP_RESULTS),
  };

  const appRows = ranked
    .filter((row) => row.appTier !== 'skip')
    .slice(0, 10)
    .map((row, index) => {
      const outcome = outcomesByItemId.get(normalizeItemId(row.itemId)) || null;
      return {
        rank: index + 1,
        itemId: row.itemId,
        title: row.title,
        url: row.itemWebUrl,
        imageUrl: row.imageUrl,
        price: row.price,
        shipping: row.shipping,
        total: row.total,
        lotType: row.listingType,
        cardCountGuess: row.cardCountGuess,
        score: row.appScore,
        tier: row.appTier,
        predictedProfit: row.predictedProfit,
        maxBuyPrice: row.maxBuyPrice,
        expectedValue: row.expectedValue,
        sellerFeedbackPercent: row.seller?.feedbackPercentage || null,
        imageVerdict: row.imageReview?.verdict || 'not_reviewed',
        imageConfidence: row.imageReview?.confidence || null,
        riskLevel: row.riskLevel,
        scoreBreakdown: row.scoreBreakdown,
        topReasons: row.topReasons,
        topRisks: row.topRisks,
        hardGatesPassed: row.hardGates?.passed || false,
        note: row.uiNote,
        reason: row.imageReview?.reason || 'No image review yet.',
        visibleSignals: row.visibleHits.map((hit) => hit.label),
        outcomeStatus: outcome?.status || 'untracked',
        decision: outcome?.decision || null,
        decisionAt: outcome?.decisionAt || null,
        realizedProfit: outcome?.realizedProfit ?? null,
        predictionError: outcome?.realizedProfit != null ? Math.round(Math.abs(Number(outcome.realizedProfit) - row.predictedProfit) * 100) / 100 : null,
      };
    });

  const appPayload = {
    generatedAt: payload.generatedAt,
    listingCount: appRows.length,
    summary: {
      reviewCount: appRows.filter((row) => row.tier === 'review').length,
      watchCount: appRows.filter((row) => row.tier === 'watch').length,
      avgScore: appRows.length ? Math.round((appRows.reduce((sum, row) => sum + Number(row.score || 0), 0) / appRows.length) * 10) / 10 : 0,
      avgPredictedProfit: appRows.length ? Math.round((appRows.reduce((sum, row) => sum + Number(row.predictedProfit || 0), 0) / appRows.length) * 100) / 100 : 0,
    },
    rows: appRows,
  };

  await fs.writeFile(OUT_JSON, JSON.stringify(payload, null, 2), 'utf8');
  await fs.writeFile(LATEST_JSON, JSON.stringify(payload, null, 2), 'utf8');

  const lines = [];
  lines.push('# One Piece bulk-lot scan');
  lines.push(`Generated: ${payload.generatedAt}`);
  lines.push(`Listings scored: ${ranked.length}`);
  lines.push('');
  payload.rows.forEach((row, index) => {
    lines.push(`${index + 1}. ${row.title}`);
    lines.push(`   Score ${row.appScore} | tier ${row.appTier} | total ${row.total.toFixed(2)} | expected ${row.expectedValue.toFixed(2)} | max buy ${row.maxBuyPrice.toFixed(2)}`);
    lines.push(`   Type: ${row.listingType} | cards~ ${row.cardCountGuess} | image ${row.imageReview?.verdict || 'not_reviewed'} | seller ${row.seller?.feedbackPercentage || 'n/a'}%`);
    lines.push(`   Note: ${row.uiNote}`);
    if (row.visibleHits.length) lines.push(`   Visible signals: ${row.visibleHits.map((hit) => `${hit.label} ~$${hit.floorValue}`).join(', ')}`);
    lines.push(`   ${row.itemWebUrl}`);
    lines.push('');
  });

  const appLines = [];
  appLines.push('# One Piece lots app-ready feed');
  appLines.push(`Generated: ${appPayload.generatedAt}`);
  appLines.push(`Review: ${appPayload.summary.reviewCount} | Watch: ${appPayload.summary.watchCount}`);
  appLines.push('');
  appPayload.rows.forEach((row) => {
    appLines.push(`${row.rank}. [${row.tier}] ${row.title}`);
    appLines.push(`   Total ${row.total.toFixed(2)} | Max buy ${row.maxBuyPrice.toFixed(2)} | Score ${row.score}`);
    appLines.push(`   ${row.note}`);
    appLines.push(`   ${row.url}`);
    appLines.push('');
  });

  const report = `${lines.join('\n')}\n`;
  const appReport = `${appLines.join('\n')}\n`;
  const outcomeSummary = summarizeOutcomes(Array.isArray(outcomes) ? outcomes : []);
  await fs.writeFile(OUT_MD, report, 'utf8');
  await fs.writeFile(LATEST_MD, report, 'utf8');
  await fs.writeFile(APP_READY_JSON, JSON.stringify(appPayload, null, 2), 'utf8');
  await fs.writeFile(APP_READY_MD, appReport, 'utf8');
  await fs.writeFile(OUTCOMES_JSON, JSON.stringify(Array.isArray(outcomes) ? outcomes : [], null, 2), 'utf8');
  await fs.writeFile(OUTCOMES_SUMMARY_JSON, JSON.stringify(outcomeSummary, null, 2), 'utf8');

  console.log(`One Piece lot scan complete.\nJSON: ${OUT_JSON}\nMD: ${OUT_MD}\nAPP: ${APP_READY_JSON}`);
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});
