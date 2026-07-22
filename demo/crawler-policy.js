// Per-crawler content negotiation policy.
//
// Decides whether a given crawler should be served prerendered HTML or derived
// Markdown — from the SAME cached render. Pure, dependency-free, and shared by
// both the EdgeWorker (main.js) and the demo UI, so the policy is defined once
// and carries unchanged into the consolidated EdgeWorker.
//
// Identity in the demo comes from an injected `X-Bot-Kind` header (a sibling of
// X-Verified-Bot); in production it comes from Akamai Bot Manager's *verified*
// bot signal and/or the User-Agent. Both are spoofable on their own — Bot
// Manager is the trust layer.

// Default representation per known crawler. Overridable per property via
// PMUSER_CRAWLER_POLICY (e.g. "googlebot=html,gptbot=markdown,...").
export const DEFAULT_CRAWLER_POLICY = {
    // Search indexers want crawlable HTML (prerendered HTML is the CSR-SEO fix).
    googlebot: 'html',
    bingbot: 'html',
    // AI crawlers ingest for LLMs/answers — leaner, cheaper Markdown.
    'google-extended': 'markdown', // Google's AI-training agent (distinct from Googlebot search)
    claudebot: 'markdown',
    'claude-web': 'markdown',
    'anthropic-ai': 'markdown',
    gptbot: 'markdown',
    'oai-searchbot': 'markdown',
    'chatgpt-user': 'markdown',
    perplexitybot: 'markdown',
    ccbot: 'markdown',
    bytespider: 'markdown',
    'cohere-ai': 'markdown',
};

// User-Agent substring → canonical bot kind. Order matters: more specific first
// (e.g. oai-searchbot before gptbot, google-extended before googlebot).
const UA_PATTERNS = [
    ['oai-searchbot', 'oai-searchbot'],
    ['chatgpt-user', 'chatgpt-user'],
    ['gptbot', 'gptbot'],
    ['claudebot', 'claudebot'],
    ['claude-web', 'claude-web'],
    ['anthropic-ai', 'anthropic-ai'],
    ['perplexitybot', 'perplexitybot'],
    ['google-extended', 'google-extended'],
    ['googlebot', 'googlebot'],
    ['bingbot', 'bingbot'],
    ['bytespider', 'bytespider'],
    ['cohere-ai', 'cohere-ai'],
    ['ccbot', 'ccbot'],
];

/**
 * Parse a PMUSER_CRAWLER_POLICY string into a {kind: 'html'|'markdown'} map.
 * Format: "googlebot=html,claudebot=markdown,gptbot=markdown". Invalid pairs are
 * ignored. Returns {} when empty.
 *
 * @param {string} raw
 * @returns {Record<string,'html'|'markdown'>}
 */
export function parseCrawlerPolicy(raw) {
    if (!raw) return {};
    const out = {};
    for (const pair of String(raw).split(',')) {
        const [k, v] = pair.split('=').map((s) => (s == null ? s : s.trim().toLowerCase()));
        if (k && (v === 'html' || v === 'markdown')) out[k] = v;
    }
    return out;
}

/**
 * Determine the crawler kind. An explicit X-Bot-Kind value wins (demo / Bot
 * Manager-asserted); otherwise match the User-Agent against known patterns.
 *
 * @param {string} [botKindHeader] - value of the X-Bot-Kind header
 * @param {string} [userAgent]
 * @returns {string|null} canonical bot kind, or null if not identified
 */
export function detectBotKind(botKindHeader, userAgent) {
    const explicit = (botKindHeader || '').trim().toLowerCase();
    if (explicit && explicit !== 'human' && explicit !== 'none') return explicit;
    if (explicit === 'human' || explicit === 'none') return null; // explicitly a human
    const ua = (userAgent || '').toLowerCase();
    for (const [needle, kind] of UA_PATTERNS) {
        if (ua.includes(needle)) return kind;
    }
    return null;
}

/**
 * Resolve which cached representation to serve.
 *
 * Precedence:
 *   1. Per-crawler policy (default ∪ PMUSER override), keyed by detected botKind.
 *   2. Explicit `Accept: text/markdown` → markdown.
 *   3. A generic AI User-Agent (isAiUa) not otherwise mapped → markdown.
 *   4. Otherwise → html (humans + SEO crawlers without a markdown policy).
 *
 * Backward compatible with the prior AI-vs-human routing: with no botKind/policy,
 * acceptsMarkdown/isAiUa → markdown, else html.
 *
 * @param {object} a
 * @param {string|null} a.botKind
 * @param {boolean} a.acceptsMarkdown
 * @param {boolean} [a.isAiUa]
 * @param {Record<string,'html'|'markdown'>} [a.policy]
 * @returns {'html'|'markdown'}
 */
export function resolveRepresentation({ botKind, acceptsMarkdown, isAiUa = false, policy = {} }) {
    const merged = { ...DEFAULT_CRAWLER_POLICY, ...policy };
    if (botKind && merged[botKind]) return merged[botKind];
    if (acceptsMarkdown) return 'markdown';
    if (isAiUa) return 'markdown';
    return 'html';
}
