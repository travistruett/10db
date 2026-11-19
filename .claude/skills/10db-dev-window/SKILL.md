---
name: 10db-dev-window
description: Open the real 10db desktop window (the "10db Dev" app, Tauri) on the current checkout or worktree, loading the UI live from it, to see or QA a desktop change, check native chrome such as the traffic lights, or let the builder click through it. Use when asked to run, open or show the app, or to check a UI change in the app rather than a browser tab.
---

# 10db Dev window

`pnpm dev:window` (`scripts/dev-window.sh`) opens the 10db Dev window on this checkout. It runs beside the
installed 10db (its own identifier and name, `src-tauri/tauri.dev.conf.json`) and loads the UI from this
checkout's Vite server, so a saved edit shows at once. What it does:

- Starts the daemon and Vite (`scripts/dev.sh`) on `.dev/window-data`, apart from `pnpm dev`'s `.dev/data`.
- With no project yet, adds one, "demo", over a small repository in `.dev/window-demo`, so the window shows the
  shell rather than the first run. `--fresh` starts the data again.
- In a worktree, borrows the main checkout's sidecar, daemon bundle and Rust build, so the window opens in
  seconds. With none anywhere it says to run `pnpm --filter @10db/desktop sidecar` once.
- Stops the daemon and Vite when the window closes or on Ctrl-C.

## Running it as an agent

1. Run it in the background (`run_in_background`); it prints "Opening the 10db Dev window" once the daemon
   answers, and the shell's build lines after.
2. Only one runs at a time: it stops with a message if port 1420 or the daemon's port is taken. Stop the other
   one (a `pnpm dev`, or another worktree's window) or ask the builder.
3. Tell the builder the window is open. You cannot see or click it: never use System Events or other assistive
   access to find it, which asks the builder to let the terminal control the Mac. For your own screenshots, drive
   the same UI in a browser at `http://localhost:1420` (Playwright from `apps/desktop`), which shows everything but
   the native window chrome.
4. Close it once the work is reviewed: `pkill -f target/debug/tendb-desktop` ends the window, and the script then
   stops the rest.

Changing `src-tauri/tauri.conf.json` (the traffic lights, the window's size) takes a restart of the window; a
change to the UI does not.
