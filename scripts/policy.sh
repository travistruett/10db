#!/usr/bin/env bash
# CI twin of the local git hooks, for a range of commits: gitleaks over the range, the staged-file
# hygiene check over the files it changed, then actionlint and zizmor over the workflows.
# Usage: scripts/policy.sh <base-sha> <head-sha>. An empty or all-zero base (a branch's first push)
# scans all of head's history. Run from the repository root.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
base=${1:-}
head=${2:?usage: scripts/policy.sh <base-sha> <head-sha>}

# gitleaks exits 0 on a range git can't resolve, so resolve both ends first.
git rev-parse --verify --quiet "$head^{commit}" > /dev/null || { echo "policy: unknown head commit $head"; exit 1; }
if [[ -z "$base" || "$base" =~ ^0+$ ]]; then
  range=$head
  diff_range=("$(git hash-object -t tree /dev/null)" "$head")
else
  git rev-parse --verify --quiet "$base^{commit}" > /dev/null || { echo "policy: unknown base commit $base; fetch full history"; exit 1; }
  range="$base..$head"
  # Three dots: only what head changed since it left base. A pull request is checked out merged
  # into a base that may have moved on, and files the base deleted since then are gone from that
  # checkout, so a plain base..head diff would list them as added.
  diff_range=("$base...$head")
fi

gitleaks git --no-banner --redact --log-opts="$range" .
git diff -z --name-only --diff-filter=ACMR "${diff_range[@]}" | xargs -0 -r node "$here/hooks/hygiene.mjs"
actionlint
zizmor --offline .github/workflows
echo "POLICY PASS"
