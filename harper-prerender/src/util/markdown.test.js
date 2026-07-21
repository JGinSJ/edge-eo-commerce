import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { toBuffer, deriveMarkdownFromGzippedHtml } from './markdown.js';

const gz = (s) => zlib.gzipSync(Buffer.from(s, 'utf8'));
const ungz = (b) => zlib.gunzipSync(b).toString('utf8');

const CSR_HTML = `<!DOCTYPE html><html><head>
<title>iPhone 17 Pro Max</title>
<script type="application/ld+json">{"@type":"Product","name":"iPhone 17 Pro Max"}</script>
<script>console.log('runtime js that must be stripped');</script>
</head><body>
<h1>iPhone 17 Pro Max</h1>
<p>The most advanced iPhone. <a href="/buy">Buy now</a>.</p>
<ul><li>6.9" display</li><li>A19 Pro chip</li></ul>
</body></html>`;

test('derives Markdown (gzip in → gzip out) with structure preserved', () => {
	const md = deriveMarkdownFromGzippedHtml(gz(CSR_HTML));
	assert.ok(md, 'should return a result');
	const text = ungz(md.gzip);
	assert.match(text, /# iPhone 17 Pro Max/);
	assert.match(text, /A19 Pro chip/);
	assert.match(text, /\(\/buy\)/);
	assert.equal(md.length, Buffer.byteLength(text, 'utf8'));
});

test('preserves JSON-LD schema markup as a fenced block', () => {
	const text = ungz(deriveMarkdownFromGzippedHtml(gz(CSR_HTML)).gzip);
	assert.match(text, /```json/);
	assert.match(text, /"@type"/);
});

test('strips executable JavaScript', () => {
	const text = ungz(deriveMarkdownFromGzippedHtml(gz(CSR_HTML)).gzip);
	assert.doesNotMatch(text, /runtime js that must be stripped/);
});

test('returns null on empty / invalid input rather than throwing', () => {
	assert.equal(deriveMarkdownFromGzippedHtml(null), null);
	assert.equal(deriveMarkdownFromGzippedHtml(Buffer.alloc(0)), null);
	assert.equal(deriveMarkdownFromGzippedHtml(Buffer.from('not gzip')), null);
});

test('returns null when the rendered HTML has no textual content', () => {
	assert.equal(deriveMarkdownFromGzippedHtml(gz('<html><body></body></html>')), null);
});

test('toBuffer handles Buffer, web stream, and null', async () => {
	assert.equal((await toBuffer(Buffer.from('abc'))).toString(), 'abc');
	assert.equal((await toBuffer(new Blob(['xyz']).stream())).toString(), 'xyz');
	assert.equal(await toBuffer(null), null);
});
