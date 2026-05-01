import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, '..');
const DASHBOARD_DIR = process.env.ONE_PIECE_DASHBOARD_DIR || path.join(APP_DIR, 'data');
const FEED_PATH = path.join(DASHBOARD_DIR, 'latest.json');
const JSON_OUT = path.join(DASHBOARD_DIR, 'trade-plan.json');
const REVIEW_OUT = path.join(DASHBOARD_DIR, 'signal-outcomes.json');
const OUTPUT_DIR = path.join(APP_DIR, 'reports', 'one-piece-hybrid');

function money(n) {
  const value = Number(n);
  return Number.isFinite(value) ? value : 0;
}

function pct(n) {
  const value = Number(n);
  return Number.isFinite(value) ? value : 0;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round(value, places = 2) {
  const factor = 10 ** places;
  return Math.round((Number(value) || 0) * factor) / factor;
}

function fmt(n) {
  return `$${money(n).toFixed(2)}`;
}

function deriveTargetBuyPrice(netExit, gradingCost, targetRoiPercent, modifiers = {}) {
  if (netExit <= 0) return 0;
  const liquidityBump = Number(modifiers.liquidityBump || 0);
  const entryPenalty = Number(modifiers.entryPenalty || 0);
  const spreadBonus = Number(modifiers.spreadBonus || 0);
  const adjustedRoi = Math.max(45, targetRoiPercent - spreadBonus + entryPenalty - liquidityBump);
  const maxAllIn = netExit / (1 + (adjustedRoi / 100));
  return round(Math.max(0, maxAllIn - gradingCost));
}

function mapConfidenceTier(score) {
  if (score >= 80) return 'A';
  if (score >= 68) return 'B';
  if (score >= 54) return 'C';
  return 'D';
}

function buildReasonList(plan) {
  const reasons = [];
  if (plan.psa10SpreadMultiple >= 6) reasons.push('PSA 10 spread is huge versus raw market');
  else if (plan.psa10SpreadMultiple >= 4) reasons.push('Strong PSA 10 spread versus raw market');
  if (plan.psa10SalesCount >= 8) reasons.push('PSA 10 sales are liquid enough to matter');
  else if (plan.psa10SalesCount >= 5) reasons.push('PSA 10 comp depth is acceptable');
  if (plan.ungradedSalesCount >= 12) reasons.push('Raw sales volume supports manual searching');
  else if (plan.ungradedSalesCount >= 8) reasons.push('Raw sales activity is healthy');
  if (plan.expectedPsaNet >= 500) reasons.push('Absolute upside is meaningful after fees');
  else if (plan.expectedPsaNet >= 200) reasons.push('Profit potential clears a solid bar after fees');
  if (plan.searchScore >= 115) reasons.push('Search score says the card is bubbling to the top');
  if (plan.collectrRawDeltaPercent <= 18 && plan.collectrRawMarket > 0) reasons.push('Collectr raw market is reasonably aligned with the board');
  return reasons.slice(0, 4);
}

function buildRiskFlags(plan) {
  const flags = [];
  if (plan.psa10SalesCount < 5) flags.push('low_psa10_liquidity');
  if (plan.ungradedSalesCount < 8) flags.push('thin_raw_sales');
  if (plan.collectrRawMarket <= 0) flags.push('missing_collectr_raw_anchor');
  if (plan.collectrRawDeltaPercent > 35) flags.push('collectr_raw_drift');
  if (plan.roiPercent > 1800) flags.push('roi_outlier');
  if (plan.rawMarket > 250) flags.push('high_raw_entry_price');
  if (plan.expectedPsaNet < 150) flags.push('low_absolute_profit');
  if (plan.noVerifiedListingPull) flags.push('search_only_no_live_pull');
  return flags;
}

function biggestRiskLabel(flags) {
  const priority = [
    'collectr_raw_drift',
    'roi_outlier',
    'low_psa10_liquidity',
    'thin_raw_sales',
    'high_raw_entry_price',
    'low_absolute_profit',
    'missing_collectr_raw_anchor',
    'search_only_no_live_pull'
  ];
  return priority.find((flag) => flags.includes(flag)) ?? flags[0] ?? 'needs_manual_search';
}

function riskLabel(flag) {
  const labels = {
    low_psa10_liquidity: 'PSA 10 comp depth is still thin',
    thin_raw_sales: 'Raw sales count is thin for conviction',
    missing_collectr_raw_anchor: 'Collectr raw market is missing',
    collectr_raw_drift: 'Collectr raw market drifts too far from board pricing',
    roi_outlier: 'ROI is so extreme it may be a false spread',
    high_raw_entry_price: 'Raw entry price is high enough to slow turnover',
    low_absolute_profit: 'Absolute dollar profit is smaller than it looks',
    search_only_no_live_pull: 'No verified eBay pull yet — this is still a manual search workflow'
  };
  return labels[flag] || flag.replace(/_/g, ' ');
}

function reasonLabel(reason) {
  return reason;
}

function reviewTags(plan) {
  const tags = [];
  if (plan.rawMarket <= 75) tags.push('low-entry');
  if (plan.psa10SalesCount >= 8 && plan.ungradedSalesCount >= 10) tags.push('liquid');
  if (/manga|silver|sp|spr/i.test(`${plan.name} ${plan.setName} ${plan.rarity || ''}`)) tags.push('chase');
  if (plan.psa10SpreadMultiple >= 4) tags.push('wide-spread');
  return tags;
}

function scorePlan(plan) {
  const roiScore = clamp(plan.roiPercent / 12, 0, 18);
  const spreadScore = clamp((plan.psa10SpreadMultiple - 1.25) * 5.5, 0, 18);
  const profitScore = clamp(plan.expectedPsaNet / 45, 0, 18);
  const psaLiquidityScore = clamp(plan.psa10SalesCount * 2.2, 0, 18);
  const rawLiquidityScore = clamp(plan.ungradedSalesCount * 1.1, 0, 14);
  const searchScoreComponent = clamp((plan.searchScore - 70) / 3, 0, 14);
  const collectrAlignmentScore = plan.collectrRawMarket > 0 ? clamp((25 - plan.collectrRawDeltaPercent) / 2, -8, 10) : -4;

  let penalty = 0;
  if (plan.psa10SalesCount < 5) penalty += 10;
  if (plan.ungradedSalesCount < 8) penalty += 8;
  if (plan.collectrRawDeltaPercent > 35) penalty += 10;
  if (plan.roiPercent > 1800) penalty += 10;
  if (plan.expectedPsaNet < 150) penalty += 8;
  if (plan.rawMarket > 250) penalty += 4;

  const score = clamp(
    roiScore + spreadScore + profitScore + psaLiquidityScore + rawLiquidityScore + searchScoreComponent + collectrAlignmentScore - penalty,
    0,
    100
  );

  const riskFlags = buildRiskFlags(plan);
  const topReasons = buildReasonList(plan);

  let action = 'pass';
  if (
    score >= 76 &&
    plan.psa10SalesCount >= 5 &&
    plan.ungradedSalesCount >= 8 &&
    plan.expectedPsaNet >= 225 &&
    !riskFlags.includes('collectr_raw_drift') &&
    !riskFlags.includes('roi_outlier')
  ) {
    action = 'priority-search';
  } else if (score >= 50 && plan.expectedPsaNet >= 100) {
    action = 'watch';
  }

  const confidenceTier = mapConfidenceTier(score);
  const gradingCost = plan.gradingCost > 0 ? plan.gradingCost : 33;
  const pricingModifiers = {
    liquidityBump: plan.psa10SalesCount >= 8 ? 12 : plan.psa10SalesCount >= 5 ? 6 : 0,
    entryPenalty: plan.rawMarket >= 500 ? 28 : plan.rawMarket >= 200 ? 14 : plan.rawMarket >= 100 ? 6 : 0,
    spreadBonus: plan.psa10SpreadMultiple >= 4 ? 18 : plan.psa10SpreadMultiple >= 2.75 ? 10 : plan.psa10SpreadMultiple >= 2 ? 4 : 0,
  };
  const idealBuyPrice = deriveTargetBuyPrice(plan.netPsa10Exit, gradingCost, 210, pricingModifiers);
  const targetBuyPrice = deriveTargetBuyPrice(plan.netPsa10Exit, gradingCost, 160, pricingModifiers);
  const stretchBuyPrice = deriveTargetBuyPrice(plan.netPsa10Exit, gradingCost, 120, pricingModifiers);
  const maxBuyPrice = deriveTargetBuyPrice(plan.netPsa10Exit, gradingCost, 95, pricingModifiers);
  const exitZoneLow = round(plan.netPsa10Exit * 0.92);
  const exitZoneHigh = round(plan.netPsa10Exit * 1.03);

  return {
    ...plan,
    discoveryScore: round(score, 1),
    buyScore: round(score, 1),
    confidenceTier,
    action,
    riskFlags,
    topReasons,
    biggestRisk: biggestRiskLabel(riskFlags),
    idealBuyPrice,
    targetBuyPrice,
    stretchBuyPrice,
    maxBuyPrice,
    exitZoneLow,
    exitZoneHigh,
    reviewTags: reviewTags(plan),
    reviewSummary: action === 'priority-search'
      ? 'Search this one first.'
      : action === 'watch'
        ? 'Worth checking, but not first in line.'
        : 'Pass for now unless the market shifts.'
  };
}

function normalizeRows(feed) {
  const rows = Array.isArray(feed.rows) ? feed.rows : [];
  const cards = Array.isArray(feed.cards) ? feed.cards : [];
  const sourceRows = rows.length ? rows : cards;
  return sourceRows.map((row, index) => {
    const psa10Market = money(row.psa10Market);
    const rawMarket = money(row.rawMarket);
    const netPsa10Exit = money(row.netPsa10Exit);
    const gradingCost = money(row.gradingCost || 33);
    const collectrRawMarket = money(row.collectrRawMarket);
    const costBasis = money(row.costBasis || rawMarket + gradingCost);
    const expectedPsaNet = money(row.profit ?? row.expectedPsaNet ?? (netPsa10Exit - costBasis));
    const roiPercent = pct(row.roiPercent ?? ((expectedPsaNet / Math.max(costBasis, 1)) * 100));
    const collectrRawDeltaPercent = collectrRawMarket > 0 && rawMarket > 0
      ? Math.abs(((collectrRawMarket - rawMarket) / rawMarket) * 100)
      : 100;
    return {
      sourceRank: index + 1,
      code: row.code,
      name: row.name,
      setName: row.setName,
      rarity: row.rarity || null,
      productId: row.productId || null,
      priceChartingPath: row.priceChartingPath || null,
      priceChartingUrl: row.priceChartingUrl || null,
      priceChartingImageUrl: row.priceChartingImageUrl || null,
      marketContext: row.marketContext || null,
      collectrLink: row.collectrLink || null,
      searchScore: Number(row.searchScore || 0),
      rawMarket,
      psa10Market,
      netPsa10Exit,
      gradingCost,
      costBasis,
      expectedPsaNet,
      profit: expectedPsaNet,
      roiPercent,
      psa10SalesCount: Number(row.psa10SalesCount || 0),
      ungradedSalesCount: Number(row.ungradedSalesCount || 0),
      bgs10SalesCount: Number(row.bgs10SalesCount || 0),
      collectrRawMarket,
      collectrRawDeltaPercent: round(collectrRawDeltaPercent, 2),
      psa10SpreadMultiple: rawMarket > 0 ? round(psa10Market / rawMarket, 2) : 0,
      noVerifiedListingPull: true,
      marketStats: row.marketStats || null
    };
  });
}

function sortPlans(plans) {
  const actionWeight = { 'priority-search': 3, watch: 2, pass: 1 };
  return [...plans]
    .sort((a, b) => (
      (actionWeight[b.action] - actionWeight[a.action]) ||
      (b.discoveryScore - a.discoveryScore) ||
      (b.expectedPsaNet - a.expectedPsaNet) ||
      (b.psa10SalesCount - a.psa10SalesCount) ||
      (b.searchScore - a.searchScore) ||
      (a.sourceRank - b.sourceRank)
    ))
    .map((plan, index) => ({ ...plan, rank: index + 1 }));
}

function buildReviewQueue(plans) {
  return plans
    .filter((plan) => plan.action === 'priority-search' || (plan.action === 'watch' && plan.discoveryScore >= 68))
    .slice(0, 5)
    .map((plan, index) => ({
      queueRank: index + 1,
      code: plan.code,
      name: plan.name,
      setName: plan.setName,
      action: plan.action,
      confidenceTier: plan.confidenceTier,
      discoveryScore: plan.discoveryScore,
      targetBuyPrice: plan.targetBuyPrice,
      idealBuyPrice: plan.idealBuyPrice,
      stretchBuyPrice: plan.stretchBuyPrice,
      maxBuyPrice: plan.maxBuyPrice,
      exitZoneLow: plan.exitZoneLow,
      exitZoneHigh: plan.exitZoneHigh,
      whyInteresting: plan.topReasons[0] || 'Signal stack is decent enough to investigate manually.',
      biggestRisk: riskLabel(plan.biggestRisk),
      reviewSummary: plan.reviewSummary,
      reviewTags: plan.reviewTags,
      collectrLink: plan.collectrLink,
      priceChartingUrl: plan.priceChartingUrl || (plan.priceChartingPath ? `https://www.pricecharting.com${plan.priceChartingPath}` : null)
    }));
}

async function readJsonSafe(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

async function updateSignalOutcomes(plans) {
  const existing = await readJsonSafe(REVIEW_OUT, { entries: [] });
  const existingByCode = new Map((Array.isArray(existing.entries) ? existing.entries : []).map((entry) => [entry.code, entry]));
  const entries = plans.slice(0, 24).map((plan) => {
    const previous = existingByCode.get(plan.code) || {};
    return {
      code: plan.code,
      name: plan.name,
      setName: plan.setName,
      action: plan.action,
      confidenceTier: plan.confidenceTier,
      discoveryScore: plan.discoveryScore,
      targetBuyPrice: plan.targetBuyPrice,
      maxBuyPrice: plan.maxBuyPrice,
      exitZoneLow: plan.exitZoneLow,
      exitZoneHigh: plan.exitZoneHigh,
      outcomeStatus: previous.outcomeStatus || 'unreviewed',
      outcomeTag: previous.outcomeTag || '',
      notes: previous.notes || '',
      lastReviewedAt: previous.lastReviewedAt || null
    };
  });
  const payload = {
    generatedAt: new Date().toISOString(),
    instructions: {
      purpose: 'Manual review ledger for sniper-test signals.',
      outcomeStatusOptions: ['unreviewed', 'checked', 'bought', 'missed', 'rejected'],
      outcomeTagExamples: ['found_real_opportunity', 'overpriced', 'fake_spread', 'low_liquidity', 'not_clean_enough']
    },
    entries
  };
  await fs.writeFile(REVIEW_OUT, JSON.stringify(payload, null, 2), 'utf8');
}

async function run() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const feed = JSON.parse(await fs.readFile(FEED_PATH, 'utf8'));
  const normalized = normalizeRows(feed);
  if (!normalized.length) throw new Error(`No plans could be derived from ${FEED_PATH}`);

  const plans = sortPlans(normalized.map(scorePlan));
  const reviewQueue = buildReviewQueue(plans);

  const payload = {
    generatedAt: new Date().toISOString(),
    sourceFeedUpdatedAt: feed.updatedAt || feed.generatedAt || null,
    sourceMode: Array.isArray(feed.rows) ? 'rows' : 'cards',
    workflowMode: 'manual-search',
    notes: [
      'This board is a discovery board, not an auto-buy engine.',
      'No verified eBay candidate pull is required for these rankings; every card should still be searched manually before action.'
    ],
    summary: {
      totalPlans: plans.length,
      prioritySearchCount: plans.filter((plan) => plan.action === 'priority-search').length,
      watchCount: plans.filter((plan) => plan.action === 'watch').length,
      passCount: plans.filter((plan) => plan.action === 'pass').length,
      manualReviewCount: plans.filter((plan) => plan.action === 'priority-search').length,
      buyNowCount: 0
    },
    reviewQueue,
    plans
  };

  await fs.writeFile(JSON_OUT, JSON.stringify(payload, null, 2), 'utf8');
  await updateSignalOutcomes(plans);

  const lines = [];
  lines.push('# One Piece Sniper — Manual Search Plan');
  lines.push(`Generated: ${payload.generatedAt}`);
  lines.push(`Feed updated: ${payload.sourceFeedUpdatedAt || 'unknown'}`);
  lines.push(`Mode: ${payload.workflowMode}`);
  lines.push(`Priority search: ${payload.summary.prioritySearchCount} | Watch: ${payload.summary.watchCount} | Pass: ${payload.summary.passCount}`);
  lines.push('');
  lines.push('## Review queue');
  for (const item of reviewQueue) {
    lines.push(`- #${item.queueRank} ${item.code} ${item.name} — ${item.action} — score ${item.discoveryScore.toFixed(1)} — target ${fmt(item.targetBuyPrice)} — max ${fmt(item.maxBuyPrice)} — risk: ${item.biggestRisk}`);
  }
  lines.push('');

  for (const plan of plans) {
    lines.push(`## #${plan.rank} ${plan.name} ${plan.code}`);
    lines.push(`- Action: ${plan.action}`);
    lines.push(`- Confidence tier: ${plan.confidenceTier}`);
    lines.push(`- Discovery score: ${plan.discoveryScore.toFixed(1)}`);
    lines.push(`- Set: ${plan.setName}`);
    lines.push(`- Raw market: ${fmt(plan.rawMarket)}`);
    lines.push(`- PSA 10 market: ${fmt(plan.psa10Market)}`);
    lines.push(`- Net PSA 10 exit: ${fmt(plan.netPsa10Exit)}`);
    lines.push(`- Profit after grading and exit haircut: ${fmt(plan.expectedPsaNet)}`);
    lines.push(`- ROI after grading fees: ${plan.roiPercent.toFixed(1)}%`);
    lines.push(`- PSA 10 sales: ${plan.psa10SalesCount} | Raw sales: ${plan.ungradedSalesCount}`);
    lines.push(`- Search score: ${plan.searchScore}`);
    lines.push(`- Collectr raw: ${fmt(plan.collectrRawMarket)} | drift vs board: ${plan.collectrRawDeltaPercent.toFixed(1)}%`);
    lines.push(`- Ideal buy: ${fmt(plan.idealBuyPrice)} | Target buy: ${fmt(plan.targetBuyPrice)} | Stretch: ${fmt(plan.stretchBuyPrice)} | Max: ${fmt(plan.maxBuyPrice)}`);
    lines.push(`- Exit zone: ${fmt(plan.exitZoneLow)} to ${fmt(plan.exitZoneHigh)}`);
    if (plan.topReasons.length) lines.push(`- Why it matters: ${plan.topReasons.map(reasonLabel).join(' | ')}`);
    if (plan.riskFlags.length) lines.push(`- Main risks: ${plan.riskFlags.map(riskLabel).join(' | ')}`);
    if (plan.collectrLink) lines.push(`- Collectr: ${plan.collectrLink}`);
    if (plan.priceChartingUrl) lines.push(`- PriceCharting: ${plan.priceChartingUrl}`);
    lines.push('');
  }

  const outPath = path.join(OUTPUT_DIR, `trade-plan-${payload.generatedAt.slice(0, 10)}.md`);
  await fs.writeFile(outPath, lines.join('\n'), 'utf8');
  console.log(`Trade plan generated.\nReport: ${outPath}\nJSON: ${JSON_OUT}`);
}

run().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});
