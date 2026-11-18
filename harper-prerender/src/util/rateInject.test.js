import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { readFileSync } from 'node:fs';
import { tokenizeGzippedHtml, fillGzipped, applyRateHeaders } from './rateInject.js';
import { deriveMarkdownFromGzippedHtml } from './markdown.js';

const RENDERED = readFileSync(new URL('./fixtures/finance-rendered.html', import.meta.url), 'utf8');
const gz = (s) => zlib.gzipSync(Buffer.from(s, 'utf8'));
const ungz = (b) => zlib.gunzipSync(b).toString('utf8');
const SHEET = {
	asOf: '2026-11-18T14:30:00-05:00',
	products: [
		{ key: 'mortgage-30-fixed', rate: 6.5, apr: 6.617, points: 0.5 },
		{ key: 'mortgage-15-fixed', rate: 5.875, apr: 6.051, points: 0.5 },
		{ key: 'mortgage-7-6-arm', rate: 6.125, apr: 6.884, points: 0.25 },
	],
};

test('a page without rate hooks keeps its exact buffer', () => {
	const buf = gz('<html><head><title>Aurora Pro</title></head><body>$349.00</body></html>');
	const r = tokenizeGzippedHtml(buf, SHEET);
	assert.equal(r.htmlGzip, buf);
	assert.equal(r.hasRateTokens, false);
	assert.equal(r.error, undefined);
});

test('a rate page is stored tokenized, with leftovers counted', () => {
	const r = tokenizeGzippedHtml(gz(RENDERED), { ...SHEET, products: [{ key: 'mortgage-30-fixed', rate: 6.625, apr: 6.742, points: 0.5 }] });
	assert.equal(r.hasRateTokens, true);
	assert.equal(r.rateLeftovers, 6); // fixture has no templates block
	assert.equal(ungz(r.htmlGzip).includes('>6.625%<'), false);
	assert.equal(tokenizeGzippedHtml(gz(RENDERED), null).rateLeftovers, null);
});

test('broken templates surface as an error', () => {
	const r = tokenizeGzippedHtml(gz(RENDERED.replace('</head>', '<script id="rate-templates">{x</script></head>')), SHEET);
	assert.match(r.error, /not valid JSON/);
	assert.equal(r.hasRateTokens, false);
});

test('fill: HTML and Markdown blobs get current rates, a fresh ETag, no-store', async () => {
	const stored = tokenizeGzippedHtml(gz(RENDERED), SHEET).htmlGzip;
	const md = deriveMarkdownFromGzippedHtml(stored).gzip;

	const a = await fillGzipped(stored, SHEET);
	assert.equal(a.ok, true);
	assert.match(ungz(a.gzip), />6\.500%</);
	const b = await fillGzipped(new Blob([md]), SHEET); // Blob path, as Harper hands it over
	assert.match(ungz(b.gzip), /\| 6\.500% +\|/);

	const other = await fillGzipped(stored, { ...SHEET, products: [{ ...SHEET.products[0], rate: 6.75 }, ...SHEET.products.slice(1)] });
	assert.notEqual(other.etag, a.etag);
	assert.equal((await fillGzipped(stored, SHEET)).etag, a.etag);

	const h = new Headers({ etag: '"origin"', 'last-modified': 'x', 'content-length': '1' });
	applyRateHeaders(h, a);
	assert.equal(h.get('etag'), a.etag);
	assert.equal(h.has('last-modified'), false);
	assert.equal(h.get('cache-control'), 'no-store');
	assert.equal(h.get('x-rate-as-of'), SHEET.asOf);
});

test('fill: a missing sheet or product is ok:false', async () => {
	const stored = tokenizeGzippedHtml(gz(RENDERED), SHEET).htmlGzip;
	assert.equal((await fillGzipped(stored, null)).ok, false);
	const r = await fillGzipped(stored, { asOf: SHEET.asOf, products: SHEET.products.slice(1) });
	assert.equal(r.ok, false);
	assert.ok(r.missing.length > 0);
});
