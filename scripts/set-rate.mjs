#!/usr/bin/env node
/**
 * Change a rate on the finance demo page by SERVE-TIME INJECTION.
 *
 * One authenticated write to the Harper rate sheet. Nothing is cleared and
 * nothing is re-rendered: the cached prerender holds tokens, and Harper fills
 * them from the sheet on the next request. People get the new rate too, because
 * the page reads the same sheet.
 *
 * Steps, each timed:
 *   1. read     GET  /rate_sheet/national          (current sheet)
 *   2. write    PUT  /rate_sheet/national          (the rate change)
 *   3. visible  GET  /page until the bot HTML carries the new rate
 *   4. check    Markdown (/page_content) carries it too
 *
 * Usage (from the repo root):
 *   set -a; . env/bulk-upload.env; set +a
 *   node scripts/set-rate.mjs --rate 6.5 --apr 6.617
 *   node scripts/set-rate.mjs --reset            # restore origin-finance/rates.json numbers
 *
 * Options:
 *   --product <key>   product to change (default: "featured" in rates.json)
 *   --points <n>      also change points
 *   --json            print one JSON line instead of the table
 *
 * Env: HARPER_OPS_URL, HARPER_ADMIN_USER, HARPER_ADMIN_PASS (write);
 *      HARPER_BOT_KEY (default eeo-commerce-demo); PAGE_URL.
 *
 * The rate and APR are both supplied by the caller: nothing is derived here.
 *
 * History: before injection existed this script changed the rate by uploading a
 * new rates.json, clearing the cached page and re-rendering it. Measured on
 * staging on November 18, 2026 that took 18 to 31 seconds per change, during
 * which bots got the origin shell with no rate. The page no longer reads its
 * numbers from rates.json, so that mode was removed.
 */
import https from 'node:https';
import zlib from 'node:zlib';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const val = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const die = (m) => { console.error('Error: ' + m); process.exit(1); };

const HARPER = (process.env.HARPER_OPS_URL || '').replace(/\/$/, '');
const USER = process.env.HARPER_ADMIN_USER;
const PASS = process.env.HARPER_ADMIN_PASS;
const BOT_KEY = process.env.HARPER_BOT_KEY || 'eeo-commerce-demo';
const PAGE_URL = process.env.PAGE_URL || 'https://stopwaitingshipit.com/finance/index.html';
const SHEET_PATH = '/rate_sheet/national';
const BASELINE = JSON.parse(readFileSync(join(here, '..', 'origin-finance', 'rates.json'), 'utf8'));
const TIMEOUT_MS = 30000;

if (!HARPER || !USER || !PASS) die('source env/bulk-upload.env first (HARPER_OPS_URL, HARPER_ADMIN_USER, HARPER_ADMIN_PASS).');
const reset = flag('--reset');
const rate = val('--rate'), apr = val('--apr'), points = val('--points');
if (!reset && (rate == null || apr == null)) die('provide --rate <n> --apr <n>, or --reset.');
for (const [k, v] of [['rate', rate], ['apr', apr], ['points', points]])
  if (v != null && !Number.isFinite(Number(v))) die('--' + k + ' must be a number.');

const pct = (n) => Number(n).toFixed(3) + '%';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Plain https, not fetch(): fetch adds "Accept-Language: *", and Harper folds
// Accept-Language into the page cache key, so fetch reads a different (empty) entry.
const request = (method, path, { headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = https.request(HARPER + path, { method, headers }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => {
      let buf = Buffer.concat(chunks);
      // Decide by magic bytes: some responses are labeled gzip but are not.
      if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
      resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, headers: res.headers, text: buf.toString('utf8') });
    });
  });
  req.on('error', reject);
  if (body) req.write(body);
  req.end();
});
const bot = { 'x-pr-req-key': BOT_KEY };
const enc = encodeURIComponent(PAGE_URL);
const ms = (t0) => Math.round((performance.now() - t0) * 10) / 10;

