# Decisions

Append-only. A row that replaces an earlier one says "Supersedes N" in its Why column.

## Repository governance

Decided in `docs/superpowers/specs/2026-10-14-10db-repo-governance-design.md` §2, which gives the reasons. The numbering is the spec's and independent of the decision log below.

| # | Decision | Enforced by |
|---|---|---|
| G1 | No contributor agreement; Apache-2.0 §5 covers contributions. | `CONTRIBUTING.md` |
| G2 | Conventional Commits with a fixed, required scope list. | `commitlint.config.js` on every commit; the `policy` job on the PR title |
| G3 | Squash merge only; the PR title becomes the commit on `main`. | `.github/repo-settings.json`, `.github/rulesets/main-protection.json` |
| G4 | Signed commits on `main`; GitHub signs squash merges. | `.github/rulesets/main-protection.json` |
| G5 | lefthook git hooks, installed by the root `prepare` script. | `lefthook.yml` |
| G6 | mise pins every non-npm tool with checksums and replaces `.node-version`; CI uses the same file. | `mise.toml`, `mise.lock` |
| G7 | Renovate for dependency updates. | `renovate.json` |
| G8 | One SemVer version for the repo, from `0.1.0`, released by release-please in manifest mode. | `release-please-config.json`, `.release-please-manifest.json` |
| G9 | macOS releases are Apple Silicon only, signed, notarized and stapled. | plan `05-release` |
| G10 | Rulesets and repo settings live as JSON and are applied by `make github-settings`. | `.github/rulesets/`, `.github/repo-settings.json`, `scripts/github-settings.mjs` |
| G11 | The pre-existing commits are reworded to Conventional Commits before the first push. | plan `04-go-public` |

How M0 implements them, where the spec leaves a choice:
- The commit scope is required (`scope-empty: never`), so every commit names its area.
- The pre-push hook refuses updating or deleting the remote `main`, but allows creating it, which is the new repository's first push.
- `main` has two rulesets, because a ruleset bypass skips every rule in that ruleset. `main-protection` has no bypass actors: PRs only, squash, linear history, signed commits, no force push or deletion, the five required checks and resolved conversations bind everyone, the admin included. `main-review` holds only the code-owner approval, and the repository admin can bypass it on a pull request, so Travis can merge his own PRs without a second reviewer but never before the checks pass.
- release-please's PR title is `chore(repo): release ${version}`, because its default scope `main` isn't on the list.

## Decision log

