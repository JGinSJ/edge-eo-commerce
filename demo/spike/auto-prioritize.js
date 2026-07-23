'use strict';
// auto-prioritize — LLM-generated "grounding layer" (prioritized HTML) for ANY page.
//
// The deterministic prioritize() in skinnify.js needs a per-template config (which
// selectors are chrome, where the core answer is). This module removes BOTH the
// per-template-config dependency AND the customer-artifact dependency: give it a raw
// page and Claude identifies the core answer, strips the chrome, and rewrites it
// answer-first — no marker, no config, works on arbitrary real URLs.
//
// This is the "we generate the grounding layer" story (vs. ingesting the customer's).
// It's pre-generated + cached in production (same prerender-then-cache pattern as the
// rest of the deployment), not run at serve time — so LLM latency isn't in the hot path.
const Anthropic = require('@anthropic-ai/sdk');
const { extractContent, escapeHtml } = require('./skinnify.js');
const { load } = require('cheerio');

const SYSTEM =
  'You restructure web-page content into a "grounding layer" for AI answer engines. ' +
  'Given the main content of a page, you rewrite it so a language model reaches the core ' +
  'answer first, in a fraction of the tokens — faithful to the source, never inventing facts.';

function buildPrompt(content, url) {
  return [
    'Here is the main content of a web page' + (url ? ' (' + url + ')' : '') + ', with site chrome already removed:',
    '',
    '<page>',
    content,
    '</page>',
    '',
    'Rewrite it as a prioritized "grounding layer" in clean, semantic HTML:',
    '- Put the single most important answer or summary FIRST, as the opening block.',
    '- Then supporting detail, in descending order of importance.',
    '- Strip anything that is not core content (leftover navigation, related links, promos, legal boilerplate).',
    '- Stay faithful to the source — do NOT invent facts, prices, steps, or device names.',
    '- Use only semantic tags (h1–h3, p, ol, ul, li, strong, table). No class/id attributes, scripts, or styles.',
    'Return the <body> inner HTML only.',
  ].join('\n');
}

// Structured output guarantees parseable JSON with the two anchors we need for the
// tokens-to-answer metric plus the generated HTML.
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    source_anchor: {
      type: 'string',
      description: 'A short (5–10 word) phrase copied EXACTLY from the source page content that marks where the core answer/topic begins — used to locate the answer in the ORIGINAL page.',
    },
    answer_lead: {
      type: 'string',
      description: 'The first ~8 words of your rewritten grounding-layer answer, verbatim — used to locate the answer in the generated HTML.',
    },
    html: {
      type: 'string',
      description: 'The prioritized grounding-layer HTML (body inner HTML), answer first, chrome removed, semantic tags only.',
    },
  },
  required: ['source_anchor', 'answer_lead', 'html'],
};

// Returns { html, answerLead, sourceAnchor, model }. Throws on auth / API errors
// (the caller turns those into a friendly message).
async function autoPrioritize(rawHtml, url) {
  const content = extractContent(rawHtml);
  const title = (load(rawHtml)('title').first().text() || '').trim();

  const client = new Anthropic(); // resolves ANTHROPIC_API_KEY or an `ant` profile

  // Stream (the HTML output can be long) and adaptive thinking (the rewrite is a
  // genuine reasoning task). Model per the claude-api skill default.
  const stream = client.messages.stream({
    model: 'claude-opus-4-8',
    max_tokens: 64000,
    thinking: { type: 'adaptive' },
    output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    system: SYSTEM,
    messages: [{ role: 'user', content: buildPrompt(content, url) }],
  });
  const msg = await stream.finalMessage();

  const textBlock = msg.content.find((b) => b.type === 'text');
  if (!textBlock) throw new Error('Model returned no text output (stop_reason: ' + msg.stop_reason + ')');
  let parsed;
  try {
    parsed = JSON.parse(textBlock.text);
  } catch (e) {
    throw new Error('Model did not return valid JSON: ' + textBlock.text.slice(0, 160));
  }

  const full =
    '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>' +
    escapeHtml(title) + '</title>\n</head>\n<body>\n' + parsed.html + '\n</body>\n</html>\n';

  return { html: full, answerLead: parsed.answer_lead, sourceAnchor: parsed.source_anchor, model: msg.model };
}

module.exports = { autoPrioritize };
