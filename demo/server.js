'use strict';
const http  = require('http');
const https = require('https');
const zlib  = require('zlib');
const fs    = require('fs');
const path  = require('path');
const dns   = require('dns').promises;

// Lightweight .env loader (no dependency). Populates process.env from
// ../env/demo.env then ./.env for keys not already set on the environment.
// Lines whose value still contains an unresolved `<placeholder>` are skipped,
// so a half-filled template can't clobber a real value (e.g. the duplicate
// HARPER_BOT_KEY line in demo.env — the real one wins).
(function loadDotenv() {
    const files = [path.join(__dirname, '..', 'env', 'demo.env'), path.join(__dirname, '.env')];
    for (const file of files) {
        let text;
        try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
        for (const raw of text.split(/\r?\n/)) {
            const line = raw.trim();
            if (!line || line.startsWith('#')) continue;
            const eq = line.indexOf('=');
            if (eq === -1) continue;
            const key = line.slice(0, eq).trim();
            let val = line.slice(eq + 1).trim();
            val = val.replace(/\s+#.*$/, '').trim();       // strip inline comment
            if (/^['"].*['"]$/.test(val)) val = val.slice(1, -1);
            if (!key || val.includes('<') || process.env[key] !== undefined) continue;
            process.env[key] = val;
        }
    }
})();

const PORT            = parseInt(process.env.PORT || '8080', 10);
const TIMEOUT_MS      = 20000;
// Edge host the 3-scenario flow runs against. Override with PRODUCTION_HOST.
const PRODUCTION_HOST = process.env.PRODUCTION_HOST || 'nobodycaresworkharder.me';

const sslAgent = new https.Agent({ rejectUnauthorized: true });
// Direct fetches (Wasm endpoint, live HTML) bypass cert verification — these
// endpoints may use self-signed or expired certs in demo environments.
const permissiveSslAgent = new https.Agent({ rejectUnauthorized: false });

// Token counting uses tiktoken cl100k_base — same methodology as akamai-html-to-md-optimization.
const { get_encoding } = require('tiktoken');
const enc = get_encoding('cl100k_base');
enc.encode('warmup'); // pre-load WASM binary so the first demo run isn't slow

// Akamai Functions converter (Fermyon Spin Wasm under the hood, HTML→Markdown). Override with WASM_URL.
const WASM_URL     = process.env.WASM_URL || 'https://bede2402-c4b7-4234-b17c-5e04fc46ef00.fwf.app';
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

// ── Scenario config (Phase A) ────────────────────────────────────────────────
// Each demo scenario points the SAME flow at a different backend (property host,
// converter, optional features). Driven by scenarios.config.json; the UI picks
// the active scenario and sends its id with each request. EDGE_IP env overrides
// the active scenario's edge (pin a staging edge until prod DNS is cut to Akamai).
let SCENARIO_CFG = { default: null, scenarios: [] };
try {
    SCENARIO_CFG = JSON.parse(fs.readFileSync(path.join(__dirname, 'scenarios.config.json'), 'utf8'));
} catch (e) { console.warn('scenarios.config.json not loaded:', e.message); }
const SCENARIOS = SCENARIO_CFG.scenarios || [];
const DEFAULT_SCENARIO = SCENARIO_CFG.default || (SCENARIOS[0] && SCENARIOS[0].id) || null;

function resolveScenario(id) {
    const s = SCENARIOS.find(x => x.id === id)
        || SCENARIOS.find(x => x.id === DEFAULT_SCENARIO)
        || SCENARIOS[0];
    if (!s) return { id: 'default', host: PRODUCTION_HOST, wasmUrl: WASM_URL, edgeIp: '', stagingHost: '', features: {} };
    return {
        id: s.id, label: s.label,
        host:   s.host   || PRODUCTION_HOST,
        wasmUrl: s.wasmUrl || WASM_URL,
        edgeIp: s.edgeIp || '',
        stagingHost: s.stagingHost || '',
        ewScenario: s.ewScenario || '',
        features: s.features || {}
    };
}

// Which Akamai edge IP to connect to for a scenario. Priority:
//   1. explicit cfg.edgeIp (pin in scenarios.config.json)
//   2. STAGING mode → resolve the scenario's OWN staging edge from its host
//      (cfg.stagingHost, default <host>.edgekey-staging.net) — so each scenario
//      targets its own edge: no global-EDGE_IP cert mismatch, no hardcoded
//      rotating IPs
//   3. global EDGE_IP env
//   4. '' → connect to the host directly via DNS (once prod is cut to Akamai)
// Enable with AKAMAI_STAGING=1.
const STAGING = /^(1|true|staging|yes)$/i.test(process.env.AKAMAI_STAGING || '');
async function resolveEdgeIp(cfg) {
    if (cfg && cfg.edgeIp) return cfg.edgeIp;
    if (STAGING && cfg && cfg.host) {
        const sHost = cfg.stagingHost || (cfg.host + '.edgekey-staging.net');
        try { return (await dns.lookup(sHost)).address; }
        catch { return process.env.EDGE_IP || ''; }
    }
    return process.env.EDGE_IP || '';
}

function countTokens(text) {
    try { return enc.encode(text).length; } catch { return Math.ceil(text.length / 4); }
}

// Turndown converts fixture HTML to Markdown for token comparison.
// Scripts, styles, nav and footer are stripped — these carry zero semantic
// value for AI crawlers and are the primary source of token bloat.
const TurndownService = require('turndown');
const td = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-' });
td.remove(['script', 'style', 'nav', 'footer', 'iframe', 'noscript', 'svg']);

function loadFixtureTokens(fixtureFile) {
    try {
        const html     = fs.readFileSync(path.join(FIXTURES_DIR, path.basename(fixtureFile)), 'utf8');
        const markdown = td.turndown(html);
        const htmlTokens     = countTokens(html);
        const markdownTokens = countTokens(markdown);
        if (!htmlTokens || !markdownTokens) return null;
        return {
            htmlTokens, markdownTokens, fromFixture: true,
            htmlBytes:     Buffer.byteLength(html, 'utf8'),
            markdownBytes: Buffer.byteLength(markdown, 'utf8'),
            significant:   (htmlTokens / markdownTokens) >= 3,
        };
    } catch {
        return null;
    }
}

// Modern Akamai edges report cache status via `server-timing: cdn-cache; desc=HIT|MISS`
// rather than the legacy X-Cache header. Extract HIT/MISS so cacheBadge can read it.
function cdnCacheStatus(serverTiming) {
    if (!serverTiming) return '';
    const m = String(serverTiming).match(/cdn-cache;\s*desc=([A-Za-z_]+)/i);
    return m ? m[1].toUpperCase() : '';
}

function makeEdgeRequest(targetUrl, extraHeaders = {}, cfg = null, previewBytes = 400) {
    const host = (cfg && cfg.host) || PRODUCTION_HOST;
    // Harper scenarios cache in Harper, so we bust the Akamai CDN (unique cb=) to
    // force the EW to re-run and read Harper on the return visit. The CDN-only
    // scenario (edge-convert) caches AT the CDN — so we must NOT bust it, or the
    // return visit never hits the CDN (shows "Bypassed" instead of a cache hit).
    const harperScenario = !!(cfg && cfg.features && cfg.features.harperCache);
    return resolveEdgeIp(cfg).then(edgeIp => new Promise((resolve, reject) => {
        const start = Date.now();
        const isBot = extraHeaders['X-Verified-Bot'] === 'true';
        const options = {
            hostname: edgeIp || host,
            servername: host,            // SNI + cert match when pinning an edge IP
            port: 443,
            path: isBot
                ? '/?url=' + encodeURIComponent(targetUrl) + (harperScenario ? '&cb=' + Date.now() : '')
                : new URL(targetUrl).pathname + (new URL(targetUrl).search || ''),
            method: 'GET',
            // X-Demo-Scenario tells the demo-mode EW which scenario to apply (one EW,
            // one property serves all scenarios). Ignored unless PMUSER_DEMO_MODE=true.
            headers: { 'Accept': '*/*', 'Host': host, ...(cfg && cfg.ewScenario ? { 'X-Demo-Scenario': cfg.ewScenario } : {}), ...extraHeaders },
            agent: sslAgent
        };

        const req = https.request(options, (res) => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const raw = Buffer.concat(chunks);
                const isGzip = (res.headers['content-encoding'] || '').includes('gzip');
                const finalize = (buf) => resolve({
                    status:          res.statusCode,
                    responseTime:    Date.now() - start,
                    contentType:     res.headers['content-type']     || '',
                    xCache:          res.headers['x-cache'] || cdnCacheStatus(res.headers['server-timing']) || '',
                    xWasmExecution:  res.headers['x-wasm-execution'] || '',
                    xServedBy:       res.headers['x-served-by']      || '',
                    xCacheWrite:     res.headers['x-cache-write']    || '',
                    bodySize:        buf.length,
                    bodyPreview:     buf.toString('utf8', 0, previewBytes).trim()
                });
                if (isGzip) {
                    zlib.gunzip(raw, (err, buf) => finalize(err ? raw : buf));
                } else {
                    finalize(raw);
                }
            });
        });

        req.setTimeout(TIMEOUT_MS, () =>
            req.destroy(new Error(`Request timed out after ${TIMEOUT_MS / 1000}s`))
        );
        req.on('error', reject);
        req.end();
    }));
}

// Direct fetch to a real URL — used for token comparison, bypasses the edge.
// Follows up to 3 redirects so pages that 301 to www. still return real HTML.
// Accept-Encoding: identity disables gzip — Node's http module does not auto-decompress,
// and tokenizing raw gzip bytes produces meaningless token counts.
function makeDirectFetch(url, headers = {}, hops = 3) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const lib = parsed.protocol === 'https:' ? https : http;
        const req = lib.request({
            hostname: parsed.hostname,
            port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
            path: parsed.pathname + (parsed.search || ''),
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; AkamaiDemo/1.0)',
                'Accept-Encoding': 'identity',
                ...headers
            },
            agent: parsed.protocol === 'https:' ? permissiveSslAgent : undefined
        }, (res) => {
            if (hops > 0 && [301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                res.resume();
                const next = new URL(res.headers.location, url).href;
                resolve(makeDirectFetch(next, headers, hops - 1));
                return;
            }
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve({
                status:      res.statusCode,
                contentType: res.headers['content-type'] || '',
                body:        Buffer.concat(chunks).toString('utf8')
            }));
        });
        req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error('Timeout')));
        req.on('error', reject);
        req.end();
    });
}

// Calls the Wasm function directly (no EdgeWorker truncation) and fetches the target HTML
// in parallel, then returns accurate cl100k_base token counts for both.
async function fetchTokenComparison(targetUrl, cfg = null) {
    const wasmUrl = (cfg && cfg.wasmUrl) || WASM_URL;
    const [htmlResult, wasmResult] = await Promise.allSettled([
        makeDirectFetch(targetUrl),
        makeDirectFetch(wasmUrl, { 'X-Target-URL': targetUrl })
    ]);
    if (htmlResult.status !== 'fulfilled' || wasmResult.status !== 'fulfilled') return null;
    if (wasmResult.value.status !== 200) return null;
    // Guard against the Wasm endpoint returning non-markdown (e.g. an error page).
    if (!wasmResult.value.contentType.includes('markdown')) return null;

    const htmlTokens     = countTokens(htmlResult.value.body);
    const markdownTokens = countTokens(wasmResult.value.body);
    if (!htmlTokens || !markdownTokens) return null;
    return {
        htmlTokens, markdownTokens,
        htmlBytes:     Buffer.byteLength(htmlResult.value.body, 'utf8'),
        markdownBytes: Buffer.byteLength(wasmResult.value.body, 'utf8'),
        // Byte sizes are ALWAYS returned (real HTML vs Markdown, for the cards). The
        // token-ratio metric is only featured when "significant" (≥3×) — pages dominated
        // by inline JS convert to nearly-as-large Markdown, where a ~1× ratio misleads.
        significant:   (htmlTokens / markdownTokens) >= 3,
    };
}

async function runTests(targetUrl, fixtureFile, cfg = null) {
    // Fixture takes priority over live fetch — falls back to live fetch when absent.
    const tokenPromise = fixtureFile
        ? Promise.resolve(loadFixtureTokens(fixtureFile))
        : fetchTokenComparison(targetUrl, cfg);

    const botHeaders = {
        'X-Verified-Bot': 'true',
        'Pragma': 'akamai-x-cache-on'
    };

    const [testA, tokenData] = await Promise.all([
        makeEdgeRequest(targetUrl, {}, cfg),
        tokenPromise
    ]);
    const testB = await makeEdgeRequest(targetUrl, botHeaders, cfg);

    // Return visit.
    //
    // Write-through (option A): the first visit's write to Harper is confirmed by
    // X-Cache-Write, so rather than re-race a ~2s read (the EdgeWorker's GET can hit
    // read-after-write lag and miss) we serve exactly what B wrote — the entry under
    // the same key. A real crawler returns minutes/hours later, well after the write,
    // so the return visit always hits; we present that truthfully from the confirmed
    // write instead of gambling on the demo's tight timing. If the write did NOT
    // confirm (e.g. origin blocked the converter), fall through to a real request so
    // we never fake a hit.
    //
    // Other scenarios (prerender, CDN): a real return visit after a short delay.
    const writeThrough = !!(cfg && cfg.features && cfg.features.writeThrough);
    const bWriteConfirmed = testB.xCacheWrite === 'ok'
        || /^harper-cache/.test((testB.xServedBy || '').toLowerCase());

    let testC;
    if (writeThrough && bWriteConfirmed) {
        testC = Object.assign({}, testB, {
            xServedBy: 'harper-cache-md',
            fromWriteThrough: true,
        });
    } else {
        await new Promise(r => setTimeout(r, 2000));
        testC = await makeEdgeRequest(targetUrl, botHeaders, cfg);
    }

    return { testA, testB, testC, tokenData, scenario: cfg ? cfg.id : null };
}

