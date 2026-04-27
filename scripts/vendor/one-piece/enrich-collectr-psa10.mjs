import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = process.env.ONE_PIECE_SNIPER_TEST_DIR || path.resolve(__dirname, '..', '..', '..');
const SCANNER_DIR = __dirname;
const REPORT_DIR = path.join(APP_DIR, 'reports', 'one-piece-hybrid');
const ACTIVE_PATH = path.join(SCANNER_DIR, 'candidates-active.json');
const REPORT_PATH = path.join(REPORT_DIR, `psa10-enrichment-${new Date().toISOString().slice(0, 10)}.md`);
const SESSION = 'collectr-psa10-enrich';
const TARGET_GRADE_ID = '12';
const MAX_CARDS = Number(process.env.COLLECTR_PSA10_MAX_CARDS || 265);
const RETRIES = Number(process.env.COLLECTR_PSA10_RETRIES || 2);
const OPEN_TIMEOUT = Number(process.env.COLLECTR_PSA10_TIMEOUT_MS || 45000);
const AGENT_BROWSER_BIN = process.env.AGENT_BROWSER_BIN || 'agent-browser';

function money(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

async function browser(args, timeout = OPEN_TIMEOUT) {
  const { stdout } = await execFileAsync(AGENT_BROWSER_BIN, ['--session', SESSION, ...args], {
    cwd: APP_DIR,
    windowsHide: true,
    timeout,
    maxBuffer: 20 * 1024 * 1024,
  });
  return String(stdout || '');
}

function extractGrade12FromHtml(html) {
  const match = html.match(/graded_sub_types\\":\[(.*?)\],\\"web_slug_group/s);
  if (!match) return null;
  const block = match[1];
  const regex = /grade_id\\":\\"(\d+)\\",\\"insertion_date\\":\\"([^\\]+?)\\",\\"market_price_diff\\":\\"([^\\]*?)\\",\\"market_price_percentage_diff\\":\\"([^\\]*?)\\",\\"market_price\\":\\"([0-9.]+)\\"/g;
  const rows = [];
  for (const row of block.matchAll(regex)) {
    rows.push({
      gradeId: row[1],
      insertionDate: row[2],
      marketPrice: money(row[5]),
    });
  }
  const hit = rows.find((row) => row.gradeId === TARGET_GRADE_ID && row.marketPrice > 0);
  if (!hit) return null;
  return {
    market: Math.round(hit.marketPrice * 100) / 100,
    insertionDate: hit.insertionDate,
  };
}

async function extractForCard(card) {
  const url = String(card.collectrLink || '').trim();
  if (!url) return { ok: false, reason: 'missing-link' };

  for (let attempt = 1; attempt <= RETRIES; attempt += 1) {
    try {
      await browser(['open', url]);
      await browser(['wait', '--load', 'networkidle']);
      const htmlJson = await browser(['get', 'html', 'body', '--json']);
      const parsed = JSON.parse(htmlJson);
      const html = String(parsed?.data?.html || '');
      const grade12 = extractGrade12FromHtml(html);
      if (grade12) {
        return {
          ok: true,
          ...grade12,
          source: `collectr-product-html grade_id=${TARGET_GRADE_ID}`,
        };
      }
    } catch (error) {
      if (attempt === RETRIES) {
        return {
          ok: false,
          reason: String(error.message || error),
        };
      }
    }
  }

  return { ok: false, reason: 'no-graded-block' };
}

async function run() {
  await fs.mkdir(REPORT_DIR, { recursive: true });
  const cards = JSON.parse(await fs.readFile(ACTIVE_PATH, 'utf8'));
  const work = cards.slice(0, Math.min(MAX_CARDS, cards.length));
  const reportLines = [];
  let hits = 0;
  let misses = 0;

  for (let i = 0; i < work.length; i += 1) {
    const card = work[i];
    console.log(`Checking ${i + 1}/${work.length}: ${card.code} | ${card.name}`);
    const result = await extractForCard(card);
    if (result.ok) {
      card.collectrPsa10Market = result.market;
      card.collectrPsa10Source = result.source;
      card.collectrPsa10At = result.insertionDate;
      hits += 1;
      reportLines.push(`- HIT | ${card.code} | ${card.name} | raw ${money(card.rawMarket).toFixed(2)} | psa10 ${result.market.toFixed(2)} | ${result.insertionDate}`);
    } else {
      delete card.collectrPsa10Market;
      delete card.collectrPsa10Source;
      delete card.collectrPsa10At;
      misses += 1;
      reportLines.push(`- MISS | ${card.code} | ${card.name} | ${result.reason}`);
    }
  }

  await fs.writeFile(ACTIVE_PATH, JSON.stringify(cards, null, 2), 'utf8');

  const summary = [
    '# One Piece Collectr PSA 10 enrichment',
    `Generated: ${new Date().toISOString()}`,
    `Cards checked: ${work.length}`,
    `Hits: ${hits}`,
    `Misses: ${misses}`,
    '',
    ...reportLines,
    '',
  ].join('\n');

  await fs.writeFile(REPORT_PATH, summary, 'utf8');
  console.log(`Enrichment done. Hits=${hits} Misses=${misses}`);
  console.log(`Active pool updated: ${ACTIVE_PATH}`);
  console.log(`Report: ${REPORT_PATH}`);
}

run().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});
