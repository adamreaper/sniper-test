import fs from 'node:fs/promises';
import dns from 'node:dns/promises';
import https from 'node:https';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = process.env.ONE_PIECE_SNIPER_TEST_DIR || path.resolve(__dirname, '..', '..', '..');
const ENV_PATH = process.env.ONE_PIECE_SNIPER_ENV || path.join(APP_DIR, '.env.local');
const CATEGORY_IDS = ['183454'];
const MAX_SEARCH_RESULTS = 18;
const MAX_VISION_PER_CARD = 10;
const MAX_CANDIDATES_PER_CARD = 10;
const MAX_REVIEW_CANDIDATES_PER_CARD = 10;
const BASE_GRADING_COST = 33;
const HIGH_END_GRADING_THRESHOLD = 500;
const HIGH_END_GRADING_COST = 79.99;
const LIQUIDITY_HAIRCUT = 0.88;

let cachedToken = null;
let cachedExpiry = 0;
let envLoaded = false;
let cachedEbayIp = null;
let cachedEbayIpExpires = 0;

const EBAY_API_HOST = 'api.ebay.com';
const EBAY_API_FALLBACK_IPS = ['66.211.163.2', '66.211.166.2'];


function money(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function envFlag(...names) {
  return names.some((name) => /^(1|true|yes|on)$/i.test(String(process.env[name] || '')));
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
  let raw = '';
  try {
    raw = await fs.readFile(ENV_PATH, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const env = parseEnv(raw);
  for (const [k, v] of Object.entries(env)) {
    if (!(k in process.env)) process.env[k] = v;
  }
  envLoaded = true;
}

async function resolveViaDnsJson(url) {
  const response = await fetch(url, {
    headers: {
      accept: 'application/dns-json',
    },
  });
  if (!response.ok) throw new Error(`DNS JSON lookup failed (${response.status})`);
  const payload = await response.json();
  const answers = Array.isArray(payload?.Answer) ? payload.Answer : [];
  return answers
    .filter((answer) => Number(answer?.type) === 1 && /^\d+\.\d+\.\d+\.\d+$/.test(String(answer?.data || '')))
    .map((answer) => String(answer.data));
}

async function resolveEbayHostname(hostname) {
  if (hostname !== EBAY_API_HOST) {
    const resolved = await dns.lookup(hostname, { family: 4 });
    return resolved.address;
  }

  const now = Date.now();
  if (cachedEbayIp && now < cachedEbayIpExpires) return cachedEbayIp;

  try {
    const resolved = await dns.lookup(hostname, { family: 4 });
    cachedEbayIp = resolved.address;
    cachedEbayIpExpires = now + 10 * 60 * 1000;
    return cachedEbayIp;
  } catch {
    // fall through to public DNS-over-HTTPS
  }

  const dohSources = [
    `https://dns.google/resolve?name=${hostname}&type=A`,
    `https://cloudflare-dns.com/dns-query?name=${hostname}&type=A`,
  ];

  for (const source of dohSources) {
    try {
      const ips = await resolveViaDnsJson(source);
      if (ips.length) {
        cachedEbayIp = ips[0];
        cachedEbayIpExpires = now + 10 * 60 * 1000;
        return cachedEbayIp;
      }
    } catch {
      // try next resolver
    }
  }

  cachedEbayIp = EBAY_API_FALLBACK_IPS[0];
  cachedEbayIpExpires = now + 5 * 60 * 1000;
  return cachedEbayIp;
}

async function ebayFetchJsonWithDns(url, options = {}) {
  const target = typeof url === 'string' ? new URL(url) : url;
  const headers = { ...(options.headers || {}) };
  const body = options.body;

  return new Promise((resolve, reject) => {
    const request = https.request(target, {
      method: options.method || 'GET',
      headers,
      lookup(hostname, requestOptions, callback) {
        resolveEbayHostname(hostname)
          .then((ip) => {
            if (requestOptions?.all) {
              callback(null, [{ address: ip, family: 4 }]);
              return;
            }
            callback(null, ip, 4);
          })
          .catch((error) => callback(error));
      },
    }, (response) => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        raw += chunk;
      });
      response.on('end', () => {
        let data = {};
        try {
          data = raw ? JSON.parse(raw) : {};
        } catch {
          data = { raw };
        }
        resolve({
          ok: (response.statusCode || 500) >= 200 && (response.statusCode || 500) < 300,
          status: response.statusCode || 500,
          data,
        });
      });
    });

    request.on('error', reject);
    request.setTimeout(20_000, () => request.destroy(new Error(`Request timeout for ${target.hostname}`)));
    if (body) request.write(body);
    request.end();
  });
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
  const { ok, status, data } = await ebayFetchJsonWithDns('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      Authorization: `Basic ${auth}`,
    },
    body: `grant_type=client_credentials&scope=${encodeURIComponent(scope)}`,
  });

  if (!ok || !data.access_token) {
    const detail = typeof data?.error_description === 'string'
      ? data.error_description
      : typeof data?.error === 'string'
        ? data.error
        : typeof data?.raw === 'string'
          ? data.raw.slice(0, 200)
          : 'unknown error';
    throw new Error(`eBay token request failed (${status}): ${detail}`);
  }

  cachedToken = data.access_token;
  cachedExpiry = now + (Number(data.expires_in || 7200) * 1000);
  return cachedToken;
}

