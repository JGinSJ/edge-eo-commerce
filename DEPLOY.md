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
**Added November 2026:** a finance vertical (`origin-finance/`) on the same property and Harper
instance, with serve-time rate injection. See "Finance vertical" and "Working from a new machine" below.

Tags: 👤 = you (cloud/Fabric/Akamai provisioning). 🤖 = Claude can do / has done.

---

## Fill-in values (record these as you go)
| Token | Value |
|---|---|
| `<origin-url>` | ✅ `https://stopwaitingshipit.com/` (Linode bucket `edge-eo-ecommerce` @ us-ord-1, fronted by the property) |
| `<new-node-fqdn>` | ✅ origin node `us-central1-a-1.commerce-demo.jorge-geronimo-org.harperfabric.com`; cluster URL `https://commerce-demo.jorge-geronimo-org.harperfabric.com` (EW `/_harper` target); Ops API `…:9925` |
| `<new-property-host>` | ✅ `stopwaitingshipit.com` (existing property, repurposed) |
| `<new-ew-id>` | new EdgeWorker ID |
| `<bot-key>` | shared secret = component `BOT_REQUEST_KEY` = `PMUSER_HARPER_BOT_KEY` |
| Harper user/pass | Basic creds (reads, write-through, renderer, seeding) |

---

## Phase 1 — CSR commerce origin  ✅ DONE (verified 2026-07-21)
- `origin/` (pure-CSR product page; content injected by `app.js`, incl. `<title>`/`<meta>`/JSON-LD).
- Hosted on **Linode Object Storage**, bucket `edge-eo-ecommerce` (root), region `us-ord-1`.
  Upload: `s3cmd sync origin/ s3://edge-eo-ecommerce/ --acl-public --guess-mime-type --no-mime-magic`.
- Fronted by property **stopwaitingshipit.com**:
  - Origin behavior → Origin Hostname `edge-eo-ecommerce.us-ord-1.linodeobjects.com`, **Forward Host Header = Origin Hostname** (Linode routes bucket by Host), HTTPS 443.
  - Rule "Default document": Criteria Path matches `/` → behavior **Modify Outgoing Request Path** → Action "Replace entire path" → `/index.html`. (In Phase 5, scope this away from `/_harper/*`.)
- Verified through the staging edge: `/`→200 text/html serving the CSR shell (0 product text), all assets 200 with correct types. `<origin-url>` = `https://stopwaitingshipit.com/`.

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

## Finance vertical: rate page with serve-time injection  ✅ DONE on staging (verified November 18, 2026)

A second CSR page, a mortgage rate page for the fictional Larkspur Bank, on the same bucket,
property, EdgeWorker and Harper instance as commerce. No property or EdgeWorker change was needed.
URL: `https://stopwaitingshipit.com/finance/index.html`. Use the explicit `index.html`; the
default-document rule only rewrites `/`.

**How a rate reaches each visitor**

| Visitor | Path |
|---|---|
| Bot | Harper stores the prerender with tokens (`%%RATE:<key>:<format>%%`) in place of rates, in both the HTML and the Markdown. On every `/page` or `/page_content` request it fills them from one row, `RateSheet` id `national`. |
| Person | `origin-finance/app.js` reads the same row through `/_harper/rate_sheet/national`. |

A rate change is one authenticated `PUT` to `/rate_sheet/national`. Nothing is cleared or re-rendered.

**Pieces**
- `origin-finance/`: the page. Its README documents the slot and template contract with the component.
- `harper-prerender/src/util/rates.js`: tokenize, substitute, leftover scan (pure, unit tested).
- `harper-prerender/src/util/rateInject.js`: gzip glue and response headers.
- `harper-prerender/src/resources/RateSheet.js`: `/rate_sheet`, public read, authenticated write.
- Schema: `RateSheet` table; `hasRateTokens` and `rateLeftovers` on `PageCache`.
- Tokenization runs on both store paths (`orchestrator.js` scheduled, `PageCache.js` on demand). Substitution runs on all three serve paths (`/page`, `/page_content`, REST `page_cache`).
- `scripts/set-rate.mjs`: change or reset the rate from the command line, with timings.
- Demo UI: the Finance vertical shows a rate control when `scenarios.config.json` gives the vertical a `"rate": { "product", "label" }`.

