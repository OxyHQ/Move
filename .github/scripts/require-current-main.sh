#!/usr/bin/env bash
# Provenance: copied from OxyHQ/Mention .github/scripts/require-current-main.sh
# @ f5ad90c9bbf6cc9f7f9b93e1378c4b011031812b (origin/main). Modified 2026-10:
# an older commit is no longer refused just for not being main's head (below),
# and `--gate` reports the decision instead of failing.
#
# Admits DEPLOY_SHA for a production release when it is main's head, OR when
# every commit main gained after it has NO CI push run that is queued, in
# progress or succeeded. Only such a run leads to a release of its own, which
# carries DEPLOY_SHA; without one, nothing ever would. A pull request merged
# with GITHUB_TOKEN (an auto-merge), a `[skip ci]` commit or a commit whose CI
# went red starts no release, and refusing on "is this main's head" alone
# stranded the newest CI-tested commit behind exactly those (OxyHQ/Alia #782,
# OxyHQ/Noted #208). History that is not a plain descendant, or too long to
# list, is still refused.
#
# Usage: require-current-main.sh [--gate]
#   (none)  exit 1 when DEPLOY_SHA is not admitted.
#   --gate  write `release=true|false` to GITHUB_OUTPUT and exit 0 instead.
#           Errors (bad input, a checkout mismatch, an API failure) still exit 1.
# Env: DEPLOY_SHA, GITHUB_REPOSITORY, GH_TOKEN (actions: read), and
# GITHUB_OUTPUT with --gate. Tested by test-require-current-main.sh.

set -euo pipefail

: "${DEPLOY_SHA:?DEPLOY_SHA is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
CI_WORKFLOW="${CI_WORKFLOW:-ci.yml}"

mode=enforce
case "${1:-}" in
  '') ;;
  --gate)
    mode=gate
    : "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required with --gate}"
    ;;
  *)
    echo "::error::usage: require-current-main.sh [--gate]"
    exit 1
    ;;
esac

if [[ ! "$DEPLOY_SHA" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]]; then
  echo "::error::DEPLOY_SHA must be a full lowercase Git commit ID."
  exit 1
fi

admit() {
  echo "$1"
  if [[ "$mode" == gate ]]; then echo "release=true" >>"$GITHUB_OUTPUT"; fi
  exit 0
}

refuse() {
  if [[ "$mode" == gate ]]; then
    echo "::notice::$1"
    echo "release=false" >>"$GITHUB_OUTPUT"
    exit 0
  fi
  echo "::error::Stale production release blocked: $1"
  exit 1
}

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

if [[ "$origin_main_sha" == "$DEPLOY_SHA" ]]; then
  admit "Production candidate $DEPLOY_SHA is the current origin/main head."
fi

# main moved on. The compare API, not the local clone: the deploy checks out
# two commits deep, and this must see every commit between the two.
compare="$(gh api "repos/$GITHUB_REPOSITORY/compare/$DEPLOY_SHA...$origin_main_sha" \
  --jq '.status, .total_commits, (.commits[].sha)')"
status="$(sed -n 1p <<<"$compare")"
total="$(sed -n 2p <<<"$compare")"
if [[ "$status" != ahead || ! "$total" =~ ^[0-9]+$ ]] || ((total >= 250)); then
  refuse "DEPLOY_SHA $DEPLOY_SHA is not a plain ancestor of origin/main $origin_main_sha (history '$status', $total commits)."
fi

while IFS= read -r newer; do
  [[ -z "$newer" ]] && continue
  runs="$(gh api -X GET "repos/$GITHUB_REPOSITORY/actions/workflows/$CI_WORKFLOW/runs" \
    -f head_sha="$newer" -f event=push -F per_page=20 \
    --jq '[.workflow_runs[] | select(.status != "completed" or .conclusion == "success")] | length')"
  if [[ ! "$runs" =~ ^[0-9]+$ ]]; then
    echo "::error::Could not count CI runs for $newer (got: $runs)."
    exit 1
  fi
  if ((runs > 0)); then
    refuse "newer main commit $newer has its own CI run; its release carries $DEPLOY_SHA."
  fi
  echo "Newer main commit $newer has no queued, running or successful CI run; it does not hold $DEPLOY_SHA."
done < <(sed -n '3,$p' <<<"$compare")

admit "Production candidate $DEPLOY_SHA is the newest CI-tested commit on origin/main ($origin_main_sha); no newer commit starts a release."
