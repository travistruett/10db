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

**Open Page hands 10db's own dev UI a read-only token.** 10db's dev UI is code a pass's agents may be editing,
so it never gets the app's UI token. When a dev UI origin is opted in (`TENDB_DEV_UI_ORIGIN`,
`decisions/2026-10-29-dev-ui-over-the-factory.md`), the daemon mints a second token at each start that only reads:
only the GETs named as reads, deny by default (`screens/dev-ui-access.ts`: a GET that writes, runs git, gh or another
command, or hands out this token is refused, and a test fails on a GET that is named neither way); everything else
answers 403. `/health` names the origin; `GET /dev-ui/connection` gives the token, over the app's own token only.
When the page's origin is that origin, Open Page puts the daemon's address and the dev UI token in the URL's
fragment, which the browser never sends to a server; the dev UI keeps them in the tab's session storage and removes
the fragment from the address bar. A copied link carries neither, and any other origin gets the plain address. The daemon's port moves at each start, so at
that origin Open Page opens and hands the connection over on every click, never turning to Copy Link. The
repository's server process holds no token, so 10db's preview command (`pnpm dev:preview`) serves the UI with none.
Acting (answering a card, changing a setting) is done in the 10db app.

## Why

The builder's call during the Workbench's QA: running and restarting the dev server by hand, and remembering to,
is the friction the Workbench exists to remove. §13's rule stands: nothing repository-controlled runs outside a
sandbox, which is why the command runs under the gate's sandbox rather than as the builder's own process, and why
10db's own dev UI gets a read-only token from Open Page instead of the app's token from the server it serves from:
code an agent wrote runs in that tab, and it must not be able to answer the agent's own cards. `pnpm dev:factory`
remains for running the dev UI by hand; it reads the token itself and holds it in Vite's process, which is fine for
a command the builder starts and not for one 10db starts.

Turned down: starting the preview only from a button (more steps for the common case, and the button is still
there when it gives up); restarting it without limit (a broken command would spin); handing the token to the
sandboxed command (the sandbox refuses secret-looking environment names and the data directory on purpose).