**Deploy or redeploy, in order**
1. Component: `HARPER_OPS_URL=https://<new-node-fqdn>:9925 … scripts/deploy-components.sh harper-prerender`. Note the port: the Operations API is 9925, while `env/bulk-upload.env` points at 9926 for seeding. The script ships source only and restarts the component.
2. Load the rate sheet: `set -a; . env/bulk-upload.env; set +a; node scripts/set-rate.mjs --reset`. Until the sheet exists, the finance page answers 503 to bots.
3. Origin: `s3cmd sync origin-finance/ s3://edge-eo-ecommerce/finance/ --acl-public --guess-mime-type --no-mime-magic --exclude README.md`.
4. Seed: `scripts/seed.sh https://stopwaitingshipit.com/finance/index.html`. A seeded page lands in the cache 12 to 30 seconds later; the scheduler queues seeds on a 30-second tick.
5. Verify on the node with the bot key header: `/page/?url=<encoded>&deviceType=desktop` returns `x-rate-injected: 1` and **`x-rate-leftovers: 0`**, and the body contains no `%%RATE`.
6. Change a rate: `node scripts/set-rate.mjs --rate 6.5 --apr 6.617`, or use the control in the demo UI.

**Behavior worth knowing**
- **Missing or invalid rate: 503, never a wrong rate.** If any token has no valid value, `/page` and `/page_content` return 503 with `x-rate-missing: <n>` and the edge falls back to the origin shell. `set-rate.mjs` and the demo server validate before writing; the component does not reject a bad write.
- **`x-rate-leftovers` should be 0.** It counts current rate values found outside a slot or template when the page was stored. Those stay frozen at their render-time value.
- **ETag and caching.** Injected responses drop the origin's `ETag` and `Last-Modified`, carry an ETag derived from the bytes served, and are `cache-control: no-store`.
- **Pages without rate hooks are untouched.** Commerce `/page` and `/page_content` were byte-identical before and after the component deploy.
- **Markdown tables are unevenly padded** on rate pages: columns are padded to the token width at store time. Valid Markdown, same content.

**Measured on staging, November 18, 2026 (from the development Mac to the `us-central1` node)**

| Method | Time for a rate change to reach a bot | Bot gets during the change |
|---|---|---|
| Re-render (upload, clear, reseed), 4 runs | 18 to 31 s | the origin shell, no rate |
| Injection, 7 runs | 112 to 308 ms, visible on the first request | the cached page, old rate then new |

Harper handler time (`server-timing: hdb`), 30 sequential requests each: finance HTML injected 1.41 ms median, commerce HTML static 0.65 ms. The pages differ in size and this was not a load test.

**Seeing the page as a person, through staging**
Public DNS for the hostname does not resolve to staging, so map it locally in a separate Chrome instance:
1. `dig +short stopwaitingshipit.com.edgekey-staging.net | tail -1` for the current staging IP.
2. `open -na "Google Chrome" --args --user-data-dir=/tmp/chrome-staging --host-resolver-rules="MAP stopwaitingshipit.com <ip>" https://stopwaitingshipit.com/finance/index.html`
3. Confirm the response header `x-akamai-staging: ESSL` in DevTools.

Verified this way on November 18, 2026: a rate published from the demo UI appeared on the page after a reload.

**Not verified**
- The REST `page_cache` path with a tokenized record.
- Replication lag of the rate sheet to the second node (see Guardrails).
- Edge caching of rate pages. Observed responses through staging were `no-store`, which differs from the `max-age=3600` the EdgeWorker bundle sets on Harper hits; not traced. Needs the EdgeWorker source.

---

## Working from a new machine  (set up on the Mac Mini, November 17, 2026)

