# apps/desktop

The 10db window: React 19 + Mantine 9 UI built by Vite, inside a Tauri 2 shell (`src-tauri/`).
The UI never touches the database; it talks to the daemon over loopback HTTP and WebSocket. The daemon's share listener, behind `tailscale serve`, is for other devices'
tokens; the app still uses the main listener.

- Daemon calls go through `src/daemon/client.ts` (Hono typed client over `AppType`). Never
  hand-write a fetch to the daemon. Parse every response with its `@10db/contracts` schema via `readJson`.
- The UI gets its daemon connection from `DaemonProvider` (Tauri `daemon_connection`, or
  `VITE_DAEMON_URL`/`VITE_DAEMON_TOKEN` in the browser); it also polls `/health` and owns the connecting,
  reconnecting and version-mismatch states. Use `useDaemon()` and the hooks in `src/daemon/queries.ts`.
- One event stream (`useEventStream`) invalidates queries by entity type (`INVALIDATIONS`). Don't poll lists.
- `pnpm dev:preview` serves the UI with no token for 10db to run as 10db's own preview command, under the gate's
  sandbox; Open Page hands a tab at the daemon's dev UI origin (`/health`'s `devUiOrigin`) the daemon's address and
  its read-only dev UI token (`GET /dev-ui/connection`; never the app's own token) in the URL's fragment (`daemon/dev-ui-handoff.ts`), which `resolveConnection` keeps in the tab's session storage and
  drops from the address. A copied link never carries it
  (`decisions/2026-11-11-10db-runs-the-preview-while-a-pass-is-open.md`).
- `pnpm dev` (`scripts/dev.sh`) shares one random token, kept in `.dev/ui-token`, between the daemon and Vite.
- `pnpm dev` and `pnpm dev:factory` serve the UI from Vite, which has no CSP of its own; `vite.config.ts` sends the
  window's `img-src` (read from `src-tauri/tauri.conf.json` by `window-csp.ts`, so the two cannot drift), so an image
  or stylesheet `url()` from elsewhere is stopped there as in the app. Only `img-src`: Vite needs inline scripts and
  its own websocket. `e2e/window-csp.spec.ts` checks it in WebKit; jsdom has no CSP.
- MSW 3 intercepts jsdom's `WebSocket` as is; no extra environment option is needed.
- Hooks, query keys and fixtures are scoped per backend entity (`daemon/<entity>-queries.ts`, `test/<entity>-fixtures.ts`), accounts first. An account secret is sent by `daemon/account-secret.ts`, never through TanStack Query, and never kept in UI state.
- Server state lives in TanStack Query; routes are code-based TanStack Router in `src/router.tsx`.
- Mantine components and theme tokens only; see `DESIGN.md`. A side panel that slides over the content is
  `SurfaceDrawer` (`src/shell/surface-drawer.tsx`), never Mantine's `Drawer`. Use the Mantine MCP server for
  component docs (pinned to our Mantine version).
- A Mantine `Modal`'s close button is named by the theme (`components.Modal` in `src/theme.ts`), so axe's button-name
  rule passes every modal's; a modal passes `closeButtonProps` only to name it differently.
- Dark by default; every view must work in light mode too.
- The React Compiler is on; don't hand-write `useMemo`/`useCallback` for render performance.
- Tests: few (dec_01a1efc1). The core e2e flows (`e2e/AGENTS.md`) are the check. A view or component no flow
  opens keeps one render test (Testing Library + MSW, hitting the daemon URL through MSW, never a real daemon).
  Pure code gets a test only as a tricky rule table or parser, and a bug that escapes gets its regression test.
- Rust in `src-tauri/`: `cargo fmt`, `cargo clippy -- -D warnings` with pedantic lints.
- The app icon's source is `app-icon.svg` ("10" in Geist Bold, "db" in Geist Light, outlined to paths).
  `src-tauri/icons/` is generated from it with `pnpm --filter @10db/desktop tauri icon app-icon.svg`;
  never edit those files by hand.
- The menu-bar icon is `tray-icon.svg`, the same wordmark in black with no tile. It ships as a template
  image, which macOS tints to match the menu bar. `src-tauri/tray-icon.png` is generated from it with
  `pnpm --filter @10db/desktop exec tsx scripts/render-tray-icon.ts`; never edit the PNG by hand.
- The window has no title bar (`titleBarStyle: Overlay`): the traffic lights sit on the sidebar's top row, on the
  title row's 44 px height (`trafficLightPosition`), and elements marked
  `data-tauri-drag-region` move the window. The native window's theme follows the app's color scheme
  (`setWindowTheme`), not the system's.
- `pnpm dev:window` (`scripts/dev-window.sh`, the `10db-dev-window` skill) does all of the below in one command on a
  worktree's own data, with a demo project, and stops it all when the window closes.
- `pnpm --filter @10db/desktop dev:shell` runs the Tauri shell against the daemon and Vite server that
  `pnpm dev` already runs. It sets `TENDB_EXTERNAL_DAEMON=1`, which makes the shell skip its sidecar.
  Run `pnpm --filter @10db/desktop sidecar` once first: `tauri-build` checks the sidecar files exist.
  `src-tauri/tauri.dev.conf.json` (passed by `dev:shell` only, never by a release build) gives that shell its own
  identifier (`app.10db.desktop.dev`) and product name ("10db Dev"), so it runs beside the installed release app
  instead of being folded into it by the single-instance plugin. `dev:shell` also defaults `TENDB_DATA_DIR` to the
  checkout's `.dev/data`, so the dev window never reads the release app's `~/Library/Application Support/10db`.
  The data directory comes from `TENDB_DATA_DIR`, not from the identifier. `tests/repo` fails if the two configs
  share an identifier or product name.

## Views

Each view's notes are in its own `src/views/<view>/AGENTS.md` (and a module's in `src/<module>/AGENTS.md`).
Read the ones for what you touch, and write a view's notes there, not here. This file keeps what crosses views.

