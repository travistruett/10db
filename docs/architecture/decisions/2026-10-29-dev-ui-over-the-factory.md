# A live dev UI can run over the factory's daemon, opted in by a loopback origin

- **Date:** 2026-10-29
- **Amends:** decision 55

## Decision

The daemon accepts browser requests only from the Tauri webview (`tauri://localhost`, `http://tauri.localhost`)
and from one origin the builder opts in with `TENDB_DEV_UI_ORIGIN`. `http://localhost:1420` is no longer built in:
`scripts/dev.sh`, the live acceptance daemon and the E2E run each set the variable for their own daemon, and
`tests/repo/src/dev-ui-origin.test.ts` checks the first two do.

`src/env.ts` accepts exactly `http://localhost:<port>`, `http://127.0.0.1:<port>` or `http://[::1]:<port>`, with a
port from 1 to 65535 and nothing after it: no path, slash, query, fragment, credentials, other host, other scheme,
upper case or second origin. Anything else is an `EnvError` naming the variable, never its value, and the daemon
exits 4 at startup, which the desktop supervisor doesn't restart into. The origin is used as both the CORS allow-list
entry and the event stream's WebSocket origin check. It is not a credential: every request from it still needs the
UI token.

The desktop supervisor no longer strips `TENDB_DEV_UI_ORIGIN` from the sidecar's environment; the other dev and test
variables of decision 55 (`TENDB_DEV_UI_TOKEN`, `TENDB_FAKE_SCRIPTS`, `TENDB_LIVE_CLAUDE`, `TENDB_SQLITE_BINDING`)
are still stripped. The builder opts the installed app in for one launch: quit 10db, then
`open -a 10db --env TENDB_DEV_UI_ORIGIN=http://localhost:1420`. The setting lasts until 10db quits.

`pnpm dev:factory` (`apps/desktop/scripts/factory-ui.ts`) serves the checkout's UI with hot reload over that daemon.
It starts no daemon. It reads the port and UI token the installed app's daemon wrote to
`~/Library/Application Support/10db` (`daemon.json`, `ui-token`), asks `/health` whether that daemon answers the
Vite origin over CORS, and stops with the `open --env` command when it doesn't. Otherwise it runs Vite with
`VITE_DAEMON_URL` and `VITE_DAEMON_TOKEN`. The dev window can join it:
`TENDB_DATA_DIR="$HOME/Library/Application Support/10db" pnpm --filter @10db/desktop dev:shell` reads the same files
on every connect, so it follows a daemon restart where the browser tab needs `pnpm dev:factory` run again.

## Why

UI work previewed only `.dev/data`, which holds none of the builder's projects or Inbox, so a view could only be
judged on the builder's real data after a release. The approval set two limits: opt-in and loopback only.

Opt-in: the built-in `http://localhost:1420` let any page served on that port reach the installed app's daemon over
CORS without the builder asking for it; the token was the only barrier. Now no browser origin reaches a daemon
unless whoever started it named one. Loopback only: the variable admits no host but the three loopback spellings a
browser sends in `Origin`, in exactly the form it sends them, so a typo is refused at startup rather than becoming an
origin that silently never matches or matches too much.

Decision 55 stripped the variable so a value set in the shell's environment couldn't reach the packaged daemon by
accident. A Dock or Finder launch doesn't inherit a shell's environment, so reaching the sidecar takes `open --env`,
`launchctl setenv` or starting the app's binary from a terminal: all deliberate. The value is checked as above and
grants no access without the token, which only the builder's account can read (`ui-token` is 0600).

Turned down:

- A second variable for the installed app (a `TENDB_DEV_ORIGIN` beside `TENDB_DEV_UI_ORIGIN`): two names for the same
  allow-list entry, with the same check, invite setting the wrong one.
- A persisted setting (a file in the data dir, or a Settings toggle): it outlives the work it was turned on for. The
  `open --env` opt-in ends when 10db quits.
- A fixed token for the installed app, as `TENDB_DEV_UI_TOKEN` gives a dev daemon: a token that doesn't change is a
  standing credential. The dev side reads the daemon's own per-start token instead.
- Serving the token to the browser from the Vite server so a tab follows a daemon restart: any page that could reach
  that endpoint would get the token. Rerunning `pnpm dev:factory` is cheap.

The UI served this way acts on real data: it can start, move and remove the builder's tasks. A UI change that needs a
daemon change can't be previewed this way, because the installed daemon is the release's; the UI shows its
version-mismatch state when the protocol versions differ.
