# edge-eo-commerce

Clean-room deployment that demos edge HTML + Markdown caching (all four scenarios) against a
**pure client-side-rendered commerce page** — the deployment the drifted staging node can't do
(it runs the old markdown-only Harper component with no renderer).

This directory holds only the **new, deployment-specific** artifacts. The reusable code
(EdgeWorker, prerender component + renderer, converter, demo UI) lives in the main repo
`~/Projects/edge-engine-optimization` and is deployed per `DEPLOY.md`.

```
origin/                     Pure-CSR commerce product page (the new origin)
harper-markdown-cache/      One-table Harper component: the markdown_cache store (md-cache scenario)
env/                        Per-service .env templates (fill in the blanks)
scripts/                    seed.sh, validate.sh, harper-bulk-upload.js
demo/                       scenarios.config template pointing at the new host
DEPLOY.md                   The step-by-step runbook  ← start here
```

## Start
1. Read `DEPLOY.md`.
2. Host `origin/` → get `<origin-url>`.
3. Provision Harper (single node, `THREADS=1`) + deploy both components + renderer VM + Akamai property/EW.
4. `scripts/seed.sh <origin-url>` then `scripts/validate.sh`.

## Provenance
The prerender component + renderer are Harper's published **`HarperFast/template-static-prerender`**
(schema/renderer identical to our repo). The stale staging component is the *different*
`HarperFast/template-markdown-prerender`. See the main repo memory for details.