- `conversation/`: the conversation kit: markdown, the windowed list, tool call cards (`src/conversation/AGENTS.md`)
- `screens/`: screens for Plan's `see_screen` (`src/screens/AGENTS.md`)
- `shell/`: the frame: rail, panel, title row, content surface, drawers (`src/shell/AGENTS.md`)
- `views/board/`: the Board: columns, cards, task state, holds and batches (`src/views/board/AGENTS.md`)
- `views/factory/`: Factory: a project's goals (`src/views/factory/AGENTS.md`)
- `views/first-run/`: the first run (`src/views/first-run/AGENTS.md`)
- `views/inbox/`: the Inbox: cards across projects, checks and knowledge proposals (`src/views/inbox/AGENTS.md`)
- `views/knowledge/`: Knowledge: its tabs, shelves and lists (`src/views/knowledge/AGENTS.md`)
- `views/project-setup/`: the one project form (`src/views/project-setup/AGENTS.md`)
- `views/sessions/`: Sessions: tabs of chats, a fresh tab, the session bar (`src/views/sessions/AGENTS.md`)
- `views/settings/`: Settings: sections, Trust, Decisions, Models, accounts and integrations (`src/views/settings/AGENTS.md`)
- `views/sessions/plan/`: a session's Plan panel, Accept and the Plan's record (`src/views/sessions/plan/AGENTS.md`)
- `views/workbench/`: the Workbench: pages, passes, turns and pictures (`src/views/workbench/AGENTS.md`)

### Across views

- The window's frame is `src/shell/app-frame.tsx` (`src/shell/AGENTS.md`): a sidebar (a 200 px labelled rail, or 76 px icons only, and an
  optional panel the builder can resize (340 px until dragged), all bg1) beside a content column (bg0) with its own 44 px title row. A view draws its title and actions
  into the title row with `TitleRow`, and what sits under it at the top of its content with `PageIntro` (an
  optional one-line byline cut to one line with its text as a tooltip, an optional toolbar of tabs and filters);
  workspaces keep compact headers.
  `src/shell/page-loading.tsx` is what a page shows while it loads (after 300 ms, placeholder rows; never a lone spinner).
  `src/shell/count-badge.tsx` is every count: muted, or `tone` attention, in the theme's primary colour, when it
  needs the builder.
