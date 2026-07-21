#!/usr/bin/env bash
# Deploy the two Harper components to a Fabric instance via the Operations API
# (deploy_component with a base64 tarball — no GitHub access needed by the instance,
# so it works for our private/custom code). Harper installs each component's npm deps.
#
# Requires (from the instance's Fabric Connect / connection details):
#   HARPER_OPS_URL     Operations API endpoint, e.g. https://<node-fqdn>:9925
#   HARPER_ADMIN_USER  Harper admin username
#   HARPER_ADMIN_PASS  Harper admin password
#
# Usage:
#   HARPER_OPS_URL=... HARPER_ADMIN_USER=... HARPER_ADMIN_PASS=... ./deploy-components.sh
set -euo pipefail
: "${HARPER_OPS_URL:?set HARPER_OPS_URL to the Operations API endpoint}"
: "${HARPER_ADMIN_USER:?}"; : "${HARPER_ADMIN_PASS:?}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AUTH="$(printf '%s:%s' "$HARPER_ADMIN_USER" "$HARPER_ADMIN_PASS" | base64 | tr -d '\n')"

deploy() {  # $1 = project name (= component dir under repo root)
  local proj="$1" tgz="/tmp/deploy-$1-$$.tgz" payload
  tar -czf "$tgz" -C "$ROOT/$proj" .
  payload="$(base64 < "$tgz" | tr -d '\n')"
  echo "→ deploying '$proj' ($(wc -c < "$tgz" | tr -d ' ') bytes)…"
  curl -sS -X POST "$HARPER_OPS_URL" \
    -H "Authorization: Basic $AUTH" -H 'Content-Type: application/json' \
    -d "{\"operation\":\"deploy_component\",\"project\":\"$proj\",\"replace\":true,\"restart\":true,\"ignore_replication_errors\":true,\"payload\":\"$payload\"}"
  echo; rm -f "$tgz"
}

deploy harper-prerender
deploy harper-markdown-cache
echo "Done. Verify: scripts/validate.sh Part A (endpoints must be 401, not 404)."
