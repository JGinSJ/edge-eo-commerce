import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { readFileSync } from 'node:fs';
import { tokenizeHtml, substitute, findLeftovers, hasTokens, token, defaultFormat } from './rates.js';
import { deriveMarkdownFromGzippedHtml } from './markdown.js';

// A real render of the finance page, captured from Harper on staging at the
// baseline rates below. It predates the rate-templates block, so it has slots only.
const RENDERED = readFileSync(new URL('./fixtures/finance-rendered.html', import.meta.url), 'utf8');

const BASELINE = {
	asOf: '2026-11-17T09:00:00-05:00',
	products: [
		{ key: 'mortgage-30-fixed', rate: 6.625, apr: 6.742, points: 0.5 },
		{ key: 'mortgage-15-fixed', rate: 5.875, apr: 6.051, points: 0.5 },
		{ key: 'mortgage-7-6-arm', rate: 6.125, apr: 6.884, points: 0.25 },
	],
};
const CHANGED = {
	asOf: '2026-11-18T14:30:00-05:00',
	products: [
		{ key: 'mortgage-30-fixed', rate: 6.5, apr: 6.617, points: 0.5 },
		BASELINE.products[1],
		BASELINE.products[2],
	],
};

const count = (s, sub) => s.split(sub).length - 1;
const titleOf = (h) => h.match(/<title>([^<]*)/)[1];
const descOf = (h) => h.match(/<meta name="description" content="([^"]*)"/)[1];
const jsonLdOf = (h) => JSON.parse(h.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
const F = 'mortgage-30-fixed';

/** The fixture as the page will render it once app.js emits its templates block. */
function withTemplates(html) {
	const ld = jsonLdOf(html);
	ld[0].interestRate = token(F + '.rate', 'json');
	ld[0].annualPercentageRate = token(F + '.apr', 'json');
	ld[0].dateModified = token('asOf', 'iso');
	const swap = (s) => s.replace('6.625%', token(F + '.rate', 'pct3')).replace('6.742%', token(F + '.apr', 'pct3'));
	const templates = { title: swap(titleOf(html)), description: swap(descOf(html)), jsonld: ld };
	const block = '<script type="application/json" id="rate-templates">' + JSON.stringify(templates) + '</script>';
	return html.replace('</head>', block + '</head>');
}

test('fixture is the baseline render', () => {
	assert.equal(titleOf(RENDERED), '30-Year Fixed Mortgage Rates: 6.625% (6.742% APR) | Larkspur Bank');
	assert.equal(count(RENDERED, 'data-rate-key='), 14);
});

test('a page with no slots or templates is returned unchanged', () => {
	const html = '<html><head><title>Aurora Pro: $349.00</title></head><body><p>6.625% off nothing</p></body></html>';
	const r = tokenizeHtml(html);
	assert.equal(r.ok, true);
	assert.equal(r.tokens, 0);
	assert.equal(r.html, html);
	assert.equal(hasTokens(r.html), false);
});

test('slots: every data-rate-key value becomes a token', () => {
	const r = tokenizeHtml(RENDERED);
	assert.equal(r.ok, true);
	assert.equal(r.slots, 14);
	assert.equal(r.templates, false);
	assert.match(r.html, /<span data-rate-key="mortgage-30-fixed\.rate">%%RATE:mortgage-30-fixed\.rate:pct3%%<\/span>/);
	assert.match(r.html, /<time data-rate-key="asOf">%%RATE:asOf:datetime%%<\/time>/);
	assert.match(r.html, /<span data-rate-key="mortgage-30-fixed\.points">%%RATE:mortgage-30-fixed\.points:num%%<\/span>/);
});

test('slots: data-rate-format overrides the default', () => {
	const r = tokenizeHtml('<b data-rate-key="x.rate" data-rate-format="num">6.5</b>');
	assert.equal(r.html, '<b data-rate-key="x.rate" data-rate-format="num">%%RATE:x.rate:num%%</b>');
	assert.equal(defaultFormat('x.rate'), 'pct3');
});

test('leftover scan flags the title, meta and JSON-LD when there are no templates', () => {
	const r = tokenizeHtml(RENDERED);
	const left = findLeftovers(r.html, BASELINE);
	// title: rate + APR; meta description: rate + APR; JSON-LD: rate + APR.
	assert.deepEqual(left.values, { '6.625': 3, '6.742': 3 });
	assert.equal(left.count, 6);
});

test('templates: title, meta description and JSON-LD are tokenized, block removed', () => {
	const r = tokenizeHtml(withTemplates(RENDERED));
	assert.equal(r.ok, true);
	assert.equal(r.templates, true);
	assert.equal(count(r.html, 'rate-templates'), 0);
	assert.equal(titleOf(r.html), '30-Year Fixed Mortgage Rates: %%RATE:mortgage-30-fixed.rate:pct3%% (%%RATE:mortgage-30-fixed.apr:pct3%% APR) | Larkspur Bank');
	// Stored JSON-LD stays parseable: numeric tokens are quoted strings until served.
	const ld = jsonLdOf(r.html);
	assert.equal(ld[0].interestRate, '%%RATE:mortgage-30-fixed.rate:json%%');
	assert.equal(ld[1]['@type'], 'FAQPage');
	assert.equal(findLeftovers(r.html, BASELINE).count, 0);
	assert.equal(r.tokens, 14 + 2 + 2 + 3);
});

test('round trip at the baseline reproduces the original render', () => {
	const r = tokenizeHtml(withTemplates(RENDERED));
	const s = substitute(r.html, BASELINE);
	assert.deepEqual(s.missing, []);
	assert.equal(s.replaced, r.tokens);
	assert.equal(hasTokens(s.text), false);
	assert.equal(titleOf(s.text), titleOf(RENDERED));
	assert.equal(descOf(s.text), descOf(RENDERED));
	assert.deepEqual(jsonLdOf(s.text), jsonLdOf(RENDERED));
	// Everything from <body> on is byte-identical, including the date as Chrome formatted it.
	assert.equal(s.text.slice(s.text.indexOf('<body')), RENDERED.slice(RENDERED.indexOf('<body')));
});

test('a rate change shows up everywhere and the old rate is gone', () => {
	const s = substitute(tokenizeHtml(withTemplates(RENDERED)).html, CHANGED);
	assert.deepEqual(s.missing, []);
	assert.equal(titleOf(s.text), '30-Year Fixed Mortgage Rates: 6.500% (6.617% APR) | Larkspur Bank');
	assert.match(descOf(s.text), /is 6\.500% \(6\.617% APR\)/);
	const ld = jsonLdOf(s.text);
	assert.equal(ld[0].interestRate, 6.5);
	assert.equal(ld[0].annualPercentageRate, 6.617);
	assert.equal(ld[0].dateModified, '2026-11-18T14:30:00-05:00');
	assert.equal(count(s.text, '6.625'), 0);
	assert.equal(count(s.text, '6.742'), 0);
	assert.equal(count(s.text, '6.500%'), 4); // rate card, table, title, meta description
	assert.match(s.text, /November 18, 2026 at 2:30\sPM EST/);
	// Other products are untouched.
	assert.equal(count(s.text, '5.875%'), 1);
});

test('missing or invalid values are reported, never rendered', () => {
	const html = tokenizeHtml(withTemplates(RENDERED)).html;

	const noProduct = substitute(html, { asOf: BASELINE.asOf, products: BASELINE.products.slice(1) });
	assert.ok(noProduct.missing.includes('mortgage-30-fixed.rate:pct3'));
	assert.ok(noProduct.missing.includes('mortgage-30-fixed.rate:json'));
	assert.equal(hasTokens(noProduct.text), true);

	const hostile = structuredClone(BASELINE);
	hostile.products[0].rate = '<script>alert(1)</script>';
	hostile.asOf = '"><img src=x>';
	const bad = substitute(html, hostile);
	assert.ok(bad.missing.includes('mortgage-30-fixed.rate:pct3'));
	assert.ok(bad.missing.includes('asOf:datetime'));
	assert.ok(bad.missing.includes('asOf:iso'));
	assert.equal(count(bad.text, 'alert(1)'), 0);
	assert.equal(count(bad.text, '<img src=x>'), 0);

	assert.ok(substitute(html, null).missing.length > 0);
	assert.ok(substitute(html, { asOf: BASELINE.asOf, products: [{ key: F, rate: NaN, apr: 1, points: 0 }] }).missing.length > 0);
});

test('templates that cannot be applied fail the tokenization', () => {
	const broken = RENDERED.replace('</head>', '<script type="application/json" id="rate-templates">{not json</script></head>');
	const r = tokenizeHtml(broken);
	assert.equal(r.ok, false);
	assert.match(r.error, /not valid JSON/);

	const noLd = '<html><head><title>x</title><script type="application/json" id="rate-templates">{"jsonld":[]}</script></head></html>';
	assert.equal(tokenizeHtml(noLd).ok, false);
});

test('a template cannot break out of its context', () => {
	const html = '<html><head><title>x</title><meta name="description" content="y">' +
		'<script type="application/ld+json">{}</script>' +
		'<script type="application/json" id="rate-templates">' +
		JSON.stringify({ title: 'a</title><b>', description: 'q" onload="z', jsonld: { n: '<\/script><i>' } }).replace(/<\//g, '<\\/') +
		'</script></head></html>';
	const r = tokenizeHtml(html);
	assert.equal(r.ok, true);
	assert.equal(count(r.html, '<b>'), 0);
	assert.equal(count(r.html, 'onload="z'), 0);
	assert.equal(count(r.html, '<i>'), 0);
});

test('Markdown derived from tokenized HTML keeps the tokens intact', () => {
	const tokenized = tokenizeHtml(withTemplates(RENDERED)).html;
	const md = zlib.gunzipSync(deriveMarkdownFromGzippedHtml(zlib.gzipSync(tokenized)).gzip).toString('utf8');
	assert.equal(hasTokens(md), true);
	assert.equal(findLeftovers(md, BASELINE).count, 0);

	const s = substitute(md, CHANGED);
	assert.deepEqual(s.missing, []);
	assert.equal(hasTokens(s.text), false);
	assert.match(s.text, /6\.500%/);
	assert.equal(count(s.text, '6.625'), 0);
	// The JSON-LD fenced block is valid JSON with a numeric rate.
	const fenced = s.text.match(/```json\n([\s\S]*?)\n```/)[1];
	assert.equal(JSON.parse(fenced)[0].interestRate, 6.5);

	// Same Markdown as deriving from the already-substituted HTML, except for table
	// padding: the converter pads columns to the token width at store time, so the
	// served table is valid but unevenly spaced. Compare with padding normalized.
	const direct = zlib.gunzipSync(
		deriveMarkdownFromGzippedHtml(zlib.gzipSync(substitute(tokenized, CHANGED).text)).gzip
	).toString('utf8');
	const norm = (t) => t.replace(/ +\|/g, ' |').replace(/-{3,}/g, '---');
	assert.notEqual(s.text, direct);
	assert.equal(norm(s.text), norm(direct));
});
