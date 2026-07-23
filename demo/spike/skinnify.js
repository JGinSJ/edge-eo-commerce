'use strict';
// skinnify — the "skinny / prioritized HTML" transforms for the prioritized-delivery spike.
//
// Two bot-optimized variants derived from a fat page, both driven by a per-TEMPLATE
// config (CSS selectors) so 50 configs cover 375k pages — not 375k hand edits:
//
//   skinny      — rip out chrome (nav/promos/footer/cookie), scripts/styles/images,
//                 flatten attributes, keep the content in its original order. The
//                 answer moves up because the junk BEFORE it is gone.
//   prioritized — everything skinny does, then SEMANTICALLY REORDER: hoist the core
//                 answer to the very top (right after the <h1>), above the marketing
//                 intro / table-of-contents. "Most important items in the first N
//                 tokens" — the customer's exact ask.
//
// Deterministic; would later run in the renderer / an Akamai Function at the edge.
const { load } = require('cheerio');

// A template config: chrome to remove, the content root, and how to find the core answer.
const telcoSupportTemplate = {
  name: 'telco-support',
  keep: 'main',                 // content root to preserve
  coreSelector: '[data-core]',  // the direct answer block
  strip: [
    '.util-bar', 'header.site', 'nav.mega', '.subnav', '.panel', '.hero-promo',
    '.promo', '.topics', '.devices', '.crumbs', '.community', '.newsletter',
    '.related', 'footer.site', '.cookie', '.feedback', '.device-tabs',
  ],
  dropImages: true,             // img/picture/svg/video/iframe
  keepAttrs: ['href', 'lang'],  // everything else is flattened away
};

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
  ));
}

// Transform `html` per `cfg` in one of two modes: 'skinny' | 'prioritized'.
// Returns { html, coreAnchor, title }. coreAnchor is a short verbatim phrase from the
// core answer — the caller uses it to locate the answer in each variant for the metric.
function transform(html, cfg = telcoSupportTemplate, mode = 'skinny') {
  const $ = load(html);

  // Capture the core anchor BEFORE we strip attributes/chrome.
  let coreAnchor = '';
  const $anchorSrc = $(cfg.coreSelector).first();
  if ($anchorSrc.length) {
    const raw = ($anchorSrc.find('strong, h1, h2, h3').first().text() || $anchorSrc.text() || '');
    coreAnchor = raw.replace(/\s+/g, ' ').trim().slice(0, 48);
  }

  // Remove non-content and chrome.
  $('script, style, noscript, link, meta').remove();
  $('*').contents().filter((_, n) => n.type === 'comment').remove();
  (cfg.strip || []).forEach((sel) => $(sel).remove());
  if (cfg.dropImages) $('img, picture, source, svg, video, iframe').remove();

  // Pick the content root (fall back to body if the template selector misses).
  let $root = $(cfg.keep).first();
  if (!$root.length) $root = $('body');

  // Prioritized: hoist the core answer to the top of the content (right after the h1),
  // above the intro/TOC. Done BEFORE flattening so the coreSelector still matches.
  if (mode === 'prioritized') {
    const $core = $(cfg.coreSelector).first();
    if ($core.length) {
      const $h1 = $root.find('h1').first();
      if ($h1.length) $h1.after($core); else $root.prepend($core);
    }
  }

  // Flatten: drop every attribute except the few worth keeping.
  const keep = new Set(cfg.keepAttrs || []);
  $root.find('*').addBack().each((_, el) => {
    if (!el.attribs) return;
    for (const name of Object.keys(el.attribs)) {
      if (!keep.has(name)) delete el.attribs[name];
    }
  });

  const title = ($('title').first().text() || $root.find('h1').first().text() || '').trim();
  const rootHtml = $.html($root).trim();
  const out =
    '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>' +
    escapeHtml(title) + '</title>\n</head>\n<body>\n' + rootHtml + '\n</body>\n</html>\n';

  return { html: out, coreAnchor, title };
}

const skinnify = (html, cfg = telcoSupportTemplate) => transform(html, cfg, 'skinny');
const prioritize = (html, cfg = telcoSupportTemplate) => transform(html, cfg, 'prioritized');

// Generic, config-FREE content extraction — for ARBITRARY pages (no per-template
// selectors). Strips scripts/styles/media + structural chrome by tag, keeps the
// main content root, flattens, and caps length. Used to bound the input handed to
// the LLM auto-prioritizer (see auto-prioritize.js) and to make the spike run on
// real URLs the deterministic telco config wouldn't match.
function extractContent(html, maxChars = 30000) {
  const $ = load(html);
  $('script, style, noscript, link, meta, svg, iframe, template').remove();
  $('*').contents().filter((_, n) => n.type === 'comment').remove();
  $('nav, header, footer, aside, form, img, picture, source, video').remove();

  let $root = $('main').first();
  if (!$root.length) $root = $('article').first();
  if (!$root.length) $root = $('body');
  if (!$root.length) $root = $.root();

  $root.find('*').addBack().each((_, el) => {
    if (!el.attribs) return;
    for (const name of Object.keys(el.attribs)) {
      if (name !== 'href') delete el.attribs[name];
    }
  });

  let out = ($root.html() || '').replace(/\n{3,}/g, '\n\n').trim();
  if (out.length > maxChars) out = out.slice(0, maxChars) + '\n<!-- …content truncated… -->';
  return out;
}

module.exports = { skinnify, prioritize, transform, extractContent, escapeHtml, telcoSupportTemplate };
