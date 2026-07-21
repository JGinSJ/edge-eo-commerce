# DEPLOY — Commerce HTML + MD caching demo (clean-room)

A fresh, independent deployment that demos **all four scenarios** (cdn-cache, md-cache,
convert-cache, prerender) — including real `harper-cache-html` + `harper-cache-md` hits —
against a pure client-side-rendered commerce page.

**Reused as-is (not in this dir):** the EdgeWorker (`edgeworker/`, bundle v2.4.0), the CSR
prerender component + renderer (`harper-prerender-html-md-cache-fermyon-fallback/` = HarperFast's
`template-static-prerender`), the converter (`977adc68…fwf.app`), the seeding script, the demo UI —
all in the main repo `~/Projects/edge-engine-optimization`.
**New here:** `origin/` (CSR commerce page), `harper-markdown-cache/` (md-cache table),
`env/` templates, `scripts/`, `demo/scenarios.config.template.json`.

Tags: 👤 = you (cloud/Fabric/Akamai provisioning). 🤖 = Claude can do / has done.

---

## Fill-in values (record these as you go)
| Token | Value |
|---|---|
| `<origin-url>` | public URL of `origin/` (S3/Netlify/Vercel) |
| `<new-node-fqdn>` | Harper node host, e.g. `gq4-<name>.harperfabric.com` |
| `<new-property-host>` | Akamai property hostname |
| `<new-ew-id>` | new EdgeWorker ID |
| `<bot-key>` | shared secret = component `BOT_REQUEST_KEY` = `PMUSER_HARPER_BOT_KEY` |
| Harper user/pass | Basic creds (reads, write-through, renderer, seeding) |

---

## Phase 1 — CSR commerce origin  🤖 built / 👤 host
- 🤖 Done: `origin/` (pure-CSR product page; content injected by `app.js`, incl. `<title>`/`<meta>`/JSON-LD).
- 👤 Host `origin/` at `<origin-url>` (any static host). Must be reachable by Akamai (as origin) AND the renderer VM.
- Verify: `curl -s <origin-url> | grep -c "Aurora Pro ANC"` → **0** (content not in raw HTML — prerender adds it).

## Phase 2 — Harper instance + components + tables  👤 provision / 🤖 verify
1. 👤 New **single-node** Fabric instance. Run params: **`THREADS=1`** (required for on-demand render), `OPERATIONSAPI_NETWORK_PORT=9925`, `HTTP_PORT=9926`, `MQTT_NETWORK_PORT=1883`, `MQTT_WEBSOCKET=true`, `MQTT_REQUIREAUTHENTICATION` on. Create the Harper user.
2. 👤 Deploy the **prerender component** (`…/harper-prerender/` — Operations API `deploy_component` or Studio git deploy). Schema auto-creates the `prerender`+`local` DBs/tables (`PageCache` etc.) — **no hand-built DB**. Set component env from `env/harper-component.env.example` (`BOT_REQUEST_KEY=<bot-key>`).
3. 👤 Deploy the **`harper-markdown-cache/`** component (this dir) the same way → creates the `markdown_cache` table for md-cache.
4. 🤖 Verify (go/no-go): `scripts/validate.sh` Part A — every endpoint returns **401, not 404**.

## Phase 3 — Renderer on cloud VM  👤 provision / 🤖 config
1. 👤 Provision a cloud VM (Docker; multi-core; RAM for Chrome `shm_size:16gb`; **egress to `<new-node-fqdn>:9926`**). Copy `…/renderer/` to it.
2. 🤖 Fill `renderer/.env` from `env/renderer.env.example` (`HDB_HOST=<new-node-fqdn>`, user/pass, `WORKER_ID=cloud-1`, `NODE_ENV=production`).
3. 👤 `docker build -t prerender/renderer .` → `docker compose up -d` → `docker logs -f renderer`.
4. 🤖 Verify: renderer logs show `register-worker` OK + MQTT connected; Harper `local.render_worker` shows the worker.

## Phase 4 — Converter (reuse)  🤖
- No deploy. New property points `PMUSER_WASM_URL` at `https://977adc68-…fwf.app` (property-agnostic; write target + auth arrive per-request from the EW). 🤖 sanity-check it responds.

## Phase 5 — Akamai property + EdgeWorker  🤖 prep / 👤 config
1. 🤖 Build bundle: `cd …/edgeworker && ./build.sh` → `bundle.tgz` (v2.4.0). *(Built — see main repo.)*
2. 👤 New EW ID → upload `bundle.tgz` → activate **Staging**.
3. 👤 New property with: **Origin** = `<origin-url>`; **`/_harper` proxy** → `<new-node-fqdn>` (443); **AI Bot Interception** rule (fire EW on `X-Verified-Bot: true`); associate `<new-ew-id>`; add edge hostname + staging. `PMUSER_*`:

   | Var | Value |
   |---|---|
   | `PMUSER_HARPER_ENABLED` | `true` |
   | `PMUSER_HARPER_URL` | `/_harper` |
   | `PMUSER_HARPER_WRITE_URL` | `https://<new-node-fqdn>` |
   | `PMUSER_HARPER_USER` / `PMUSER_HARPER_PASS` | Harper Basic creds (Sensitive) |
   | `PMUSER_HARPER_BOT_KEY` | `<bot-key>` (= component `BOT_REQUEST_KEY`) |
   | `PMUSER_WASM_URL` | `https://977adc68-…fwf.app` |
   | `PMUSER_DEMO_MODE` | `true` |
   | `PMUSER_HARPER_TIMEOUT_MS` | `1500` |

   `HARPER_READ_MODE`/`WRITE_THROUGH`/`SERVE_HTML` are NOT set — demo presets supply them per `X-Demo-Scenario`.

## Phase 6 — Seed + validate  🤖
1. Seed desktop: `set -a; . env/bulk-upload.env; set +a; scripts/seed.sh <origin-url>`. Watch renderer logs for the render to complete → `PageCache`.
2. `HOST=<new-property-host> NODE=https://<new-node-fqdn> ORIGIN_URL=<origin-url> scripts/validate.sh` — Part B expects `harper-cache-html` (prerender/googlebot), `harper-cache-md` (convert-cache/claudebot), md-cache populate on 2nd hit, cdn-cache via Fermyon.
3. Point the demo UI: copy `demo/scenarios.config.template.json` → `…/demo/scenarios.config.json` (replace `<new-property-host>`); export `env/demo.env`; `AKAMAI_STAGING=1 npm start`.

---

## Guardrails (hard-won)
- **`THREADS=1`** — mandatory for on-demand renders on one node.
- **Renderer→9926 egress** — verify first; hard blocker, not perf.
- **Bot-key must match** across component `BOT_REQUEST_KEY` and `PMUSER_HARPER_BOT_KEY`, or `/page*` → 401.
- **`markdown_cache` present** — `validate.sh` Part A catches a 404 (component not deployed).
- **Same node reads+writes** — `PMUSER_HARPER_WRITE_URL` = `<new-node-fqdn>` (Fabric doesn't replicate cache).
- **Cache-bust every test** — `validate.sh` uses `?url=…&cb=…`; a plain URL serves a stale edge hit (`edge;dur=1`, wrong `x-bot-kind`).
- **EW fires only on `X-Verified-Bot: true`** — a plain browser request bypasses the EW and serves origin.

## Done =
`validate.sh` Part A all 401; Part B shows `harper-cache-html` + `harper-cache-md` (no 401/origin-fallback), md-cache write-through populates, cdn-cache via Fermyon; demo UI renders all four against the commerce page.
