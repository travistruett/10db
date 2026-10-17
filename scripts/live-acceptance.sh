#!/usr/bin/env bash
# Manual §1.3 run against real Claude Code on the builder's subscription. Never run in CI.
# Run it from a plain terminal where `claude` is logged in to the Max plan, not from a Bedrock-billed session.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -n "${CLAUDE_CODE_USE_BEDROCK:-}" ] || [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  echo "Note: this shell sets a billing variable. 10db strips it from sessions and checks billing at session start;"
  echo "the run fails loudly rather than bill Bedrock or an API key."
fi
pnpm --filter @10db/daemon build
exec pnpm --filter @10db/daemon exec tsx scripts/live-acceptance.ts "$@"