| # | Decision | Why |
|---|---|---|
| 1 | The first slice is the factory loop: board → batch → managed sessions → automatic handoff → inbox → verified done. | It removes most of the traced manual steps. |
| 2 | Clean handoff at a context threshold is the default. Compaction is only an emergency fallback, and is logged. | A fresh, curated context is cheaper per turn and leaves a structured record. Blocking compaction outright fails requests during context-limit recovery. |
| 3 | Managed headless sessions are the default. "Open in terminal" is an explicit, serialized takeover. | Structured events power the inbox, like the Codex app. A session is never driven two ways at once. |
| 4 | Claude first. The session interface is designed for several providers, and Codex is the next adapter. | Claude subscription use is documented as allowed. Codex's third-party terms are unknown and its app-server is experimental. |
| 5 | The runtime is the official TypeScript Claude Agent SDK, pointed at the user's installed `claude` binary. Raw `claude -p` stream-json is the fallback adapter. | Typed events, a permission callback, hooks as functions, resume by id, context usage. The least protocol code to own. |
| 6 | 10db's SQLite owns tasks, decisions, deviations, handoffs, proposals, sessions and events. Agents write only through MCP tools. Markdown is exported, never authoritative. | One writer per concept. gbrain's Markdown-plus-DB design was its largest source of drift bugs. |
| 7 | The harness is injected at launch: plugin dir, settings and per-session MCP config. Repos keep only `AGENTS.md`. | One version to maintain, nothing to copy between repos, and the same behavior on every machine. |
| 8 | Tauri 2 shell, a TypeScript daemon, one pnpm monorepo. | The builder's choice. TypeScript everywhere except a thin Rust shell. |
| 9 | No LangGraph or Pydantic AI. A hand-rolled state machine sits behind an interface. | Claude Code is the agent; 10db needs only a status workflow. A framework adds a second language and a second source of truth. |
| 10 | SQLite (WAL) via Drizzle, with FTS5 and no embeddings. | It is mature and can be inspected live with `sqlite3`. gbrain's PGlite record shows unclean-shutdown corruption, deadlocks and lock bugs. gbrain's own evals show vector search adds little over keyword search. |
| 11 | Picker: rules choose candidates, then a skippable PM-agent review, then the builder approves. | Rules are fast and predictable. Some judgment helps. |
| 12 | The pilot project first, then 10db manages its own build. | Real backlog and real pain first, then dogfooding. |
| 13 | One shared checkout per repo, enforced (§8). Worktrees come later, per task. | Worktrees duplicate Docker, databases and ports, and complicate QA. The real collisions were git and staging collisions, which serialized git fixes. Claims schedule work; they don't sandbox it. |
| 14 | Kanban board plus brainstorm. Brainstorm suggestions are pending proposals, never applied silently. | Planning in the same place. Proposals are the mechanism PDF intake reuses. |
| 15 | Personas, flows and per-project teams are configurable. Humans are team members, with routing rules. | Different projects need different spend and specialists, and questions route to the right human. |
| 16 | No named tiers. Each step is right-sized to the cheapest model and effort at or above its need, under the project's budget ceiling, escalating on failure. | This matches the model-and-effort mental model, and the frontier can be visualized later. |
| 17 | The knowledge layer has decisions, principles and facts with you, project or area scope. Agents only propose principles. Supersession is by a fixed key. Every write needs provenance. | Learned from an earlier private knowledge repo and gbrain. It stops repetition across projects. |
| 18 | Keep the Mac awake while lanes run. | It retires the `caffeinate` tab. |
| 19 | Apache-2.0. | Permissive, with an explicit patent grant and contribution terms. |
| 20 | Type-aware ESLint (typescript-eslint strict-type-checked), Prettier, the strictest TypeScript, enforced boundaries, knip, exact pins, and zod at every boundary. | The builder wants really robust, modern, idiomatic code, and type-aware rules catch daemon bugs. |
| 21 | TypeScript 7 (`tsc`) typechecks; the TypeScript 6.0 API is installed alongside under the `typescript` name (`npm:@typescript/typescript6`) for ESLint and knip. Drop the alias when typescript-eslint supports the TypeScript 7.1 API. | TypeScript 7 is much faster but ships no compiler API until 7.1; typescript-eslint requires `typescript` < 6.1. This is the side-by-side setup the TypeScript team recommends. |
| 22 | Node 26 (pinned 26.11.1) instead of Node 24. | Node 26 becomes LTS on 2026-10-28 and Node 24 enters maintenance on 2026-10-20; the builder prefers the most modern stable toolchain. |
| 23 | TanStack Router with code-based routes, not file-based generation. | No generated route tree to drift-check; four routes don't need a generator. |
| 24 | React Compiler through Babel (`@rolldown/plugin-babel`), not the Rust compiler in `@vitejs/plugin-react`. | The Rust React Compiler is marked experimental; the Babel one is stable. Revisit when the Rust one is stable. |
| 25 | Import boundaries are enforced with `no-restricted-imports` patterns, not `eslint-plugin-boundaries`: workspace packages through their entry point only (M0), and daemon modules through their `index.ts` only (M1a). | Workspace imports resolve through package exports, which the boundaries plugin can't see without an extra resolver; the daemon's modules are one flat level deep, so two path patterns express the rule exactly with no extra dependency. |
| 26 | `eslint-plugin-jsx-a11y` runs on ESLint 10 through `@eslint/compat`'s `fixupPluginRules`, with a pnpm peer-rule allowance. | Its last release declares ESLint ≤ 9; the shim restores the context APIs ESLint 10 removed. Revisit when it publishes ESLint 10 support. |
| 27 | Permission grants live in a `permission_rules` table (project or workstream scope, tool, optional command prefix). An allow (base, gate or stored rule) only covers a plain command segment: no redirection beyond `2>&1` or `>/dev/null`, no `NAME=value` prefix, no `$` or backtick, no command-carrying wrapper flags; anything else raises a card. "Always for this project" on a command with no safe prefix acts as allow-once. | Spec §7's "always for this project writes an allow rule" needs a home; a table is queryable and auditable, unlike settings JSON. A rule that matched a prefix of a compound or expanded command would approve more than the builder saw. |
| 28 | Flag, proposal and review cards close straight to RESOLVED when answered; only question and permission cards deliver to waiting sessions. In M1 a review card only acknowledges; reopening work from it arrives with flows in M2. | They have nothing to deliver; skipping DELIVERING keeps recovery's redelivery pass to cards that need it. |
| 29 | The workstream state machine lives in `@10db/contracts`, not the daemon. | The database layer enforces it on every transition and the UI can show which actions are allowed; both import the same table. |
| 30 | `commit` stamps a `10db-Op: <opId>` git trailer and checks for it before committing. | It makes a retried commit idempotent even when the daemon crashed between the git commit and recording the operation. |
| 31 | One shared daemon log (`logs/daemon.log`, rotated at startup past 10 MiB, 5 kept) with `workstreamId` on every runner line, instead of a file per workstream for now. | The Factory detail view (M2) is the first reader of per-workstream logs; filtering by field covers M1 debugging. |
| 32 | Hazard claims are exclusive per hazard name (two workstreams can't both hold `deps`), not one hazard workstream per repo. A hazard command matches on its words with flags and flag values dropped, so `pnpm -w add`, `pnpm --filter x add` and `pnpm i` need the `deps` claim too. Git is an allowlist (read-only verbs, branch listing, `push` with its own checks). The guard is defense in depth for a cooperative agent, not a sandbox. | The spec's "hazard work never runs in parallel" is met per hazard; a repo-wide hazard mutex would serialize unrelated migrations and dependency work. Revisit if real collisions say otherwise. A literal prefix match was trivially bypassed by a flag before the subcommand. Git through 10db's commit tool, claims and the watcher are the other layers. |
| 33 | `inbox.answer` applies what an answer implies in the answer's own transaction: permission rules for `allow_workstream` / `allow_project`, and a proposal's status and rationale. An `allow_once` that arrives after the workstream was parked becomes a one-time allowance for the identical call in the resumed session. | The asking session may have been parked before the builder answered, so the broker can't be the only place a choice takes effect. |
| 34 | Recovery signals a stored pid only while its OS start time (`ps -o lstart=`, recorded when the session or gate started) still matches; a running gate's process group is recorded on the workstream so recovery can kill it. | After a reboot a stored pid can belong to an unrelated process; a detached gate survives `kill -9` and would otherwise run twice in one checkout. The `started` session event is unchanged, because the daemon looks the start time up itself. |
| 35 | A clean stop writes `daemon.clean_shutdown` to `app_settings`; the next start passes it to recovery, which then keeps `recoveryAttempts` unchanged. A session that ends in `handoff` or `step_done` resets `recoveryAttempts` to 0. | Spec §5.4 counts failed attempts: quitting the app three times must not fail a long task, and the limit is about consecutive failures, not lifetime ones. |
| 36 | Claims are released when the workstream reaches DONE, CANCELLED or FAILED (including a recovery that fails it), never by lease expiry. `claims.lease_expires_at` follows the workstream lease for diagnostics. | Claims belong to the workstream, recovery re-queues the same holder, and every terminal transition releases them, so expiry would only add a race. Spec §8.1's "released when the lease expires" needs rewording to match (open item). |
