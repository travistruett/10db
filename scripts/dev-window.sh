#!/usr/bin/env bash
# Opens the 10db Dev window on this checkout: the daemon and Vite from scripts/dev.sh, then the Tauri shell
# (`dev:shell`) against them. The window loads the UI live from this checkout, so edits show as they are saved.
# State lives in .dev/window-data, apart from `pnpm dev`'s .dev/data; --fresh starts it again. With no project
# yet it adds one, "demo", over a small repository in .dev/window-demo, so the shell shows past the first run.
# Closing the window, or Ctrl-C, stops everything this started.
set -euo pipefail
set -m # Each background job gets its own process group, so the cleanup stops all of it.

root=$(git rev-parse --show-toplevel)
cd "$root"
data="$root/.dev/window-data"
demo="$root/.dev/window-demo"
log="$root/.dev/window.log"
port="${TENDB_PORT:-4317}"

if [ "${1:-}" = "--fresh" ]; then rm -rf "$data" "$demo"; fi

for busy in 1420 "$port"; do
  if lsof -iTCP:"$busy" -sTCP:LISTEN -P >/dev/null 2>&1; then
    echo "Port $busy is in use: another pnpm dev or dev window is running. Stop it first; only one runs at a time." >&2
    exit 1
  fi
done

# The shell's build checks for the sidecar and the daemon bundle, which git ignores. A worktree borrows the
# main checkout's, and its Rust build too, so the first build takes seconds rather than minutes.
main=$(git worktree list --porcelain | sed -n '1s/^worktree //p')
tauri="$root/apps/desktop/src-tauri"
for part in binaries resources; do
  if [ ! -d "$tauri/$part" ]; then
    if [ -d "$main/apps/desktop/src-tauri/$part" ]; then
      cp -R "$main/apps/desktop/src-tauri/$part" "$tauri/$part"
    else
      echo "No src-tauri/$part here or in $main. Run: pnpm --filter @10db/desktop sidecar" >&2
      exit 1
    fi
  fi
done
if [ -z "${CARGO_TARGET_DIR:-}" ] && [ -d "$main/apps/desktop/src-tauri/target" ]; then
  export CARGO_TARGET_DIR="$main/apps/desktop/src-tauri/target"
fi

mkdir -p "$root/.dev"
export TENDB_DATA_DIR="$data"
bash scripts/dev.sh >"$log" 2>&1 &
servers=$!
stop() {
  kill -TERM -- "-$servers" 2>/dev/null || true
}
trap stop EXIT INT TERM

echo "Starting the daemon and Vite (log: $log)…"
for _ in $(seq 1 90); do
  if curl -sf -o /dev/null "http://127.0.0.1:$port/health"; then break; fi
  if ! kill -0 "$servers" 2>/dev/null; then
    echo "The daemon stopped. Its log:" >&2
    tail -20 "$log" >&2
    exit 1
  fi
  sleep 1
done
curl -sf -o /dev/null "http://127.0.0.1:$port/health" || {
  echo "The daemon did not answer within 90 s. Its log: $log" >&2
  exit 1
}

token=$(cat "$root/.dev/ui-token")
projects=$(curl -sf "http://127.0.0.1:$port/projects" -H "Authorization: Bearer $token")
if [ "$projects" = "[]" ]; then
  mkdir -p "$demo"
  if [ ! -d "$demo/.git" ]; then
    git -C "$demo" init -q -b main
    git -C "$demo" config maintenance.auto false
    git -C "$demo" config gc.auto 0
    echo "A demo project for the 10db Dev window." >"$demo/README.md"
    git -C "$demo" add README.md
    git -C "$demo" -c user.name=10db -c user.email=demo@10db.invalid commit -qm 'chore: start the demo'
  fi
  curl -sf -o /dev/null -X POST "http://127.0.0.1:$port/projects" \
    -H "Authorization: Bearer $token" -H 'content-type: application/json' \
    -d "{\"name\":\"demo\",\"repoPath\":\"$demo\",\"gateCommand\":\"true\",\"areas\":[{\"name\":\"docs\",\"globs\":[\"**\"]}],\"handoffPct\":40,\"nudgePct\":50,\"delivery\":\"pull_request\",\"workspaceMode\":\"shared\"}"
  echo "Added the demo project."
fi

echo "Opening the 10db Dev window. Close it, or press Ctrl-C, to stop."
pnpm --filter @10db/desktop dev:shell
