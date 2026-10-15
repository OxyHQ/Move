#!/usr/bin/env bash
# Fixture tests for require-current-main.sh. A throwaway repository with a bare
# `origin` stands in for the checkout, and `gh` is a stub on PATH that answers
# the compare and CI-runs endpoints from FAKE_* variables (already in the shape
# the real `--jq` filter prints). Every decision is driven both ways, the
# refusals first: those are what keep an older rollout off a newer one.

set -euo pipefail

script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/require-current-main.sh"
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT

mkdir "$work/bin"
cat >"$work/bin/gh" <<'STUB'
#!/usr/bin/env bash
args="$*"
case "$args" in
  *"/compare/"*)
    [[ "${FAKE_FAIL_COMPARE:-}" == 1 ]] && exit 1
    printf '%s\n' "$FAKE_COMPARE" ;;
  *"/actions/workflows/"*"/runs"*)
    [[ "${FAKE_FAIL_RUNS:-}" == 1 ]] && exit 1
    sha="$(grep -oE 'head_sha=[0-9a-f]{40}' <<<"$args" | cut -d= -f2)"
    if [[ " ${FAKE_CI_RUNS_FOR:-} " == *" $sha "* ]]; then echo 1; else echo 0; fi ;;
  *) echo "unexpected gh call: $args" >&2; exit 2 ;;
esac
STUB
chmod +x "$work/bin/gh"

git init -q --bare "$work/origin.git"
git init -q -b main "$work/repo"
cd "$work/repo"
git config user.email test@example.invalid
git config user.name test
git remote add origin "$work/origin.git"
for n in 1 2 3; do
  git commit -q --allow-empty -m "c$n"
done
c1="$(git rev-parse HEAD~2)"
c2="$(git rev-parse HEAD~1)"
c3="$(git rev-parse HEAD)"
git push -q origin main

failures=0
# run <expected exit> <expected GITHUB_OUTPUT line or ''> <checked-out sha> <env...> -- <args...>
run() {
  local want_rc="$1" want_line="$2" head="$3"
  shift 3
  local -a env=()
  while [[ "$1" != -- ]]; do
    env+=("$1")
    shift
  done
  shift
  git checkout -q --detach "$head"
  local output="$work/output" rc=0
  : >"$output"
  env PATH="$work/bin:$PATH" DEPLOY_SHA="$head" GITHUB_REPOSITORY=OxyHQ/Move \
    GITHUB_OUTPUT="$output" GH_TOKEN=x "${env[@]}" \
    bash "$script" "$@" >"$work/log" 2>&1 || rc=$?
  if [[ "$rc" != "$want_rc" ]] || { [[ -n "$want_line" ]] && ! grep -qxF "$want_line" "$output"; } ||
    { [[ -z "$want_line" ]] && [[ -s "$output" ]]; }; then
    echo "FAIL: $* (${env[*]}): exit $rc, output: $(tr '\n' ' ' <"$output")"
    sed 's/^/    /' "$work/log"
    failures=$((failures + 1))
  fi
}

newer_two="$(printf 'ahead\n2\n%s\n%s' "$c2" "$c3")"

# main's head: admitted in both modes.
run 0 '' "$c3" --
run 0 release=true "$c3" -- --gate

# A newer commit has its own CI run: refused (enforce) / held (gate).
run 1 '' "$c1" "FAKE_COMPARE=$newer_two" FAKE_CI_RUNS_FOR="$c3" --
run 0 release=false "$c1" "FAKE_COMPARE=$newer_two" FAKE_CI_RUNS_FOR="$c3" -- --gate
run 0 release=false "$c1" "FAKE_COMPARE=$newer_two" FAKE_CI_RUNS_FOR="$c2" -- --gate

# Every newer commit started no CI (an auto-merge, [skip ci], a red run): the
# older commit is the newest CI-tested one, and is admitted.
run 0 '' "$c1" "FAKE_COMPARE=$newer_two" --
run 0 release=true "$c1" "FAKE_COMPARE=$newer_two" -- --gate

# History that cannot be proven a plain descendant: refused / held.
run 1 '' "$c1" "FAKE_COMPARE=$(printf 'diverged\n1\n%s' "$c3")" --
run 0 release=false "$c1" "FAKE_COMPARE=$(printf 'diverged\n1\n%s' "$c3")" -- --gate
run 0 release=false "$c1" "FAKE_COMPARE=$(printf 'ahead\n250\n%s' "$c3")" -- --gate

# Errors fail in both modes: an API failure is never read as "no CI run".
run 1 '' "$c1" FAKE_FAIL_COMPARE=1 -- --gate
run 1 '' "$c1" "FAKE_COMPARE=$newer_two" FAKE_FAIL_RUNS=1 -- --gate
run 1 '' "$c1" "FAKE_COMPARE=$newer_two" FAKE_FAIL_RUNS=1 --

# The checkout must be DEPLOY_SHA, and DEPLOY_SHA a full commit id.
git checkout -q --detach "$c2"
rc=0
env PATH="$work/bin:$PATH" DEPLOY_SHA="$c3" GITHUB_REPOSITORY=OxyHQ/Move GITHUB_OUTPUT="$work/output" \
  bash "$script" --gate >"$work/log" 2>&1 || rc=$?
if [[ "$rc" != 1 ]]; then
  echo "FAIL: a checkout that differs from DEPLOY_SHA was not refused (exit $rc)"
  failures=$((failures + 1))
fi
run 1 '' "$c3" DEPLOY_SHA=main -- --gate
run 1 '' "$c3" -- --sideways

if ((failures > 0)); then
  echo "test-require-current-main: $failures case(s) failed"
  exit 1
fi
echo "test-require-current-main: OK"
