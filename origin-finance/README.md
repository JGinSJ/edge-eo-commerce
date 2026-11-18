# CSR finance origin (demo)

The finance vertical of the demo: a deliberately **client-side-rendered** mortgage rate page for
a fictional bank (Larkspur Bank). Same idea as `../origin/`: `index.html` is an empty shell,
and `app.js` builds the whole page in the browser, including `<title>`,
`<meta name="description">`, and JSON-LD (`MortgageLoan` + `FAQPage`).

Copy comes from `rates.json`. The numbers come from the Harper rate sheet at
`/_harper/rate_sheet/national`, the same row Harper fills the bot view from. There is no
fallback: if the sheet cannot be read, the page shows an error and no rate. On localhost
(no `/_harper`) the sample numbers in `rates.json` stand in.

The rates are sample data, not market rates.

## Files
- `index.html`: shell (no rates until JS runs)
- `app.js`: client-side render; sets `<html data-rendered="1">` as a settle signal
- `rates.json`: page copy, plus sample numbers used only on localhost and as the `set-rate.mjs --reset` baseline
- `styles.css`: self-contained styling (light/dark aware)

## Rate slots and templates
This is the contract with the Harper component (`harper-prerender/src/util/rates.js`).

- **Slots.** Every visible value is rendered through `rateSlot()` in `app.js`, which tags the
  element with `data-rate-key="<product-key>.<field>"` (or `asOf`) and
  `data-rate-format` (`pct3`, `num`, `datetime`). Harper replaces the text with a token when it
  stores the prerender and fills it from the rate sheet on every bot request.
- **Templates.** The `<title>`, the meta description, and the JSON-LD carry the rate but cannot
  be slots. `app.js` emits their tokenized form in
  `<script type="application/json" id="rate-templates">`; Harper swaps them in and removes the
  block. One builder (`buildMetadata`) produces both the live values and the templates, so they
  cannot drift.

A rate written anywhere else on the page (FAQ prose, for example) stays frozen at its
render-time value. Harper counts those and reports them in `x-rate-leftovers`; it should be 0.

## Changing `app.js`
The property serves `app.js` with a seven-day cache lifetime, and the renderer's Chrome keeps a
disk cache. After changing `app.js`, bump the version in `index.html`
(`./app.js?v=N`), or the renderer and returning visitors keep running the old script.
`index.html` and `rates.json` are served `no-store`, so they need no versioning.

## Host it
It lives under `/finance/` on the same bucket and property as the commerce origin:

```
s3cmd sync origin-finance/ s3://edge-eo-ecommerce/finance/ --acl-public --guess-mime-type --no-mime-magic --exclude README.md
```

The demo URL is `https://stopwaitingshipit.com/finance/index.html`. Use the explicit
`index.html`: the property's default-document rule only rewrites `/`, so `/finance/` alone
would not resolve. That avoids a property change.

Seed it: `scripts/seed.sh https://stopwaitingshipit.com/finance/index.html`

## Local preview
```
python3 -m http.server 8001 --directory origin-finance   # http://localhost:8001
```

## Verify the CSR property
```
curl -s <url> | grep -c "6.625"   # → 0 : the rate is NOT in the raw HTML
```

## Demo UI
`demo/scenarios.config.json` has a `verticals` list (`id`, `label`, `noun`, `path`). With more
than one entry, the "Who's asking?" hero shows a Commerce / Finance switch that repoints the
locked store URL. The choice is remembered per browser.
