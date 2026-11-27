# 10db working rules

These rules bind every contributor: people, Claude Code and Codex. Each app and package has its own
`AGENTS.md` with local rules, and a module or view keeps its notes in an `AGENTS.md` beside its code; read the
root file and the ones for every directory you touch, and write a note in the nearest one
(`docs/architecture/decisions/2026-11-13-module-notes-live-beside-the-module.md`).
`CLAUDE.md` files are not used here, and a test fails if one appears.

## What 10db is

A local macOS control plane that runs Claude Code sessions as a software factory. The design is
`docs/superpowers/specs/2026-10-13-10db-factory-loop-design.md`; architecture records are in
`docs/architecture/`. Say whether something is _built_ or only _designed_.

## Layout

| Path                   | Holds                                               |
| ---------------------- | --------------------------------------------------- |
| `apps/daemon`          | the TypeScript daemon: the only database writer     |
| `apps/desktop`         | the React + Mantine UI and its Tauri 2 shell        |
| `packages/agent-skill` | the `10db-task` agent skill: its files and CLI      |
| `packages/contracts`   | zod schemas: the source of API, event and MCP types |
| `packages/db`          | Drizzle schema, migrations, repositories            |
| `packages/harness`     | the plugin dir injected into managed sessions       |
| `tests/repo`           | tests that enforce these rules                      |

## Rules

- Code style: `.claude/rules/code-style.md`. Testing: `.claude/rules/testing.md`. Both bind Codex too.
- **Provider parity.** Every feature works on every kind of account 10db supports: a Claude plan,
  Claude through Bedrock or an API key, and a ChatGPT/Codex plan. A project's account is the
  builder's billing line, so 10db never asks the builder to move a project to another provider to
  use a feature. Where a provider can't do something yet, the feature still runs there and says what
  it lacks, and a follow-up task closes the gap. Specs and plans state how each feature behaves per
  provider; plan review checks it.
- **Trust the developer, contain the agent.** 10db is a developer tool for people building their own
  projects. The kernel sandbox is the security, and inside it agents work freely
  (`docs/architecture/decisions/2026-11-12-10db-trusts-the-developer-and-contains-the-agent.md`):
  - Hard limits are about consequences: destroying data, sending data out, reading secrets, and
    writing to anything live. Everything else runs.
  - A judge decides what touches a limit (Claude's auto mode, Codex's Auto-review, or 10db's judge),
    not a rulebook. Rules stay only for the sandbox's integrity and for coordinating 10db's own
    writers.
  - A task that stops to wait on the builder is a bug. Unattended work skips what crosses a limit,
    finishes the rest, and leaves one Inbox item.
  - The builder's setup comes along by default: skills, plugins, MCP servers, the project's
    instructions and the web. The builder turns things off, not on.
  - When in doubt, do what Claude Code does. A restriction Claude Code doesn't have needs a reason
    tied to a hard limit or to 10db's own coordination. Specs say which; plan review checks it.
- Import workspace packages by name through their entry point only. Packages never import apps.
- Pin every dependency exactly, latest stable when added. A held-back pin gets a decision saying
  why.
- A design decision is its own file in `docs/architecture/decisions/` (its README gives the format).
  The numbered log `decisions.md` is closed; never add a row to it.
- Generated files are never edited by hand: `packages/contracts/generated/`,
  `packages/db/drizzle/`, `apps/daemon/src/sessions/codex-generated/`. `make gate` fails when they
  drift. The Codex folder is written only by `pnpm --filter @10db/daemon generate:codex`, run on a
  Mac, and `make gate` checks its `STAMP`. The exception is a
  `drizzle-kit generate --custom` migration: it is authored by hand once and its SQL never changes.
  Until the first published release the migration baseline is regenerated instead of extended
  (`packages/db/AGENTS.md`).
- **Briefs, not documents.** Every spec, plan and end-of-run report opens with a brief of one screen
  for the builder: what changes for them, what it buys, what could go wrong and how we'd know, the
  calls they might disagree with, and what is needed from them (usually nothing). The rest is for
  agents. The builder approves by replying to the brief; with nothing needed from them, work goes ahead.
- **A roadmap is cut by the builder before it runs.** It opens with a "Builder's cut" table: each milestone is
  needed for the goal, later, or cut, and only the needed ones run. A plan is written once its predecessors
  have merged, so at most one milestone is planned ahead, and one plan's index stays under about 8,000 words; a
  bigger one is split (`docs/architecture/research/2026-11-14-build-process-audit.md` §3.2).
- **A plan is sized first, by what its code touches.** A Feature milestone's plan is one page (brief, sizes, the
  parts and their tests) built by one implementer end to end; a plan longer than its code is cut.
