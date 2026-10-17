#!/usr/bin/env bash
# Manual §1.3 run against real Claude Code on the builder's subscription. Never run in CI.
# Run it from a plain terminal where `claude` is logged in to the Max plan, not from a Bedrock-billed session.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -z "${CI:-}" ] || { echo 'live-acceptance never runs in CI' >&2; exit 1; }
if env | grep -Eq '^(ANTHROPIC_|CLAUDE_CODE_USE_|AWS_)'; then
  echo "Note: this shell sets billing or cloud-provider variables. The run drops them before starting the daemon, 10db strips them from sessions and checks billing at session start;"
  echo "the run fails loudly rather than bill Bedrock or an API key."
fi
pnpm --filter @10db/daemon build
exec pnpm --filter @10db/daemon exec tsx scripts/live-acceptance.ts "$@"
