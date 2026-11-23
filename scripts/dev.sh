#!/usr/bin/env bash
# Runs the daemon from source and the Vite UI together. They share one random dev UI token, so the browser
# UI can authenticate (the Tauri window reads the daemon's own token file instead). State lives in .dev/.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .dev
token_file=.dev/ui-token
if [ ! -s "$token_file" ]; then
  (umask 077 && node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))" > "$token_file")
fi
token=$(cat "$token_file")
export TENDB_DEV_UI_TOKEN="$token" VITE_DAEMON_TOKEN="$token"
# The browser UI and the dev window both load the page from Vite on port 1420.
export TENDB_DEV_UI_ORIGIN=http://localhost:1420
# Each is off unless set: `TENDB_JUDGE=on pnpm dev:window` turns one on to see its screens.
# Only the installed app calls Artificial Analysis; this daemon restarts on every file change.
export TENDB_BENCHMARKS="${TENDB_BENCHMARKS:-off}"
# Nor does it spend the builder's OpenRouter key on decisions.
export TENDB_JUDGE="${TENDB_JUDGE:-off}"
# Nor does it message the builder's stakeholders on the Slack bot token.
export TENDB_SLACK="${TENDB_SLACK:-off}"
# `TENDB_FAKE_SLACK=on` turns Slack on against a fake one (scripts/fake-slack.mjs) with made-up workspaces:
# connect with the token xoxb-fake-acme or xoxb-fake-globex. Nothing reaches the real Slack.
if [ "${TENDB_FAKE_SLACK:-off}" = on ]; then
  fake_port="${FAKE_SLACK_PORT:-4399}"
  FAKE_SLACK_PORT="$fake_port" node scripts/fake-slack.mjs &
  export TENDB_SLACK=on TENDB_SLACK_API="http://127.0.0.1:$fake_port"
fi
export TENDB_DATA_DIR="${TENDB_DATA_DIR:-$PWD/.dev/data}"
export VITE_DAEMON_URL="${VITE_DAEMON_URL:-http://127.0.0.1:${TENDB_PORT:-4317}}"
exec pnpm -r --parallel --if-present run dev