- **A Core milestone's plan is an index plus one card per task** (security, permissions, data loss, git,
  recovery; 10db's Careful and Critical). The index (`docs/superpowers/plans/<date>-<name>.md`) holds the
  brief, Global Constraints, provider parity, Interfaces, the state table, the tracks and one line per task.
  Each task is a card (`docs/superpowers/plans/<date>-<name>/task-<n>.md`) an implementer can work from alone: its
  files, the Interfaces signatures it implements or calls (quoted exactly), the state-table rows it handles (as
  design, not a test list), the tests it adds (only those `.claude/rules/testing.md` allows, often none), and the
  spec sections it implements, named by heading rather than restated. An implementer reads the
  index's brief and Global Constraints and its card, not the whole plan or spec, so a fresh one starts in
  minutes and a heavy track can run one implementer per card.
- **A branch generates its migrations last**, after its final merge of `main`, and only one open pull request
  adds migrations at a time. Two branches that both number migrations renumber each other at every landing.
- Done means the pull request's CI is green. Before a push outside a coordinated build, run `make check-changed` (the packages the diff
  touches and their dependents); the pre-push hook runs `make precheck`. `make gate` runs every check on the Mac
  and is optional (`docs/architecture/decisions/2026-11-13-ci-is-the-gate-before-a-merge.md`). Docs are part
  of done. An agent in a 10db lane leaves the gate to 10db, which runs it after each implement step: it runs
  only the checks for what it changed (the changed packages' tests, typecheck and lint, or the failing step's
  command) and never the full gate.
- **An agent in a coordinated build** (a long-lived integration branch that several agents merge into) does not
  run `make check-changed` before a push: it diffs against `origin/main`, so on that branch it widens to every
  package's whole suite (18-49 minutes on the Mac against 7-13 in CI's shards) and finds nothing CI would not.
  While working it runs the tests that relate to its change, typecheck and lint; before a push it runs
  `make precheck` (format, lint, typecheck, drift, and tests/repo when the change touches a file they read; no
  other tests); then it pushes a draft PR and relies on CI for
  the suite.

## Git

- Work on a branch and open a PR to `main`. Nobody pushes to `main`. PRs are squash-merged, and the
  PR title becomes the commit, so it must be a Conventional Commit too. `main` has no merge
  queue: a user-owned repository can't have one, so a pull request merges when its required checks
  pass on its own head (`docs/architecture/decisions/2026-11-02-main-has-no-merge-queue.md`). CI
  still runs on `merge_group`, which is inert without a queue.
- Sessions running in parallel each work in their own worktree, never in a shared checkout. A
  worktree made by hand goes in `10db-worktrees.noindex/` beside the checkout, a name Spotlight skips
  (`docs/architecture/decisions/2026-11-24-hand-made-worktrees-live-in-a-noindex-folder.md`; the older
  `10db-worktrees/` is still accepted while it drains):
  `git worktree add ../10db-worktrees.noindex/<name> -b <branch> origin/main`. Never put one inside the
  checkout, where the linters, tests and gate would read it too. Remove it once its work merges: once
  its PR merges, or, for an implementer's worktree that never gets its own PR, once its branch merges
  into the integration branch. Its `.dev/data/tools` is read-only, so make it writable first
  (`chmod -R u+w <worktree>/.dev`) or the removal stops part-way. Only a worktree whose change touches
  `apps/desktop/src-tauri` builds Rust; its `target/` is 1-3 GB.
  The worktrees 10db makes for its own lanes live under `~/.10db/worktrees/`.
- Commit messages are Conventional Commits with an optional scope, for example
  `fix(daemon): close the db on shutdown` or `fix: close the db on shutdown`. Allowed scopes: `daemon`, `desktop`, `contracts`, `db`,
  `harness`, `repo`, `ci`, `docs`, `deps`. The subject starts lowercase. `commitlint.config.js`
  is the source of truth.
- Name every path, in one command: `git add path/a path/b && git commit -m '...'`. A commit in its
  own command names the paths again after `--`: `git commit -m '...' -- path/a path/b`. Never
  `git add -A`, `git add .` or `git commit -a`.
- Use single quotes for `-m`; zsh runs backticks inside double quotes.
- The git hooks run gitleaks, Prettier, ESLint, `cargo fmt` and a hygiene check before each
  commit, commitlint on the message, and `make precheck` before a push. lefthook is pinned in
  `mise.toml`, not in `package.json`, and `make setup` installs the hooks with it. A hook names the
  lefthook that installed it, so the hooks name mise's copy, outside every checkout, and are the
  same whichever checkout installed them; `pnpm install` never touches them. A new clone, or a
  lefthook bump, runs `make setup` (or `mise install lefthook && lefthook install`). The hooks'
  jobs need mise activated so the pinned tools are on `PATH`; Claude Code sessions
  get mise's shims from the `SessionStart` hook in `.claude/settings.json`. When a hook fails,
  fix the cause and rerun the same command; the paths are still staged. Agents never use
  `--no-verify`, `LEFTHOOK=0`, `LEFTHOOK_EXCLUDE` or `core.hooksPath`.
