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
# Only the installed app calls Artificial Analysis; this daemon restarts on every file change.
export TENDB_BENCHMARKS=off
export TENDB_DATA_DIR="${TENDB_DATA_DIR:-$PWD/.dev/data}"
export VITE_DAEMON_URL="${VITE_DAEMON_URL:-http://127.0.0.1:${TENDB_PORT:-4317}}"
exec pnpm -r --parallel --if-present run dev
