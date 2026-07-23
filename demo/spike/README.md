# Prioritized-delivery spike — skinny HTML for AI bots

**A separate thought-leadership track (target: a telco), spiked on edge-eo-commerce
infra to decide "is this worth productizing?" without standing up new infra.** It is
deliberately isolated from the commerce demo (its own `spike/` dir + a `/spike` route)
so a second customer's narrative doesn't tangle into the commerce work, and so it's
easy to extract when it graduates to its own project/property.

## What it proves

The customer thesis (already proven by *their* PoC: citation accuracy 25–30% → 60%)
is that feeding AI bots a **prioritized/skinny HTML** — the answer first, chrome gone —
is what moves the needle. This spike shows the **delivery layer**: derive two
bot-optimized variants from a fat page via a per-**template** config, and measure it.

- **skinny** — strip chrome (nav/promos/footer), scripts/styles/images; flatten;
  keep content in original order. The answer moves up because the junk before it is gone.
- **prioritized** — skinny + **semantic reorder**: hoist the core answer above the
  marketing intro/TOC. "Most important items in the first N tokens" — the exact ask.

And the **routing**: a "who's asking?" selector maps each visitor to a variant via a
policy that mirrors the edge `crawler-policy` — 👤 person / 🔍 search → full HTML,
🤖 AI crawler → skinny, ✨ answer engine → prioritized. One URL, negotiated at the edge.

Sample = a fat, **fictional** telco support page (`telco-support-sample.html`,
"how to take a screenshot") where the answer is buried under mega-menus/promos/footer,
and (inside the article) behind a marketing intro + table-of-contents.

Measured (sample), answer position: **token 4,955** (person) → **446** (skinny) →
**76** (prioritized) — **65× closer**; **7,460 → 960 tokens** (−87%); **24.1 KB →
3.9 KB**. Real telco pages are far fatter, so the production effect is larger.

## Run

```bash
AKAMAI_STAGING=1 npm start      # then open http://localhost:8099/spike
```

Leave the URL blank for the sample, or paste any URL to skinnify it live (the
"test on business.company.com" story).

## Files

- `telco-support-sample.html` — the fat sample subject (fictional "Northwind Mobile").
- `skinnify.js` — the transforms (`skinnify` + `prioritize`, sharing `transform(html,
  cfg, mode)`). Deterministic, driven by a per-template config (`telcoSupportTemplate`):
  CSS selectors for chrome-to-strip + content root + core-answer anchor. 50 configs →
  375k pages; this is the scale story in miniature. Uses `cheerio`.
- `index.html` — the standalone `/spike` UI: 3-row token ruler + tiles + before/after
  panes, with a **"who's asking?" bot selector** (client-side `ROUTING` policy) that
  re-routes the bot pane + highlights the matching ruler row.
- Wired into `../server.js` via two routes: `GET /spike`, `POST /spike/skinnify`
  (`{url?}` → returns `original`, `skinny`, `prioritized`, each `{bytes,tokens,answerAt,html}`).

## How it graduates (not in the spike)

- **Move the transform to the edge**: skinnify runs in the renderer / an Akamai
  Function (Wasm), not the demo server. Store `skinny-html` as a new **variant** in
  the Harper cache key `{url, device, lang, variant}`; extend `crawler-policy.js` to
  route AI-answer-engine bots → `skinny-html`.
- **Prioritized-HTML variant**: the semantic *reorder* (core-first) is in this spike;
  the next step is an **ingest** path for the customer's own "grounding layer" artifact
  (when they generate the reordered HTML with their big-prompt agent, we cache+serve it).
- **Origin sync** (their #1 fear): content-hash revalidation + publish-driven purge +
  live "holes" (ESI/edge fetch) for volatile fields like pricing. Architecture, not
  a spike.
- **Metrics**: bot-type × cache hit/miss × status × ASN dashboard.
- **New project/property** with real telco content + an isolated section
  (`business.company.com`-style) when it's a real customer demo.