/** Refuse to write a sheet the serve path would reject (which would 503 every bot). */
function validate(sheet) {
  if (typeof sheet.asOf !== 'string' || Number.isNaN(Date.parse(sheet.asOf))) die('sheet.asOf is not a timestamp.');
  if (!Array.isArray(sheet.products) || !sheet.products.length) die('sheet.products is empty.');
  for (const p of sheet.products) {
    if (typeof p.key !== 'string' || !p.key) die('a product has no key.');
    for (const f of ['rate', 'apr', 'points'])
      if (typeof p[f] !== 'number' || !Number.isFinite(p[f])) die(p.key + '.' + f + ' is not a number.');
  }
  for (const p of BASELINE.products)
    if (!sheet.products.some((x) => x.key === p.key)) die('the page shows ' + p.key + ' but the sheet would not have it.');
}

// 1. read
let t0 = performance.now();
let sheet;
if (reset) {
  sheet = {
    id: 'national',
    asOf: BASELINE.asOf,
    products: BASELINE.products.map(({ key, rate, apr, points }) => ({ key, rate, apr, points })),
  };
} else {
  const r = await request('GET', SHEET_PATH);
  if (!r.ok) die('GET ' + SHEET_PATH + ' returned ' + r.status + ' (load the sheet first with --reset).');
  const cur = JSON.parse(r.text);
  sheet = { id: 'national', asOf: new Date().toISOString(), products: cur.products.map((p) => ({ ...p })) };
  const key = val('--product') || BASELINE.featured;
  const p = sheet.products.find((x) => x.key === key);
  if (!p) die('no product "' + key + '" in the rate sheet.');
  p.rate = Number(rate);
  p.apr = Number(apr);
  if (points != null) p.points = Number(points);
}
validate(sheet);
const read_ms = ms(t0);
const featured = sheet.products.find((x) => x.key === BASELINE.featured) || sheet.products[0];
// What the bot's <title> must contain once the change is visible.
const want = pct(featured.rate) + ' (' + pct(featured.apr) + ' APR)';

// 2. write
const body = JSON.stringify(sheet);
t0 = performance.now();
const w = await request('PUT', SHEET_PATH, {
  headers: {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    authorization: 'Basic ' + Buffer.from(USER + ':' + PASS).toString('base64'),
  },
  body,
});
if (!w.ok) die('PUT ' + SHEET_PATH + ' returned ' + w.status + ' ' + w.text.slice(0, 200));
const write_ms = ms(t0);

// 3. visible: time from the start of the write until a bot request shows the new rate
const titleOf = (html) => (html.match(/<title>([^<]*)/) || [])[1] || '';
let requests = 0, title = '', page;
const deadline = Date.now() + TIMEOUT_MS;
for (;;) {
  requests++;
  page = await request('GET', '/page/?url=' + enc + '&deviceType=desktop', { headers: bot });
  title = page.ok ? titleOf(page.text) : '';
  if (title.includes(want)) break;
  if (Date.now() > deadline) die('timed out after ' + TIMEOUT_MS + ' ms; last status ' + page.status + ', title "' + title + '"');
  await sleep(50);
}
const visible_ms = ms(t0);

// 4. check Markdown, tokens, and the freeze scan
const md = await request('GET', '/page_content?path=' + enc, { headers: bot });
const mdOk = md.ok && md.text.includes(pct(featured.rate));
const leaked = page.text.includes('%%RATE:') || md.text.includes('%%RATE:');
const leftovers = page.headers['x-rate-leftovers'];

const result = {
  rate: featured.rate, apr: featured.apr, asOf: sheet.asOf, title,
  read_ms, write_ms, visible_ms, requests_until_visible: requests,
  markdown_has_rate: mdOk, tokens_leaked: leaked,
  injected: page.headers['x-rate-injected'] === '1', leftovers: leftovers == null ? null : Number(leftovers),
};
if (flag('--json')) {
  console.log(JSON.stringify(result));
} else {
  console.log('Rate now ' + pct(featured.rate) + ' (' + pct(featured.apr) + ' APR), as of ' + sheet.asOf);
  console.log('  title:     ' + title);
  console.log('  markdown:  ' + (mdOk ? 'has the new rate' : 'DOES NOT have the new rate'));
  console.log('  injected:  ' + (result.injected ? 'yes' : 'NO (page is not tokenized; reseed it)') + ', frozen rates: ' + (leftovers ?? 'unknown'));
  console.log('  sheet write          ' + String(write_ms).padStart(7) + ' ms');
  console.log('  write to bot-visible ' + String(visible_ms).padStart(7) + ' ms  (' + requests + ' request' + (requests === 1 ? '' : 's') + ')');
}
process.exit(mdOk && !leaked && result.injected ? 0 : 2);
