# 10db runs the project's preview while a pass is open

- **Date:** 2026-11-11
- **Amends:** `docs/superpowers/specs/2026-11-09-10db-workbench-design.md` §8.2 ("10db does not start or restart
  the builder's dev server. It is the builder's own process.") and §10 (the project's fields)

## Decision

A project may name a **preview command** (Project Settings › General, under App address; `projects.preview_command`):
the command that serves its app at its app address. Empty, nothing changes: the builder runs the dev server.

**10db runs it, under the gate's sandbox.** The daemon's preview module (`apps/daemon/src/preview/`) starts the
command in the project's folder through the unslotted gate runner, as the dev login runs
(`pictures/sign-in.ts`): the same Seatbelt profile, the same protected reads (the data directory and its UI
token among them) and the same env allowlist, with no timeout of its own and an abort signal that kills its
process group. Serving needs the sandbox's loopback (the project's Allow loopback); without it the module starts
nothing and says so. The process tree goes in a process ledger, as the pictures browser's does
(`pictures/browser-ledger.ts`), so a daemon that dies leaves it for the next start to reap.

**When it runs:**

- It starts when a pass of the project opens, when the daemon starts with one open, and when a picture finds
  nothing answering at the app address; each time only if nothing answers there already. A dev server the builder
  started is left alone.
- It stops when the project has no open pass any more (closed, abandoned), when its command is changed or
  cleared, and when the daemon stops.
- It restarts by itself when it exits while wanted, at most 3 times in 10 minutes; after that it stays stopped.

**What the builder sees** is the pass header, and only when something needs a look: "Starting the preview" while it
comes up (cleared once the app answers), and "The preview stopped", with its last output and **Restart Preview**,
when it gave up or could not start. A preview that runs says nothing. With a preview command set, a picture that
finds nothing answering raises no "Nothing answers" notice (`pictures/preview-marks.ts`): the module starts the
preview instead.

**Open Page hands 10db's own dev UI its connection.** When the page's origin is the dev UI origin the builder opted
into (`TENDB_DEV_UI_ORIGIN`, `decisions/2026-10-29-dev-ui-over-the-factory.md`), Open Page puts the daemon's address
and UI token in the URL's fragment, which the browser never sends to a server. The dev UI takes them from there,
keeps them in the tab's session storage and removes the fragment from the address bar. The repository's server
process never holds the token, so 10db's preview command (`pnpm dev:preview`) serves the UI with none. Any other
origin gets the plain address.

## Why

The builder's call during the Workbench's QA: running and restarting the dev server by hand, and remembering to,
is the friction the Workbench exists to remove. §13's rule stands: nothing repository-controlled runs outside a
sandbox, which is why the command runs under the gate's sandbox rather than as the builder's own process, and why
10db's own dev UI gets its token from Open Page instead of from the server it serves from. `pnpm dev:factory`
remains for running the dev UI by hand; it reads the token itself and holds it in Vite's process, which is fine for
a command the builder starts and not for one 10db starts.

Turned down: starting the preview only from a button (more steps for the common case, and the button is still
there when it gives up); restarting it without limit (a broken command would spin); handing the token to the
sandboxed command (the sandbox refuses secret-looking environment names and the data directory on purpose).
