# apps/daemon

The 10db daemon: the only database writer. It serves the UI over loopback HTTP and WebSocket,
serves agents over MCP, and runs Claude Code sessions and, for a `codex_signin` account, Codex sessions through
`codex app-server` (`sessions/codex-*.ts`).

- `src/env.ts` is the only module that parses or validates environment variables; `src/main.ts`
  hands it `process.env`. Every variable is in `.env.example` with a comment. Errors name variables
  and problems, never values. `main.ts` exits 4 with one line on an `EnvError` or a `WorktreeRootError`,
  and the desktop supervisor stops instead of restarting into the same refusal.
- `TENDB_BENCHMARKS=off` keeps a daemon from reading the Artificial Analysis key and from calling AA
  (`aaKeyReaderFromEnv`: the sync records `no_key`), and with it from reading OpenRouter's scores and speeds
  (`daemonOptionsFromEnv` leaves `openRouterSync` off). Only the installed app's daemon syncs; the e2e web
  server, the live acceptance daemon and `scripts/dev.sh` set it, and `tests/repo/src/benchmarks-off.test.ts`
  checks they do. A new launcher of a throwaway daemon sets it too.
- `TENDB_CATALOGUE=off` keeps a daemon from fetching the model catalogue from models.dev
  (`catalogueSync` in `daemonOptionsFromEnv`); the stored copy and the release snapshot are still read. It also turns
  off the account-list refresh that follows each fetch, so a daemon test never spawns a probe.
  The e2e web server, the live acceptance daemon and every daemon test that spawns the entry with its own
  environment (`test/crash-recovery.test.ts`, `parent-death`, `bundle`, `refused-config`) set it, and
  `tests/repo/src/benchmarks-off.test.ts` checks they do. `scripts/dev.sh` leaves it on, so `pnpm dev` sees
  real data; the fetch is one daily GET with no key. A new launcher of a throwaway daemon sets it too.
  `DaemonOptions.catalogueSync` is off unless given, so an in-process test harness never reaches the network.
- `TENDB_CATALOGUE_SNAPSHOT` (an absolute path; `catalogueSnapshotFromEnv`) names the catalogue file read when none is
  stored, instead of the one beside the bundle. `startDaemon` rebuilds the model profiles from the catalogue it holds
  (stored, else snapshot) before it returns, whatever `catalogueSync` says, so a daemon that never fetches still plans
  and launches on real models. Every launcher that sets `TENDB_CATALOGUE=off` also sets this to
  `test/fixtures/catalogue.json`, and `tests/repo/src/benchmarks-off.test.ts` checks it.