- Factory and preview: the installed release app is the factory; it manages the 10db repo and runs its tasks.
  `pnpm dev` (its own `.dev/data`) with `dev:shell` or http://localhost:1420 is the preview: it renders the
  checkout with live reload and never runs tasks. While a task holds the checkout (Your folder / shared mode),
  don't hand-edit it; work in a worktree under `../10db-worktrees.noindex/`.
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
- Tests that need the native panel answer Tauri's IPC (`mockIPC` for `plugin:dialog|open`) rather than mocking `choose-folder`: the test setup imports the app, so a module mock registers after the real module loaded.
- The e2e specs are a small set of core flows, listed with what each proves in `e2e/AGENTS.md`. Read it before adding or changing a spec: a page, a layout or a scheme is not a flow.
- `e2e/workbench.spec.ts` (runs after `window-csp.spec.ts`) adds a project with one area and no page, on a repository holding an app that names three routes in code (`createProject` in `e2e/shape-project.ts` takes areas and files to commit), runs the setup (axe at 480 and 1280, dark), unticks Billing and applies, then drives one pass on Settings and People against the real daemon: the fake adapter's "Settings: UI work" and "People: UI work" scripts in `e2e/script-book.json` ask a question, end turns Ready and wait for the builder's messages. It answers the question in place, sends a message with a picture, adds to the working turn, commits Settings, reloads, discards People (its row leaves the queue and its task the Board), and ends by discarding the pass, because later specs read Factory across projects; a `MutationObserver` added before the page loads records the announcer's messages and every queue row's lines, so a state shown for a moment ("Committing…") is still seen. axe scans the setup at 480 and 1280 dark, the picker at 480 dark and the open pass with a Ready page at 480 and 1280, dark and light.
- `e2e/process-per-rigor.spec.ts` opens a Critical row's drawer on Settings › Models and edits and resets Standard's review rounds, then runs two Critical tasks, each in its own project, through the fake adapter's "Pair the device" and "Pair the second device" scripts: the first waits on a `plan` card in the Inbox until Approve, builds and reaches Done; the second needs a note to Send Back and plans again. axe scans the drawer and the plan card, dark.
- `e2e/sessions.spec.ts` (runs after `see-screen.spec.ts`, before `stakeholder-questions.spec.ts`) adds a project and drives one chat on the real daemon: ⌘T from the Board opens a fresh tab (axe at 1280 and 480, dark and light), a first line with an `@` file starts the chat, and the fake adapter answers from script-book.json's "Chat: Why does login fail after sleep?" (a read, a command, `set_title`, a markdown reply with a link, then on the typed message "File the work we agreed on" `create_task`, `start_task` and a `remove_task` on the builder's own task, which waits on a card; a book names a task by title with `$task:<title>`). It checks the tab's ring and the sidebar badge, the Inbox's Open Session, Deny in the tab, ⌘J, ⌘W and ⌘⇧T, a reload, the switcher at 480 and Archive, with axe on the conversation, the waiting card and the open All Tabs menu, and ends by cancelling the started task, because later specs read Factory across projects. The File as Tasks step is typed words, not a menu item. Its New Plan flow also adds a plain session that grows a plan by Show Plan and, in another, by proposing; `archive()` waits for the screen to leave the session, and every plan session the spec leaves open is archived. The New Plan flow also Accepts, Undoes the latest Accept, runs Accept and Start, checks the disabled Undo Accept and its reason, and cancels the runs it started (`POST /workstreams/:id/cancel`) before it archives.
- `e2e/inbox.spec.ts` makes the project `e2e-inbox`, seeds three question cards into it with `apps/daemon/scripts/seed-question-card.ts` and answers them from the keyboard. It answers every card it left open when it ends, but the project stays, so later specs that read every project (Factory) see it.
- `e2e/inbox-activity.spec.ts` makes the project `e2e-activity` (shared mode, its own repository with an empty branch) and seeds one HELD batch on that branch with `apps/daemon/scripts/seed-worktree-batches.ts` (`branch`, `baseSha`, `worktree: false`), abandons it through the daemon, and checks the branch-deleted notice shows in Activity (axe, dark and light) while Open's total, its card ids and the rail's badge stay as they were.
- `e2e/loop.spec.ts` creates its project through `POST /projects` before opening the page; `e2e/first-run.spec.ts` runs first (one worker, name order) and creates `e2e-first-run` through the first-run form, because a window with no project opens on the first run.
