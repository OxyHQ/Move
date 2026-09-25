#!/usr/bin/env bash
# Post-deploy smoke checks for the Move API, run by deploy-ecs-image.sh after the
# ECS rollout reaches steady state. A non-zero exit rolls the service back.
#
# Each check has a NEGATIVE control: an unauthenticated `/jobs` MUST be refused,
# so a deploy that accidentally opened the API (or answers 200 to everything,
# e.g. a default page) cannot pass.
set -euo pipefail

API_ORIGIN="${API_ORIGIN:-https://api.move.oxy.so}"
body="$(mktemp)"
trap 'rm -f "$body"' EXIT

status() {
  curl --silent --show-error --max-time 20 --retry 6 --retry-delay 5 --retry-all-errors \
    --max-redirs 0 --output "$body" --write-out '%{http_code}' "$@"
}

code="$(status "$API_ORIGIN/health")"
[[ "$code" == 200 ]] && jq -e '.status == "ok" and .service == "move-backend"' "$body" >/dev/null \
  || { echo "::error::/health answered $code: $(head -c 300 "$body")"; exit 1; }

code="$(status "$API_ORIGIN/ready")"
[[ "$code" == 200 ]] && jq -e '.status == "ready" and .dependencies.migrations == "ready"' "$body" >/dev/null \
  || { echo "::error::/ready answered $code: $(head -c 300 "$body")"; exit 1; }

code="$(status "$API_ORIGIN/platforms")"
[[ "$code" == 200 ]] && jq -e '[.platforms[] | select(.status == "available")] | length >= 2' "$body" >/dev/null \
  || { echo "::error::/platforms answered $code: $(head -c 300 "$body")"; exit 1; }

# Negative control: no session, no jobs.
code="$(status "$API_ORIGIN/jobs")"
if [[ "$code" != 401 && "$code" != 403 ]]; then
  echo "::error::unauthenticated GET /jobs answered $code (expected 401/403)."
  exit 1
fi

echo "Move API smoke checks passed against $API_ORIGIN"
