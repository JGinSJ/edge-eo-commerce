#!/usr/bin/env bash
# Seed the commerce URL(s) for DESKTOP into Harper (POST /sitemaps -> render -> PageCache).
# Requires env from env/bulk-upload.env.example. Note: --urls is LAST so it doesn't
# swallow the device value (a quirk of the upload script's arg parsing).
#
# Usage:
#   set -a; . ../env/bulk-upload.env; set +a
#   ./seed.sh https://shop.example.com/
set -euo pipefail
: "${HARPER_OPS_URL:?}"; : "${HARPER_ADMIN_USER:?}"; : "${HARPER_ADMIN_PASS:?}"
[ "$#" -ge 1 ] || { echo "usage: ./seed.sh <url> [<url> ...]"; exit 1; }
node "$(dirname "$0")/harper-bulk-upload.js" --device-types desktop --urls "$@"
