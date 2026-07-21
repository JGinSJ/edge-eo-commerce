# CSR commerce origin (demo)

A deliberately **client-side-rendered** product page. The initial HTML (`index.html`) is an
empty shell + spinner; `app.js` fetches `products.json` and builds the entire page in the
browser — product content, `<title>`/`<meta>`, and JSON-LD `Product` structured data.

**Why it's built this way:** a search/AI crawler that doesn't execute JS sees almost nothing.
The headless prerenderer runs the JS, waits for the network to settle, and captures the fully
rendered HTML (with structured data) — which the edge then caches and serves. This origin
maximizes the visible delta between "raw origin" and "prerendered", which is the whole demo.

## Files
- `index.html` — shell (near-empty; generic title until JS runs)
- `app.js` — client-side render + metadata/JSON-LD injection; sets `<html data-rendered="1">` as a settle signal
- `products.json` — the product data fetched at runtime (content is NOT in the HTML)
- `styles.css` — commerce styling (light/dark aware)

## Host it
Any static host works (S3 + CloudFront, Netlify, Vercel, GitHub Pages). It must be a **public URL**
reachable by (a) the Akamai property as its origin, and (b) the renderer VM (to fetch + render).

Local preview:
```
cd origin && python3 -m http.server 8000   # http://localhost:8000
```

## Verify the CSR property (proves prerender adds value)
```
curl -s <origin-url> | grep -c "Aurora Pro ANC"   # → 0 : product text is NOT in raw HTML
# In a browser, the page renders fully; <html data-rendered="1"> appears after JS.
```
The prerendered snapshot (via Harper `/page`) WILL contain the product text, title, and JSON-LD.
