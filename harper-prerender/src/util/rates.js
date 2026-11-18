/**
 * @module rates
 *
 * Serve-time rate injection, the pure string half. No Harper globals here, so it
 * runs under `node --test`.
 *
 *   store time:  tokenizeHtml(renderedHtml)   values  → tokens
 *   serve time:  substitute(text, rateSheet)  tokens  → current values
 *
 * A token is `%%RATE:<key>:<format>%%`.
 *   key     "asOf", or "<product-key>.<field>" (e.g. "mortgage-30-fixed.rate")
 *   format  pct3 | num | datetime | iso | json
 *
 * Where tokens come from (the contract with the origin page):
 *
 *   1. Slots. Any element with `data-rate-key="<key>"` and text-only content has
 *      its text replaced by a token. The format is `data-rate-format` if present,
 *      else a default by field name (see defaultFormat).
 *
 *   2. Templates. The <title>, the meta description and the JSON-LD carry rates
 *      but cannot be slots. The page supplies their tokenized form in
 *        <script type="application/json" id="rate-templates">
 *          { "title": "…", "description": "…", "jsonld": [ … ] }
 *        </script>
 *      and tokenizeHtml swaps each one in, then removes the block. Inside
 *      `jsonld`, a number is written as the quoted token "%%RATE:<key>:json%%";
 *      substitute() replaces the token together with its quotes.
 *
 * A page with neither is returned unchanged (tokens: 0), so non-rate pages keep
 * their existing path.
 */

const KEY = '[A-Za-z0-9._-]+';
const TOKEN_RE = new RegExp('%%RATE:(' + KEY + '):([a-z0-9]+)%%', 'g');
// The json format is only valid as a whole JSON string value: quotes included.
const QUOTED_JSON_TOKEN_RE = new RegExp('"%%RATE:(' + KEY + '):json%%"', 'g');

