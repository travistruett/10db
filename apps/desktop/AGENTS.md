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
- The board's batch sheet (`views/board/batch/`) starts work as the project's delivery mode and current batch allow: in a pull-request project one `POST /projects/:id/batches` (it starts, joins or reopens the batch), in a local one a `POST /tasks/:id/start` per task. A worktree-mode project (`workspaceMode`) always sends the request as new work, which answers one batch per task or per dependency-linked group, and the board shows a `BatchStrip` per `openBatches` entry; its "Add a fix task" posts the batch id to join that batch. Each card's menu keeps its own Start.
- The Inbox (`views/inbox/`) shows one row per card, except that identical dismissable flags (same project, title and body, no options) share a row with a count (`inbox-rows.ts`). A collapsed flag shows its body's first line and a Dismiss. Its keys are in `use-inbox-keys.ts` and the list the ? button opens is in `inbox-shortcuts.tsx`; change both together.
- Settings (`views/settings/`) is one route over `sections.ts`. To fill a planned section, set its `planned` to null and replace its arm in `section-body.tsx`.
