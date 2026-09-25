#!/usr/bin/env bash
# Smoke checks for the Move web app on Cloudflare Workers Static Assets.
#
# Asserts the ARTEFACT, not just a 200: the shell must be Expo's (a marker only
# the export produces), a deep link must fall back to the SPA shell, and the two
# security headers `_headers` declares must be on the live responses (Pages used
# to add them implicitly; Workers does not).
set -euo pipefail

WEB_ORIGIN="${WEB_ORIGIN:-https://move.oxy.so}"
dir="$(mktemp -d)"
trap 'rm -rf "$dir"' EXIT

fetch() {
  local name="$1" url="$2"
  curl --silent --show-error --max-time 20 --retry 8 --retry-delay 5 --retry-all-errors \
    --max-redirs 0 --dump-header "$dir/$name.h" --output "$dir/$name.b" --write-out '%{http_code}' "$url"
}

for path in / /jobs/does-not-exist; do
  name="$(echo "$path" | tr '/' '_')"
  code="$(fetch "$name" "$WEB_ORIGIN$path")"
  [[ "$code" == 200 ]] || { echo "::error::$WEB_ORIGIN$path answered $code"; exit 1; }
  grep -q '_expo/static/js/web/' "$dir/$name.b" \
    || { echo "::error::$WEB_ORIGIN$path is not the Expo web shell"; exit 1; }
  grep -qi '^x-content-type-options: *nosniff' "$dir/$name.h" \
    || { echo "::error::$WEB_ORIGIN$path lacks X-Content-Type-Options: nosniff"; exit 1; }
  grep -qi '^referrer-policy: *strict-origin-when-cross-origin' "$dir/$name.h" \
    || { echo "::error::$WEB_ORIGIN$path lacks Referrer-Policy"; exit 1; }
done

echo "Move web smoke checks passed against $WEB_ORIGIN"