function sendJSON(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

// ---------------------------------------------------------------------------
// HTML frontend (embedded — no build step required)
// ---------------------------------------------------------------------------
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AI Content Optimization — Akamai Live Demo</title>
<style>
/* Akamai brand palette (from brand-guidelines.pdf)
   Navy:   #002F6C  (RGB 0,47,108)
   Blue:   #00A4EB  (RGB 0,164,235)
   Orange: #FF8B00  (RGB 255,139,0)
   Font:   Instrument Sans
*/
@import url('https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;600;700;800&display=swap');
/* ── Who's asking? (hero view) ───────────────────────────────────────────── */
.wa-hero{background:#fff;border-radius:14px;padding:30px 32px;margin-bottom:20px;
         box-shadow:0 1px 3px rgba(0,0,0,.08);border-top:3px solid #00A4EB}
.wa-eyebrow{font-size:11px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:#00A4EB;margin-bottom:10px}
.wa-h2{font-size:30px;font-weight:800;color:#002F6C;letter-spacing:-.5px;margin-bottom:12px;text-wrap:balance}
.wa-lede{font-size:15px;line-height:1.7;color:#5a6b7b;max-width:720px;margin-bottom:22px}
.wa-lede em{font-style:normal;font-weight:700;color:#002F6C}
.wa-urlrow{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.wa-urlrow .url-input{flex:1;min-width:260px}
.wa-store{display:flex;align-items:center;gap:10px;flex:1;min-width:260px;
          background:#f1f5f9;border:1px solid #e2e8f0;border-radius:10px;padding:11px 14px}
.wa-lock{font-size:14px;opacity:.55}
.wa-store-url{font-family:ui-monospace,Menlo,monospace;font-size:14px;font-weight:600;color:#002F6C}
.wa-store-tag{margin-left:auto;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;
              color:#0284c7;background:#e0f2fe;padding:3px 9px;border-radius:999px;white-space:nowrap}
.wa-store-hint{margin-top:10px;font-size:12.5px;line-height:1.5;color:#94a3b8}
.wa-custom-toggle{margin-top:10px;font-size:13px}
.wa-custom-toggle a{color:#0284c7;text-decoration:none;font-weight:600}
.wa-custom-toggle a:hover{text-decoration:underline}
.wa-custom{margin-top:12px;padding:14px;background:#f8fafc;border:1px dashed #cbd5e1;border-radius:10px}
.wa-custom-row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.wa-custom-input{flex:1;min-width:260px;padding:11px 13px;border:1px solid #cbd5e1;border-radius:8px;
                 font-family:ui-monospace,Menlo,monospace;font-size:13px;color:#0f172a}
.wa-custom-input:focus{outline:none;border-color:#00A4EB;box-shadow:0 0 0 3px rgba(0,164,235,.15)}
.wa-custom-hint{margin-top:9px;font-size:12px;line-height:1.5;color:#94a3b8}
.wa-custom-back{margin-top:10px;font-size:12.5px}
.wa-custom-back a{color:#64748b;text-decoration:none;font-weight:600}
.wa-custom-back a:hover{text-decoration:underline}
.wa-ba{display:inline-block;margin-top:4px;font-size:12.5px;color:#475569;font-weight:600}
.wa-note{margin-top:12px;font-size:13px;color:#8a97a5;min-height:18px}
.wa-note code{background:#f1f5f9;padding:2px 7px;border-radius:5px;font-size:12px;color:#334155}
.wa-note.err{color:#c0392b}
.wa-switch{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:18px}
.wa-seg{display:flex;flex-direction:column;align-items:flex-start;gap:2px;
        padding:16px 18px;border-radius:12px;border:1.5px solid #e2e8f0;background:#fff;
        cursor:pointer;text-align:left;transition:border-color .14s ease,transform .14s ease,box-shadow .14s ease}
.wa-seg:hover{border-color:#cbd5e1;transform:translateY(-1px)}
.wa-ico{font-size:22px;line-height:1;margin-bottom:6px}
.wa-seg-t{font-size:15px;font-weight:700;color:#1f2d3d}
.wa-seg-s{font-size:12px;font-weight:600;color:#94a3b8;font-family:ui-monospace,Menlo,monospace}
.wa-seg.active{box-shadow:0 4px 14px rgba(0,0,0,.10)}
.wa-seg.is-human.active{border-color:#64748b;background:#f8fafc}
.wa-seg.is-search.active{border-color:#00A4EB;background:#f0f9ff}
.wa-seg.is-ai.active{border-color:#FF8B00;background:#fff8f0}
.wa-seg.active .wa-seg-t{color:#002F6C}
.wa-crawlers{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:-4px 0 18px}
.wa-crawlers:empty{display:none}
.wa-chip-lead{font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#94a3b8;margin-right:2px}
.wa-chip{font-family:ui-monospace,Menlo,monospace;font-size:12.5px;font-weight:600;padding:6px 13px;border-radius:999px;
         border:1px solid #d9e1ea;background:#fff;color:#475569;cursor:pointer;transition:border-color .12s,color .12s,background .12s}
.wa-chip:hover{border-color:#94a3b8}
.wa-chip.on{color:#fff;border-color:transparent}
.wa-crawlers.lane-search .wa-chip.on{background:#00A4EB}
.wa-crawlers.lane-ai .wa-chip.on{background:#FF8B00}
.wa-inspector{display:grid;grid-template-columns:minmax(0,0.92fr) minmax(0,1.08fr);gap:16px;margin-bottom:22px}
.wa-col{background:#fff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.08);overflow:hidden;border:1px solid #eef2f6}
.wa-col-head{padding:12px 18px;font-size:11px;font-weight:800;letter-spacing:.09em;text-transform:uppercase;
             border-bottom:1px solid #eef2f6;display:flex;align-items:center;justify-content:space-between;gap:10px}
.wa-req .wa-col-head{color:#64748b;background:#f8fafc}
.wa-col-body{padding:18px}
.wa-who{font-size:14px;color:#334155;line-height:1.6;margin-bottom:16px}
.wa-who strong{color:#002F6C}
.wa-hdrs{font-family:ui-monospace,Menlo,monospace;font-size:12.5px;line-height:1.9}
.wa-hdr{display:flex;gap:8px;padding:3px 0;border-bottom:1px dashed #eef2f6}
.wa-hk{color:#94a3b8;flex:0 0 116px}
.wa-hv{color:#1f2d3d;word-break:break-all}
.wa-hv .hl{color:#0284c7;font-weight:700}
.wa-hv .hlo{color:#d97706;font-weight:700}
.wa-res .wa-col-head{color:#fff;border-bottom:none}
.wa-res.lane-human .wa-col-head{background:#64748b}
.wa-res.lane-search .wa-col-head{background:#00A4EB}
.wa-res.lane-ai .wa-col-head{background:#FF8B00}
.wa-served{font-family:ui-monospace,Menlo,monospace;font-size:12px;font-weight:700;
           padding:4px 10px;border-radius:6px;background:rgba(255,255,255,.22);color:#fff;white-space:nowrap}
.wa-metrics{display:flex;gap:22px;flex-wrap:wrap;margin-bottom:16px;padding-bottom:16px;border-bottom:1px solid #eef2f6}
.wa-metric .mv{font-size:19px;font-weight:800;color:#002F6C;font-variant-numeric:tabular-nums}
.wa-metric .ml{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#94a3b8;margin-top:2px}
.wa-body-label{font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:#94a3b8;margin:0 0 8px}
.wa-pre{font-family:ui-monospace,Menlo,monospace;font-size:12px;line-height:1.6;
        background:#0f1b2d;color:#cbd5e1;border-radius:8px;padding:14px 16px;max-height:290px;overflow:auto;
        white-space:pre-wrap;word-break:break-word}
.wa-callout{font-size:13px;line-height:1.6;color:#5a6b7b;background:#f8fafc;border-left:3px solid #cbd5e1;
            padding:10px 14px;border-radius:0 8px 8px 0;margin-bottom:16px}
.wa-res.lane-search .wa-callout{border-left-color:#00A4EB}
.wa-res.lane-ai .wa-callout{border-left-color:#FF8B00}
.wa-empty{padding:34px 18px;text-align:center;color:#94a3b8;font-size:14px}
.wa-spin{display:inline-block;width:15px;height:15px;border:2px solid #cbd5e1;border-top-color:#00A4EB;
         border-radius:50%;animation:wa-rot .7s linear infinite;vertical-align:-2px;margin-right:8px}
@keyframes wa-rot{to{transform:rotate(360deg)}}
.wa-flow{display:flex;align-items:center;justify-content:center;gap:14px;flex-wrap:wrap;
         background:#002F6C;border-radius:12px;padding:16px 22px}
.wa-flow-step{font-size:13px;font-weight:600;color:#cfe6f5;display:flex;align-items:center}
.wa-flow-n{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;
           background:#00A4EB;color:#fff;font-size:11px;font-weight:800;margin-right:8px;flex:0 0 auto}
.wa-flow-step code{background:rgba(255,255,255,.12);padding:1px 6px;border-radius:4px;font-size:12px;color:#fff;margin:0 4px}
.wa-flow-arrow{color:#4a7bb0;font-size:16px}
@media(max-width:820px){.wa-inspector{grid-template-columns:1fr}.wa-switch{grid-template-columns:1fr}}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Instrument Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
     background:#f0f4f8;color:#3d3d3d;min-height:100vh}

/* ── Header ── */
header{background:#002F6C;padding:0 48px;
       display:flex;align-items:center;justify-content:space-between;
       min-height:68px}
.logo{display:flex;align-items:center;gap:14px}
.logo-mark{width:34px;height:34px;background:#00A4EB;border-radius:6px;
           display:flex;align-items:center;justify-content:center;
           font-weight:800;font-size:16px;color:#fff;letter-spacing:-1px}
.logo-name{font-size:17px;font-weight:700;color:#fff;letter-spacing:-.2px}
.header-pill{background:rgba(0,164,235,.18);border:1px solid rgba(0,164,235,.35);
             color:#7dd6f0;padding:4px 14px;border-radius:100px;
             font-size:12px;font-weight:600;letter-spacing:.3px}

/* ── Hero ── */
.hero{background:#002F6C;padding:0 48px 40px;border-bottom:3px solid #00A4EB}
.hero h1{font-size:32px;font-weight:800;color:#fff;
         margin-bottom:10px;letter-spacing:-.4px}
.hero p{font-size:15px;line-height:1.7;color:#9ab4cc;max-width:680px}
.hero-hook{display:inline-block;background:#FF8B00;color:#fff;
           font-size:12px;font-weight:800;text-transform:uppercase;
           letter-spacing:.8px;padding:4px 12px;border-radius:4px;
           margin-bottom:18px}

/* ── Layout ── */
main{max-width:1120px;margin:0 auto;padding:36px 24px 60px}

/* ── URL Form ── */
.url-form{background:#fff;border-radius:12px;padding:24px 28px;
          margin-bottom:28px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.url-form label{display:block;font-size:13px;font-weight:700;
                color:#002F6C;margin-bottom:10px}
.url-hint{font-size:12px;font-weight:400;color:#a8a8aa;margin-left:6px}
.url-row{display:flex;gap:10px}
.url-input{flex:1;padding:12px 16px;border:1.5px solid #d4dbe3;
           border-radius:8px;font-size:15px;color:#002F6C;outline:none;
           transition:border-color .15s}
.url-input:focus{border-color:#00A4EB}
.run-btn{background:#00A4EB;color:#fff;border:none;padding:12px 32px;
         border-radius:8px;font-size:15px;font-weight:700;cursor:pointer;
         white-space:nowrap;transition:background .15s;letter-spacing:.2px}
.run-btn:hover{background:#007faa}
.run-btn:disabled{background:#a8a8aa;cursor:not-allowed}

/* ── Loading ── */
.loading{display:none;text-align:center;padding:56px 24px}
.spinner{width:40px;height:40px;border:3px solid #dde3e9;
         border-top-color:#00A4EB;border-radius:50%;
         animation:spin .75s linear infinite;margin:0 auto 20px}
@keyframes spin{to{transform:rotate(360deg)}}
.loading-label{font-size:13px;font-weight:700;color:#002F6C;
               text-transform:uppercase;letter-spacing:.6px;margin-bottom:6px}
.loading p{font-size:14px;color:#a8a8aa}

/* ── Error ── */
.error-banner{display:none;background:#fef2f2;border:1px solid #fecaca;
              color:#b91c1c;padding:14px 18px;border-radius:8px;
              margin-bottom:20px;font-size:14px}

/* ── Section title ── */
.section-title{font-size:11px;font-weight:700;text-transform:uppercase;
               letter-spacing:.9px;color:#a8a8aa;margin-bottom:14px}

/* ── Test Cards ── */
#results{display:none}
.test-cards{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;
            margin-bottom:36px}
.test-card{background:#fff;border-radius:12px;overflow:hidden;
           box-shadow:0 1px 3px rgba(0,0,0,.08);
           display:flex;flex-direction:column}
.card-stripe{height:4px}
.test-a .card-stripe{background:#6b7280}
.test-b .card-stripe{background:#00A4EB}
.test-c .card-stripe{background:#FF8B00}
.card-head{padding:18px 20px 14px;border-bottom:1px solid #f2f5f7}
.card-step{font-size:10px;font-weight:800;text-transform:uppercase;
           letter-spacing:1.2px;margin-bottom:6px}
.test-a .card-step{color:#6b7280}
.test-b .card-step{color:#00A4EB}
.test-c .card-step{color:#FF8B00}
.card-title{font-size:17px;font-weight:800;color:#002F6C;margin-bottom:4px}
.card-sub{font-size:12px;color:#a8a8aa;line-height:1.5}
.card-body{padding:14px 20px;flex:1}
.stat{display:flex;justify-content:space-between;align-items:center;
      padding:8px 0;border-bottom:1px solid #f5f7f9;font-size:13px}
.stat:last-child{border-bottom:none}
.stat-k{font-size:12px;color:#6b7280;font-weight:500}
.stat-v{font-weight:700;color:#002F6C;font-size:13px}
.preview-label{font-size:10px;font-weight:700;text-transform:uppercase;
               letter-spacing:.5px;color:#a8a8aa;margin-top:14px;margin-bottom:6px}
.preview{background:#f7f9fb;border:1px solid #e8edf2;border-radius:6px;
         padding:10px 12px;font-family:'SF Mono','Fira Code','Courier New',monospace;
         font-size:11px;color:#3d4f5c;line-height:1.6;max-height:90px;
         overflow:hidden;word-break:break-all}
.card-desc{padding:14px 20px;background:#f8fafb;border-top:1px solid #f0f4f7;
           font-size:13px;color:#4b5563;line-height:1.7}

/* ── Badges ── */
.badge{display:inline-flex;align-items:center;padding:3px 9px;border-radius:4px;
       font-size:11px;font-weight:700;letter-spacing:.3px}
.b-hit    {background:#d1fae5;color:#065f46}
.b-miss   {background:#fef3c7;color:#92400e}
.b-bypass {background:#f1f5f9;color:#64748b}
.b-html   {background:#ede9fe;color:#5b21b6}
.b-md     {background:#dbeafe;color:#1d4ed8}
.b-ok     {background:#d1fae5;color:#065f46}
.b-err    {background:#fee2e2;color:#b91c1c}
.b-edge   {background:#e0f2fe;color:#0369a1}

/* ── Metrics ── */
.metrics-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.metric-card{background:#fff;border-radius:12px;padding:28px 24px;
             box-shadow:0 1px 3px rgba(0,0,0,.08);
             border-top:4px solid #00A4EB}
.metric-card:nth-child(2){border-top-color:#FF8B00}
.metric-card:nth-child(3){border-top-color:#002F6C}
.metric-val{font-size:52px;font-weight:900;color:#002F6C;line-height:1;
            margin-bottom:10px}
.metric-val sup{font-size:24px;font-weight:700;vertical-align:super;
                line-height:0;color:#00A4EB}
.metric-card:nth-child(2) .metric-val sup{color:#FF8B00}
.metric-card:nth-child(3) .metric-val sup{color:#002F6C}
.metric-tokens{font-size:13px;font-weight:600;color:#9ca3af;margin-bottom:10px;
               letter-spacing:.01em;min-height:18px}
.metric-label{font-size:16px;font-weight:800;color:#002F6C;margin-bottom:8px}
.metric-desc{font-size:13px;color:#4b5563;line-height:1.65;margin-bottom:10px}
.metric-src{font-size:11px;color:#c0c8d0;font-style:italic}

footer{text-align:center;padding:32px;color:#c0c8d0;font-size:12px}

/* ── Fixture bar ── */
.fixture-bar{background:#fff;border-radius:12px;padding:20px 28px;
             margin-bottom:28px;box-shadow:0 1px 3px rgba(0,0,0,.08);
             border-left:4px solid #FF8B00}
.fixture-bar-header{display:flex;align-items:baseline;gap:10px;margin-bottom:14px}
.fixture-bar-title{font-size:13px;font-weight:700;color:#002F6C}
.fixture-bar-hint{font-size:12px;color:#a8a8aa}
.fixture-customer{margin-bottom:10px}
.fixture-customer:last-child{margin-bottom:0}
.fixture-customer-name{font-size:10px;font-weight:800;text-transform:uppercase;
                        letter-spacing:1px;color:#6b7280;margin-bottom:7px}
.fixture-pages{display:flex;gap:8px;flex-wrap:wrap}
.fixture-btn{background:#f0f4f8;border:1.5px solid #d4dbe3;color:#002F6C;
             padding:7px 16px;border-radius:6px;font-size:13px;font-weight:600;
             cursor:pointer;transition:all .15s;white-space:nowrap}
.fixture-btn:hover{background:#e8f4fd;border-color:#00A4EB;color:#00A4EB}
.fixture-btn.active{background:#FF8B00;color:#fff;border-color:#FF8B00}

/* ── Render Lab ── */
.lab-input{width:100%;padding:9px 11px;border:1.5px solid #d4dbe3;border-radius:7px;
           font-size:13px;color:#002F6C;outline:none;font-family:inherit;background:#fff}
.lab-input:focus{border-color:#00A4EB}
.lab-actions{display:flex;align-items:center;gap:10px;margin-top:16px;flex-wrap:wrap}
.lab-status{font-size:13px;color:#6b7280}
.lab-results{margin-top:20px;border-top:1px solid #f0f4f7;padding-top:18px}

/* ── Tabs ── */
.tabs{display:flex;gap:4px;border-bottom:2px solid #e5e7eb;margin-bottom:28px}
.tab{background:none;border:0;padding:12px 22px;font-size:15px;font-weight:700;color:#a8a8aa;
     cursor:pointer;border-bottom:3px solid transparent;margin-bottom:-2px;transition:color .15s}
.tab:hover{color:#002F6C}
.tab.active{color:#002F6C;border-bottom-color:#00A4EB}
</style>
</head>
<body>

<header>
  <div class="logo">
    <div class="logo-mark">A</div>
    <span class="logo-name">Akamai</span>
  </div>
  <div class="header-pill">AI Content Optimization &middot; Live Demo</div>
</header>

<div class="hero">
  <div class="hero-hook">Live Demo</div>
  <h1>Your Content, Optimized for AI &mdash; Automatically</h1>
  <p>Enter any URL below to see Akamai serve the right content to the right audience in real time: standard pages for your visitors, and AI-optimized content for search crawlers &mdash; all at the edge, with no changes to your website.</p>
</div>

<main>
  <div class="scenario-bar" style="margin:0 0 16px;padding:12px 14px;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:10px;display:none">
    <span style="font-size:12px;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:.04em;vertical-align:middle">Demo scenario</span>
    <span id="scenario-buttons" style="display:inline-flex;gap:8px;margin-left:10px;flex-wrap:wrap;vertical-align:middle"></span>
    <div class="scenario-blurb" id="scenario-blurb" style="margin-top:8px;font-size:13px;color:#64748b"></div>
  </div>

  <div class="tabs">
    <button class="tab active" id="tab-btn-hero" type="button" onclick="switchTab('hero')">Who&rsquo;s asking?</button>
    <button class="tab" id="tab-btn-demo" type="button" onclick="switchTab('demo')">Scenario Walkthrough</button>
  </div>

  <div id="tab-hero" class="tab-panel">
    <div class="wa-hero">
      <div class="wa-eyebrow">Content negotiation at the edge</div>
      <h2 class="wa-h2">Who&rsquo;s asking?</h2>
      <p class="wa-lede">One product page. One URL. The edge inspects <em>who</em> is requesting it &mdash; and hands each visitor exactly what serves them best. Same origin, same cached render, no application changes.</p>
      <div class="wa-urlrow">
        <div class="wa-store" title="The demo store — the CSR page prerendered into Harper">
          <span class="wa-lock">&#128274;</span>
          <span class="wa-store-url" id="wa-store-url">the demo store</span>
          <span class="wa-store-tag">prerendered into Harper</span>
        </div>
        <button class="run-btn" id="wa-run" type="button" onclick="runHero()">&#9654;&nbsp; Run live</button>
      </div>
      <div class="wa-store-hint">Prerendering renders each page into Harper first, so this view runs against the demo store &mdash; not arbitrary URLs. (Edge conversion of any URL is a different scenario.)</div>
      <div class="wa-custom-toggle" id="wa-custom-toggle" style="display:none"><a href="#" onclick="heroToggleCustom(event)">or prerender another page &rarr;</a></div>
      <div class="wa-custom" id="wa-custom" style="display:none">
        <div class="wa-custom-row">
          <input type="text" id="wa-custom-url" class="wa-custom-input" placeholder="https://example.com/product/&hellip;" onkeydown="if(event.key==='Enter')heroRunCustomFromInput()" />
          <button class="run-btn" id="wa-custom-run" type="button" onclick="heroRunCustomFromInput()">&#9654;&nbsp; Prerender &amp; compare</button>
        </div>
        <div class="wa-custom-hint">We fetch the raw page (the <strong>before</strong>), prerender it into Harper with headless Chrome, then show what each visitor is served (the <strong>after</strong>). The first render of a new page takes a few seconds.</div>
      </div>
      <div class="wa-custom-back" id="wa-custom-back" style="display:none"><a href="#" onclick="heroBackToStore(event)">&larr; back to the demo store</a></div>
      <div class="wa-note" id="wa-note"></div>
    </div>

    <div class="wa-switch" id="wa-switch" role="tablist" aria-label="Choose a visitor">
      <button class="wa-seg is-human active" type="button" data-c="human" onclick="heroSelect('human')">
        <span class="wa-ico">&#128100;</span><span class="wa-seg-t">A person</span><span class="wa-seg-s">Chrome / Safari</span>
      </button>
      <button class="wa-seg is-search" type="button" data-c="search" onclick="heroSelect('search')">
        <span class="wa-ico">&#128269;</span><span class="wa-seg-t">Search crawler</span><span class="wa-seg-s">Search engines</span>
      </button>
      <button class="wa-seg is-ai" type="button" data-c="ai" onclick="heroSelect('ai')">
        <span class="wa-ico">&#129302;</span><span class="wa-seg-t">AI crawler</span><span class="wa-seg-s">AI assistants</span>
      </button>
    </div>

    <div class="wa-crawlers" id="wa-crawlers"></div>

    <div class="wa-inspector">
      <div class="wa-col wa-req" id="wa-req"></div>
      <div class="wa-col wa-res lane-human" id="wa-res"></div>
    </div>

    <div class="wa-flow">
      <div class="wa-flow-step"><span class="wa-flow-n">1</span>One request hits the edge</div>
      <div class="wa-flow-arrow">&rarr;</div>
      <div class="wa-flow-step"><span class="wa-flow-n">2</span>EdgeWorker reads <code>who</code> is asking</div>
      <div class="wa-flow-arrow">&rarr;</div>
      <div class="wa-flow-step"><span class="wa-flow-n">3</span>Serves HTML, Markdown, or the live shell</div>
    </div>
  </div><!-- /tab-hero -->

  <div id="tab-demo" class="tab-panel" style="display:none">
  <div class="url-form">
    <label for="target-url">Enter a website URL to run the live demo
      <span class="url-hint">— try your own site, or use the default</span>
    </label>
    <div class="url-row">
      <input type="url" id="target-url" class="url-input"
             placeholder="https://stopwaitingshipit.com/"
             value="https://stopwaitingshipit.com/" />
      <button class="run-btn" id="run-btn" onclick="runPipeline()">&#9654;&nbsp; Run Live Demo</button>
    </div>
  </div>

  <div class="fixture-bar" id="fixture-bar" style="display:none">
    <div class="fixture-bar-header">
      <span class="fixture-bar-title">Enterprise Demo Pages</span>
      <span class="fixture-bar-hint">Select a page to load real enterprise HTML for the token comparison &mdash; the live pipeline still runs against the actual URL</span>
    </div>
    <div id="fixture-list"></div>
  </div>

  <div class="error-banner" id="error-banner"></div>

  <div class="loading" id="loading">
    <div class="spinner"></div>
    <div class="loading-label">Running live demo&hellip;</div>
    <p id="loading-msg">Starting up&hellip;</p>
  </div>

  <div id="results">
    <div class="section-title">Live Results — Three Scenarios, One URL</div>
    <div class="test-cards">

      <div class="test-card test-a">
        <div class="card-stripe"></div>
        <div class="card-head">
          <div class="card-step">Scenario A</div>
          <div class="card-title">Human Visitor</div>
          <div class="card-sub">A standard browser visits your page.<br>Nothing changes. No risk.</div>
        </div>
        <div class="card-body" id="body-a"></div>
        <div class="card-desc">
          Your visitors experience no difference whatsoever. The pipeline is completely invisible to humans.
        </div>
      </div>

      <div class="test-card test-b">
        <div class="card-stripe"></div>
        <div class="card-head">
          <div class="card-step">Scenario B</div>
          <div class="card-title">AI Crawler &mdash; First Visit</div>
          <div class="card-sub">An AI crawler arrives for the first time. Akamai converts and caches.</div>
        </div>
        <div class="card-body" id="body-b"></div>
        <div class="card-desc">
          Akamai detects the AI crawler at the edge and automatically converts your page to AI-optimized content on the fly. The result is cached globally — no origin changes, no IT tickets, no sprint cycles needed.
        </div>
      </div>

      <div class="test-card test-c">
        <div class="card-stripe"></div>
        <div class="card-head">
          <div class="card-step">Scenario C</div>
          <div class="card-title">AI Crawler &mdash; Return Visit</div>
          <div class="card-sub">The same AI crawler comes back.<br>Served instantly. Origin untouched.</div>
        </div>
        <div class="card-body" id="body-c"></div>
        <div class="card-desc">
          Every return visit from an AI crawler is served straight from cache — converted once on the first visit, never reconverted. Your origin server receives zero additional load from crawlers, permanently, after that very first visit.
        </div>
      </div>

    </div>

    <div class="section-title" style="margin-top:8px">What This Means for Your Business</div>
    <div class="metrics-grid">

      <div class="metric-card">
        <div class="metric-val" id="m1-val">&mdash;</div>
        <div class="metric-label">Edge Processing Time</div>
        <div class="metric-desc" id="m1-desc">Akamai intercepted the AI crawler at the edge and delivered AI-optimized Markdown — without touching your origin infrastructure.</div>
        <div class="metric-src">Measured live during this demo &middot; Scenario B</div>
      </div>

      <div class="metric-card">
        <div class="metric-val" id="m2-val">&mdash;</div>
        <div class="metric-tokens" id="m2-tokens"></div>
        <div class="metric-label">Leaner Content for AI</div>
        <div class="metric-desc" id="m2-desc">AI models receive a streamlined version of your content, making it faster and cheaper for them to process — and more likely to cite your brand accurately.</div>
        <div class="metric-src" id="m2-src">Measured live &middot; cl100k_base tokenizer &middot; Scenario B</div>
      </div>

      <div class="metric-card">
        <div class="metric-val" id="m3-val">&mdash;</div>
        <div class="metric-label">conversion to visits</div>
        <div class="metric-desc" id="m3-desc">One Markdown conversion at first crawler visit, served indefinitely from cache to every subsequent crawler.</div>
        <div class="metric-src">Demonstrated live &middot; Scenarios B and C</div>
      </div>

    </div>
  </div>

  </div><!-- /tab-demo -->
</main>

<footer>Akamai Technologies &nbsp;&middot;&nbsp; AI Content Optimization &nbsp;&middot;&nbsp; Live Demo</footer>

<script>
var running = false;
var selectedFixture = null;
var currentScenario = null;
var scenarioFeatures = {};

// ── Scenario selector (Phase A) — switch which backend the demo targets ──────
function loadScenarios() {
  fetch('/scenarios').then(function(r){ return r.json(); }).then(function(d){
    heroStoreUrl = d.storeUrl || heroStoreUrl;
    var su = document.getElementById('wa-store-url');
    if (su && heroStoreUrl) {
      var disp = heroStoreUrl.replace('https://', '').replace('http://', '');
      if (disp.slice(-1) === '/') disp = disp.slice(0, -1);
      su.textContent = disp;
    }
    // Offer the "prerender another page" affordance only when the server has the
    // Harper seed credentials to actually render on demand.
    heroHarperReady = !!d.harperReady;
    var ct = document.getElementById('wa-custom-toggle');
    if (ct) ct.style.display = heroHarperReady ? '' : 'none';
    // Default the Scenario Walkthrough to the prerendered store, so the out-of-box
    // run hits the cache (Scenario C shows real rows) instead of seeding a heavy
    // arbitrary URL. Stays editable — any other URL triggers seed-on-demand.
    var tu = document.getElementById('target-url');
    if (tu && heroStoreUrl) {
      var v = tu.value || '';
      var isDefault = !v || v.indexOf('akamai.com') !== -1 || v === heroStoreUrl;
      if (isDefault) { tu.value = heroStoreUrl; tu.placeholder = heroStoreUrl; }
    }
    var wrap = document.getElementById('scenario-buttons');
    if (!wrap) return;
    wrap.innerHTML = '';
    (d.scenarios || []).forEach(function(s){
      var live = s.live !== false;
      var b = document.createElement('button');
      b.type = 'button'; b.id = 'scn-' + s.id;
      b.innerHTML = esc(s.label) + (live ? '' : ' <span style="font-size:10px;font-weight:800;letter-spacing:.03em">&#9888; DNS</span>');
      b.style.cssText = 'padding:6px 12px;border-radius:999px;border:1px solid #cbd5e1;background:#fff;color:#334155;font-size:13px;font-weight:600;cursor:pointer' + (live ? '' : ';opacity:.6');
      if (!live) b.title = s.blockedReason || 'Not wired live yet';
      b.setAttribute('data-blurb', s.blurb || '');
      b.setAttribute('data-live', live ? '1' : '0');
      b.setAttribute('data-reason', s.blockedReason || '');
      b.setAttribute('data-features', JSON.stringify(s.features || {}));
      b.onclick = function(){ selectScenario(s.id); };
      wrap.appendChild(b);
    });
    selectScenario(d.default || (d.scenarios && d.scenarios[0] && d.scenarios[0].id));
  }).catch(function(){});
}
function selectScenario(id) {
  if (!id) return;
  currentScenario = id; scenarioFeatures = {};
  var blurb = '', live = true, reason = '';
  var btns = document.querySelectorAll('#scenario-buttons button');
  for (var i = 0; i < btns.length; i++) {
    var b = btns[i], on = b.id === 'scn-' + id, bLive = b.getAttribute('data-live') !== '0';
    b.style.background = on ? (bLive ? '#0369a1' : '#64748b') : '#fff';
    b.style.color = on ? '#fff' : '#334155';
    b.style.borderColor = on ? (bLive ? '#0369a1' : '#64748b') : '#cbd5e1';
    b.style.opacity = bLive ? '1' : (on ? '.92' : '.6');
    if (on) { blurb = b.getAttribute('data-blurb'); live = bLive; reason = b.getAttribute('data-reason') || ''; try { scenarioFeatures = JSON.parse(b.getAttribute('data-features')); } catch(e) {} }
  }
  var bl = document.getElementById('scenario-blurb');
  if (bl) bl.innerHTML = esc(blurb) + (live ? '' : ' <strong style="color:#b45309">&mdash; not wired live yet: ' + esc(reason) + '</strong>');
  // Scenarios that aren't live yet (DNS cutover pending) can't run through the
  // edge — gate the Run button so nobody triggers a broken demo.
  var runBtn = document.getElementById('run-btn');
  if (runBtn) {
    runBtn.disabled = !live;
    runBtn.style.opacity = live ? '' : '.55';
    runBtn.style.cursor = live ? '' : 'not-allowed';
    runBtn.innerHTML = live ? '&#9654;&nbsp; Run Live Demo' : '&#9888;&nbsp; Needs DNS cutover';
  }
}

// ── Tabs ────────────────────────────────────────────────────────────────────
var currentTab = 'hero';
function switchTab(which) {
  currentTab = which;
  ['hero','demo'].forEach(function(p){
    var panel = document.getElementById('tab-' + p);
    var btn   = document.getElementById('tab-btn-' + p);
    if (panel) panel.style.display = (p === which) ? 'block' : 'none';
    if (btn)   btn.classList.toggle('active', p === which);
  });
  // The scenario selector only means something for the Scenario Walkthrough.
  var sb = document.querySelector('.scenario-bar');
  if (sb) sb.style.display = (which === 'hero') ? 'none' : '';
  if (which === 'hero' && !heroRan) runHero();
}

// ── Who's asking? (hero view) ─────────────────────────────────────────────────
// One URL, one edge config (the per-crawler prerender scenario), fetched live per
// visitor. We only vary WHO is asking (the bot headers); the EdgeWorker alone
// decides what each is handed back. The segmented control picks the KIND of
// visitor; the crawler chips pick the specific named bot within a lane.
var HERO_LANES = {
  human: {
    lane: 'human', icon: '👤', label: 'A person', sub: 'Chrome / Safari',
    who: 'Someone browsing your store in <strong>Chrome or Safari</strong>. No bot signature &mdash; just a normal visitor.',
    callout: 'No verified-bot header, so the EdgeWorker never fires. The person gets the raw single-page-app shell and their browser renders the product with JavaScript.'
  },
  search: {
    lane: 'search', icon: '🔍', label: 'Search crawler', sub: 'Search engines',
    whoTmpl: '<strong>{L}</strong>, a verified search crawler indexing this page so it ranks in results.',
    callout: 'A verified search crawler. The edge serves fully-rendered HTML &mdash; the same cached render a person&rsquo;s browser would produce &mdash; with JSON-LD structured data baked in. Nothing to execute, nothing missed.'
  },
  ai: {
    lane: 'ai', icon: '🤖', label: 'AI crawler', sub: 'AI assistants',
    whoTmpl: '<strong>{L}</strong>, a verified AI crawler reading this page to answer questions about your product.',
    callout: 'A verified AI crawler. The edge serves clean Markdown from the same render &mdash; no navigation, ads, or scripts &mdash; a fraction of the tokens, so the model reads your product accurately and cheaply.'
  }
};
// All search bots route to HTML, all AI bots to Markdown — the chips prove the
// policy recognises each named crawler, not just the defaults.
var HERO_CRAWLERS = {
  search: [
    { kind: 'googlebot', label: 'Googlebot', hl: 'hl', ua: 'Mozilla/5.0 (compatible; <span class="hl">Googlebot</span>/2.1; +http://www.google.com/bot.html)' },
    { kind: 'bingbot',   label: 'Bingbot',   hl: 'hl', ua: 'Mozilla/5.0 (compatible; <span class="hl">bingbot</span>/2.0; +http://www.bing.com/bingbot.htm)' }
  ],
  ai: [
    { kind: 'claudebot',       label: 'ClaudeBot',       hl: 'hlo', ua: 'Mozilla/5.0 (compatible; <span class="hlo">ClaudeBot</span>/1.0; +claudebot@anthropic.com)' },
    { kind: 'gptbot',          label: 'GPTBot',          hl: 'hlo', ua: 'Mozilla/5.0 (compatible; <span class="hlo">GPTBot</span>/1.1; +https://openai.com/gptbot)' },
    { kind: 'google-extended', label: 'Google-Extended', hl: 'hlo', ua: 'Mozilla/5.0 (compatible; <span class="hlo">Google-Extended</span>; +Google AI)' },
    { kind: 'oai-searchbot',   label: 'OAI-SearchBot',   hl: 'hlo', ua: 'Mozilla/5.0 (compatible; <span class="hlo">OAI-SearchBot</span>/1.0; +https://openai.com/searchbot)' },
    { kind: 'perplexitybot',   label: 'PerplexityBot',   hl: 'hlo', ua: 'Mozilla/5.0 (compatible; <span class="hlo">PerplexityBot</span>/1.0; +https://perplexity.ai/perplexitybot)' }
  ]
};
var heroSel = 'human';
var heroPick = { search: 'googlebot', ai: 'claudebot' };
var heroCache = {};   // results keyed by kind ('human','googlebot',…) in store mode, by lane ('human','search','ai') in custom mode
var heroBusy = {};    // key -> true while its fetch is in flight
var heroUrl = '';
var heroStoreUrl = '';   // the demo store — always prerendered into Harper
var heroRan = false;
// 'store' = the locked demo store, fetched live through the Akamai edge (the real
// production path). 'custom' = any URL the user prerenders on demand; its lanes are
// read straight from Harper (no edge property fronts an arbitrary URL).
var heroMode = 'store';
var heroCustomUrl = '';
var heroHarperReady = false;   // set from /scenarios — gates the "prerender another page" affordance

// http(s) URL test. Built via new RegExp so the backslashes survive the outer
// HTML template literal (a slash-delimited regex literal here would be mangled).
function isHttpUrl(u) { return new RegExp('^https?://', 'i').test(String(u == null ? '' : u)); }
// In custom mode a page has ONE render, so every search bot shows the same HTML and
// every AI bot the same Markdown — cache by lane. In store mode cache by exact kind.
function heroCacheKey() { return heroMode === 'custom' ? heroSel : heroActiveKind(); }

function esc(s) { return (s == null ? '' : String(s)).replace(/[&<>]/g, function(c){ return { '&':'&amp;', '<':'&lt;', '>':'&gt;' }[c]; }); }

function extractJsonLd(html) {
  if (!html) return null;
  // This runs inside the page's own inline JS block, so its source must never
  // contain the literal closing script tag (the HTML parser would end the block
  // early and dump the rest of the JS onto the page). Build the tag name from
  // parts and the regex via new RegExp; the \\ pairs survive the outer template
  // literal as single-backslash regex metacharacters.
  var TAG = 'scr' + 'ipt';
  var re = new RegExp('<' + TAG + '[^>]*application/ld\\+json[^>]*>([\\s\\S]*?)</' + TAG + '>', 'i');
  var m = html.match(re);
  if (!m) return null;
  try { return JSON.stringify(JSON.parse(m[1].trim()), null, 2); } catch (e) { return m[1].trim(); }
}

function heroActiveKind() { return heroSel === 'human' ? 'human' : heroPick[heroSel]; }
function heroCrawler(lane, kind) {
  var list = HERO_CRAWLERS[lane] || [];
  for (var i = 0; i < list.length; i++) if (list[i].kind === kind) return list[i];
  return list[0] || null;
}

// Fetch one or more visitors live through the edge and cache each by kind.
function heroFetch(kinds) {
  var want = kinds.filter(function(k){ return !heroBusy[k] && !heroCache[k]; });
  if (!want.length) { renderHero(); return; }
  want.forEach(function(k){ heroBusy[k] = true; });
  var note = document.getElementById('wa-note');
  if (note && (note.className || '').indexOf('err') === -1) { note.className = 'wa-note'; note.innerHTML = '<span class="wa-spin"></span>Asking the edge&hellip;'; }
  renderHero();
  fetch('/hero-lane', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: heroUrl, kinds: want }) })
    .then(function(r){ return r.json(); })
    .then(function(d){
      want.forEach(function(k){ heroBusy[k] = false; });
      if (d.error) { if (note) { note.className = 'wa-note err'; note.textContent = 'Error: ' + d.error; } renderHero(); return; }
      Object.keys(d.results || {}).forEach(function(k){ heroCache[k] = d.results[k]; });
      if (note) { note.className = 'wa-note'; note.innerHTML = 'Live through the Akamai staging edge &middot; <code>' + esc(d.url || heroUrl) + '</code>'; }
      renderHero();
    })
    .catch(function(e){
      want.forEach(function(k){ heroBusy[k] = false; });
      if (note) { note.className = 'wa-note err'; note.textContent = 'Request failed: ' + e.message; }
      renderHero();
    });
}

// Make sure the currently-selected visitor has been fetched, then render.
function heroEnsure() {
  // Custom mode never re-fetches on selection — all lanes were captured by the
  // seed+poll cycle and cached by lane; selecting just re-renders.
  if (heroMode === 'custom') { renderHero(); return; }
  var k = heroActiveKind();
  if (heroUrl && !heroCache[k] && !heroBusy[k]) heroFetch([k]);
  else renderHero();
}

function runHero() {
  heroMode = 'store';       // "Run live" always returns to the locked store
  heroRan = true;
  heroUrl = heroStoreUrl;   // fixed: the demo store (empty until /scenarios loads → server defaults to it)
  heroCache = {}; heroBusy = {};
  // Prime the three default visitors (person + current search + current AI bot).
  heroFetch(['human', heroPick.search, heroPick.ai]);
}

// ── Prerender another page (custom mode) ────────────────────────────────────
function heroSetSeg(lane) {
  heroSel = lane;
  var segs = document.querySelectorAll('#wa-switch .wa-seg');
  for (var i = 0; i < segs.length; i++) segs[i].classList.toggle('active', segs[i].getAttribute('data-c') === lane);
}

function heroToggleCustom(e) {
  if (e && e.preventDefault) e.preventDefault();
  var c = document.getElementById('wa-custom');
  var t = document.getElementById('wa-custom-toggle');
  if (c) c.style.display = '';
  if (t) t.style.display = 'none';
  var inp = document.getElementById('wa-custom-url');
  if (inp) inp.focus();
}

function heroBackToStore(e) {
  if (e && e.preventDefault) e.preventDefault();
  var c = document.getElementById('wa-custom'); if (c) c.style.display = 'none';
  var t = document.getElementById('wa-custom-toggle'); if (t) t.style.display = '';
  var b = document.getElementById('wa-custom-back'); if (b) b.style.display = 'none';
  heroSetSeg('human');
  runHero();
}

function heroRunCustomFromInput() {
  var el = document.getElementById('wa-custom-url');
  var url = (el && el.value || '').trim();
  var note = document.getElementById('wa-note');
  if (!isHttpUrl(url)) {
    if (note) { note.className = 'wa-note err'; note.textContent = 'Enter a full URL, e.g. https://example.com/'; }
    return;
  }
  heroSetSeg('human');   // land on the "before" (the raw shell)
  var b = document.getElementById('wa-custom-back'); if (b) b.style.display = '';
  heroRunCustom(url);
}

function heroCustomFail(msg) {
  heroBusy = {};
  var note = document.getElementById('wa-note');
  if (note) { note.className = 'wa-note err'; note.textContent = 'Error: ' + msg; }
  renderHero();
}

function kbSize(n) { n = n || 0; return n >= 1024 ? (Math.round((n / 1024) * 10) / 10 + ' KB') : (n + ' B'); }

function heroBeforeAfterSummary() {
  var b = heroCache['human'] || {}, s = heroCache['search'] || {}, a = heroCache['ai'] || {};
  return 'Prerendered &#10003; &middot; <code>' + esc(heroCustomUrl) + '</code><br>' +
    '<span class="wa-ba">Raw shell ' + kbSize(b.bytes) + ' / ' + (b.tokens || 0).toLocaleString() + ' tok ' +
    '&rarr; HTML for search ' + kbSize(s.bytes) + ' &middot; Markdown for AI ' + (a.tokens || 0).toLocaleString() + ' tok</span>';
}

// Seed a URL, show the "before" instantly, then poll until the render lands.
function heroRunCustom(url) {
  heroMode = 'custom';
  heroRan = true;
  heroCustomUrl = url;
  heroUrl = url;
  heroCache = {};
  heroBusy = { human: true, search: true, ai: true };
  var note = document.getElementById('wa-note');
  if (note) { note.className = 'wa-note'; note.innerHTML = '<span class="wa-spin"></span>Fetching the raw page &amp; seeding the prerender&hellip;'; }
  renderHero();
  fetch('/prerender-seed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: url }) })
    .then(function(r){ return r.json(); })
    .then(function(d){
      if (d.error) { heroCustomFail(d.error); return; }
      heroCache['human'] = d.before;   // the "before" is ready immediately
      heroBusy['human'] = false;
      renderHero();
      if (note) {
        note.className = 'wa-note';
        note.innerHTML = d.alreadyCached
          ? '<span class="wa-spin"></span>Already prerendered &mdash; reading it back from Harper&hellip;'
          : '<span class="wa-spin"></span>Prerendering with headless Chrome&hellip; (usually 5&ndash;20s)';
      }
      heroPollCustom(url, 0);
    })
    .catch(function(e){ heroCustomFail(e.message); });
}

function heroPollCustom(url, tries) {
  fetch('/prerender-poll?url=' + encodeURIComponent(url))
    .then(function(r){ return r.json(); })
    .then(function(d){
      if (heroMode !== 'custom' || heroCustomUrl !== url) return;   // user navigated away
      if (d.ready) {
        heroCache['search'] = d.search;
        heroCache['ai'] = d.ai;
        heroBusy['search'] = false; heroBusy['ai'] = false;
        var note = document.getElementById('wa-note');
        if (note) { note.className = 'wa-note'; note.innerHTML = heroBeforeAfterSummary(); }
        renderHero();
        return;
      }
      if (tries >= 28) {   // ~70s
        heroBusy['search'] = false; heroBusy['ai'] = false;
        var note2 = document.getElementById('wa-note');
        if (note2) { note2.className = 'wa-note err'; note2.innerHTML = 'The render is taking longer than expected &mdash; the renderer may be busy. The HTML/Markdown lanes will fill once it lands; try selecting them again in a moment.'; }
        renderHero();
        return;
      }
      setTimeout(function(){ heroPollCustom(url, tries + 1); }, 2500);
    })
    .catch(function(){ if (tries < 28) setTimeout(function(){ heroPollCustom(url, tries + 1); }, 2500); });
}

function heroSelect(lane) {
  heroSel = lane;
  var segs = document.querySelectorAll('#wa-switch .wa-seg');
  for (var i = 0; i < segs.length; i++) segs[i].classList.toggle('active', segs[i].getAttribute('data-c') === lane);
  heroEnsure();
}

function heroPickCrawler(kind) {
  heroPick[heroSel] = kind;
  heroEnsure();
}

function renderHero() {
  var meta = HERO_LANES[heroSel];
  var reqEl = document.getElementById('wa-req');
  var resEl = document.getElementById('wa-res');
  var chipsEl = document.getElementById('wa-crawlers');
  if (!reqEl || !resEl) return;
  var kind = heroActiveKind();          // the specific bot — drives request identity + chips
  var cacheKey = heroCacheKey();        // where this lane's result lives (kind in store mode, lane in custom mode)
  var crawler = heroSel === 'human' ? null : heroCrawler(heroSel, kind);

  // Crawler chips — only for lanes that have a named set.
  if (chipsEl) {
    var list = HERO_CRAWLERS[heroSel];
    if (list) {
      chipsEl.className = 'wa-crawlers lane-' + meta.lane;
      chipsEl.innerHTML = '<span class="wa-chip-lead">which one?</span>' + list.map(function(c){
        return '<button type="button" class="wa-chip' + (c.kind === kind ? ' on' : '') + '" onclick="heroPickCrawler(\\'' + c.kind + '\\')">' + c.label + '</button>';
      }).join('');
    } else {
      chipsEl.className = 'wa-crawlers';
      chipsEl.innerHTML = '';
    }
  }

  // Request panel — identity reflects the specific bot chosen in this lane.
  var who = crawler ? meta.whoTmpl.replace('{L}', crawler.label) : meta.who;
  var hdrs = crawler
    ? [['User-Agent', crawler.ua], ['X-Verified-Bot', '<span class="' + crawler.hl + '">true</span>'], ['X-Bot-Kind', '<span class="' + crawler.hl + '">' + crawler.kind + '</span>']]
    : [['User-Agent', 'Mozilla/5.0 &hellip; Chrome/121'], ['Accept', 'text/html, */*'], ['X-Verified-Bot', '&mdash;']];
  var hrows = hdrs.map(function(h){ return '<div class="wa-hdr"><span class="wa-hk">' + h[0] + '</span><span class="wa-hv">' + h[1] + '</span></div>'; }).join('');
  reqEl.innerHTML =
    '<div class="wa-col-head"><span>The request</span><span>' + meta.icon + ' ' + (crawler ? crawler.label : meta.label) + '</span></div>' +
    '<div class="wa-col-body"><div class="wa-who">' + who + '</div>' +
    '<div class="wa-body-label">Identifying headers</div><div class="wa-hdrs">' + hrows + '</div></div>';

  // Response panel.
  resEl.className = 'wa-col wa-res lane-' + meta.lane;
  var r = heroCache[cacheKey];
  var busy = !!heroBusy[cacheKey];
  // A person's request never trips the EdgeWorker, so there's no x-served-by —
  // label it as what it is: the origin shell.
  var servedLabel = (r && !r.error) ? (r.servedBy || (meta.lane === 'human' ? 'origin · shell' : '')) : '';
  var badge = servedLabel ? '<span class="wa-served">' + esc(servedLabel) + '</span>'
            : (busy ? '<span class="wa-served">&hellip;</span>' : '');
  var servedHeadLabel = heroMode === 'custom'
    ? (heroSel === 'human' ? 'The raw page (before)' : 'Prerendered from Harper (after)')
    : 'What the edge served';
  var head = '<div class="wa-col-head"><span>' + servedHeadLabel + '</span>' + badge + '</div>';

  var body;
  if (busy && !r) {
    var waitMsg = heroMode === 'custom'
      ? (heroSel === 'human' ? 'Fetching the raw page&hellip;' : 'Prerendering with headless Chrome&hellip;')
      : 'Fetching from the edge&hellip;';
    body = '<div class="wa-col-body"><div class="wa-empty"><span class="wa-spin"></span>' + waitMsg + '</div></div>';
  } else if (!r) {
    body = '<div class="wa-col-body"><div class="wa-empty">Click <strong>Run live</strong> to run this against the edge.</div></div>';
  } else if (r.error) {
    body = '<div class="wa-col-body"><div class="wa-empty">Edge error: ' + esc(r.error) + '</div></div>';
  } else {
    var metrics =
      '<div class="wa-metrics">' +
      '<div class="wa-metric"><div class="mv">' + esc((r.contentType || '&mdash;').split(';')[0]) + '</div><div class="ml">Content-Type</div></div>' +
      '<div class="wa-metric"><div class="mv">' + (r.bytes || 0).toLocaleString() + '</div><div class="ml">Bytes</div></div>' +
      '<div class="wa-metric"><div class="mv">' + (r.tokens || 0).toLocaleString() + '</div><div class="ml">Tokens</div></div>' +
      '<div class="wa-metric"><div class="mv">' + (r.responseTime || 0) + 'ms</div><div class="ml">Edge time</div></div>' +
      '</div>';
    var content;
    if (heroSel === 'ai') {
      content = '<div class="wa-body-label">Markdown delivered to the model</div><div class="wa-pre">' + esc(r.sample || '(empty)') + '</div>';
    } else if (heroSel === 'search') {
      var ld = extractJsonLd(r.sample);
      content = ld
        ? '<div class="wa-body-label">JSON-LD structured data (extracted from the served HTML)</div><div class="wa-pre">' + esc(ld) + '</div>'
        : '<div class="wa-body-label">Rendered HTML delivered to the crawler (sample)</div><div class="wa-pre">' + esc((r.sample || '').slice(0, 2600)) + '</div>';
    } else {
      content = '<div class="wa-body-label">Raw shell delivered to the browser (sample)</div><div class="wa-pre">' + esc((r.sample || '').slice(0, 2600)) + '</div>';
    }
    body = '<div class="wa-col-body">' + metrics + '<div class="wa-callout">' + meta.callout + '</div>' + content + '</div>';
  }
  resEl.innerHTML = head + body;
}

function loadFixtures() {
  fetch('/fixtures')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (!data.customers || !data.customers.length) return;
      var listEl = document.getElementById('fixture-list');
      data.customers.forEach(function(customer) {
        var group = document.createElement('div');
        group.className = 'fixture-customer';
        var nameEl = document.createElement('div');
        nameEl.className = 'fixture-customer-name';
        nameEl.textContent = customer.name;
        group.appendChild(nameEl);
        var pages = document.createElement('div');
        pages.className = 'fixture-pages';
        customer.pages.forEach(function(page) {
          var btn = document.createElement('button');
          btn.className = 'fixture-btn';
          btn.textContent = page.label;
          btn.onclick = function() {
            document.querySelectorAll('.fixture-btn').forEach(function(b) {
              b.classList.remove('active');
            });
            if (selectedFixture && selectedFixture.file === page.file) {
              selectedFixture = null; // toggle off
            } else {
              btn.classList.add('active');
              selectedFixture = page;
              document.getElementById('target-url').value = page.url;
              // Also pre-fill the per-crawler URL so the same page can be checked
              // through the crawler-negotiation view in one click.
              var labUrl = document.getElementById('lab-url');
              if (labUrl) labUrl.value = page.url;
            }
          };
          pages.appendChild(btn);
        });
        group.appendChild(pages);
        listEl.appendChild(group);
      });
      show('fixture-bar');
    })
    .catch(function() {});
}

var STEPS = [
  'Simulating a standard visitor request…',
  'AI crawler detected — optimizing content at the edge…',
  'Caching optimized content globally…',
  'AI crawler returns — checking the edge cache…',
  'Calculating results…'
];

function runPipeline() {
  if (running) return;
  var url = document.getElementById('target-url').value.trim();
  if (!url) { showErr('Please enter a website URL to run the demo.'); return; }
  try { new URL(url); } catch(e) {
    showErr('Please enter a valid URL, for example: https://www.akamai.com'); return;
  }

  running = true;
  document.getElementById('run-btn').disabled = true;
  hide('error-banner'); hide('results');
  show('loading');

  var msgEl = document.getElementById('loading-msg');
  var timer = null;
  function startSteps() {
    var si = 0;
    msgEl.textContent = STEPS[0];
    timer = setInterval(function() {
      si = Math.min(si + 1, STEPS.length - 1);
      msgEl.textContent = STEPS[si];
    }, 2600);
  }

  // Seed-on-demand: prerender / convert-cache read from a page that must already be
  // rendered into Harper. If this URL isn't cached yet, prerender it FIRST so the
  // return visit (Scenario C) hits the cache instead of racing a miss and talk-tracking.
  // Needs Harper creds; degrades gracefully (proceeds to the run) if unavailable.
  var needsSeed = heroHarperReady && scenarioFeatures && scenarioFeatures.needsPrerender;
  var prep;
  if (needsSeed) {
    msgEl.textContent = 'Checking Harper for a prerender of this page…';
    prep = ensurePrerendered(url, function(m){ msgEl.textContent = m; });
  } else {
    prep = Promise.resolve();
  }

  prep.then(function() {
    startSteps();
    return fetch('/run-tests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: url, scenario: currentScenario, fixtureFile: selectedFixture ? selectedFixture.file : null })
    });
  })
  .then(function(r) {
    return r.json().then(function(d) {
      if (!r.ok) throw new Error(d.error || 'Demo run failed');
      return d;
    });
  })
  .then(function(data) {
    if (timer) clearInterval(timer);
    renderResults(data);
  })
  .catch(function(err) {
    if (timer) clearInterval(timer);
    showErr('Something went wrong: ' + err.message);
  })
  .finally(function() {
    running = false;
    document.getElementById('run-btn').disabled = false;
    hide('loading');
  });
}

// Make sure the URL is prerendered into Harper (reuses the hero's seed then poll).
// Resolves when the render has landed, or gives up gracefully so the walkthrough
// still runs — on give-up, Scenario C falls back to the talk-track exactly as before.
function ensurePrerendered(url, onMsg) {
  return fetch('/prerender-seed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: url }) })
    .then(function(r){ return r.json(); })
    .then(function(d){
      if (!d || d.error || d.alreadyCached) return;   // no creds / seed failed / already there → nothing to wait on
      if (onMsg) onMsg('Prerendering this page with headless Chrome… (first render takes a few seconds)');
      return pollPrerendered(url, 0);
    })
    .catch(function(){ /* proceed regardless */ });
}
function pollPrerendered(url, tries) {
  return fetch('/prerender-poll?url=' + encodeURIComponent(url))
    .then(function(r){ return r.json(); })
    .then(function(d){
      if (d && d.ready) return;
      if (tries >= 28) return;   // ~70s cap → proceed anyway (graceful fallback)
      return new Promise(function(res){ setTimeout(res, 2500); }).then(function(){ return pollPrerendered(url, tries + 1); });
    })
    .catch(function(){ /* proceed */ });
}

function renderResults(d) {
  renderCard('body-a', d.testA, 'a', null, d.tokenData);
  renderCard('body-b', d.testB, 'b', d.testA.bodySize, d.tokenData);
  renderCard('body-c', d.testC, 'c', d.testA.bodySize, d.tokenData);

  var bMarkdown = d.testB.contentType.includes('markdown');
  var cMarkdown = d.testC.contentType.includes('markdown');

  // Metric 1: Edge processing time — how fast Akamai delivered AI-optimized content on first visit.
  if (bMarkdown) {
    document.getElementById('m1-val').innerHTML = d.testB.responseTime + '<sup>ms</sup>';
    document.getElementById('m1-desc').textContent =
      'The Akamai edge intercepted the AI crawler and delivered AI-optimized Markdown in ' +
      d.testB.responseTime + 'ms — without touching your origin infrastructure.';
  } else {
    document.getElementById('m1-val').innerHTML = '<span style="font-size:26px;font-weight:800">Re-run</span>';
    document.getElementById('m1-desc').textContent =
      'Edge processing was not confirmed on this run. Run the demo again to see the result.';
  }

  // Metric 2: Token efficiency — cl100k_base HTML tokens vs Markdown tokens.
  // Falls back to Markdown payload size when token data is unavailable.
  var tokenData = d.tokenData;
  var pageLabel = selectedFixture ? selectedFixture.label : 'this page';
  if (tokenData && tokenData.significant) {
    var mult = (tokenData.htmlTokens / tokenData.markdownTokens).toFixed(1);
    document.getElementById('m2-val').innerHTML = mult + '<sup>&times;</sup>';
    document.getElementById('m2-tokens').textContent =
      fmtTokens(tokenData.htmlTokens) + ' tokens → ' + fmtTokens(tokenData.markdownTokens) + ' tokens';
    document.getElementById('m2-desc').textContent =
      'AI models processed ' + fmtTokens(tokenData.markdownTokens) + ' tokens of clean Markdown — ' +
      'vs ' + fmtTokens(tokenData.htmlTokens) + ' tokens for the ' + pageLabel + ' HTML. ' +
      "That's " + mult + '× more token-efficient.';
    document.getElementById('m2-src').textContent = tokenData.fromFixture
      ? 'Pre-loaded page fixture · cl100k_base tokenizer · scripts & nav stripped'
      : 'Measured live · cl100k_base tokenizer · Scenario B';
  } else if (bMarkdown) {
    var bSize = d.testB.bodySize;
    document.getElementById('m2-val').innerHTML = fmtBytes(bSize);
    document.getElementById('m2-desc').textContent =
      'AI models received ' + fmtBytes(bSize) + ' of clean, structured Markdown — ' +
      'free of layout markup, navigation, and rendering overhead that adds noise for AI parsers.';
  } else {
    document.getElementById('m2-val').innerHTML = '<span style="font-size:26px;font-weight:800">Re-run</span>';
    document.getElementById('m2-desc').textContent =
      'Edge processing was not confirmed on this run. Run the demo again to see content efficiency results.';
  }

  // Metric 3: 1→∞ conversion story — only confirmed when both B and C deliver markdown.
  if (bMarkdown && cMarkdown) {
    document.getElementById('m3-val').innerHTML = '1<sup>→ ∞</sup>';
    document.getElementById('m3-desc').textContent =
      'One Markdown conversion at first crawler visit, served indefinitely from cache to every subsequent crawler.';
  } else {
    document.getElementById('m3-val').innerHTML = '<span style="font-size:26px;font-weight:800">Re-run</span>';
    document.getElementById('m3-desc').textContent =
      'Edge processing was not confirmed on this run. Run the demo again to see the full pipeline.';
  }

  show('results');
}

function renderCard(id, t, scenario, htmlSize, tokenData) {
  var isMarkdown = t.contentType.includes('markdown');
  // The unified EdgeWorker emits harper-cache-md / harper-cache-html on a Harper hit.
  var harperHit = /^harper-cache/.test((t.xServedBy || '').toLowerCase());
  // Harper-backed scenarios (write-through, prerender): the cache-state rows are
  // hidden because a ~2s gap between visits races the write/render, so the live
  // result is inconsistent and misleading. We talk-track over it instead.
  var harperScenario = !!(scenarioFeatures && scenarioFeatures.harperCache);

  // Edge Processing row — all three scenarios.
  var edgeRow = '';
  if (scenario === 'a') {
    edgeRow = statRow('Edge Processing', badge('Origin passthrough', 'b-bypass'));
  } else if (scenario === 'b') {
    edgeRow = statRow('Edge Processing',
      harperHit          ? badge('Served from cache', 'b-hit')
      : t.xWasmExecution ? badge('Markdown conversion + cached', 'b-miss')
      :                    badge('Not Confirmed', 'b-miss'));
  } else if (scenario === 'c') {
    var cHit = (t.xCache || '').toUpperCase().includes('HIT');
    edgeRow = statRow('Edge Processing',
      (harperHit || cHit) ? badge('Served from cache', 'b-hit')
      : t.xWasmExecution  ? badge('Markdown conversion + cached', 'b-miss')
      :                     badge('Not Confirmed', 'b-miss'));
  }

  // Response size. For the AI scenarios, show the size of the AI-optimized
  // Markdown — the same clean conversion the token metric uses — rather than the
  // raw edge bytes, which bloat on JS-heavy pages when the on-demand Wasm
  // fallback (not the Harper prerender) does the conversion. This keeps the
  // HTML-vs-Markdown contrast (and the reduction %) consistent with the token ratio.
  var realHtml = tokenData && tokenData.htmlBytes;     // real target HTML (direct fetch)
  var cleanMd  = tokenData && tokenData.markdownBytes; // clean Markdown
  var isAi = (scenario === 'b' || scenario === 'c');
  // Human card shows the REAL target HTML size (direct fetch) — not the property's
  // passthrough placeholder, which is a fixed ~37KB and makes Markdown look bloated
  // on large pages. AI cards show the clean Markdown size; reduction % is vs real HTML.
  var displayBytes = isAi ? (cleanMd ? tokenData.markdownBytes : t.bodySize)
                          : (realHtml || t.bodySize);
  var baseline = realHtml || htmlSize;
  var sizeStr = fmtBytes(displayBytes);
  if (isAi && baseline && displayBytes && displayBytes < baseline) {
    var redPct = Math.round((1 - displayBytes / baseline) * 100);
    sizeStr += '<span style="font-size:10px;font-weight:700;color:#059669;margin-left:6px">↓ ' + redPct + '%</span>';
  }

  // Content preview: only for B and C, and only when the response is actually
  // markdown. Showing XML or HTML here would mislead the audience.
  var preview = '';
  if (scenario !== 'a' && isMarkdown && t.bodyPreview) {
    preview = '<div class="preview-label">Sample of AI-optimized content delivered</div>' +
              '<div class="preview">' + esc(t.bodyPreview.substring(0, 320)) + '</div>';
  } else if (scenario !== 'a' && t.bodyPreview &&
             (t.status >= 400 || /non-2xx|forbidden|blocked|wasm error/i.test(t.bodyPreview))) {
    // The origin's bot/WAF defenses (often Akamai's own) returned a non-2xx to the
    // converter's anonymous edge fetch. Reframe as the protection working as intended —
    // and explain why this never happens converting your OWN content in production.
    preview = '<div class="preview-label" style="color:#00558C">&#128737; Blocked by bot &amp; WAF protection &mdash; working as intended</div>' +
              '<div class="preview" style="background:#eff6ff;border-color:#bfdbfe;color:#1e3a5f">' +
              esc(t.bodyPreview.substring(0, 200)) + '</div>' +
              '<div style="font-size:11px;color:#334155;line-height:1.5;margin-top:6px">' +
              'This site is shielded by bot &amp; application defenses &mdash; the kind <strong>Akamai Bot Manager</strong> and <strong>App &amp; API Protector</strong> deliver &mdash; ' +
              'correctly returning <strong>403</strong> to an anonymous automated fetch from outside its perimeter. That&rsquo;s exactly the protection you want against unwanted bots. ' +
              'In production this path reads <strong>your own</strong> content as an authorized, on-property edge fetch &mdash; not an external fetch &mdash; so it&rsquo;s never blocked. ' +
              '(Use a fetch-friendly page to see the live conversion.)</div>';
  }

  // Caveat below Response Time on Scenario B only — scenario-accurate:
  //  • Harper hit (e.g. prerender): the render happened ahead of time, out of band;
  //    a higher first-visit time is connection warm-up, not extra work.
  //  • conversion (md-cache cold miss): the convert happens in parallel; repeats are faster.
  var rtCaveat = scenario === 'b'
    ? '<div style="font-size:11px;color:#a8a8aa;line-height:1.4;padding:2px 0 6px">' +
      (harperHit
        ? 'Served from the prerender cache — the page was rendered once, ahead of time. A higher first-visit time here is connection warm-up, not extra work.'
        : 'First-visit conversion happens in parallel — cached responses are typically faster on repeat visits.') +
      '</div>'
    : '';

  // Write-through Scenario C (option A): the return visit is served from the exact
  // entry the first visit wrote — the write is confirmed (X-Cache-Write), so we
  // present the cached result rather than a re-raced live read.
  if (t.fromWriteThrough) {
    var writeRow = t.xCacheWrite
      ? statRow('Cache Write', badge(t.xCacheWrite, t.xCacheWrite === 'ok' ? 'b-ok' : 'b-err'))
      : '';
    document.getElementById(id).innerHTML =
      statRow('Response Time',  '<strong>' + t.responseTime + 'ms</strong>') +
      statRow('Content Format', ctBadge(t.contentType, scenario)) +
      statRow('Cache Status',   cacheBadge(t, scenario)) +
      edgeRow +
      statRow('Served by', servedByBadge(t, scenario)) +
      writeRow +
      statRow('Response Size',  sizeStr) +
      preview;
    return;
  }

  // Scenario C, prerender on a MISS: show the talk-track note instead of cache-state
  // rows. When prerender actually hits Harper (harper-cache-*), fall through to the
  // real rows below. Scenario B, the CDN scenario, and any real hit keep the rows.
  var cacheBlock;
  if (harperScenario && scenario === 'c' && !harperHit) {
    cacheBlock =
      '<div style="font-size:12px;color:#475569;line-height:1.55;background:#f1f5f9;' +
      'border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px;margin:6px 0">' +
      'This demo sends the two visits just seconds apart, so the cache may still be writing when the ' +
      'second one arrives \\u2014 too tight a window to show a reliable result here. In practice, AI ' +
      'crawlers come back minutes or hours later, well after the page is cached, so return visits are ' +
      'served straight from cache.' +
      '</div>';
  } else {
    cacheBlock =
      statRow('Cache Status',   cacheBadge(t, scenario)) +
      edgeRow +
      statRow('Served by', servedByBadge(t, scenario));
  }

  document.getElementById(id).innerHTML =
    statRow('Response Time',  '<strong>' + t.responseTime + 'ms</strong>') +
    rtCaveat +
    statRow('Content Format', ctBadge(t.contentType, scenario)) +
    cacheBlock +
    statRow('Response Size',  sizeStr) +
    preview;
}

function statRow(k, v) {
  return '<div class="stat"><span class="stat-k">' + k +
         '</span><span class="stat-v">' + v + '</span></div>';
}

function badge(text, cls) {
  return '<span class="badge ' + cls + '">' + esc(String(text)) + '</span>';
}

function ctBadge(ct, scenario) {
  if (ct.includes('markdown'))                  return badge('AI‑Optimized Markdown', 'b-md');
  if (ct.includes('html') && scenario === 'a')  return badge('Native HTML', 'b-html');
  if (ct.includes('html'))                      return badge('Standard HTML', 'b-html');
  if (scenario === 'a')                         return badge('Origin Response', 'b-bypass');
  return badge(ct || 'unknown', 'b-bypass');
}

function cacheBadge(t, scenario) {
  // Harper-backed scenarios cache in Harper — the truth is in X-Served-By, not the
  // CDN's X-Cache (which always misses when the EdgeWorker runs). The edge-convert
  // scenario has no Harper, so its only cache is the Akamai CDN (X-Cache).
  var harper = !!(scenarioFeatures && scenarioFeatures.harperCache);
  var sb = (t.xServedBy || '').toLowerCase();
  if (/^harper-cache/.test(sb))            return badge('Harper Cache Hit', 'b-hit');
  if (harper && /fermyon|origin/.test(sb)) return badge('Cache Miss → Harper', 'b-miss');
  var v = (t.xCache || '').toUpperCase();   // CDN scenario / passthrough
  if (v.includes('HIT'))  return badge(harper ? 'Harper Cache Hit' : 'CDN Cache Hit', 'b-hit');
  if (v.includes('MISS')) return badge(harper ? 'Cache Miss → Harper' : 'CDN Cache Miss', 'b-miss');
  return badge('Bypassed', 'b-bypass');
}

// Surfaces the EdgeWorker's X-Served-By decision (which path served the response).
// Handles the new dual-path values (harper-cache-html / harper-cache-md /
// fermyon-fallback / origin-fallback) and the baseline values the current
// production endpoint still emits (harper-cache + x-wasm-execution).
function servedByBadge(t, scenario) {
  var s = (t.xServedBy || '').toLowerCase();
  var harper = !!(scenarioFeatures && scenarioFeatures.harperCache);
  if (s === 'harper-cache-html')                       return badge('Harper · prerendered HTML', 'b-html');
  if (s === 'harper-cache-md' || s === 'harper-cache') return badge('Harper · cached Markdown', 'b-md');
  // fermyon-origin = the EW converted via Akamai Functions on a miss (write-through
  // scenarios also wrote it to Harper at that point; edge-convert just CDN-caches it).
  if (s === 'fermyon-origin')                          return badge(harper ? 'Akamai Functions · converted + written to Harper' : 'Akamai Functions · converted at edge', 'b-miss');
  if (s === 'fermyon-fallback')                        return badge('Akamai Functions · fallback', 'b-miss');
  if (s === 'origin-fallback')                         return badge('Origin · fallback', 'b-bypass');
  if (s)                                               return badge(s, 'b-bypass');
  // No X-Served-By header present (scenario A, or an endpoint without the header).
  if (t.xWasmExecution)                                return badge('Akamai Functions · converted at edge', 'b-miss');
  if (scenario === 'a')                                return badge('Origin · direct', 'b-bypass');
  return badge('Not reported', 'b-bypass');
}

function fmtBytes(n) {
  if (!n) return '0 B';
  return n < 1024 ? n + ' B' : (n / 1024).toFixed(1) + ' KB';
}

function fmtTokens(n) {
  return n >= 1000 ? (n / 1000).toFixed(1) + 'K' : String(n);
}

function esc(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function show(id) { document.getElementById(id).style.display = 'block'; }
function hide(id) { document.getElementById(id).style.display = 'none';  }

function showErr(msg) {
  var el = document.getElementById('error-banner');
  el.textContent = msg;
  show('error-banner');
}

document.getElementById('target-url').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') runPipeline();
});

loadFixtures();
loadScenarios();
switchTab('hero');
</script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// Render Lab — standalone page (served at GET /lab)
// ---------------------------------------------------------------------------
const RENDER_LAB_HTML = [
'<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/>',
'<meta name="viewport" content="width=device-width, initial-scale=1"/>',
'<title>Render Lab — Harper Prerender</title><style>',
'body{font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:#0f1115;color:#e6e6e6}',
'.wrap{max-width:1000px;margin:0 auto;padding:24px}',
'h1{font-size:20px;margin:0 0 4px}.sub{color:#8a93a2;margin:0 0 20px}',
'.card{background:#171a21;border:1px solid #262b36;border-radius:10px;padding:16px;margin-bottom:16px}',
'label{display:block;font-size:12px;color:#9aa4b2;margin:8px 0 3px}',
'input,select{width:100%;box-sizing:border-box;padding:8px 10px;background:#0f1115;border:1px solid #2b313d;border-radius:6px;color:#e6e6e6}',
'.row{display:flex;gap:12px;flex-wrap:wrap}.row>div{flex:1;min-width:120px}',
'button{margin-top:14px;padding:10px 18px;background:#3b82f6;border:0;border-radius:6px;color:#fff;font-weight:600;cursor:pointer}',
'button:disabled{opacity:.5;cursor:wait}',
'.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}',
'.metric{background:#0f1115;border:1px solid #262b36;border-radius:8px;padding:12px}',
'.metric .n{font-size:22px;font-weight:700}.metric .l{font-size:11px;color:#8a93a2;text-transform:uppercase;letter-spacing:.04em}',
'.good{color:#34d399}.bad{color:#f87171}.tag{display:inline-block;font-size:11px;padding:2px 8px;border-radius:99px;background:#222834;color:#9aa4b2;margin-right:6px}',
'pre{background:#0b0d11;border:1px solid #222834;border-radius:8px;padding:12px;overflow:auto;max-height:340px;white-space:pre-wrap;font-size:12px}',
'.muted{color:#8a93a2;font-size:12px}',
'</style></head><body><div class="wrap">',
'<h1>Render Lab</h1>',
'<p class="sub">Tune the headless render per URL and see HTML vs Markdown — same knob as <code>scripts/harper-render-probe.js</code>, calling Harper <code>/render_preview</code>.</p>',
'<div class="card">',
'<label>URL</label><input id="url" placeholder="https://www.example.com/product"/>',
'<div class="row">',
'<div><label>Device</label><select id="device"><option>desktop</option><option>mobile</option><option>tablet</option></select></div>',
'<div><label>Wait until</label><select id="wait"><option value="">(default)</option><option>domcontentloaded</option><option>load</option><option>networkidle2</option><option>networkidle0</option></select></div>',
'<div><label>Settle ms (network-idle cap, 0=off)</label><input id="settle" placeholder="(default 12000)"/></div>',
'<div><label>Idle ms</label><input id="idle" placeholder="(default 600)"/></div>',
'</div>',
'<label>Wait for selector (optional CSS)</label><input id="selector" placeholder="e.g. h1, [data-testid=price]"/>',
'<button id="go">Render</button> ',
'<button id="clearUrl" style="background:#475569">Clear this URL</button> ',
'<button id="clearAll" style="background:#7f1d1d">Clear ALL cache</button> ',
'<span id="status" class="muted"></span>',
'</div>',
'<div id="results" style="display:none">',
'<div class="card"><div class="grid">',
'<div class="metric"><div class="l">Raw fetch — body text</div><div class="n" id="rawText">–</div><div class="muted">the un-rendered shell</div></div>',
'<div class="metric"><div class="l">Rendered — body text</div><div class="n good" id="renText">–</div><div class="muted">after JS executes</div></div>',
'<div class="metric"><div class="l">Raw HTML tokens</div><div class="n" id="rawTok">–</div></div>',
'<div class="metric"><div class="l">Rendered Markdown tokens</div><div class="n good" id="mdTok">–</div><div class="muted" id="ratio"></div></div>',
'</div><div style="margin-top:12px" id="meta"></div></div>',
'<div class="card"><label>Derived Markdown (sample)</label><pre id="md"></pre></div>',
'</div>',
'<script>',
'function n(x){return (x==null?0:x).toLocaleString();}',
'var btn=document.getElementById("go");',
'btn.onclick=async function(){',
' var url=document.getElementById("url").value.trim();',
' if(!url){alert("Enter a URL");return;}',
' var payload={url:url,deviceType:document.getElementById("device").value,',
'  waitUntil:document.getElementById("wait").value,',
'  settleMs:document.getElementById("settle").value,',
'  idleMs:document.getElementById("idle").value,',
'  selector:document.getElementById("selector").value};',
' btn.disabled=true;document.getElementById("status").textContent="Rendering… (can take 10–40s)";',
' try{',
'  var r=await fetch("/render-lab",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});',
'  var d=await r.json();',
'  if(d.error){document.getElementById("status").textContent="Error: "+d.error;btn.disabled=false;return;}',
'  document.getElementById("results").style.display="block";',
'  document.getElementById("rawText").textContent=n(d.raw.textLen)+" ch";',
'  var rt=document.getElementById("renText");rt.textContent=n(d.rendered.textLen)+" ch";',
'  rt.className="n "+((d.rendered.textLen>d.raw.textLen*1.2||d.raw.textLen<50)?"good":"bad");',
'  document.getElementById("rawTok").textContent=n(d.raw.htmlTokens);',
'  document.getElementById("mdTok").textContent=n(d.rendered.markdownTokens);',
'  var ratio=(d.raw.htmlTokens&&d.rendered.markdownTokens)?(d.raw.htmlTokens/d.rendered.markdownTokens).toFixed(1):0;',
'  document.getElementById("ratio").textContent=ratio?(ratio+"x fewer tokens than raw HTML"):"";',
'  var eo=d.effectiveOptions||{};',
'  document.getElementById("meta").innerHTML=',
'   \'<span class="tag">HTTP \'+d.statusCode+\'</span>\'+',
'   \'<span class="tag">\'+(d.elapsedMs||0)+\' ms</span>\'+',
'   \'<span class="tag">waitUntil: \'+eo.waitUntil+\'</span>\'+',
'   \'<span class="tag">settle: \'+eo.settleTimeoutMs+\'</span>\'+',
'   \'<span class="tag">idle: \'+eo.networkIdleMs+\'</span>\'+',
'   \'<span class="tag">selector: \'+(eo.waitForSelector||"none")+\'</span>\';',
'  document.getElementById("md").textContent=d.markdownSample||"(no markdown — non-200 or empty render)";',
' }catch(e){document.getElementById("status").textContent="Request failed: "+e.message;}',
' document.getElementById("status").textContent="";btn.disabled=false;',
'};',
'async function doClear(p){',
' var s=document.getElementById("status");s.textContent="Clearing cache…";',
' try{',
'  var r=await fetch("/cache-clear",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(p)});',
'  var d=await r.json();',
'  s.textContent=d.ok?("Cleared "+d.cleared+" page(s)"+(d.jobsCleared?(" + "+d.jobsCleared+" jobs"):"")):("Error: "+(d.error||"?"));',
' }catch(e){s.textContent="Clear failed: "+e.message;}',
'}',
'document.getElementById("clearAll").onclick=function(){doClear({all:true});};',
'document.getElementById("clearUrl").onclick=function(){var u=document.getElementById("url").value.trim();if(!u){alert("Enter a URL");return;}doClear({url:u});};',
'</script></div></body></html>'
].join('\n');

// ---------------------------------------------------------------------------
// Render Lab — render-tuning knob, wired to Harper's /render_preview
// ---------------------------------------------------------------------------
const HARPER_PREVIEW_URL = process.env.HARPER_PREVIEW_URL || 'http://localhost:9926';
const HARPER_BOT_KEY     = process.env.HARPER_BOT_KEY || '';
// Admin Basic-auth creds for seeding (POST /sitemaps). When all four Harper
// settings are present the "prerender another page" affordance is offered.
const HARPER_ADMIN_USER  = process.env.HARPER_ADMIN_USER || '';
const HARPER_ADMIN_PASS  = process.env.HARPER_ADMIN_PASS || '';
const HARPER_READY = !!(HARPER_PREVIEW_URL && HARPER_BOT_KEY && HARPER_ADMIN_USER && HARPER_ADMIN_PASS);

// Seed a URL for prerendering: POST /sitemaps (Basic auth), url-list mode —
// same contract as scripts/harper-bulk-upload.js. The renderer (headless Chrome)
// then picks up the job and writes both HTML + Markdown into PageCache.
function harperSeed(targetUrl) {
    return new Promise((resolve) => {
        const u = new URL(HARPER_PREVIEW_URL.replace(/\/$/, '') + '/sitemaps');
        const payload = JSON.stringify({
            sitemapURL: 'urllist:' + targetUrl,
            refreshInterval: 864000000,
            isSitemap: false,
            urlList: [targetUrl],
            deviceTypes: ['desktop'],
        });
        const lib = u.protocol === 'https:' ? https : http;
        const req = lib.request({
            hostname: u.hostname,
            port: u.port || (u.protocol === 'https:' ? 443 : 80),
            path: u.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
                'Authorization': 'Basic ' + Buffer.from(HARPER_ADMIN_USER + ':' + HARPER_ADMIN_PASS).toString('base64'),
            },
            agent: u.protocol === 'https:' ? permissiveSslAgent : undefined,
        }, (r) => {
            const chunks = [];
            r.on('data', (c) => chunks.push(c));
            r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', (e) => resolve({ status: 0, body: e.message }));
        req.setTimeout(30000, () => req.destroy());
        req.end(payload);
    });
}

// Call Harper's /render_preview with the chosen options (server-side so the
// bot-key never reaches the browser).
function harperRenderPreview({ url, deviceType, waitUntil, settleMs, idleMs, selector }) {
    return new Promise((resolve, reject) => {
        const qs = new URLSearchParams({ url });
        if (deviceType) qs.set('deviceType', deviceType);
        if (waitUntil)  qs.set('waitUntil', waitUntil);
        if (settleMs !== undefined && settleMs !== '' && settleMs !== null) qs.set('settleMs', String(settleMs));
        if (idleMs   !== undefined && idleMs   !== '' && idleMs   !== null) qs.set('idleMs', String(idleMs));
        if (selector)   qs.set('selector', selector);

        const u   = new URL(HARPER_PREVIEW_URL.replace(/\/$/, '') + '/render_preview?' + qs.toString());
        const lib = u.protocol === 'https:' ? https : http;
        const req = lib.request({
            hostname: u.hostname,
            port: u.port || (u.protocol === 'https:' ? 443 : 80),
            path: u.pathname + u.search,
            method: 'GET',
            headers: { 'x-pr-req-key': HARPER_BOT_KEY },
            agent: u.protocol === 'https:' ? permissiveSslAgent : undefined,
        }, (r) => {
            let data = '';
            r.on('data', (c) => { data += c; });
            r.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch { reject(new Error('Harper returned non-JSON: ' + data.slice(0, 200))); }
            });
        });
        req.on('error', reject);
        req.setTimeout(70000, () => req.destroy(new Error('Harper /render_preview timed out')));
        req.end();
    });
}

// Clear Harper's cache (all, or a single URL) — no DB restart needed.
function harperCacheClear({ all, url }) {
    return new Promise((resolve, reject) => {
        const qs = new URLSearchParams();
        if (all) qs.set('all', 'true');
        else if (url) qs.set('url', url);
        const u = new URL(HARPER_PREVIEW_URL.replace(/\/$/, '') + '/cache_clear?' + qs.toString());
        const lib = u.protocol === 'https:' ? https : http;
        const req = lib.request({
            hostname: u.hostname,
            port: u.port || (u.protocol === 'https:' ? 443 : 80),
            path: u.pathname + u.search,
            method: 'POST',
            headers: { 'x-pr-req-key': HARPER_BOT_KEY },
            agent: u.protocol === 'https:' ? permissiveSslAgent : undefined,
        }, (r) => {
            let d = '';
            r.on('data', (c) => { d += c; });
            r.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('Harper returned non-JSON: ' + d.slice(0, 200))); } });
        });
        req.on('error', reject);
        req.setTimeout(30000, () => req.destroy(new Error('Harper /cache_clear timed out')));
        req.end();
    });
}

// Plain origin fetch — the "before" (un-rendered) baseline for the comparison.
function fetchRaw(targetUrl) {
    return new Promise((resolve) => {
        let u; try { u = new URL(targetUrl); } catch { return resolve({ ok: false, status: 0, html: '' }); }
        const lib = u.protocol === 'https:' ? https : http;
        const req = lib.request({
            hostname: u.hostname,
            port: u.port || (u.protocol === 'https:' ? 443 : 80),
            path: u.pathname + u.search,
            method: 'GET',
            headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html', 'Accept-Encoding': 'gzip, br, deflate' },
            agent: u.protocol === 'https:' ? permissiveSslAgent : undefined,
        }, (r) => {
            const chunks = [];
            r.on('data', (c) => chunks.push(c));
            r.on('end', () => {
                let buf = Buffer.concat(chunks);
                const e = r.headers['content-encoding'] || '';
                try {
                    if (e.includes('gzip')) buf = zlib.gunzipSync(buf);
                    else if (e.includes('br')) buf = zlib.brotliDecompressSync(buf);
                    else if (e.includes('deflate')) buf = zlib.inflateSync(buf);
                } catch { /* leave as-is */ }
                resolve({ ok: true, status: r.statusCode, html: buf.toString('utf8') });
            });
        });
        req.on('error', () => resolve({ ok: false, status: 0, html: '' }));
        req.setTimeout(30000, () => req.destroy());
        req.end();
    });
}

// Crude visible-text length — the CSR-gap signal (shell ≈ 0, rendered ≫ 0).
function bodyTextLength(html) {
    const stripped = String(html || '')
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '');
    return stripped.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length;
}

// Shared per-crawler policy module (ESM) — dynamically imported so the demo and
// the EdgeWorker use the EXACT same routing logic (edgeworker/crawler-policy.js).
let _policyMod = null;
async function crawlerPolicyModule() {
    if (!_policyMod) _policyMod = await import('./crawler-policy.js');
    return _policyMod;
}

// Read a representation straight from Harper's cache (mirrors the EdgeWorker read):
// /page_content for markdown, /page for html. Both come from the same cached render.
function harperReadRepresentation(url, representation, deviceType) {
    return new Promise((resolve) => {
        const path = representation === 'markdown'
            ? '/page_content?path=' + encodeURIComponent(url)
            : '/page/?url=' + encodeURIComponent(url) + '&deviceType=' + encodeURIComponent(deviceType || 'desktop');
        const u = new URL(HARPER_PREVIEW_URL.replace(/\/$/, '') + path);
        const lib = u.protocol === 'https:' ? https : http;
        const req = lib.request({
            hostname: u.hostname,
            port: u.port || (u.protocol === 'https:' ? 443 : 80),
            path: u.pathname + u.search,
            method: 'GET',
            headers: { 'x-pr-req-key': HARPER_BOT_KEY, 'accept-encoding': 'gzip' },
            agent: u.protocol === 'https:' ? permissiveSslAgent : undefined,
        }, (r) => {
            const chunks = [];
            r.on('data', (c) => chunks.push(c));
            r.on('end', () => {
                let buf = Buffer.concat(chunks);
                if ((r.headers['content-encoding'] || '').includes('gzip')) { try { buf = zlib.gunzipSync(buf); } catch { /* leave */ } }
                resolve({ status: r.statusCode, contentType: r.headers['content-type'] || '', body: buf.toString('utf8') });
            });
        });
        req.on('error', () => resolve({ status: 0, contentType: '', body: '' }));
        req.setTimeout(40000, () => req.destroy());
        req.end();
    });
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/lab') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(RENDER_LAB_HTML);
        return;
    }

    // Who's asking? — one URL, one edge config (the per-crawler `prerender`
    // scenario), fetched live through the staging edge as one or more visitors.
    // We only vary WHO is asking (the bot headers); the EdgeWorker alone decides
    // what each is handed back — HTML for search crawlers, Markdown for AI
    // crawlers, the raw shell for a person. `kinds` is a list of X-Bot-Kind
    // values ('human' = no bot); results come back keyed by kind.
    if (req.method === 'POST' && req.url === '/hero-lane') {
        let body = '';
        req.on('data', (chunk) => { body += chunk.toString(); });
        req.on('end', async () => {
            try {
                const parsed = JSON.parse(body || '{}');
                const cfg = resolveScenario('prerender');
                const url = (parsed.url && /^https?:\/\//i.test(parsed.url))
                    ? parsed.url
                    : ('https://' + cfg.host + '/');
                const kinds = (Array.isArray(parsed.kinds) && parsed.kinds.length ? parsed.kinds : ['human'])
                    .map(k => String(k)).slice(0, 8);
                const settled = await Promise.all(kinds.map(async (kind) => {
                    const headers = kind === 'human'
                        ? {}
                        : { 'X-Verified-Bot': 'true', 'X-Bot-Kind': kind };
                    try {
                        const r = await makeEdgeRequest(url, headers, cfg, 150000);
                        const served = r.bodyPreview || '';
                        return [kind, {
                            status: r.status,
                            servedBy: r.xServedBy || '',
                            contentType: r.contentType || '',
                            responseTime: r.responseTime,
                            bytes: r.bodySize,
                            tokens: served ? countTokens(served) : 0,
                            sample: served,
                        }];
                    } catch (err) {
                        return [kind, { error: err.message }];
                    }
                }));
                sendJSON(res, 200, { url, scenario: cfg.ewScenario, results: Object.fromEntries(settled) });
            } catch (err) {
                sendJSON(res, 500, { error: err.message });
            }
        });
        return;
    }

    // Prerender-another-page — seed step. Fetches the raw origin (the "before":
    // the pre-JS shell a browser gets) instantly, then seeds the URL so the
    // renderer prerenders it into Harper. The client then polls /prerender-poll.
    if (req.method === 'POST' && req.url === '/prerender-seed') {
        let body = '';
        req.on('data', (chunk) => { body += chunk.toString(); });
        req.on('end', async () => {
            try {
                if (!HARPER_READY) return sendJSON(res, 400, { error: 'Harper seed credentials not configured (set HARPER_PREVIEW_URL / HARPER_ADMIN_USER / HARPER_ADMIN_PASS / HARPER_BOT_KEY in env/demo.env)' });
                const o = JSON.parse(body || '{}');
                const url = String(o.url || '').trim();
                if (!/^https?:\/\//i.test(url)) return sendJSON(res, 400, { error: 'Provide a valid http(s) URL' });

                // "Before": the raw origin bytes (what a non-JS client / the pre-render shell sees).
                const raw = await fetchRaw(url);
                const rawBody = raw.html || '';
                const before = { status: raw.status, servedBy: 'origin · shell', contentType: 'text/html', bytes: Buffer.byteLength(rawBody), tokens: rawBody ? countTokens(rawBody) : 0, sample: rawBody };

                // Already prerendered? (idempotent — re-seeding is harmless, but skip the wait.)
                const existing = await harperReadRepresentation(url, 'html', 'desktop');
                const alreadyCached = existing.status === 200;

                const seed = await harperSeed(url);
                const seededOk = seed.status >= 200 && seed.status < 300;
                if (!seededOk && !alreadyCached) return sendJSON(res, 502, { error: 'Seed failed (HTTP ' + seed.status + '): ' + (seed.body || '').slice(0, 300) });

                sendJSON(res, 200, { ok: true, url, alreadyCached, before });
            } catch (err) {
                sendJSON(res, 500, { error: err.message });
            }
        });
        return;
    }

    // Prerender-another-page — poll step. Reads HTML (/page) + Markdown
    // (/page_content) straight from Harper. `ready` once both are 200 — i.e. the
    // headless-Chrome render has landed and both representations are cached.
    if (req.method === 'GET' && req.url.startsWith('/prerender-poll')) {
        try {
            if (!HARPER_READY) return sendJSON(res, 400, { error: 'Harper not configured' });
            const url = new URL(req.url, 'http://x').searchParams.get('url') || '';
            if (!/^https?:\/\//i.test(url)) return sendJSON(res, 400, { error: 'Provide a valid http(s) URL' });
            const [html, md] = await Promise.all([
                harperReadRepresentation(url, 'html', 'desktop'),
                harperReadRepresentation(url, 'markdown', 'desktop'),
            ]);
            const ready = html.status === 200 && md.status === 200;
            const mk = (r, servedBy) => ({ status: r.status, servedBy, contentType: r.contentType || '', bytes: r.body ? Buffer.byteLength(r.body) : 0, tokens: r.body ? countTokens(r.body) : 0, sample: r.body || '' });
            sendJSON(res, 200, {
                ready,
                htmlStatus: html.status,
                mdStatus: md.status,
                search: ready ? mk(html, 'harper-cache-html') : null,
                ai: ready ? mk(md, 'harper-cache-md') : null,
            });
        } catch (err) {
            sendJSON(res, 500, { error: err.message });
        }
        return;
    }

    if (req.method === 'POST' && req.url === '/cache-clear') {
        let body = '';
        req.on('data', (chunk) => { body += chunk.toString(); });
        req.on('end', async () => {
            try {
                const o = JSON.parse(body || '{}');
                if (!o.all && !o.url) return sendJSON(res, 400, { error: 'provide {all:true} or {url}' });
                const d = await harperCacheClear({ all: !!o.all, url: o.url });
                sendJSON(res, 200, d);
            } catch (err) {
                sendJSON(res, 500, { error: err.message });
            }
        });
        return;
    }

    if (req.method === 'POST' && req.url === '/render-lab') {
        let body = '';
        req.on('data', (chunk) => { body += chunk.toString(); });
        req.on('end', async () => {
            try {
                const opts = JSON.parse(body || '{}');
                if (!opts.url || !/^https?:\/\//i.test(opts.url)) {
                    return sendJSON(res, 400, { error: 'Provide a valid http(s) url' });
                }
                const [preview, raw] = await Promise.all([harperRenderPreview(opts), fetchRaw(opts.url)]);
                const renderedMdTokens = preview.markdown ? countTokens(preview.markdown) : 0;
                const renderedHtmlTokens = preview.html ? countTokens(preview.html) : 0;
                sendJSON(res, 200, {
                    ok: !!preview.ok,
                    statusCode: preview.statusCode,
                    error: preview.error || null,
                    elapsedMs: preview.elapsedMs,
                    renderTimeMs: preview.renderTimeMs,
                    effectiveOptions: preview.effectiveOptions || {},
                    rendered: {
                        htmlBytes: preview.htmlBytes || 0,
                        markdownBytes: preview.markdownBytes || 0,
                        htmlTokens: renderedHtmlTokens,
                        markdownTokens: renderedMdTokens,
                        textLen: bodyTextLength(preview.html),
                    },
                    raw: {
                        ok: raw.ok, status: raw.status,
                        htmlTokens: raw.ok ? countTokens(raw.html) : 0,
                        textLen: bodyTextLength(raw.html),
                    },
                    markdownSample: (preview.markdown || '').slice(0, 6000),
                });
            } catch (err) {
                sendJSON(res, 500, { error: err.message });
            }
        });
        return;
    }

    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(HTML);
        return;
    }

    if (req.method === 'GET' && req.url === '/fixtures') {
        try {
            const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures.json'), 'utf8'));
            sendJSON(res, 200, config);
        } catch { sendJSON(res, 200, { customers: [] }); }
        return;
    }

    if (req.method === 'GET' && req.url === '/scenarios') {
        const hero = resolveScenario('prerender');
        return sendJSON(res, 200, {
            default: DEFAULT_SCENARIO,
            storeUrl: 'https://' + hero.host + '/',
            harperReady: HARPER_READY,   // gates the "prerender another page" affordance
            scenarios: SCENARIOS.map(s => ({
                id: s.id, label: s.label, blurb: s.blurb, source: s.source, features: s.features || {},
                live: s.live !== false, blockedReason: s.blockedReason || ''
            }))
        });
    }

    if (req.method === 'POST' && req.url === '/run-tests') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', async () => {
            try {
                const { url: targetUrl, fixtureFile, scenario } = JSON.parse(body);
                if (!targetUrl || typeof targetUrl !== 'string') {
                    return sendJSON(res, 400, { error: 'Missing or invalid url parameter' });
                }
                // Validate URL and restrict to http/https to prevent misuse.
                let parsed;
                try { parsed = new URL(targetUrl); } catch {
                    return sendJSON(res, 400, { error: 'Invalid URL format' });
                }
                if (!['http:', 'https:'].includes(parsed.protocol)) {
                    return sendJSON(res, 400, { error: 'URL must use http or https' });
                }
                const results = await runTests(targetUrl, fixtureFile || null, resolveScenario(scenario));
                sendJSON(res, 200, results);
            } catch (err) {
                sendJSON(res, 500, { error: err.message });
            }
        });
        return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
    console.log('\n  Serverless AI-SEO Pipeline — Demo UI');
    console.log(`  http://localhost:${PORT}\n`);
});