- `TENDB_JUDGE=off` keeps a daemon from reading any OpenRouter account's key (or the `openrouter-api-key` item
  that `moveOpenRouterKey` moves into an account at start) and from calling OpenRouter (`judgeOff` in
  `daemonOptionsFromEnv`; every decision then keeps today's rule), and keeps the OpenRouter sync (`benchmarks/openrouter-sync.ts`) from running. Only the installed app's daemon asks models;
  the e2e web server, the live acceptance daemon and `scripts/dev.sh` set it, and
  `tests/repo/src/benchmarks-off.test.ts` checks they do. A new launcher of a throwaway daemon sets it too.
- `TENDB_SLACK=off` keeps a daemon from reading the Slack bot token (Keychain service `10db`, account
  `slack-bot`, `SLACK_BOT_ACCOUNT`) and from calling Slack (`slackOnFromEnv`; `DaemonOptions.slack` is off unless
  given, so an in-process harness never reaches Slack). Only the installed app's daemon messages people; the e2e
  web server, the live acceptance daemon, `scripts/dev.sh` and every daemon test that spawns the entry set it, and
  `tests/repo/src/benchmarks-off.test.ts` checks they do. A new launcher of a throwaway daemon sets it too.
- `slack/` is the only module that calls Slack: `createSlackClient` takes an injected `fetch`, token reader and
  `Clock`, reads parse with zod, and a `SlackError` names the method and a code, never the token. Reads are GETs and
  writes JSON POSTs. `stakeholders/` holds the pure texts and rules around it (compose, escape, scan, read a reply,
  read a conversation); neither module ever sees the token outside `slack/client.ts`.
- `src/api/` is typechecked by the desktop app too (it imports `AppType`). Code there must not import
  `node:*` modules or `@10db/db`; receive services through the `ApiServices` interface (passed in `ApiDeps`).
- The package entry (`src/index.ts`) exports types only.
- Listen on `127.0.0.1` only.
- Browser origins: only the Tauri webview's are built in. `TENDB_DEV_UI_ORIGIN` opts one loopback http origin in
  (`decisions/2026-10-29-dev-ui-over-the-factory.md`); a launcher of a daemon a browser UI talks to sets it.
- `pnpm --filter @10db/daemon build [outDir]` bundles everything into `dist/daemon.mjs`, bundles srt's
  command line (`@anthropic-ai/sandbox-runtime`) into `srt.mjs`, copies srt's Java proxy agent to
  `vendor/java-proxy-agent/srt-proxy-agent.jar`, where srt looks before it runs `npm root -g` unsandboxed from
  the gate's checkout, and copies migrations (`drizzle/`) and the
  SQLite addon (`better_sqlite3.node`) beside it. The Tauri sidecar runs the bundle from a directory with no
  node_modules above it, so only one package stays external: `playwright-core`, which reads its own
  `package.json` and `browsers.json` from disk, is copied whole to `node_modules/playwright-core` beside
  `daemon.mjs` and loaded by a dynamic import (`pictures/playwright.ts`) when a picture is first taken. The
  build removes that `node_modules` first, so a stale copy never survives; `test/bundle.test.ts` checks the
  copy's version and that `daemon.mjs`'s directory resolves it.
  `better-sqlite3` is still a daemon dependency: the build copies its addon, and
  `test/crash-recovery.test.ts` opens the database with it directly.
- `pnpm --filter @10db/daemon dev` runs from source with tsx and loads `apps/daemon/.env` when it
  exists. Copy `.env.example` to `.env` to override a variable; `.env` is git-ignored.

## Modules

`src/<module>/` directories are flat; each exports its public surface from `index.ts`, and other
modules import only that (ESLint enforces it). Dependencies point one way:

`clock`, `log`, `events`, `judge`, `slack`, `guard`, `permissions`, `trust`, `sandbox`, `git`, `github`, `verify`, `routing`, `picker`, `folders`, `placement`, `knowledge` → `plan-record` → `sessions`, `inbox`, `briefing`, `team` → `session-setup` →
`delivery`, `stakeholders`, `accounts` → `pass` → `pictures` → `mcp` → `screens` → `thread`, `shape` → `runner` → `watcher`, `scheduler`, `recovery`, `backups`, `benchmarks`, `self-update` → `daemon` (composition root) → `main.ts`.
`api` depends only on `@10db/contracts` and its own `ApiServices` interface; the composition root
implements it and hands it to `createApp` in `ApiDeps`.

Time comes from an injected `Clock`; never call `Date.now()` or `setTimeout` directly in logic.

The fake adapter (`sessions/fake-adapter.ts`) is the test boundary for Claude Code; daemon tests never call the real CLI.

Each module's notes are in its own `src/<module>/AGENTS.md`. Read the ones for the modules you touch, and
write a module's notes there, not here. This file keeps what crosses modules.

- `accounts/`: account pauses, the monthly cap, readiness and staggered starts (`src/accounts/AGENTS.md`)
- `benchmarks/`: Artificial Analysis's model list and OpenRouter's scores and speeds, each synced with the builder's own key (`src/benchmarks/AGENTS.md`)
- `catalogue/`: the model catalogue from models.dev and its four rungs (`src/catalogue/AGENTS.md`)
- `daemon/`: the composition root: start-up, wiring and the services behind the API (`src/daemon/AGENTS.md`)
- `delivery/`: batches: cutting, joining, gates, landing and pull requests (`src/delivery/AGENTS.md`)
- `environment/`: the login environment, account secrets and pinned installs (`src/environment/AGENTS.md`)
- `folders/`: gate detection, folder inspection and the routes read from code (`src/folders/AGENTS.md`)
- `git/`: the only module that runs `git`: plumbing, pins, worktrees and pushes (`src/git/AGENTS.md`)
- `github/`: the only module that runs `gh` (`src/github/AGENTS.md`)
- `goals/`: adopting a goal brief, and goal digests (`src/goals/AGENTS.md`)
- `guard/`: the PreToolUse guard: protected paths, hazards and the shell judge (`src/guard/AGENTS.md`)
- `hazards/`: a project's hazards, read from its repository, and claims per copy or project (`src/hazards/AGENTS.md`)
- `judge/`: routine decisions asked of a fast model through OpenRouter, and each decision model's cost and time (`src/judge/AGENTS.md`)
- `keep-awake/`: keeps the Mac awake while lanes run (`src/keep-awake/AGENTS.md`)
- `knowledge/`: the knowledge rules: scope, the context pack and promotion (`src/knowledge/AGENTS.md`)
- `load/`: the load guard that holds work while the Mac is overloaded (`src/load/AGENTS.md`)
- `mcp/`: 10db's MCP tools for sessions: commits, claims, report_pages (`src/mcp/AGENTS.md`)
- `pass/`: a Workbench pass: turns, sign-off, close and the work kept in Your folder (`src/pass/AGENTS.md`)
- `permissions/`: a lane's permission rules (`src/permissions/AGENTS.md`)
- `picker/`: which planned task runs next (pure) (`src/picker/AGENTS.md`)
- `pictures/`: pictures of the builder's app: the pinned browser, preview marks and pruning (`src/pictures/AGENTS.md`)
- `placement/`: where a new task works (pure) (`src/placement/AGENTS.md`)
- `plan-record/`: a Plan's whole record and how it reaches the lanes (`src/plan-record/AGENTS.md`)
- `preview/`: runs a project's preview command while a pass is open (`src/preview/AGENTS.md`)
- `priority/`: CPU priority for lane and gate processes (`src/priority/AGENTS.md`)
- `routing/`: flows, floors and the router that picks a model per role (pure) (`src/routing/AGENTS.md`)
- `runner/`: runs a workstream step by step: checks, messages and launches (`src/runner/AGENTS.md`)
- `runtime-files/`: the data directory's runtime files and tokens (`src/runtime-files/AGENTS.md`)
- `sandbox/`: the lane, gate and MCP sandboxes (srt and Seatbelt profiles) (`src/sandbox/AGENTS.md`)
- `screens/`: Shape's `see_screen`: screenshots of the app (`src/screens/AGENTS.md`)
- `self-update/`: the installed app follows `main` (`src/self-update/AGENTS.md`)
- `session-setup/`: what comes along into a session: instructions, skills, definitions (`src/session-setup/AGENTS.md`)
- `sessions/`: Claude Code and Codex sessions: adapters, launch, repo config and tool calls (`src/sessions/AGENTS.md`)
- `shape/`: Shape (Plan) conversations: ceremony, preview and landings (`src/shape/AGENTS.md`)
- `team/`: the team configuration and each task's step plan (`src/team/AGENTS.md`)
- `thread/`: a task's thread (`src/thread/AGENTS.md`)
- `trust/`: each session's trust policy (`src/trust/AGENTS.md`)
- `verify/`: the gate runner and machine-wide gate slots (`src/verify/AGENTS.md`)
- `watcher/`: flags writes to sensitive paths and strays outside claims (`src/watcher/AGENTS.md`)

### Across modules

- **The security rule.** No process outside a sandbox acts on lane-writable input (a file in a checkout, a
  `PATH` entry or tool variable that names one, a lockfile). Remove a capability rather than check for its
  misuse. Never deny individual secrets inside an otherwise open tree: open only what is needed. Its
  exceptions are what the builder approved: a pass's plain commit, push or merge the builder allowed on a card,
  which 10db runs once as the builder would (`git/run-as-builder.ts`: in the checkout's own git dir, a commit or merge inside the gate's
  sandbox, whose hooks then run contained, and a push or `gh pr merge` outside it with no hook; the card says which), and what the builder installed: Claude Code reads the builder's skills and plugins (Settings ›
  Trust) outside the sandbox, and each skill or plugin whose real path a lane could write is left out. Their
  hooks and `allowed-tools` run as in Claude Code (live checks L3b and L3c: the guard doesn't judge a hook's
  rewrite again, and `allowed-tools` skips the card, never a guard deny); a plugin hook starts in its wrapper's
  folder.
