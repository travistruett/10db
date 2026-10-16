#!/usr/bin/env bash
# Fast focused check: typecheck everything (TypeScript 7 is fast), then lint and test only what
# changed since the branch left its base, including uncommitted and untracked files. The base is
# the merge-base with the upstream branch (what a push would add), else origin/main, else main,
# else HEAD. Diffing against HEAD alone would see nothing at pre-push time, when the tree is clean.
# Runs on macOS /bin/bash 3.2: no mapfile.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

base=HEAD
for ref in '@{upstream}' origin/main main; do
  if git rev-parse --verify --quiet "$ref^{commit}" > /dev/null; then
    if found=$(git merge-base HEAD "$ref" 2> /dev/null); then
      base=$found
      break
    fi
  fi
done

pnpm -s typecheck
changed=()
while IFS= read -r file; do
  changed+=("$file")
done < <({ git diff --name-only --diff-filter=d "$base"; git ls-files --others --exclude-standard; } | grep -E '\.(ts|tsx|js|mjs|cjs)$' | sort -u || true)
if ((${#changed[@]} > 0)); then
  # Changed files can match an ESLint ignore (fixtures, spikes); skip them instead of warning.
  pnpm -s exec eslint --cache --max-warnings=0 --no-warn-ignored "${changed[@]}"
fi
# --passWithNoTests is defensive: vitest exits 0 when --changed finds nothing, but a future
# version should not turn a change with no affected tests into a failed push.
pnpm -s exec vitest run --changed "$base" --passWithNoTests
echo "CHECK PASS"