async function ebayFetchJson(url) {
  const token = await getEbayToken();
  const { ok, status, data } = await ebayFetchJsonWithDns(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-EBAY-C-MARKETPLACE-ID': process.env.EBAY_MARKETPLACE_ID || 'EBAY_US',
      Accept: 'application/json',
    },
  });
  if (!ok) {
    const detail = typeof data?.message === 'string'
      ? data.message
      : typeof data?.errors?.[0]?.message === 'string'
        ? data.errors[0].message
        : typeof data?.raw === 'string'
          ? data.raw.slice(0, 200)
          : 'unknown error';
    throw new Error(`eBay request failed (${status}): ${detail}`);
  }
  return data;
}

function normalizeLooseText(value) {
  return ` ${String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()} `;
}

function hasLooseTerm(haystack, needle) {
  return haystack.includes(normalizeLooseText(needle));
}

function buildNameFragments(card) {
  const cleaned = String(card.name || '')
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/[^a-z0-9.'-]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const parts = cleaned.split(' ').filter(Boolean);
  return [cleaned, parts.slice(0, 2).join(' '), parts.slice(0, 3).join(' ')].filter(Boolean);
}

function getVariantRules(card) {
  const name = String(card.name || '').toLowerCase();
  const rules = [];
  if (/manga/.test(name)) rules.push({ required: ['manga'] });
  if (/alternate art/.test(name)) rules.push({ requiredAny: ['alternate art', 'alt art'] });
  if (/parallel/.test(name)) rules.push({ required: ['parallel'] });
  if (/\(sp\)|\bsp\b/.test(name)) rules.push({ requiredAny: ['sp', 'special card', 'special art'] });
  if (/\(spr\)|\bspr\b/.test(name)) rules.push({ requiredAny: ['spr', 'super parallel'] });
  if (/wanted poster/.test(name)) rules.push({ required: ['wanted'] });
  if (/3rd anniversary/.test(name)) rules.push({ requiredAny: ['3rd anniversary', 'anniversary'] });
  if (/gold/.test(name)) rules.push({ required: ['gold'] });
  if (!/alternate art/.test(name)) rules.push({ forbiddenAny: ['alternate art', 'alt art'] });
  if (!/parallel/.test(name)) rules.push({ forbiddenAny: ['parallel'] });
  if (!/manga/.test(name)) rules.push({ forbiddenAny: ['manga'] });
  if (!/\(sp\)|\bsp\b/.test(name)) rules.push({ forbiddenAny: ['sp', 'special art', 'special card'] });
  if (!/\(spr\)|\bspr\b/.test(name)) rules.push({ forbiddenAny: ['spr', 'super parallel'] });
  return rules;
}

function buildRawQueries(card) {
  const nameBits = buildNameFragments(card);
  const setName = String(card.setName || '').replace(/^Extra Booster:\s*/i, '').trim();
  const primaryName = nameBits[0] || String(card.name || '').trim();
  const shortName = nameBits[1] || primaryName;
  const queries = [
    `"${primaryName}" "One Piece"`,
    `"${shortName}" "One Piece"`,
    card.code ? `"${card.code}" "One Piece"` : '',
    setName ? `"${primaryName}" "${setName}" "One Piece"` : '',
  ].filter(Boolean);
  return Array.from(new Set(queries));
}

async function searchLiveListings(query) {
  const url = new URL('https://api.ebay.com/buy/browse/v1/item_summary/search');
  url.searchParams.set('q', query);
  url.searchParams.set('limit', String(MAX_SEARCH_RESULTS));
  url.searchParams.set('sort', 'bestMatch');
  url.searchParams.set('filter', `buyingOptions:{FIXED_PRICE|AUCTION},conditions:{NEW|USED|LIKE_NEW|VERY_GOOD|GOOD|ACCEPTABLE|NOT_SPECIFIED},categoryIds:{${CATEGORY_IDS.join('|')}}`);
  const data = await ebayFetchJson(url);
  return Array.isArray(data.itemSummaries) ? data.itemSummaries : [];
}

async function getItem(itemId) {
  return ebayFetchJson(`https://api.ebay.com/buy/browse/v1/item/${encodeURIComponent(itemId)}`);
}

function normalizeItemSummary(item) {
  const price = money(item.price?.value ?? item.currentBidPrice?.value);
  const shipping = money(item.shippingOptions?.[0]?.shippingCost?.value);
  return {
    itemId: item.itemId,
    title: item.title || 'Untitled',
    price,
    shipping,
    total: price + shipping,
    condition: item.condition || '',
    conditionId: item.conditionId || '',
    buyingOptions: item.buyingOptions || [],
    itemWebUrl: item.itemWebUrl || null,
    imageUrl: item.image?.imageUrl || null,
    additionalImages: Array.isArray(item.additionalImages) ? item.additionalImages.map((img) => img?.imageUrl).filter(Boolean) : [],
    seller: item.seller || null,
  };
}

function hasForeignLanguageMarker(title) {
  const text = String(title || '').toLowerCase();
  return text.includes('japan')
    || text.includes('japanese')
    || text.includes('jpn')
    || /(^|[^a-z])jp([^a-z]|$)/i.test(text)
    || text.includes('asia')
    || text.includes('asian')
    || text.includes('china')
    || text.includes('chinese')
    || text.includes('korea')
    || text.includes('korean')
    || text.includes('thai')
    || text.includes('francais')
    || text.includes('french')
    || text.includes('deutsch')
    || text.includes('german')
    || text.includes('espanol')
    || text.includes('spanish')
    || text.includes('italian')
    || text.includes('portuguese');
}

function hasStockImageMarker(value) {
  const text = String(value || '').toLowerCase();
  return text.includes('stock photo')
    || text.includes('sample image')
    || text.includes('sample photo')
    || text.includes('placeholder image')
    || text.includes('display only')
    || text.includes('not actual card')
    || text.includes('generic photo')
    || text.includes('catalog image')
    || text.includes('representative image')
    || text.includes('scan shown')
    || text.includes('image for reference')
    || /\b(sample|placeholder|proxy|custom|demo)\b/i.test(text);
}

function detailSuggestsForeignLanguage(detail) {
  const aspects = Array.isArray(detail?.localizedAspects) ? detail.localizedAspects : [];
  const languageValue = aspects.find((aspect) => String(aspect?.name || '').toLowerCase() === 'language')?.value;
  return hasForeignLanguageMarker(languageValue || '');
}

function detailSuggestsStockImage(detail) {
  const parts = [detail?.title, detail?.shortDescription, detail?.description];
  return parts.some((part) => hasStockImageMarker(part));
}

function filterRawMatches(items, card) {
  const nameBits = buildNameFragments(card).map((value) => normalizeLooseText(value));

  return items.filter((item) => {
    const title = String(item.title || '');
    const lower = normalizeLooseText(title);

    if (!nameBits.some((bit) => bit && lower.includes(bit))) return false;
    if (/\b(psa|bgs|cgc|sgc|ace grading|tag|beckett|pristine|black label|graded|slab)\b/i.test(title)) return false;
    if (/\b(korean|thai|french|francais|german|deutsch|spanish|espanol|italian|portuguese|chinese)\b/i.test(title)) return false;
    if (hasStockImageMarker(title)) return false;

    return true;
  });
}

async function scoreListingPhotos(card, listing) {
  await loadEnv();
  const llmVisionEnabled = envFlag('ONE_PIECE_ENABLE_LLM_VISION', 'ENABLE_LLM_VISION');
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
  const imageUrls = [listing.imageUrl, ...(listing.additionalImages || [])].filter(Boolean).slice(0, 4);
  if (!llmVisionEnabled || !apiKey || !imageUrls.length) {
    return {
      score: 50,
      psa10Probability: 50,
      confidence: 30,
      notes: llmVisionEnabled ? 'No photo AI score available.' : 'LLM photo scoring disabled.',
      visibleLanguage: 'unknown',
      rejectForLanguage: false,
      rejectForStockImage: false,
    };
  }

  const prompt = [
    'You are grading raw trading card listing photos for PSA 10 potential.',
    `Target card: ${card.code} ${card.name}`,
    'Be strict. Penalize sleeve glare, poor centering, soft corners, edge whitening, bad crop, and missing back photo.',
    'Also inspect visible printed card text or obvious card layout language cues.',
    'Reject stock/sample/placeholder/catalog images, screenshots, digital renders, or listings that do not clearly show the actual raw card being sold.',
    'This workflow only accepts English or Japanese One Piece cards.',
    'Reject listings that clearly show another language or the wrong product entirely.',
    'Return compact JSON only with keys: score, psa10Probability, confidence, notes, visibleLanguage, rejectForLanguage, rejectForStockImage.',
    'score is 0-100 overall photo quality for PSA 10 candidacy.',
    'psa10Probability is 0-100 estimated probability the shown raw card could gem if authentic and as shown.',
    'confidence is 0-100 for how reliable the photo assessment is based on image coverage/clarity.',
    "visibleLanguage is one of: english, japanese, non-english, unknown.",
    'rejectForLanguage is true if visible card text suggests a language other than English or Japanese, or the wrong product entirely.',
    'rejectForStockImage is true if the images look like stock/sample/placeholder art, a catalog scan, or otherwise not the real card/listing photos.',
    'notes is one short sentence.',
  ].join(' ');

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'psa10_photo_score',
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              score: { type: 'number' },
              psa10Probability: { type: 'number' },
              confidence: { type: 'number' },
              notes: { type: 'string' },
              visibleLanguage: { type: 'string', enum: ['english', 'japanese', 'non-english', 'unknown'] },
              rejectForLanguage: { type: 'boolean' },
              rejectForStockImage: { type: 'boolean' }
            },
            required: ['score', 'psa10Probability', 'confidence', 'notes', 'visibleLanguage', 'rejectForLanguage', 'rejectForStockImage']
          }
        }
      },
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          ...imageUrls.map((url) => ({ type: 'image_url', image_url: { url } })),
        ],
      }],
      max_completion_tokens: 220,
    }),
  });

  const data = await response.json().catch(() => ({}));
  const text = String(data.choices?.[0]?.message?.content || '').trim();
  try {
    const parsed = JSON.parse(text);
    return {
      score: Math.max(0, Math.min(100, money(parsed.score))),
      psa10Probability: Math.max(0, Math.min(100, money(parsed.psa10Probability))),
      confidence: Math.max(0, Math.min(100, money(parsed.confidence))),
      notes: String(parsed.notes || '').trim() || 'Photo score generated.',
      visibleLanguage: ['english', 'japanese', 'non-english', 'unknown'].includes(String(parsed.visibleLanguage || '').toLowerCase())
        ? String(parsed.visibleLanguage).toLowerCase()
        : 'unknown',
      rejectForLanguage: Boolean(parsed.rejectForLanguage),
      rejectForStockImage: Boolean(parsed.rejectForStockImage),
    };
  } catch {
    return {
      score: 50,
      psa10Probability: 50,
      confidence: 20,
      notes: 'Photo score fallback used.',
      visibleLanguage: 'unknown',
      rejectForLanguage: false,
      rejectForStockImage: false,
    };
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function gradingCostForValue(value) {
  return money(value) >= HIGH_END_GRADING_THRESHOLD ? HIGH_END_GRADING_COST : BASE_GRADING_COST;
}

function computeListingRoi(card, listingTotal) {
  const gradingCost = gradingCostForValue(listingTotal);
  const costBasis = money(listingTotal) + gradingCost;
  const netExit = money(card.psa10Market) * LIQUIDITY_HAIRCUT;
  const profit = netExit - costBasis;
  const roi = costBasis > 0 ? profit / costBasis : -1;
  return {
    gradingCost: Math.round(gradingCost * 100) / 100,
    costBasis: Math.round(costBasis * 100) / 100,
    netExit: Math.round(netExit * 100) / 100,
    profit: Math.round(profit * 100) / 100,
    roi: Math.round(roi * 10000) / 10000,
    roiPercent: Math.round(roi * 10000) / 100,
  };
}

function computeCandidateRank(card, candidate) {
  const photoScore = Number(candidate.photoScore?.score || 0);
  const roiScore = clamp(Number(candidate.roi?.roiPercent || 0) / 8, 0, 35);
  const psa10ProbScore = clamp(Number(candidate.photoScore?.psa10Probability || 0) / 5, 0, 18);
  const photoQualityScore = clamp(photoScore / 5, 0, 16);
  const priceEdgePercent = card.rawMarket > 0 ? ((money(card.rawMarket) - money(candidate.total)) / money(card.rawMarket)) * 100 : 0;
  const edgeScore = clamp(priceEdgePercent / 2, -10, 15);
  const shippingPenalty = clamp(money(candidate.shipping) / 2, 0, 8);
  const sellerFeedbackPct = Number(candidate.seller?.feedbackPercentage || 0);
  const sellerFeedbackScore = clamp((sellerFeedbackPct - 95) * 2, -10, 8);
  const sellerVolumeScore = clamp(Math.log10(Math.max(1, Number(candidate.seller?.feedbackScore || 0))) * 3, 0, 8);
  const rawScore = roiScore + psa10ProbScore + photoQualityScore + edgeScore + sellerFeedbackScore + sellerVolumeScore - shippingPenalty;
  return {
    score: Math.round(clamp(rawScore, 0, 100) * 10) / 10,
    priceEdgePercent: Math.round(priceEdgePercent * 100) / 100,
    sellerFeedbackPct,
  };
}

function sortCandidates(candidates) {
  return [...candidates]
    .sort((a, b) => Number(b.rankMeta?.score || 0) - Number(a.rankMeta?.score || 0)
      || Number(b.photoScore?.psa10Probability || 0) - Number(a.photoScore?.psa10Probability || 0)
      || Number(b.roi?.roiPercent || 0) - Number(a.roi?.roiPercent || 0)
      || money(a.total) - money(b.total));
}

function pickTopCandidates(candidates) {
  return sortCandidates(candidates).slice(0, MAX_CANDIDATES_PER_CARD);
}

function pickTopReviewCandidates(candidates) {
  return sortCandidates(candidates).slice(0, MAX_REVIEW_CANDIDATES_PER_CARD);
}

export async function enrichRowsWithEbayCandidates(rows) {
  await loadEnv();
  const enriched = [];

  for (const row of rows) {
    const queries = buildRawQueries(row);
    const all = [];
    const ebayLookupErrors = [];
    for (const query of queries) {
      try {
        const items = await searchLiveListings(query);
        all.push(...items.map(normalizeItemSummary));
      } catch (error) {
        ebayLookupErrors.push({
          stage: 'search',
          query,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const deduped = Array.from(new Map(all.filter((item) => item.itemId).map((item) => [item.itemId, item])).values());
    const filtered = filterRawMatches(deduped, row).slice(0, MAX_VISION_PER_CARD);
    const scored = [];
    const reviewPool = [];

    for (const item of filtered) {
      let detail = null;
      try {
        detail = await getItem(item.itemId);
      } catch (error) {
        ebayLookupErrors.push({
          stage: 'detail',
          itemId: item.itemId,
          title: item.title,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      const listing = detail ? {
        ...item,
        imageUrl: detail.image?.imageUrl || item.imageUrl,
        additionalImages: Array.isArray(detail.additionalImages) ? detail.additionalImages.map((img) => img?.imageUrl).filter(Boolean) : item.additionalImages,
        itemWebUrl: detail.itemWebUrl || item.itemWebUrl,
        seller: detail.seller || item.seller,
      } : item;
      if (detailSuggestsStockImage(detail)) continue;
      const photoScore = await scoreListingPhotos(row, listing).catch(() => ({
        score: 50,
        psa10Probability: 50,
        confidence: 20,
        notes: 'Photo score failed.',
        visibleLanguage: 'unknown',
        rejectForLanguage: false,
        rejectForStockImage: false,
      }));
      if (photoScore.rejectForLanguage || photoScore.rejectForStockImage) continue;
      const roi = computeListingRoi(row, listing.total);
      const normalizedCandidate = {
        itemId: listing.itemId,
        title: listing.title,
        price: Math.round(money(listing.price) * 100) / 100,
        shipping: Math.round(money(listing.shipping) * 100) / 100,
        total: Math.round(money(listing.total) * 100) / 100,
        itemWebUrl: listing.itemWebUrl,
        imageUrl: listing.imageUrl,
        additionalImages: listing.additionalImages || [],
        seller: listing.seller ? {
          username: listing.seller.username || listing.seller.sellerUsername || null,
          feedbackPercentage: listing.seller.feedbackPercentage || null,
          feedbackScore: listing.seller.feedbackScore || null,
        } : null,
        photoScore,
        roi,
      };
      const rankedCandidate = {
        ...normalizedCandidate,
        rankMeta: computeCandidateRank(row, normalizedCandidate),
      };
      if (photoScore.visibleLanguage === 'unknown') {
        reviewPool.push({
          ...rankedCandidate,
          reviewReason: `Manual review: visible language = ${photoScore.visibleLanguage || 'unknown'}`,
        });
      }
      scored.push(rankedCandidate);
    }

    enriched.push({
      ...row,
      ebayCandidates: pickTopCandidates(scored),
      reviewCandidates: pickTopReviewCandidates(reviewPool),
      ebayCandidateCount: scored.length,
      ebayLookupDegraded: ebayLookupErrors.length > 0,
      ebayLookupErrors,
    });
  }

  return enriched;
}