1. `brew install s3cmd`. It prints Python `SyntaxWarning` lines; they are harmless.
2. `~/.s3cfg` (mode 600): `host_base = us-ord-1.linodeobjects.com`, `host_bucket = %(bucket)s.us-ord-1.linodeobjects.com`, `use_https = True`, plus an Object Storage access key with read/write on `edge-eo-ecommerce`. Check: `s3cmd ls s3://edge-eo-ecommerce/`.
3. `env/bulk-upload.env` (gitignored, sourced by the shell, so quote values): `HARPER_OPS_URL='https://<new-node-fqdn>:9926'`, `HARPER_ADMIN_USER`, `HARPER_ADMIN_PASS`.
4. `env/demo.env` (gitignored, read by the demo server, no quotes): see `env/demo.env.example`. `HARPER_BOT_KEY` must match the component's.
5. `cd harper-prerender && npm install && npm test` to run the component's unit tests locally. Harper itself is not needed for these.
6. Demo UI: `node demo/server.js`, then `http://localhost:8080`.

Not on the Mac Mini: the main repo `~/Projects/edge-engine-optimization`, which holds the EdgeWorker source. This repo carries only the built bundle.

---

## Guardrails (hard-won)
- **`THREADS=1`** — mandatory for on-demand renders on one node.
- **Renderer→9926 egress** — verify first; hard blocker, not perf.
- **Bot-key must match** across component `BOT_REQUEST_KEY` and `PMUSER_HARPER_BOT_KEY`, or `/page*` → 401.
- **`markdown_cache` present** — `validate.sh` Part A catches a 404 (component not deployed).
- **Same node reads+writes** — `PMUSER_HARPER_WRITE_URL` = `<new-node-fqdn>` (Fabric doesn't replicate cache).
- **Cache-bust every test** — `validate.sh` uses `?url=…&cb=…`; a plain URL serves a stale edge hit (`edge;dur=1`, wrong `x-bot-kind`).
- **EW fires only on `X-Verified-Bot: true`** — a plain browser request bypasses the EW and serves origin.

Added November 2026:
- **The staging certificate can expire and take the renderer with it.** The Let's Encrypt certificate on the staging edge expired on November 8, 2026. Every render of a `stopwaitingshipit.com` URL then failed with status 500 in about 110 ms, commerce included, while cached pages kept serving and hid the problem. Renewed November 18, 2026; it expires February 16, 2027. First check when renders fail fast: `openssl s_client` against the staging edge IP with the property hostname as SNI.
- **The property is on Akamai staging only.** The apex A records at the registrar are a mix that does not serve this property, so public DNS never reaches it. The demo UI and `validate.sh` pin the staging edge themselves.
- **The renderer VM must be pinned to the staging edge, and how is not recorded here.** Nothing in this repo sets it (no `extra_hosts`, no host-resolver rule). It works, so the mapping lives on the VM. Inferred, not inspected. If it is a hard-coded IP, it can go stale. Record the mechanism here when someone next logs in to the VM.
- **Bots must be tested with `/?url=<encoded page URL>`.** That is what the demo-mode EdgeWorker keys on. A bot request straight to `/finance/index.html` misses Harper (observed: 400 `origin-fallback` for HTML, a 55-byte `fermyon-fallback` for Markdown). Not checked for commerce.
- **`Accept-Language` is part of the page cache key.** Seeds are stored without one. A client that sends it reads a different, empty entry and gets 503. Node's `fetch` sends `Accept-Language: *`; curl sends none. `set-rate.mjs` uses plain `https` for this reason.
- **Version `app.js` when it changes.** The property serves `.js` with a cache lifetime of about seven days and the renderer's Chrome keeps a disk cache, so a changed `app.js` is ignored by the renderer and by returning visitors. Bump `./app.js?v=N` in `index.html` (served `no-store`). Applies to `origin/` too.
- **The instance has a second node.** A component deploy reported replication to `hub-us-west2-a-1`, and the rate sheet was readable there after a write. Phase 2 above says single-node and the guardrail above says Fabric does not replicate the cache; both may still hold for `PageCache`, but the rate sheet does replicate. Everything here was tested against `us-central1-a-1` only.
- **Redeploying the component kept the bot key.** After a `deploy_component` with `replace: true`, the default key still worked and a wrong key still got 401. The key in use equals the repo default, so this does not prove a custom key would survive.

## Done =
`validate.sh` Part A all 401; Part B shows `harper-cache-html` + `harper-cache-md` (no 401/origin-fallback), md-cache write-through populates, cdn-cache via Fermyon; demo UI renders all four against the commerce page.
