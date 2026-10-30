# apps/desktop

The 10db window: React 19 + Mantine 9 UI built by Vite, inside a Tauri 2 shell (`src-tauri/`).
The UI never touches the database; it talks to the daemon over loopback HTTP and WebSocket.

- Daemon calls go through `src/daemon/client.ts` (Hono typed client over `AppType`). Never
  hand-write a fetch to the daemon. Parse every response with its `@10db/contracts` schema via `readJson`.
- The UI gets its daemon connection from `DaemonProvider` (Tauri `daemon_connection`, or
  `VITE_DAEMON_URL`/`VITE_DAEMON_TOKEN` in the browser); it also polls `/health` and owns the connecting,
  reconnecting and version-mismatch states. Use `useDaemon()` and the hooks in `src/daemon/queries.ts`.
- One event stream (`useEventStream`) invalidates queries by entity type (`INVALIDATIONS`). Don't poll lists.
- `pnpm dev` (`scripts/dev.sh`) shares one random token, kept in `.dev/ui-token`, between the daemon and Vite.
- MSW 3 intercepts jsdom's `WebSocket` as is; no extra environment option is needed.
- Hooks, query keys and fixtures are scoped per backend entity (`daemon/<entity>-queries.ts`, `test/<entity>-fixtures.ts`), accounts first. An account secret is sent by `daemon/account-secret.ts`, never through TanStack Query, and never kept in UI state.
- Server state lives in TanStack Query; routes are code-based TanStack Router in `src/router.tsx`.
- Mantine components and theme tokens only; see `DESIGN.md`. Use the Mantine MCP server for
  component docs (pinned to our Mantine version).
- Dark by default; every view must work in light mode too.
- The React Compiler is on; don't hand-write `useMemo`/`useCallback` for render performance.
- Tests: Testing Library + MSW. Hit the daemon URL through MSW, never a real daemon.
- Rust in `src-tauri/`: `cargo fmt`, `cargo clippy -- -D warnings` with pedantic lints.
- The app icon's source is `app-icon.svg` ("10" in Geist Bold, "db" in Geist Light, outlined to paths).
  `src-tauri/icons/` is generated from it with `pnpm --filter @10db/desktop tauri icon app-icon.svg`;
  never edit those files by hand.
- The menu-bar icon is `tray-icon.svg`, the same wordmark in black with no tile. It ships as a template
  image, which macOS tints to match the menu bar. `src-tauri/tray-icon.png` is generated from it with
  `pnpm --filter @10db/desktop exec tsx scripts/render-tray-icon.ts`; never edit the PNG by hand.
- The window has no title bar (`titleBarStyle: Overlay`): the traffic lights sit over the header's left
  end, `trafficLightPosition` centres them on its 48 px height, and elements marked
  `data-tauri-drag-region` move the window. The native window's theme follows the app's color scheme
  (`setWindowTheme`), not the system's.
- `pnpm --filter @10db/desktop dev:shell` runs the Tauri shell against the daemon and Vite server that
  `pnpm dev` already runs. It sets `TENDB_EXTERNAL_DAEMON=1`, which makes the shell skip its sidecar.
  Run `pnpm --filter @10db/desktop sidecar` once first: `tauri-build` checks the sidecar files exist.
  `src-tauri/tauri.dev.conf.json` (passed by `dev:shell` only, never by a release build) gives that shell its own
  identifier (`app.10db.desktop.dev`) and product name ("10db Dev"), so it runs beside the installed release app
  instead of being folded into it by the single-instance plugin. `dev:shell` also defaults `TENDB_DATA_DIR` to the
  checkout's `.dev/data`, so the dev window never reads the release app's `~/Library/Application Support/10db`.
  The data directory comes from `TENDB_DATA_DIR`, not from the identifier. `tests/repo` fails if the two configs
  share an identifier or product name.
- Factory and preview: the installed release app is the factory; it manages the 10db repo and runs its tasks.
  `pnpm dev` (its own `.dev/data`) with `dev:shell` or http://localhost:1420 is the preview: it renders the
  checkout with live reload and never runs tasks. While a task holds the checkout (Your folder / shared mode),
  don't hand-edit it; work in a worktree under `../10db-worktrees/`.
