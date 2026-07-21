/**
 * @module markdown
 *
 * Derives Markdown from prerendered HTML so a single headless-Chrome render
 * yields BOTH cached representations under one PageCache record:
 *   - `content`         — gzipped HTML  (served to humans / SEO crawlers)
 *   - `markdownContent` — gzipped Markdown derived here (served to AI crawlers)
 *
 * The renderer uploads HTML gzip-compressed and Harper stores it as a Blob
 * unchanged, so derivation gunzips the HTML, converts it, and re-gzips the
 * Markdown to match the storage/encoding contract of `content`.
 *
 * `node-html-markdown` is the same converter the upstream Harper
 * markdown-prerender template uses, kept for output parity.
 */

import zlib from 'node:zlib';
import { NodeHtmlMarkdown } from 'node-html-markdown';

// Reused across calls — `translate()` is stateless per call.
const nhm = new NodeHtmlMarkdown({ keepDataImages: false });

// Matches <script type="application/ld+json">…</script> blocks. JSON-LD payloads
// never contain a literal </script>, so a non-greedy capture is safe.
const JSON_LD_RE = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

/**
 * Extract JSON-LD structured-data blocks so they survive HTML→Markdown
 * conversion. node-html-markdown strips all <script> tags, but JSON-LD is the
 * schema markup AI crawlers care about, so we re-attach it as fenced code.
 *
 * @param {string} html
 * @returns {string[]} trimmed JSON-LD payloads (raw JSON strings)
 */
function extractJsonLd(html) {
	const blocks = [];
	for (const match of html.matchAll(JSON_LD_RE)) {
		const json = match[1]?.trim();
		if (json) blocks.push(json);
	}
	return blocks;
}

/**
 * Fully read a stream / web-stream / Buffer into a single Buffer.
 *
 * Render results arrive as Node Readables (scheduled path) or web ReadableStreams
 * (Harper Blob streams). Buffering lets us both store the HTML blob and derive
 * Markdown from the same bytes without consuming the stream twice.
 *
 * @param {Buffer|import('stream').Readable|ReadableStream|null} input
 * @returns {Promise<Buffer|null>}
 */
export async function toBuffer(input) {
	if (input == null) return null;
	if (Buffer.isBuffer(input)) return input;

	const chunks = [];

	// Web ReadableStream (e.g. Blob.stream())
	if (typeof input.getReader === 'function') {
		const reader = input.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(Buffer.from(value));
		}
		return Buffer.concat(chunks);
	}

	// Node Readable (async iterable)
	for await (const chunk of input) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return Buffer.concat(chunks);
}

/**
 * Convert a gzipped-HTML buffer into gzipped Markdown.
 *
 * Mirrors the storage contract of `PageCache.content` (gzip in, gzip out).
 * Returns `null` on any failure so the HTML blob still caches and the AI path
 * simply falls back to Fermyon at the edge — derivation is best-effort.
 *
 * @param {Buffer} gzippedHtml - gzip-compressed HTML bytes (as uploaded by the renderer)
 * @returns {{ gzip: Buffer, length: number } | null}
 */
export function deriveMarkdownFromGzippedHtml(gzippedHtml) {
	try {
		if (!gzippedHtml || gzippedHtml.length === 0) return null;
		const html = zlib.gunzipSync(gzippedHtml).toString('utf8');

		let markdown = nhm.translate(html);

		// Re-attach JSON-LD schema markup the converter dropped with the <script> tags.
		const jsonLd = extractJsonLd(html);
		if (jsonLd.length) {
			markdown += '\n\n' + jsonLd.map((j) => '```json\n' + j + '\n```').join('\n\n');
		}

		if (!markdown || markdown.trim().length === 0) return null;
		const md = Buffer.from(markdown, 'utf8');
		return { gzip: zlib.gzipSync(md, { level: 6 }), length: md.length };
	} catch (err) {
		// `logger` is a Harper global inside the component runtime.
		if (typeof logger !== 'undefined') logger.error('Markdown derivation failed', err);
		return null;
	}
}