- A test that needs what no sandbox gives (a setuid `ps`, a short path under the shared `/tmp`, the builder's real home, Seatbelt itself) skips with `SANDBOXED` from `test/fixtures.ts` (`TENDB_SANDBOX=1`) and says why; CI and an unsandboxed `make gate` still run it. A test that starts a daemon process passes it the test's own `TMPDIR` and `GIT_CONFIG_GLOBAL=/dev/null`.
- `createTempRepo` copies a template repository that `test/repo-template.global.ts` builds once per test run with `buildRepoTemplate` and removes after it: a copy is a few file writes, where building a repository takes nine git calls. A change to what every test repository holds (its config, its first commit) goes in `buildRepoTemplate`.
- A session runs in its launch env (the project env plus its account's variables); the gate and the shipping gate get the lanes' allowlist of the project env (the login env with every billing switch stripped), inside their sandbox, and the repo's stdio MCP servers get `PATH`, `HOME` and their approved variables from it, plus the lanes' allowlist inside their sandbox. Nothing from the daemon's own `process.env` reaches a project's commands.

## Stakeholder questions

- `src/stakeholders/` holds the stakeholder-question logic (designed in
  `docs/superpowers/specs/2026-11-11-10db-stakeholder-questions-design.md`). `triage.ts` routes a question card
  that no explicit route claimed: `InboxService.ask` inserts it `routedBy: 'triage_pending'` with the builder when
  something is wired to run triage (`onQuestionOpened`) and the judge can run (not `TENDB_JUDGE=off`, the master
  switch and `question_route` on), and the callback runs `triage.run` after the write commits. `run` never throws,
  and every outcome leaves pending in one `setInboxRecipients` write (`judge`, `builder` or `rule`) before
  `afterRouted`, which parks the card's sessions through `Runner.parkFor`. A card no longer pending is left as it
  is. The start sweep settles a card a crash left pending.
- A routed question is drafted in the transaction that routes it (`drafts.ts`, `draftOnOpen`; a recipient with no
  Slack contact makes the card the builder's), and `sends.ts` sends it: `afterDraft` sends at once only when
  `holdFor` finds no reason (scan, first send, limit, review, in that order), `send` rescans and refuses a hold,
  and the post carries `tendb_send` metadata so `recoverSending` finds a post a crash left in flight instead of
  posting twice. `onCardChanged`, subscribed to `inbox.changed`, closes the send and says why in every thread it
  used (`closing-lines.ts`). With Slack off (`TENDB_SLACK=off`, no token) every draft stays as it is.
- `reply-watch.ts` reads each open send's thread and the DM's top level every minute (and twice at once after the
  clock jumped), on the injected clock. A lone recipient's reply is joined and answers the card through
  `InboxService.answerAs` once a tick finds nothing newer (`quietSince` is in memory, so a restart costs one tick);
  it also posts the reminder, looks for sends left mid-post (`recoverSending`) on every good tick, and keeps the
  connection state (`slack-connection.ts`: `refused` and `none` stop the watch until `reconnect()`, three failed
  ticks make it `unreachable`). With several open questions in one DM a top-level reply is matched by the judge
  (`reply_match`) or by asking "Which one is this for?" (`reply-match.ts`). `timer-watch.ts` returns an overdue
  send to the builder from the wall clock alone, with no Slack (`timers.ts` holds the pure rule).
- `bring-in.ts` moves a conversation to a group DM when a participant mentions someone (`moveSend` keeps the old
  thread as `moved_from`, forgets the proposal and approval marks, and counts nobody toward a limit), and `agree.ts`
  settles a conversation with several voices: the judge's `thread_answer` becomes a proposal line with the bot's own
  ✅ seeded, a recipient's ✅ is seen on one tick and confirmed on the next, and disagreement returns the card to
  the builder with no decision. Every line 10db posts about a send carries `tendb_send` metadata (`bot-lines.ts`),
  so a crash between a post and its write finds the line again instead of posting it twice.
- A question card routed to anyone but the builder parks its session at once (`onWaitStart` reads the card again),
  even with another wait open, so a stakeholder's words never reach a live `ask_human` call.

## Tests

- A delivery test starts from a named world in `test/delivery-worlds.ts`: `opened`, `committed` and `shipped`,
  each built through the real pipeline on a `createDeliveryHarness` from the world before it, and each checking it
  got there. The module also holds the helpers those tests share (`commitIn`, `pathOf`, `branchOf`, `checkoutOf`,
  `onOrigin`). A test that needs a state none of them gives adds a world there, not a builder in its own file;
  setup only one file needs, such as a file planted before the ship, starts from a world and passes it on as `from`.
