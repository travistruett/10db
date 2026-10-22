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
- Server state lives in TanStack Query; routes are code-based TanStack Router in `src/router.tsx`.
- Mantine components and theme tokens only; see `DESIGN.md`. Use the Mantine MCP server for
  component docs (pinned to our Mantine version).
- Dark by default; every view must work in light mode too.
- The React Compiler is on; don't hand-write `useMemo`/`useCallback` for render performance.
- Tests: Testing Library + MSW. Hit the daemon URL through MSW, never a real daemon.
- Rust in `src-tauri/`: `cargo fmt`, `cargo clippy -- -D warnings` with pedantic lints.
- `pnpm --filter @10db/desktop dev:shell` runs the Tauri shell against the daemon and Vite server that
  `pnpm dev` already runs. It sets `TENDB_EXTERNAL_DAEMON=1`, which makes the shell skip its sidecar.
  Run `pnpm --filter @10db/desktop sidecar` once first: `tauri-build` checks the sidecar files exist.
- `pnpm --filter @10db/desktop e2e` drives the Vite app in Playwright's WebKit, the WKWebView engine,
  against the real daemon on the fake adapter. It is not the Tauri window. `make live-acceptance` runs the daemon as a plain node process with the browser UI, so the Tauri window (sidecar, tray, close-to-tray, webview) has no scripted coverage and is checked by hand.
  `make setup` installs the browser. Each run picks free ports for its daemon and Vite server
  (`e2e/ports.ts`) and passes the Vite origin to the daemon as `TENDB_DEV_UI_ORIGIN`, so parallel
  gates never collide; set `E2E_DAEMON_PORT` and `E2E_UI_PORT` to fix them while debugging.
  `pnpm dev` and the Tauri shell keep Vite on 1420.
