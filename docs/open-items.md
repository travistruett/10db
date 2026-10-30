# Open items

- [ ] Spikes 1–7, 9 run and recorded (plan 00).
- [x] M0 scaffold merged (plan 01).
- [x] M1a engine core merged (plan 02).
- [x] M1b sessions and bare UI merged; §1.3 acceptance passed on a disposable repo (plan 03).
- [ ] Bump `typescript` to 7.x and drop the 6.0 alias once typescript-eslint supports the 7.1 API.
- [ ] Drop the jsx-a11y peer allowance once it supports ESLint 10.
- [ ] Replace the placeholder app icon.
- [ ] Post-MVP: backup export and import (spec §13 fast-follow).
- [ ] Renovate bumps Rust in `mise.toml` but not `rust-toolchain.toml`; match them by hand in that PR (a repo test fails until they agree).
- [ ] M2: "answered from D-n" lookup before a question reaches the inbox (spec §7).
- [x] M2: reviewer approval in flows with a review step before DONE (spec §5.4). (M2a: review, plan-review and QA steps give verdicts through `complete_step`.)
- [ ] M2: per-workstream log files for the Factory detail view (spec §12; M1a has one shared daemon log, decision 31).
- [ ] M2: diagnostics bundle export (spec §12; not built in M1a).
- [x] M2: project settings for extra allowed commands (test and lint), beyond the gate command. A project lists command prefixes in Settings > General; an edit step runs each without a permission card, and the guard still judges every command.
- [x] Spec §8.1: reword "claims are released when the lease expires" to match decision 36 (released on DONE, CANCELLED or FAILED, never by lease expiry).
- [ ] M2: let a resumed agent retrying `ask_human` with the same `opId` get the parked answer back, instead of only the "do not ask again" message.
- [ ] M2: inject the environment into `createGit(env)` instead of reading `process.env` in `git.ts` (M1b already calls `createGit()` with no arguments).
- [ ] Spec §5.1: "Ready" does not yet check for an open blocking inbox item.
- [ ] Spec §9: the context pack uses FTS only; area match is not built.
- [x] Spec §12: the fake adapter is typed at the `SessionEvent` seam, not with the SDK's message types; M1b's scripted query covers the SDK level.
- [ ] Spec §4: the inbox delivery record, persona avatars and people's channels are not built yet.
- [ ] A multi-question `AskUserQuestion` parked mid-sequence drops the earlier answers, so the agent re-asks. Fix: open all question cards up front, or include every card resolved for the workstream in the resume prompt.
- [x] M1b: when two waits overlap and the first card is answered, a stop or crash parks on that answered card and the second card's later answer is dropped. Fix: track the set of open waits and park on one that is still open.
- [x] M1b: a preserved `answer` next action re-prompted and re-granted the same allow-once on every clean restart before a handoff or step done. Fixed: once the session reports `started`, the runner rewrites the next action to a fresh start action (`start`, or `continue_from_handoff` from the latest handoff), so the answer and a one-time permission reach exactly one session.
- [x] M1b: end the daemon log's file destination in `stop()`; a daemon stopped milliseconds after start can throw an async ENOENT, and each start leaks a file descriptor.
- [ ] M2: per-project overrides and security settings for the repo's MCP servers (decisions 39, 50–53): approve a subset of a server's variables, list and revoke approvals in Settings, and check `canUseTool`'s `mcpServer.source` in the adapter.
- [ ] M2: a setting to allow overage spending per project (decision 41).
- [ ] M2: evaluate the Tauri MCP bridge (`hypothesi/mcp-server-tauri`) as a debug-only build feature for driving the real webview.
- [ ] M2: signing and notarization for distributing the .app beyond this machine (spike 8 notes).
- [ ] M2: the ⌘K palette.
- [ ] M2: "Pause all" in the menu bar (spec §10); M1's tray shows lanes, inbox count and keep-awake only.
- [ ] M3: §1.3 live on the pilot project.
- [ ] Spec question: a repo's committed .claude/settings.json hooks and statusLine run with session credentials without approval (decision 51 trusts the project); consider bringing them under the .mcp.json approval model.
- [ ] Spec question: repo-configured git filters (.gitattributes + filter.<name>.clean/process in .git/config) run during the watcher's git status and during 10db's own commits; consider a sanitized git config or refusing sessions whose .git/config gains such keys.
- [x] M1b live run: confirm on the setMcpServers route that a repo MCP tool call reaches canUseTool as a permission card (`repo MCP tool gated`) and that a stdio server sees only PATH and HOME (`repo MCP server env`) (make live-acceptance). Header delivery to a repo HTTP server is not covered; 10db's own HTTP MCP server covers the route's headers.
- [ ] M2: a crash after a session has written its handoff resumes that conversation, which hands off again at once; continuing fresh from the handoff it already wrote would save a session (seen in the M1 live run).
- [x] M2b: the board with human and derived columns and drag and drop, and the Settings view with General, Board columns, Areas and hazards, Billing and Keep-awake (plan 07, part A).
- [x] M2b: the picker rules and `GET /projects/:projectId/candidates`, the approval sheet's input (plan 07, part B, its daemon half).
- [x] M2b: the batch approval sheet (plan 07, part B), after the delivery plan's batch contracts.
- [ ] M2: the PM-agent review (need estimates, optional steps), the Brainstorm panel, the consult step and ⌘K.
- [ ] M2: Settings editors for team bindings, routing rules, personas, flows and model profiles, the AA key field and the Intelligence-vs-Cost chart (Pareto line, axis picker, AA logo and source link); their sections are slots.
- [x] M2: editing a project's areas and hazards in Settings (`PATCH /projects/:id`).
- [ ] Board, designed for later: a per-project manual board setting that lets drags override the system columns; person-linked human columns (board_columns.person_id → people); on-drop behaviors (board_columns.on_drop, e.g. start a consult).
- [ ] M2c: takeover and the PTY (plan 08).
- [ ] Idea, after the M2b board: a "Model changes" review tab on a task or PR. Data-model changes (schema, migrations, contract types) are the hardest part of a change to reverse, so review should open on them, not the whole diff. Which paths count as "model" is a setting resolved at layered scopes like VS Code's (account, then project), so other hard-to-reverse areas can be watched the same way. Storage is open: record the matching paths per step and render the diff, or store a link to the forge's diff narrowed to those files. Later: track what reviewers drill into and tune the defaults.
- [ ] Idea, beside the "Model changes" tab: a "Query changes" view, shown only when a change adds or edits an API endpoint. For each such endpoint it records the SQL the endpoint runs, before and after the change, with each statement's query plan, and flags N+1 and duplicate queries and related rows read one at a time instead of prefetched. The reviewer gets a quick check that the endpoint's data access is sound without reading the handler. Open: how the queries are captured (a query log in the endpoint's tests, or a replay of recorded requests), and which plan changes count as regressions.
- [ ] M2b: the live acceptance run adds a task on the standard flow, so a real reviewer calls complete_step (M2a keeps §1.3 on the quick flow).
- [ ] Spec §7: a card's owner is stored but nothing filters or notifies by owner yet; the inbox's "mine / teammate" filter is M2b.
- [ ] Spec §4 model_profiles: the observed stats count steps and escalations only; tokens per step are not recorded yet.
- [ ] Spec §8: a read-only step keeps its task's area claims while it reviews, so other implementers in that area wait; consider releasing claims for read-only steps and re-acquiring them on a send-back.
- [x] Drop the project's `model` and `effort` with a migration, and their place in `ProjectInput` and the fixtures: routing runs a step with no score on its role default and no longer reads them (`decisions/2026-10-28-routing-role-defaults.md`).
- [ ] AA: a real sync confirmed the free API's slugs and its `page` query parameter match the catalogue's and the client's. Still open: AA's index versions may shift scores between syncs, and 10db's needs and floors are absolute index points. The status flags a major-version change (AA says scores are comparable within a major version); patch versions aren't reported, so they can't be detected. AA's free API gives no Coding or Agentic Index for some models; those roles route on Intelligence (decision 66) until it does. The sync status lists the profiles routing can't use (`unmeasuredProfiles`) and the score kinds missing from the rest (`missingScores`).
- [ ] M2a read-only shell: a read-only step's shell accepts only plain words and simple quoting, so unquoted globs, ~, $, braces and backslashes are refused (quote them), and so is any `=` at the start of a word or right after `=` or `:`, quoted or not (for example `'==='` or `'a:=b'`), so reviewers use the Grep tool for those. Revisit if real reviews hit it.
- [ ] M2a read-only shell: aliases and functions in the user's shell configuration can rewrite plain words, which the read-only grammar cannot see; check whether Claude Code's Bash tool loads them.
- [x] Batch delivery: worktrees and one PR per task (workspace_mode = worktree), the spec's expected fast-follow (batch delivery spec §9). Built: `docs/superpowers/specs/2026-10-27-10db-worktree-mode-design.md`, `docs/architecture/02-batch-delivery.md`.
- [ ] Worktree mode: a port block per worktree (a project-wide hazard, the default for a hazard the builder adds, still serializes the shared ports, spec §11; `harness` and `deps` are per copy, `decisions/2026-10-29-per-copy-hazards-and-waiting-claims.md`).
- [x] Worktree mode: a worktree whose lockfile is newer than the main checkout's install installs without the builder. Built for pnpm projects: `pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile` under the gate sandbox after the seed (`decisions/2026-10-28-worktree-dependency-install.md`). Not built: a setup command of the project's own, and an install inside a lane.
- [ ] Worktree mode: seeding ignored files such as `.env`; `worktree_seed` names directories only.
- [ ] Worktree mode: parallel ships behind a limit (one ship runs at a time per project now).
- [ ] Worktree mode: updating a pull request after it ships. Before each gate a worktree batch's branch takes its base as origin has it (`decisions/2026-10-29-gate-with-base.md`); once shipped, a pull request that falls behind or conflicts is the builder's.
- [ ] Worktree mode: choose shared or worktree per task, decided when work is broken into tasks. The goal:
      frontend tasks on different screens run as parallel lanes in the shared checkout, where the builder watches
      them live in one dev window, and only a task that needs isolation (migrations, the lockfile, contracts, a long
      daemon change, anything that would break the dev server mid-iteration) gets its own worktree. Areas, hazards
      and dependencies are the inputs; the planner proposes the lane count and each task's placement, and the
      builder confirms. Worktrees make rapid UI iteration across screens harder, so a project-wide switch isn't
      enough. Keep `tasks.workspace_mode` for this rather than dropping it.
- [x] Worktree mode: removing a clean leftover worktree also removed its git-ignored files, such as a
      hand-made `.env`. Built: a finished or orphaned worktree holding ignored files outside matched
      directories and the seed is kept with a card (`decisions/2026-10-28-worktree-keeps-ignored-files.md`).
- [ ] Worktree mode: a hand-made file inside a directory the ignore rules match as a whole (such as
      `scratch/notes.md`) still goes when its worktree is removed.
- [x] Worktree mode: a finished worktree was kept for the `tsconfig.tsbuildinfo` the gate's typecheck wrote.
      Built: build output known by name doesn't keep a worktree
      (`decisions/2026-10-29-worktree-build-output-not-loose-work.md`).
- [x] Worktree mode: with `worktree.useRelativePaths=true` in the builder's git config (git 2.48+), every
      worktree cut failed. Built: the daemon's `git worktree add` passes the setting off.
- [x] Worktree mode: a `WorktreeRootError` at start (a bad `TENDB_WORKTREE_ROOT`, or a checkout containing
      `~/.10db`) made the desktop supervisor restart into it. Built: the daemon exits 4 with one line and the
      supervisor stops (`decisions/2026-10-28-daemon-refused-config-exit.md`).
- [ ] Batch delivery: an after-ship action per batch or task (auto_merge with gh pr merge --auto --squash, or a project deploy command), spec §9.
- [ ] Batch delivery: stacked batches, rebasing or updating an unmerged PR, and hosts other than GitHub (spec §9).
- [ ] Batch delivery: agents' gh api is GET only, so read-only GraphQL queries (always POST) are denied too; allow them if a persona needs them.
- [ ] Batch delivery: the manual acceptance on a throwaway GitHub repository (plan 08 Task 13).
- [ ] Batch delivery: fork support. The cut records the repository from `gh repo view` without `-R`, which picks the base repository by remote priority (`upstream`, then `github`, then `origin`), so a fork with an `upstream` remote records the parent repository while the push goes to `origin`. Record it from `git remote get-url origin` instead, and test a fork.
- [x] Accounts: the Accounts Settings screen (accounts spec §7, §12 point 4): list accounts with kind, verified identity and this month's usage against the cap, sign-in steps, secret entry and confirmation (plan 13, `docs/superpowers/plans/2026-10-26-10db-13-accounts-settings.md`).
- [ ] Accounts: relax staggered subscription starts once the refresh question is answered (decision 112; spike 12 refresh rerun).
- [ ] Accounts: the Factory view shows a paused workstream's account and pause reason; today the inbox card says why.
- [ ] Accounts: an account card folds per project, so an account two projects share can raise one card in each.
- [ ] Accounts: OS-level isolation (one macOS user per subscription account), if two-subscription Keychain separation fails (accounts spec §10).
- [ ] Accounts: Codex accounts (`openai_api_key`, `codex_signin`) with the Codex adapter.
- [ ] Accounts: the manual live checks, two subscriptions in parallel, an API-key or Bedrock account, a project moved mid-step and back, and the rate-limit events on a Max plan (plan 09 Task 14).
- [ ] Accounts: spike carrying a cut-off conversation to the account a project moved to (`forkSession` and `getSessionMessages` on a per-account config directory, a subscription transcript resumed on Bedrock, thinking blocks, token cost). If it passes, a small follow-up plan resumes that conversation after a move instead of starting fresh from the handoff (accounts spec §11).
- [ ] Accounts: the Accounts screen shows each project's fallback, the account it moved from and when 10db will ask to move it back.
- [ ] Accounts: an in-memory Keychain for the fake-scripts daemon, so the secret form gets an end-to-end run.
- [x] First run: propose a project's areas from the repository (workspace packages, app folders, screens) instead of one `repo` area over `**`; the folder inspection is where it would go (first-run spec §13). (Adding a project proposes areas from HEAD's files and recent commits, named by a model, for the builder to edit; Settings can call the same `proposeAreas` later. Decision `2026-10-29-propose-areas-from-the-repository.md`.)
- [ ] First run: propose a new task's areas from its description, and edit a task's areas and dependencies in the drawer (needs a task patch route).
- [ ] First run: the sandbox check as a setup row; 10db checks its sandbox when a lane starts, and a row needs a daemon probe that doesn't exist yet.
- [ ] First run: Codex as a second agent in the setup check's Agents card.
- [ ] Settings: the base branch as a Select of the checkout's branches; it needs inspection of an existing project's checkout, so it stays a text input.
- [ ] Settings: the global Models section, and the fallback model as two selects.
- [ ] Board: goals and the shaping flow (`scratch/design-note-2026-10-28-starting-work-and-goals.md`), voice capture for a task, and a sharpen assist that rewrites vague acceptance criteria.
- [ ] Desktop: a written type scale and spacing rhythm in `DESIGN.md`, with one pass over every view.
- [ ] First run: the native folder panel and the Tauri window are checked by hand; the browser run covers the form and its axe scan (`e2e/first-run.spec.ts`).
- [ ] Desktop: split the rest of `apps/desktop/src/daemon/queries.ts` and `test/fixtures.ts` per entity, as accounts already is; deferred until no big branches are in flight.
- [x] Sandbox: run approved repo stdio MCP servers under srt (decision 133, threat model §4.6), with srt measured to keep a stdio server's stdout clean.
- [x] Sandbox: let an MCP approval name the hosts its stdio server may reach, so a server that fetches its package at start (`npx -y`) or calls a web API can run (`decisions/2026-10-27-mcp-approval-hosts.md`, `.10db/mcp-hosts.json`).
- [ ] Settings: show and edit a project's MCP servers and the hosts each may reach in 10db, writing `.mcp.json` and `.10db/mcp-hosts.json` for the builder, so neither file is maintained by hand.
- [ ] MCP: recommend MCP servers for a project (search, or suggestions from the repo), each with the hosts it needs, for the builder to add and approve.
- [ ] Live acceptance: run `make live-acceptance` once to confirm its "repo MCP server connected" check passes, now that the disposable repo names `mantine`'s hosts from 10db's own `.10db/mcp-hosts.json` (measured outside the run: `npx -y @mantine/mcp-server` downloads and answers `initialize` under the MCP sandbox).
- [ ] Sandbox: Playwright's WebKit can't run in a sandboxed gate (its XPC services start outside the sandbox), so 10db's e2e runs only in CI and an unsandboxed `make gate`. Measure Chromium under srt before any project relies on browser tests in its gate.
- [ ] Sandbox: a project's sandbox additions in Settings (read paths, hosts, `.env*` exceptions such as `.env.example`), for lanes and the gate alike (D9, R3).
- [ ] Sandbox: each gate run downloads and rebuilds its cargo crates (its `CARGO_HOME` goes with its temp dir). A cache shared between runs needs a fetch that runs inside a sandbox, never outside one.