- `pnpm dev:factory` (`scripts/factory-ui.ts`) runs Vite over the installed app's daemon instead: it reads that
  daemon's `daemon.json` and `ui-token` from `~/Library/Application Support/10db`, checks over `/health` that it
  answers the Vite origin over CORS and takes the token (`GET /projects`), and runs Vite with `--no-cors` and
  `VITE_DAEMON_URL` and `VITE_DAEMON_TOKEN` (`factory-vite.ts`): CORS off keeps other localhost pages from reading the
  module that inlines the token. The daemon accepts
  the page only when 10db started with `TENDB_DEV_UI_ORIGIN=http://localhost:1420`, which the supervisor passes
  through (`decisions/2026-10-29-dev-ui-over-the-factory.md`). `pnpm dev:factory:enable` and `:disable`
  (`scripts/set-factory-opt-in.ts`, plan in `factory-opt-in.ts`) set and unset it with `launchctl`; they never quit
  or open 10db, because quitting stops running work. `scripts/*.test.ts` run in node, in their own vitest project
  (`scripts/vitest.config.ts`).
- `pnpm --filter @10db/desktop e2e` drives the Vite app in Playwright's WebKit, the WKWebView engine,
  against the real daemon on the fake adapter. It is not the Tauri window. `make live-acceptance` runs the daemon as a plain node process with the browser UI, so the Tauri window (sidecar, tray, close-to-tray, webview) has no scripted coverage and is checked by hand.
  `make setup` installs the browser. Each run picks free ports for its daemon and Vite server
  (`e2e/ports.ts`) and passes the Vite origin to the daemon as `TENDB_DEV_UI_ORIGIN`, so parallel
  gates don't share fixed ports. The ports are probed free on 127.0.0.1 and released before the
  servers bind them, so another process can take one in between; the run then fails at startup
  (`reuseExistingServer: false`, Vite's `--strictPort`) rather than reaching another server. Set
  `E2E_DAEMON_PORT` and `E2E_UI_PORT` to fix them while debugging.
  `pnpm dev` and the Tauri shell keep Vite on 1420.
- The board (`views/board/`) has human columns (parked tasks, never started) left of the derived system columns. `drop-rules.ts` holds the drag rules and the card menu's equivalent moves; both call `POST /tasks/:taskId/move` or `POST /tasks/:taskId/start`. jsdom can't drive dnd-kit's sensors (no layout): unit tests move cards through the menu, and `e2e/loop.spec.ts` drives a keyboard drag in WebKit. The whole card is the drag handle and the one `role="button"` (click or Enter opens `TaskDrawer`, Space picks it up); its menu and a shipped card's pull request link are siblings laid over it, because a button can't hold another control; Enter opens the drawer only when no drag is under way.
- The board's batch sheet (`views/board/batch/`) starts work as the project's delivery mode and current batch allow: in a pull-request project one `POST /projects/:id/batches` (it starts, joins or reopens the batch), in a local one a `POST /tasks/:id/start` per task. A worktree-mode project (`workspaceMode`) always sends the request as new work, which answers one batch per task or per dependency-linked group; its "Add a fix task" (in the task drawer's `BatchPanel`) posts the batch id to join that batch.
- A task's state is said once, on its card (`task-state.ts`: one plain line and a DESIGN.md color; the card's border and dot take the color, a card waiting on the builder gets a 2 px yellow border). The branch, pull request, why a ship failed (with the gate log), Retry, Ship anyway, Add a fix task and Abandon live in the task drawer (`batch-panel.tsx`); the card menu has Retry and Abandon too. A `BatchStrip` is one slim line (branch, task count, Abandon) and appears above the columns only for a batch several tasks share (`sharedBatches`); one task alone shows nothing above the columns. The strips sit in a scroll area capped at a third of the board's height, so the columns keep their minimum height. Batch history is not on the Board: Factory lists every batch with its pull request (`factory/batch-history.tsx`). The app shell's main area is a flex column, and the Board takes the height the system alerts above it leave (never a fixed viewport height); when the strips and the columns' minimum exceed the window, the page scrolls. Each card's menu keeps its own Start.
- Hold (`task-hold.ts`, `POST /tasks/:taskId/hold`): a started task whose run is queued and has not run has Hold in its card menu and drawer; the run becomes `HELD`, sits in Blocked as "Held: not in the queue" and keeps its worktree. Every other live run shows Hold disabled with why ("<task> is running: cancel it in Factory first"). A held task's menu and drawer offer Start (`POST /tasks/:taskId/start` queues the same run again) and Remove (`POST /tasks/:taskId/remove`, which deletes its worktree and branch when nothing else is in its batch); `decisions/2026-10-29-hold-a-queued-task.md`.
- The Inbox (`views/inbox/`) shows one row per card, except that identical dismissable flags (same project, title and body, no options) share a row with a count (`inbox-rows.ts`). A collapsed flag shows its body's first line and a Dismiss. Its keys are in `use-inbox-keys.ts` and the list the ? button opens is in `inbox-shortcuts.tsx`; change both together.
- A `check` card in the Inbox (`views/inbox/`) is the builder's check of finished work in a project with no gate command (`decisions/2026-10-28-optional-gate.md`): it loads the task's changes from `GET /workstreams/:id/changes` and answers Approve, or Send Back with a required note. The board shows the waiting task as Blocked.
- Settings (`views/settings/`) is one route over `sections.ts`. To fill a planned section, set its `planned` to null and replace its arm in `section-body.tsx`.
- The first run (`views/first-run/`) replaces the app shell while `GET /projects` has loaded empty on a live connection (`shell/app-layout.tsx`); while the list loads, or the daemon connects or reconnects, the shell shows. Its three steps are Welcome, Check your setup (`use-setup-check.ts`, rows in `claude-row.ts` and `tool-rows.ts`) and Add a project. The Claude Code login probe starts Claude Code, so it runs once on entering the check and on each Agents recheck, never on a render; nothing in the first run patches the default account (a login added with Add Another Login is a new account, edited like any other).
- `views/project-setup/` is the one project form: `useProjectSetup` serves the first run and the switcher's New Project modal (`shell/new-project-modal.tsx`). The folder is chosen in the native panel (`desktop/choose-folder.ts`) or typed in the browser, then inspected by `POST /folders/inspect`; the fields appear only after a folder passes. Setup then asks `POST /folders/propose-areas` for the folder's areas, which the builder renames, merges, removes and adds to (`area-drafts.ts`), and sends exactly those, handoff 40, with nudge 50, and nothing else; Settings holds the rest. When no proposal comes, the areas start from one `repo` area over `WHOLE_REPOSITORY_GLOBS` (`@10db/contracts`).
- Tests that need the native panel answer Tauri's IPC (`mockIPC` for `plugin:dialog|open`) rather than mocking `choose-folder`: the test setup imports the app, so a module mock registers after the real module loaded.
- `e2e/worktree-board.spec.ts` (runs after `loop.spec.ts`) checks in WebKit, at 1440x900 and 1280x720, that the board's columns keep their minimum height with three open batches. Starting a real worktree batch needs a GitHub origin and a signed-in gh, so `apps/daemon/scripts/seed-worktree-batches.ts` writes the batches and workstreams into the idle daemon's database; it is the one place a process other than the daemon writes the database. `E2E_SCREENSHOT_DIR` makes the spec save a full-window screenshot per size.
- `e2e/loop.spec.ts` creates its project through `POST /projects` before opening the page, because a window with no project opens on the first run; `e2e/first-run.spec.ts` runs first (one worker, name order), scans the three first-run steps with axe in dark and light, and creates nothing.
- The Inbox keys (`use-inbox-keys.ts`) ignore anything inside `data-inbox-keys-ignore`, and a check card is answered with its own buttons, never the digits or Enter.
- Settings › Network hosts (`views/settings/network-hosts-section.tsx`) lists, adds and removes a project's allowed hosts through `/projects/:id/network-hosts`; the daemon's refusal text is shown beside Add Host (`decisions/2026-10-29-project-network-hosts.md`).