- `commit --amend`, `stash`, `reset --hard/--keep/--merge`, rebases, `clean -f`, `checkout -- .`,
  `branch -D`, force pushes and pushes to `main` ask first. One exception, in the Claude guard
  and inside a worktree in `10db-worktrees.noindex/` (or the older `10db-worktrees/`) only: discarding named tracked files
  (`git checkout -- <file>`, `git restore <file>`) doesn't ask. It holds only where git runs: the
  command's cwd, or the directory that plain `cd <dir> &&` segments right before the git call lead
  to. `git -C <worktree>`, a `cd` joined by `;` or `||`, a `cd` the guard can't read or that
  CDPATH may redirect (a relative name without `./` or `../`), another command in the line, or any
  other way of pointing git elsewhere turns it off. Directories, globs, `.`, untracked paths and
  every `stash` still ask.
  A second exception, in the Claude guard, anywhere: a lone `git branch -D <branch>...` doesn't ask
  when each local branch's pull request has merged on GitHub (checked with `gh pr list`) and the
  branch tip is that pull request's head commit, so deleting it loses nothing. PRs are
  squash-merged, so `-d` refuses a merged branch. A branch with commits added after its pull
  request's head, an open or closed pull request, none, or a state the guard can't confirm (no
  network, no `gh`) still asks. The guard asks GitHub only for a deletion that would otherwise ask
  (never for `-d`), and all its lookups for one command wait at most 20 s together; a branch not
  confirmed by then counts as unconfirmed. Codex has no such check; its rule always prompts.
  A bare `git push` is judged in the directory the command runs in: the Claude guard follows a
  `cd` (and `git -C`) earlier in the same command line, so `cd ../10db-worktrees.noindex/x && git push`
  on a feature branch doesn't ask, while a `cd` to a checkout on main, or to a path it can't read
  (a variable, substitution, `~`, glob, `pushd`, `eval`, a subshell, a `cd` that may not run, a
  relative name without `./` or `../`, which CDPATH may redirect, or zsh's stack entries `+N` and
  `-N`),
  still asks, as does a push after a subshell, backtick substitution or `&` that follows a `cd`. This
  is separate from the discard exception above, which follows only `cd <dir> &&` and never `-C`.
  Inside a subagent (the hook input carries `agent_id`), where nobody can answer, every ask in the
  Claude guard is a deny instead. Its reason keeps the rule, names a way that needs no approval
  where there is one, and otherwise says to stop and report the command as blocked; the main
  session still asks. Codex's rules can't tell a subagent apart and keep prompting.
  While the builder is away the main session gets the same denies: `~/.10db/away` exists and was
  touched within a day (`touch ~/.10db/away` when the builder says they are going, `rm` it when
  they are back; it lapses on its own after a day). A deny then says to skip the command, note it
  for the builder and carry on. The file only turns asks into denies, so an agent may write it.
  Commands that ask stop an unattended session for hours: run a push as its own command
  (`cd <worktree> && git push`), never after `;` or a pipe, and leave merged branches undeleted.
- `.claude/hooks/git-guard.mjs` (Claude Code) and `.codex/rules/default.rules` (Codex) enforce
  these rules. The Claude guard fails open; only `TENDB_GIT_GUARD=off` in the environment
  Claude Code starts with disables it. It also asks before `gh pr merge --admin`, `gh api` writes
  to rulesets, environments, secrets or the repository's own settings, and `make github-settings`
  (or running `scripts/github-settings.mjs` directly).
- Contributor rules (setup, commits and scopes, squash merges, signing, AI-assisted work) are in
  `CONTRIBUTING.md`; vulnerability reports follow `SECURITY.md`. Branch and tag rules live in
  `.github/rulesets/` and repo settings in `.github/repo-settings.json`; `make github-settings`
  applies both, by hand, with admin rights (the merge queue rule included; nothing applies it
  automatically). Releases come from release-please
  (`release-please-config.json`); never edit `CHANGELOG.md` or a version field by hand.

## Subagents

| Role          | Model  | Use                                             |
| ------------- | ------ | ----------------------------------------------- |
| implementer   | sonnet | executes one plan task                          |
| researcher    | sonnet | reads docs and code, reports facts with sources |
| code-reviewer | opus   | adversarial review of a diff                    |
| plan-reviewer | fable  | review of a spec or plan                        |

Every report opens with the exact model ID it ran on. The author of a change never reviews it.
A review converges (`.claude/agents/code-reviewer.md`): round 1 lists everything, later rounds check
only the earlier findings and what their fixes broke, findings that don't block become follow-up
tasks, and after two fix rounds the work ships unless a finding blocks. A change with a UI is run
against the real daemon, by a click-through or an e2e, before it is reviewed.
`.codex/agents/*.toml` point at the same bodies. Fable answers on Amazon Bedrock (inference profile
`us.anthropic.claude-fable-5-2`), so plan-reviewer runs on it, and a code review may too.

## MCP servers

`.mcp.json` (Claude Code) and `.codex/config.toml` (Codex) declare the same servers. Mantine's docs
server is pinned to the Mantine version the UI uses; bump them together.

The Artificial Analysis server is remote and signs in with OAuth (`/mcp` in Claude Code, `codex mcp
login artificial-analysis` in Codex); never put a key or token in either file. Its terms allow reading
its data for this work but not committing it: no AA numbers in the repo, fixtures or docs.
