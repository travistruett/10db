#!/usr/bin/env bash
# Fails when generated paths differ from the index: unstaged edits or deletions, or untracked
# files. Staged changes pass, so `git add <generated> && pnpm drift` succeeds before the commit.
# Usage: scripts/check-clean.sh <path>... (paths relative to the repository root)
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
unstaged=$(git diff --name-status -- "$@")
untracked=$(git ls-files --others --exclude-standard -- "$@")
if [[ -n "$unstaged" || -n "$untracked" ]]; then
  echo "Generated files are out of date. Regenerate them, then stage and commit the result:"
  if [[ -n "$unstaged" ]]; then echo "$unstaged"; fi
  if [[ -n "$untracked" ]]; then echo "$untracked" | sed 's/^/??	/'; fi
  exit 1
fi
