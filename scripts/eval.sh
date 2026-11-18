#!/usr/bin/env bash
# Replays the lane-pipeline eval set at one rigor and writes its report (apps/daemon/scripts/eval/AGENTS.md).
# A real run starts real sessions on the default Claude account and spends usage, so it never runs in CI;
# AGENT=fake proves the plumbing without either.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${RIGOR:?Set RIGOR to light, standard, careful or critical}"
AGENT="${AGENT:-claude}"
if [ "$AGENT" != fake ] && [ -n "${CI:-}" ]; then
  echo 'A real eval run never runs in CI; use AGENT=fake' >&2
  exit 1
fi
exec pnpm --filter @10db/daemon exec tsx scripts/eval.ts \
  "--rigor=$RIGOR" "--agent=$AGENT" "--cases=${CASES:-}" "--save-baseline=${SAVE_BASELINE:-0}" \
  "--plans-in-build=${PLANS_IN_BUILD:-}" "--fix-by=${FIX_BY:-}" "--brief=${BRIEF:-}"
