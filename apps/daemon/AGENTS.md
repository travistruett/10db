# apps/daemon

The 10db daemon: the only database writer. It serves the UI over loopback HTTP and WebSocket,
serves agents over MCP, and runs Claude Code sessions.

- `src/env.ts` is the only module that parses or validates environment variables; `src/main.ts`
  hands it `process.env`. Every variable is in `.env.example` with a comment. Errors name variables
  and problems, never values.
- `src/api/` is typechecked by the desktop app too (it imports `AppType`). Code there must not import
  `node:*` modules or `@10db/db`; receive services through `ApiDeps` interfaces.
- The package entry (`src/index.ts`) exports types only.
- Listen on `127.0.0.1` only.
- `pnpm --filter @10db/daemon build` bundles to `dist/daemon.mjs` and copies migrations to
  `dist/drizzle/`. `better-sqlite3` stays external (native addon), so it is a daemon dependency
  even though only `@10db/db` imports it; `knip.json` ignores it for that reason.
- `pnpm --filter @10db/daemon dev` runs from source with tsx and loads `apps/daemon/.env` when it
  exists. Copy `.env.example` to `.env` to override a variable; `.env` is git-ignored.
