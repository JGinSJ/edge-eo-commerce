#!/usr/bin/env bash
# End-to-end validation for the commerce deployment.
#   Part A: probe the Harper node directly — the new endpoints must be PRESENT (401), not 404.
#   Part B: exercise all four scenarios through the edge with the cache-bust + demo-header pattern.
#
# Usage:
#   HOST=shop.example.com \
#   NODE=https://gq4-xxx.harperfabric.com \
#   ORIGIN_URL=https://shop.example.com/ \
#   [STAGING_EDGE=shop.example.com.edgekey-staging.net] \
#   ./validate.sh
set -uo pipefail

: "${HOST:?set HOST to the property hostname}"
: "${NODE:?set NODE to the Harper node base URL (https://...)}"
: "${ORIGIN_URL:?set ORIGIN_URL to the commerce page URL to test}"
STAGING_EDGE="${STAGING_EDGE:-${HOST}.edgekey-staging.net}"     # use .edgesuite-staging.net for Standard-TLS
CONNECT="--connect-to ${HOST}:443:${STAGING_EDGE}:443"
enc() { python3 -c 'import sys,urllib.parse as u; print(u.quote(sys.argv[1], safe=""))' "$1"; }
ENC_URL="$(enc "$ORIGIN_URL")"

echo "== Part A: Harper node endpoint probe (want 401 present, NOT 404) =="
for p in "page_content?path=$ENC_URL" "page/?url=$ENC_URL&deviceType=desktop" "sitemaps" "render_preview?url=$ENC_URL" "markdown_cache/x"; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 25 "$NODE/$p")
  flag="ok"; [ "$code" = "404" ] && flag="MISSING (deploy component/table)"
  printf '  %-40s -> %s  %s\n' "${p%%\?*}" "$code" "$flag"
done

echo ""
echo "== Part B: four-scenario matrix through the staging edge =="
probe() { # $1=scenario $2=botkind $3=expected
  local url="https://${HOST}/?url=${ENC_URL}&cb=$(date +%s%N)"
  echo "-- $1 ($2) — expect: $3"
  curl -sD - -o /dev/null --max-time 30 $CONNECT \
    -H 'X-Verified-Bot: true' -H "X-Bot-Kind: $2" -H "X-Demo-Scenario: $1" "$url" \
    | grep -iE 'x-served-by|x-cache-write|x-harper|x-bot-kind|x-ew-version|content-type|edge; dur' | sed 's/^/    /'
  echo ""
}
probe convert-cache claudebot "x-served-by: harper-cache-md"
probe prerender     googlebot "x-served-by: harper-cache-html"
probe md-cache      claudebot "1st: fermyon-origin + X-Cache-Write: ok ; run again -> harper-cache-md"
probe md-cache      claudebot "(2nd hit) x-served-by: harper-cache-md"
probe cdn-cache     claudebot "x-served-by: fermyon-origin (Akamai CDN caches)"
echo "Tells of a STALE edge hit (rerun with a fresh cb): edge;dur=1, wrong echoed x-bot-kind."
