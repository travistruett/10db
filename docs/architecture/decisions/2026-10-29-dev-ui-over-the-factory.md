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
are still stripped.

The builder turns the opt-in on with `pnpm dev:factory:enable`, which runs
`launchctl setenv TENDB_DEV_UI_ORIGIN http://localhost:1420`, and off with `pnpm dev:factory:disable`
(`launchctl unsetenv TENDB_DEV_UI_ORIGIN`), the way `OLLAMA_ORIGINS` is set for Ollama's app
(`apps/desktop/scripts/set-factory-opt-in.ts`, plan in `factory-opt-in.ts`). Both print the next step, quit 10db and
open it again, and never quit or open 10db themselves, because quitting stops running work. The value is in launchd's
user environment, which every app opened from the Dock, Finder or Spotlight starts with, until the Mac restarts. On
any platform but macOS both run nothing and say the installed app is macOS only.

`pnpm dev:factory` (`apps/desktop/scripts/factory-ui.ts`) serves the checkout's UI with hot reload over that daemon.
It starts no daemon. It reads the port and UI token the installed app's daemon wrote to
`~/Library/Application Support/10db` (`daemon.json`, `ui-token`), asks `/health` whether that daemon answers the
Vite origin over CORS, and when it doesn't, stops with the two steps: `pnpm dev:factory:enable`, then quit and reopen
10db. Otherwise it runs Vite with
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
accident. A Dock or Finder launch doesn't inherit a shell's environment, so reaching the sidecar takes
`launchctl setenv`, `open --env` or starting the app's binary from a terminal: all deliberate. The value is checked as
above and grants no access without the token, which only the builder's account can read (`ui-token` is 0600).

`launchctl setenv` was checked on macOS 15.7 (Darwin 24): after `launchctl setenv TENDB_ENV_PROBE …`, a bundle opened
through LaunchServices (`open`, the path the Dock, Finder and Spotlight take), whose parent was `launchd`, had the
variable in its environment, though the shell that ran `open` didn't; after `launchctl unsetenv` the next launch
didn't. The 10db bundle sets no `LSEnvironment`, and the supervisor's command inherits the shell's environment less the
stripped variables, so the value reaches the sidecar.

`launchctl setenv` was chosen over `open -a 10db --env …`: one command to remember, it survives quitting and
reopening 10db however it is opened, and `pnpm dev:factory:disable` turns it off. A restart clears it, which keeps it
from becoming a standing setting.

Turned down:

- A second variable for the installed app (a `TENDB_DEV_ORIGIN` beside `TENDB_DEV_UI_ORIGIN`): two names for the same
  allow-list entry, with the same check, invite setting the wrong one.
- A persisted setting (a file in the data dir, or a Settings toggle): it outlives the work it was turned on for; the
  launchd value ends at the next restart. Needed only if `launchctl setenv` stops reaching apps.
- A fixed token for the installed app, as `TENDB_DEV_UI_TOKEN` gives a dev daemon: a token that doesn't change is a
  standing credential. The dev side reads the daemon's own per-start token instead.
- Serving the token to the browser from the Vite server so a tab follows a daemon restart: any page that could reach
  that endpoint would get the token. Rerunning `pnpm dev:factory` is cheap.

The UI served this way acts on real data: it can start, move and remove the builder's tasks. A UI change that needs a
daemon change can't be previewed this way, because the installed daemon is the release's; the UI shows its
version-mismatch state when the protocol versions differ.
