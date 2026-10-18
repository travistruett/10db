# apps/daemon

The 10db daemon: the only database writer. It serves the UI over loopback HTTP and WebSocket,
serves agents over MCP, and runs Claude Code sessions.

- `src/env.ts` is the only module that parses or validates environment variables; `src/main.ts`
  hands it `process.env`. Every variable is in `.env.example` with a comment. Errors name variables
  and problems, never values.
- `src/api/` is typechecked by the desktop app too (it imports `AppType`). Code there must not import
  `node:*` modules or `@10db/db`; receive services through the `ApiServices` interface (passed in `ApiDeps`).
- The package entry (`src/index.ts`) exports types only.
- Listen on `127.0.0.1` only.
- `pnpm --filter @10db/daemon build [outDir]` bundles everything into `dist/daemon.mjs` and copies
  migrations (`drizzle/`) and the SQLite addon (`better_sqlite3.node`) beside it. Nothing stays
  external: the Tauri sidecar runs the bundle from a directory with no node_modules.
  `better-sqlite3` is still a daemon dependency: the build copies its addon, and
  `test/crash-recovery.test.ts` opens the database with it directly.
- `pnpm --filter @10db/daemon dev` runs from source with tsx and loads `apps/daemon/.env` when it
  exists. Copy `.env.example` to `.env` to override a variable; `.env` is git-ignored.

## Modules

`src/<module>/` directories are flat; each exports its public surface from `index.ts`, and other
modules import only that (ESLint enforces it). Dependencies point one way:

`clock`, `log`, `events`, `guard`, `permissions`, `git`, `verify`, `routing` → `sessions`, `inbox`, `briefing`, `team` →
`mcp` → `runner` → `watcher`, `scheduler`, `recovery`, `backups`, `benchmarks` → `daemon` (composition root) → `main.ts`.
`api` depends only on `@10db/contracts` and its own `ApiServices` interface; the composition root
implements it and hands it to `createApp` in `ApiDeps`.

Time comes from an injected `Clock`; never call `Date.now()` or `setTimeout` directly in logic.

The fake adapter (`sessions/fake-adapter.ts`) is the test boundary for Claude Code; daemon tests never call the real CLI.

- `routing/` is pure: flows, floors, the per-role AA score, the router, escalation and step plans over rows its caller passes in. It imports `@10db/contracts` only. Its tests use the invented catalogue in `test-catalogue.ts`, never AA's numbers.
- `team/` seeds the team configuration at start and turns a task into its stored step plan. Read the step a workstream is on with `currentStep` from `@10db/contracts`. Daemon tests get an invented measured catalogue from `test/catalogue.ts`.
- `benchmarks/` syncs Artificial Analysis's free model list with the builder's own key, read from the Keychain (service `10db`, account `artificial-analysis-api-key`). AA data stays on the machine: never in logs, fixtures, docs or the repo, and every view of it shows AA's attribution. Tests use invented numbers and an injected `fetch`.
- `environment/` owns the login env (memory only), the session env builder and the system check. Nothing
  else reads the login env. Never write it to disk, the database or logs; log variable names, never values.
- Only `sessions/claude-*.ts` import `@anthropic-ai/claude-agent-sdk`, and only `claude-adapter.ts` imports it at runtime (the others import types).
  Tests inject a scripted `query`; only `claude-adapter.live.test.ts` runs real Claude Code, behind
  `TENDB_LIVE_CLAUDE=1`.
- Sessions and the gate both run in `sessionEnv(project)`. Nothing from the daemon's own
  `process.env` reaches a project's commands.
- `keep-awake/` and `watcher/` follow lanes through `workstream.*` events, wired in `daemon/start.ts`.
- A managed session's MCP servers are 10db's own plus the repo's `.mcp.json` servers the builder approved
  for that exact config, resolved per session in `sessions/project-mcp.ts`. Claude Code never reads MCP
  config itself (`strictMcpConfig: true`). A repo stdio server is launched through `env -i` with PATH,
  HOME and its declared env only; never hand it the session environment.
