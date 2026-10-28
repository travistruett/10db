# 10db working rules

These rules bind every contributor: people, Claude Code and Codex. Each app and package has its own
`AGENTS.md` with local rules; read the root file and the ones for every directory you touch.
`CLAUDE.md` files are not used here, and a test fails if one appears.

## What 10db is

A local macOS control plane that runs Claude Code sessions as a software factory. The design is
`docs/superpowers/specs/2026-10-13-10db-factory-loop-design.md`; architecture records are in
`docs/architecture/`. Say whether something is _built_ or only _designed_.

## Layout

| Path                 | Holds                                               |
| -------------------- | --------------------------------------------------- |
| `apps/daemon`        | the TypeScript daemon: the only database writer     |
| `apps/desktop`       | the React + Mantine UI and its Tauri 2 shell        |
| `packages/contracts` | zod schemas: the source of API, event and MCP types |
| `packages/db`        | Drizzle schema, migrations, repositories            |
| `packages/harness`   | the plugin dir injected into managed sessions       |
| `tests/repo`         | tests that enforce these rules                      |

## Rules

- Code style: `.claude/rules/code-style.md`. Testing: `.claude/rules/testing.md`. Both bind Codex too.
- Import workspace packages by name through their entry point only. Packages never import apps.
- Pin every dependency exactly, latest stable when added. A held-back pin gets a decision saying
  why.
- A design decision is its own file in `docs/architecture/decisions/` (its README gives the format).
  The numbered log `decisions.md` is closed; never add a row to it.
- Generated files are never edited by hand: `packages/contracts/generated/`,
  `packages/db/drizzle/`. `make gate` fails when they drift. The exception is a
  `drizzle-kit generate --custom` migration: it is authored by hand once and its SQL never changes.
  Until the first published release the migration baseline is regenerated instead of extended
  (`packages/db/AGENTS.md`).
- Done means `make gate` printed `GATE PASS`. Docs are part of done.

## Git

- Work on a branch and open a PR to `main`. Nobody pushes to `main`. PRs are squash-merged, and the
  PR title becomes the commit, so it must be a Conventional Commit too.
- Commit messages are Conventional Commits with a required scope, for example
  `fix(daemon): close the db on shutdown`. Scopes: `daemon`, `desktop`, `contracts`, `db`,
  `harness`, `repo`, `ci`, `docs`, `deps`. The subject starts lowercase. `commitlint.config.js`
  is the source of truth.
- Name every path, in one command: `git add path/a path/b && git commit -m '...'`. A commit in its
  own command names the paths again after `--`: `git commit -m '...' -- path/a path/b`. Never
  `git add -A`, `git add .` or `git commit -a`.
- Use single quotes for `-m`; zsh runs backticks inside double quotes.
- The git hooks (lefthook, installed by `pnpm install`) run gitleaks, Prettier, ESLint,
  `cargo fmt` and a hygiene check before each commit, commitlint on the message, and `make check`
  before a push. They need mise activated so the pinned tools are on `PATH`; Claude Code sessions
  get mise's shims from the `SessionStart` hook in `.claude/settings.json`. When a hook fails,
  fix the cause and rerun the same command; the paths are still staged. Agents never use
  `--no-verify`, `LEFTHOOK=0`, `LEFTHOOK_EXCLUDE` or `core.hooksPath`.
- `commit --amend`, `stash`, `reset --hard/--keep/--merge`, rebases, `clean -f`, `checkout -- .`,
  `branch -D`, force pushes and pushes to `main` ask first.
- `.claude/hooks/git-guard.mjs` (Claude Code) and `.codex/rules/default.rules` (Codex) enforce
  these rules. The Claude guard fails open; only `TENDB_GIT_GUARD=off` in the environment
  Claude Code starts with disables it. It also asks before `gh pr merge --admin`, `gh api` writes
  to rulesets, environments, secrets or the repository's own settings, and `make github-settings`
  (or running `scripts/github-settings.mjs` directly).
- Contributor rules (setup, commits and scopes, squash merges, signing, AI-assisted work) are in
  `CONTRIBUTING.md`; vulnerability reports follow `SECURITY.md`. Branch and tag rules live in
  `.github/rulesets/` and repo settings in `.github/repo-settings.json`; `make github-settings`
  applies both, by hand, with admin rights. Releases come from release-please
  (`release-please-config.json`); never edit `CHANGELOG.md` or a version field by hand.

## Subagents

| Role          | Model  | Use                                             |
| ------------- | ------ | ----------------------------------------------- |
| implementer   | sonnet | executes one plan task                          |
| researcher    | sonnet | reads docs and code, reports facts with sources |
| code-reviewer | opus   | adversarial review of a diff                    |
| plan-reviewer | fable  | review of a spec or plan                        |

Every report opens with the exact model ID it ran on. The author of a change never reviews it.
`.codex/agents/*.toml` point at the same bodies. On Amazon Bedrock, dispatch plan-reviewer with
model `opus`: Fable isn't available there.

## MCP servers

`.mcp.json` (Claude Code) and `.codex/config.toml` (Codex) declare the same servers. Mantine's docs
server is pinned to the Mantine version the UI uses; bump them together.

The Artificial Analysis server is remote and signs in with OAuth (`/mcp` in Claude Code, `codex mcp
login artificial-analysis` in Codex); never put a key or token in either file. Its terms allow reading
its data for this work but not committing it: no AA numbers in the repo, fixtures or docs.
