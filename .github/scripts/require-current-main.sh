#!/usr/bin/env bash
# Provenance: copied from OxyHQ/Mention .github/scripts/require-current-main.sh
# @ f5ad90c9bbf6cc9f7f9b93e1378c4b011031812b (origin/main). Unchanged.

set -euo pipefail

: "${DEPLOY_SHA:?DEPLOY_SHA is required}"

if [[ ! "$DEPLOY_SHA" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]]; then
  echo "::error::DEPLOY_SHA must be a full lowercase Git commit ID."
  exit 1
fi

git fetch \
  --force \
  --no-tags \
  --prune \
  origin \
  '+refs/heads/main:refs/remotes/origin/main'

checked_out_sha="$(git rev-parse --verify 'HEAD^{commit}')"
origin_main_sha="$(git rev-parse --verify 'refs/remotes/origin/main^{commit}')"

if [[ "$checked_out_sha" != "$DEPLOY_SHA" ]]; then
  echo "::error::The checked-out commit does not match DEPLOY_SHA; refusing a production release."
  exit 1
fi

if [[ "$origin_main_sha" != "$DEPLOY_SHA" ]]; then
  echo "::error::Stale production release blocked: DEPLOY_SHA is no longer the exact head of origin/main."
  exit 1
fi

echo "Production candidate $DEPLOY_SHA is the current origin/main head."
