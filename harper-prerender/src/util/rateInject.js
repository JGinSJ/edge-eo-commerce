/**
 * @module rateInject
 *
 * Glue between the pure token logic (rates.js) and the gzip blobs PageCache
 * stores. See rates.js for the token contract.
 *
 *   store time:  tokenizeGzippedHtml()  render → tokenized blob (+ flag)
 *   serve time:  fillGzipped()          tokenized blob → response body
 *
 * Pages without rate hooks never pay for any of this: tokenizeGzippedHtml
 * returns the original buffer and hasRateTokens:false, and the serve paths only
 * call fillGzipped when the record carries hasRateTokens.
 */

import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { tokenizeHtml, substitute, findLeftovers } from './rates.js';
import { toBuffer } from './markdown.js';

/** One national rate sheet: a single row, so rate and APR change in one write. */
export const RATE_SHEET_ID = 'national';

/** Read the current rate sheet (Harper runtime only). Null if it has not been loaded. */
export async function getRateSheet() {
	const row = await databases.prerender.RateSheet.get(RATE_SHEET_ID);
	if (!row) return null;
	return { asOf: row.asOf, products: row.products };
}

/**
 * Tokenize a freshly rendered page before it is stored.
 *
 * @param {Buffer} htmlGzip - gzipped rendered HTML
 * @param {object|null} sheet - current rate sheet, used only for the leftover scan
 * @returns {{ htmlGzip: Buffer, hasRateTokens: boolean, rateLeftovers: number|null, error?: string }}
 *   `error` means the page declared rate templates that could not be applied;
 *   the caller must not cache the render.
 */
export function tokenizeGzippedHtml(htmlGzip, sheet) {
	const untouched = { htmlGzip, hasRateTokens: false, rateLeftovers: null };
	if (!htmlGzip || htmlGzip.length === 0) return untouched;

	const html = zlib.gunzipSync(htmlGzip).toString('utf8');
	// Cheap gate so pages with no rate hooks skip the regex work entirely.
	if (!html.includes('data-rate-key') && !html.includes('rate-templates')) return untouched;

	const t = tokenizeHtml(html);
	if (!t.ok) return { ...untouched, error: t.error };
	if (t.tokens === 0) return untouched;

	return {
		htmlGzip: zlib.gzipSync(Buffer.from(t.html, 'utf8'), { level: 6 }),
		hasRateTokens: true,
		rateLeftovers: sheet ? findLeftovers(t.html, sheet).count : null,
	};
}

/**
 * Fill the tokens in a stored gzip blob with current rates.
 *
 * @param {Blob|Buffer} body - gzipped tokenized HTML or Markdown
 * @param {object|null} sheet
 * @returns {Promise<{ ok: true, gzip: Buffer, etag: string, asOf: string } | { ok: false, missing: string[] }>}
 *   ok:false means at least one token had no valid value. The caller must
 *   answer 503 rather than serve the page.
 */
export async function fillGzipped(body, sheet) {
	const stored = Buffer.isBuffer(body) ? body : await toBuffer(typeof body.stream === 'function' ? body.stream() : body);
	const text = zlib.gunzipSync(stored).toString('utf8');
	const s = substitute(text, sheet);
	if (s.missing.length) return { ok: false, missing: s.missing };

	const out = Buffer.from(s.text, 'utf8');
	return {
		ok: true,
		gzip: zlib.gzipSync(out, { level: 6 }),
		// The origin's ETag describes the render, not the rates. Derive one from the
		// bytes actually served so a conditional request cannot revive an old rate.
		etag: '"r-' + crypto.createHash('sha1').update(out).digest('hex').slice(0, 20) + '"',
		asOf: String(sheet?.asOf ?? ''),
	};
}

/** Response headers for a page whose rates were filled at serve time. */
export function applyRateHeaders(headers, filled) {
	headers.delete('last-modified');
	headers.delete('content-length');
	headers.set('etag', filled.etag);
	// A rate page is only as fresh as its last fill: nothing downstream may reuse it.
	headers.set('cache-control', 'no-store');
	headers.set('x-rate-injected', '1');
	headers.set('x-rate-as-of', filled.asOf);
}

/** The 503 a serve path returns when a rate is missing: the edge falls back to origin. */
export function rateMissingResponse(missing) {
	if (typeof logger !== 'undefined') logger.error('Rate injection: no valid value for ' + missing.join(', '));
	return {
		headers: { 'retry-after': '10', 'cache-control': 'no-store', 'x-rate-missing': String(missing.length) },
		status: 503,
	};
}
