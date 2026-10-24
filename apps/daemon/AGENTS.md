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

`clock`, `log`, `events`, `guard`, `permissions`, `git`, `github`, `verify`, `routing`, `picker` → `sessions`, `inbox`, `briefing`, `team` →
`delivery`, `accounts` → `mcp` → `runner` → `watcher`, `scheduler`, `recovery`, `backups`, `benchmarks` → `daemon` (composition root) → `main.ts`.
`api` depends only on `@10db/contracts` and its own `ApiServices` interface; the composition root
implements it and hands it to `createApp` in `ApiDeps`.

Time comes from an injected `Clock`; never call `Date.now()` or `setTimeout` directly in logic.

The fake adapter (`sessions/fake-adapter.ts`) is the test boundary for Claude Code; daemon tests never call the real CLI.

- `routing/` is pure: flows, floors, the per-role AA score (a role compares its own unless some enabled, costed profile that has an Intelligence score lacks it, then all on Intelligence), the router, escalation and step plans over rows its caller passes in. It imports `@10db/contracts` only. Its tests use the invented catalogue in `test-catalogue.ts`, never AA's numbers.
- `picker/` is pure like `routing/`: the spec §5.2.1 rules over rows its caller passes in, planned tasks only. `team/candidates.ts` gathers the rows and adds each candidate's claims and step plan; `GET /projects/:projectId/candidates` serves the result. It models no batch: a batch is the delivery spec's entity.
- `team/` seeds the team configuration at start and turns a task into its stored step plan. Read the step a workstream is on with `currentStep` from `@10db/contracts`. Daemon tests get an invented measured catalogue from `test/catalogue.ts`.
- `benchmarks/` syncs Artificial Analysis's free model list with the builder's own key, read from the Keychain (service `10db`, account `artificial-analysis-api-key`). AA data stays on the machine: never in logs, fixtures, docs or the repo, and every view of it shows AA's attribution. Tests use invented numbers and an injected `fetch`.
- `github/` is the only module that runs `gh`, and `git/` the only one that runs `git`; both use `execFile` or `spawn` with argument arrays, never a shell. Network calls (fetch, push, every `gh` call) take a `NetworkCall` built from `environment/buildNetworkEnv`, a timeout and an abort signal, with prompts off. A push gets `pushTimeoutMs` (the gate's timeout), since it runs the clone's pre-push hook; fetch and `gh` get `networkTimeoutMs`. Fetch and push run detached in their own process group, and a timeout or abort kills the group. Delivery tests fake `gh` with `test/fake-gh.ts`; real git runs against a local bare `origin` (`createTempRepoWithOrigin`).
- `accounts/` owns account pauses (usage limit, monthly cap, refused; one per account), the monthly cap in local time on the injected clock, and the account cards. The scheduler and the runner ask `AccountRuntime.blocked` before every session start; a cap or refusal pause lets running sessions finish and a usage limit stops them.
- `delivery/` owns batches: a start answers at once and cuts or joins in a background job (`jobs.ts`, one at a time per project); git and gh refusals are flag cards (`cards.ts`) that name their tasks in `detail.taskIds`, except the card for a `CUTTING` row startup deletes, which has only `detail.batchId`. A failed batch member's card offers Retry and Ship anyway (`batch-card.ts`), acted on through the inbox's `onFlagAnswer`. `recoverBatches` runs at startup after `recoverOnStartup`; `subscribeShipTrigger` follows `workstream.changed`. The scheduler imports only `batchLaunchVerdict` and `LaunchVerdict`, and the composition root passes `flagWrongBranch` to it as `onWrongBranch`; the runner and workstream recovery import `batchCardFields` for the failed card. Tests wait on `Scheduler.idle()` and the delivery jobs' `idle()`.
- `environment/` owns the login env (memory only), the account launcher and the system check. Nothing
  else reads the login env. Never write it to disk, the database or logs; log variable names, never values.
- Only `sessions/claude-*.ts` import `@anthropic-ai/claude-agent-sdk`, and only `claude-adapter.ts` imports it at runtime (the others import types).
  Tests inject a scripted `query`; only `claude-adapter.live.test.ts` runs real Claude Code, behind
  `TENDB_LIVE_CLAUDE=1`.
- A session runs in its account's launch (`Launcher.session`), and the gate and the repo's MCP servers
  in `Launcher.projectEnv()`, which never holds an account's credentials. A session proves its account
  (`sessions/account-check.ts`) before its prompt; a refusal pauses the account and the workstream waits
  in `PAUSED_LIMIT`, while a model mismatch fails the workstream. Nothing from the daemon's own
  `process.env` reaches a project's commands.
- The variables that point git at a repository (`GIT_REPO_ENV_VARS` in `git/`: `GIT_DIR` and the
  rest of `git rev-parse --local-env-vars` except the config ones) are dropped wherever the daemon
  starts a process that may run git: `git/`'s own calls (fetch and push take theirs off the
  `NetworkCall` env), every `gh` call (gh runs git to read the remotes), the login shell capture,
  and the launcher's env (sessions and the gate). A daemon started from a git hook still acts on the
  repository it names. Git config variables (`GIT_CONFIG_COUNT` with its `KEY_n`/`VALUE_n`,
  `GIT_CONFIG_PARAMETERS`, `GIT_CONFIG`) are kept: they name no repository, and a builder's
  profile may set them on purpose.
- `git/`'s own calls also set `GIT_OPTIONAL_LOCKS=0`, so a read such as `status` never refreshes
  the index under `index.lock`. With the lock held, a lane's commit running at the same moment
  fails with "index.lock: File exists".
- `keep-awake/` and `watcher/` follow lanes through `workstream.*` events, wired in `daemon/start.ts`.
- A managed session's MCP servers are 10db's own plus the repo's `.mcp.json` servers the builder approved
  for that exact config, resolved per session in `sessions/project-mcp.ts`. Claude Code never reads MCP
  config itself (`strictMcpConfig: true`). A repo stdio server is launched through `env -i` with PATH,
  HOME and its declared env only; never hand it the session environment.