const SLOT_RE = /(<([a-z][a-z0-9]*)\b[^>]*\sdata-rate-key="([^"]+)"[^>]*>)([^<]*)(<\/\2>)/gi;
const TEMPLATES_RE = /<script\b[^>]*\bid=["']rate-templates["'][^>]*>([\s\S]*?)<\/script>\s*/i;
const JSON_LD_RE = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi;
const TITLE_RE = /(<title\b[^>]*>)[\s\S]*?(<\/title>)/i;
const META_DESC_RE = /(<meta\b[^>]*\bname=["']description["'][^>]*\bcontent=")[^"]*(")/i;

// Must match asOfText() in origin-finance/app.js.
const DATETIME = new Intl.DateTimeFormat('en-US', {
	month: 'long', day: 'numeric', year: 'numeric',
	hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York', timeZoneName: 'short',
});

const escapeHtml = (s) =>
	String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const token = (key, format) => '%%RATE:' + key + ':' + format + '%%';

/** Format used for a slot that does not declare `data-rate-format`. */
export function defaultFormat(key) {
	if (key === 'asOf') return 'datetime';
	const field = key.slice(key.lastIndexOf('.') + 1);
	return field === 'rate' || field === 'apr' ? 'pct3' : 'num';
}

export function hasTokens(text) {
	return typeof text === 'string' && text.includes('%%RATE:');
}

/**
 * Replace rendered rate values with tokens.
 *
 * @param {string} html - rendered HTML
 * @returns {{ ok: boolean, html: string, tokens: number, slots: number, templates: boolean, error?: string }}
 *   ok:false means the page declared templates that could not be applied. The
 *   caller must not cache such a render: a half-tokenized page would freeze a rate.
 */
export function tokenizeHtml(html) {
	let slots = 0;
	let out = html.replace(SLOT_RE, (_m, open, _tag, key, _text, close) => {
		if (!new RegExp('^' + KEY + '$').test(key)) return _m;
		const fmt = (open.match(/\sdata-rate-format="([a-z0-9]+)"/i) || [])[1] || defaultFormat(key);
		slots++;
		return open + token(key, fmt) + close;
	});

	let templates = false;
	const block = out.match(TEMPLATES_RE);
	if (block) {
		let t;
		try {
			t = JSON.parse(block[1]);
		} catch (err) {
			return { ok: false, html, tokens: 0, slots, templates: false, error: 'rate-templates is not valid JSON' };
		}
		out = out.replace(TEMPLATES_RE, '');
		if (typeof t.title === 'string') {
			if (!TITLE_RE.test(out)) return { ok: false, html, tokens: 0, slots, templates: false, error: 'no <title> to template' };
			out = out.replace(TITLE_RE, (_m, a, b) => a + escapeHtml(t.title) + b);
		}
		if (typeof t.description === 'string') {
			if (!META_DESC_RE.test(out)) return { ok: false, html, tokens: 0, slots, templates: false, error: 'no meta description to template' };
			out = out.replace(META_DESC_RE, (_m, a, b) => a + escapeHtml(t.description) + b);
		}
		if (t.jsonld !== undefined) {
			// "<" is escaped so the payload can never close its own <script>.
			const payload = JSON.stringify(t.jsonld).replace(/</g, '\\u003c');
			const script = '<script type="application/ld+json">' + payload + '</script>';
			let placed = false;
			out = out.replace(JSON_LD_RE, () => (placed ? '' : ((placed = true), script)));
			if (!placed) return { ok: false, html, tokens: 0, slots, templates: false, error: 'no JSON-LD to template' };
		}
		templates = true;
	}

	const tokens = (out.match(TOKEN_RE) || []).length;
	return { ok: true, html: out, tokens, slots, templates };
}

function resolve(sheet, key) {
	if (!sheet) return undefined;
	if (key === 'asOf') return sheet.asOf;
	const dot = key.lastIndexOf('.');
	if (dot < 1) return undefined;
	const productKey = key.slice(0, dot);
	const field = key.slice(dot + 1);
	const products = sheet.products;
	const product = Array.isArray(products) ? products.find((p) => p && p.key === productKey) : products?.[productKey];
	return product ? product[field] : undefined;
}

/** Returns the display string, or undefined if the value is not valid for the format. */
function format(value, fmt) {
	if (fmt === 'pct3' || fmt === 'num' || fmt === 'json') {
		if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
		return fmt === 'pct3' ? value.toFixed(3) + '%' : String(value);
	}
	if (fmt === 'datetime' || fmt === 'iso') {
		if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return undefined;
		// iso echoes the stored string, but only if it is plainly a timestamp.
		if (fmt === 'iso') return /^[0-9T:.+Z-]+$/.test(value) ? value : undefined;
		return DATETIME.format(new Date(value));
	}
	return undefined;
}

/**
 * Fill tokens from a rate sheet.
 *
 * @param {string} text - tokenized HTML or Markdown
 * @param {{ asOf: string, products: Array<object>|object }} sheet
 * @returns {{ text: string, replaced: number, missing: string[] }}
 *   `missing` lists every token that had no valid value. If it is non-empty the
 *   text still contains those tokens and MUST NOT be served.
 */
export function substitute(text, sheet) {
	const missing = [];
	let replaced = 0;
	const fill = (fmtOverride) => (m, key, fmt) => {
		const v = format(resolve(sheet, key), fmtOverride || fmt);
		if (v === undefined) {
			missing.push(key + ':' + (fmtOverride || fmt));
			return m;
		}
		replaced++;
		return v;
	};
	const out = text.replace(QUOTED_JSON_TOKEN_RE, (m, key) => fill('json')(m, key)).replace(TOKEN_RE, fill());
	return { text: out, replaced, missing };
}

/**
 * Count current rate values that survived tokenization: rates the page shows
 * outside a slot or template, which would stay frozen at their render-time value.
 * Checks each product's rate and APR, as displayed ("6.500") and as a bare JSON
 * number ("6.5"). Points are skipped: values like 0.5 are too common to be a signal.
 *
 * @returns {{ count: number, values: Record<string, number> }}
 */
export function findLeftovers(tokenizedHtml, sheet) {
	const products = Array.isArray(sheet?.products) ? sheet.products : Object.values(sheet?.products || {});
	const forms = new Set();
	for (const p of products) {
		for (const f of ['rate', 'apr']) {
			if (typeof p?.[f] === 'number' && Number.isFinite(p[f])) {
				forms.add(p[f].toFixed(3));
				forms.add(String(p[f]));
			}
		}
	}
	const values = {};
	let count = 0;
	for (const form of forms) {
		const re = new RegExp('(?<![0-9.])' + form.replace(/\./g, '\\.') + '(?![0-9])', 'g');
		const n = (tokenizedHtml.match(re) || []).length;
		if (n) {
			values[form] = n;
			count += n;
		}
	}
	return { count, values };
}
