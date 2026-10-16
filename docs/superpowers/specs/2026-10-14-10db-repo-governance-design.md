# 10db repo governance: commits, hooks, CI, releases and public-repo rules

**Status:** design approved section by section on 2026-10-14; this document awaits review.
**Applies to:** the 10db repository itself, not the target repos that 10db manages.

## 1. Intent

10db goes public on GitHub. Before the first push, it needs clear rules for commits, versioning, hooks, security
and standardization, and machines must enforce them rather than docs merely describing them. The rules follow
current (2026) best practice, not old in-house repos, which were surveyed only for reusable patterns.

**Who commits:** Travis, a few trusted friends, and AI agents (Claude Code and Codex). The same rules bind all of
them.

**Success means the first push already has:**
- a protected `main`;
- a history free of secrets and private details;
- enforced Conventional Commits;
- a documented and automated release path;
- a security policy;
- every rule checked both locally and by a required CI check.

**Principle:** local hooks give fast feedback, and CI enforces. Anyone can skip a hook, so every hook rule has a
required CI twin that runs the same command.

## 2. Decisions

| # | Decision | Why |
|---|---|---|
| G1 | No contributor agreement. Apache-2.0 §5 covers contributions, and `CONTRIBUTING.md` says so in one line. | A small trusted group; a DCO or CLA would add friction for no gain. |
| G2 | Conventional Commits, enforced by commitlint (`@commitlint/config-conventional`) with a fixed scope list: `daemon`, `desktop`, `contracts`, `db`, `harness`, `repo`, `ci`, `docs`, `deps`. Trailers such as `Co-Authored-By:` are allowed. | Machine-readable history drives the changelog and the version bump. |
| G3 | Squash merge only. The PR title becomes the commit on `main` and is checked as a Conventional Commit. | One revertable commit per PR and a clean `main`. |
| G4 | Signed commits are required on `main` by ruleset. GitHub signs squash merges. SSH signing is encouraged on branches but not required. | Verified history on `main` without blocking friends or agents. |
| G5 | Git hooks: **lefthook**, pinned as a pnpm dev dependency and installed by the root `prepare` script. | One fast binary and one config; it handles TS, Rust and standalone tools without Python. |
| G6 | Tool pins: **mise** (`mise.toml`) pins Node, pnpm, Rust, gitleaks, actionlint and zizmor, with checksums. It replaces `.node-version`, and CI uses the same file. | One pinned manifest for every non-npm tool, locally and in CI. |
| G7 | Dependency updates: **Renovate**. | Handles `mise.toml`, SHA-pinned actions with version comments, Cargo and pnpm; respects release age; groups updates. |
| G8 | One SemVer version for the whole repo, starting at `0.1.0`, released with **release-please** (manifest mode). | The only shipped artifact is the desktop app; internal packages stay private and unversioned. |
| G9 | macOS releases are **Apple Silicon (arm64) only**, signed with a Developer ID, notarized and stapled. | Clean installs for users; Intel isn't supported. |
| G10 | GitHub rulesets and repo settings live as JSON in the repo and are applied by an idempotent `make github-settings` script that calls `gh api`. | Reviewable config without Terraform. |
| G11 | Before the first push, reword the 3 existing unpushed commits to Conventional Commits. Travis gives explicit OK at that step. | They have never been pushed, so nobody else sees the rewrite. |

## 3. Local hooks (`lefthook.yml`)

**pre-commit** runs on staged files only, in parallel:
- `gitleaks git --pre-commit --staged`.
- Prettier `--check` and ESLint (`--max-warnings=0`) on staged files.
- `cargo fmt --check` when `.rs` files are staged.
- Hygiene:
  - conflict markers;
  - files over 1 MB;
  - case-insensitive path collisions;
  - refusing anything staged under `scratch/` or `.claude/settings.local.json`.

**commit-msg:** commitlint (G2).

**pre-push:**
- `make check`: typecheck, lint and unit tests. The full `make gate` stays in CI.
- Refuse pushes to `main`.

**Agent layer.** This is M0's `.claude/hooks/git-guard.mjs` plus a new `.codex/rules/default.rules`:
- **Deny** every way an agent could skip or reroute the hooks:
  - `--no-verify`, including the prefixes git accepts (`--no-verif`, `--no-v`), and `commit -n`;
  - lefthook's switches: `LEFTHOOK=0`, `LEFTHOOK_EXCLUDE`, `LEFTHOOK_CONFIG` and `LEFTHOOK_BIN`;
  - `core.hooksPath`, whether set by `git config`, `-c`, `--config-env` or the `GIT_CONFIG_*` variables.

  The Claude guard also judges the command inside `bash -c`, `sh -c` and `eval`. It asks before anything that
  writes under `.git/hooks` or runs `lefthook uninstall`. Its only kill switch is an environment variable that a
  Bash command can't set for the hook; there is no kill-switch file an agent could create.
- **Ask** before the commands that change GitHub's enforcement, because agents run with Travis's admin `gh`
  login: `gh pr merge --admin`, `gh api` writes to rulesets, environments or secrets, `gh secret set` and
  `make github-settings`.
- **Port** the remaining rules from the pilot project's git guard that fit a PR-based repo:
  - ask on `commit --amend`, `stash`, `reset --hard/--keep/--merge`, `rebase`, `clean -f`, `filter-repo`, force
    push and push to `main`;
  - warn on broad `git add`.
- **Keep** M0's existing rules.

Codex rules are prefix-only: a rule matches the command's leading words, so a flag after the message
(`git commit -m x --no-verify`) or an env assignment with an arbitrary value (`LEFTHOOK_EXCLUDE=…`) goes
unmatched. Codex therefore prompts on every `git -c` and `gh pr merge`, and the required CI checks are the
backstop.

Humans can still skip hooks; CI catches the result.

## 4. CI (`.github/workflows/`)

**Required on every PR:**
- **`gate`** (Ubuntu) and **`desktop`** (macOS), as in M0 Task 12. Apply the M0 review fix: an explicit Rust skip
  in the Ubuntu job.
- **`policy`**, which runs:
  - commitlint on the PR title;
  - gitleaks over the PR's commit range;
  - actionlint and zizmor over the workflows;
  - Prettier, ESLint and `cargo fmt` over the whole tree.
- **`dependency-review`** (`actions/dependency-review-action`). It fails on new dependencies with high or
  critical advisories, or with licences incompatible with Apache-2.0 distribution (GPL, AGPL and similar).
- **`cargo-deny`**: advisories, licences, bans and sources for the Rust crates.

**Advisory:**
- CodeQL for JavaScript/TypeScript and Actions;
- OpenSSF Scorecard, weekly, with a README badge;
- `pnpm audit`, weekly. This replaces M0's per-PR advisory `audit` job.

**Workflow hardening**, enforced by a repo test like M0's `ci.test.ts`:
- every action is pinned to a full SHA, with a `# vX.Y.Z` comment;
- top-level `permissions: {}`, and each job grants only what it needs;
- `persist-credentials: false` on every checkout;
- no `pull_request_target`;
- no `paths` filters on required workflows;
- secrets only appear in jobs bound to a protected environment.

**pnpm supply chain** (`pnpm-workspace.yaml`):
- `minimumReleaseAge` of 1 day;
- install scripts denied by default, with an explicit allowlist (e.g. `better-sqlite3`, `esbuild`).

The plan must confirm the exact pnpm 12 setting names against the pnpm docs before writing them.

## 5. Versioning and releases

**Version.** SemVer from `0.1.0`. Before 1.0, a breaking change bumps the minor version. The UI/daemon
`PROTOCOL_VERSION` stays independent.

**release-please:**
- It keeps a Release PR open from the Conventional Commits on `main`.
- It updates `CHANGELOG.md`, and the version in root `package.json`, `apps/desktop/src-tauri/tauri.conf.json`
  and `apps/desktop/src-tauri/Cargo.toml` (the generic, json and toml updaters).
- Merging the Release PR tags `vX.Y.Z` and creates a draft GitHub Release.
- release-please authenticates with a token from a private GitHub App, `10db-release-bot`. A default
  `GITHUB_TOKEN` wouldn't trigger the Release PR's required checks.

**The release build** runs on the tag, in the protected `release` environment, which needs Travis's approval and
deploys from `v*` tags only:
1. `tauri build` for `aarch64-apple-darwin`.
2. Codesign with the Developer ID, notarize with `notarytool` using an App Store Connect API key, and staple.
3. Upload the DMG and `SHA256SUMS`, plus build provenance attestations from `actions/attest-build-provenance`.
4. Publish the draft Release only after every step succeeds.

**Secrets**, all in the `release` environment only: the certificate `.p12`, its password, the API key, the issuer
ID and the team ID.

**Tags.** Two rulesets on `refs/tags/v*`, split for the same reason as `main`'s (a bypass covers every rule in
its ruleset):
- **`tags-immutable`** restricts updates and deletions and has no bypass actors, so nobody can move or delete a
  release tag, the release bot and Travis included.
- **`tags-create`** restricts creation, and the release bot is its only bypass actor. Only the bot can create a
  `v*` tag, and its bypass reaches no further.

The "Go public" plan proves this live: the bot creates a test tag, then the bot and Travis both fail to move or
delete it. Removing the test tag means disabling `tags-immutable` for that one deletion and re-applying the
rulesets.

**Deferred:** in-app auto-updates (the Tauri updater and its own signing key).

## 6. GitHub settings and community files

**Rulesets** live in `.github/rulesets/` and are applied by `make github-settings`.

`main` has two rulesets. A ruleset bypass skips every rule in that ruleset, so the review rule sits in a ruleset
of its own.

**`main-protection`**, with no bypass actors:
- changes through PRs only (a `pull_request` rule with 0 required approvals), squash merge only, and linear
  history;
- signed commits;
- no force pushes or deletion;
- the checks `gate`, `desktop`, `policy`, `dependency-review` and `cargo-deny`, each pinned to the GitHub Actions
  App (`integration_id` 15368), so a commit status posted through the API can't stand in for one;
- conversations resolved before merging.

**`main-review`**, which the repo admin can bypass:
- a `pull_request` rule with 1 required code-owner approval, and stale approvals dismissed on push.

Travis merges his own PRs by bypassing `main-review` only. `main-protection` still requires the PR and the
checks. The "Go public" plan verifies this layering live with a test PR that leaves the workflows alone: it must
stay unmergeable while red, even for the admin.

**Residual: a PR can change its own checks.** On `pull_request`, each check runs from the PR's own copy of the
workflows. A PR that edits `.github/workflows/` (or the hook, commit or tool config they run) can therefore turn its
own checks green. A user-owned repo has no required-workflow or file-path rulesets that would close this fully. So:
- `CODEOWNERS` names Travis for `.github/`, `lefthook.yml`, `commitlint.config.*`, `mise.toml`, `mise.lock`,
  `.claude/` and `.codex/`, on the file's last lines. A friend's PR can't bypass `main-review`, so any change it
  makes there needs Travis's code-owner review.
- Travis's own PRs are trusted: he bypasses `main-review` and reads any such diff himself before an `--admin`
  merge.
- Agents work under Travis's `gh` login, so their PRs are his PRs. The agent guard asks before every
  `gh pr merge --admin`, which puts Travis in front of that merge.

The tag rulesets are described in §5.

**Repo settings** (the same script):
- squash merge only, with the PR title as the default message;
- branches deleted after merge;
- secret scanning and push protection on;
- private vulnerability reporting on;
- Dependabot alerts on;
- approval required for first-time contributors' workflows.

**Files:**
- `SECURITY.md`: private reporting through GitHub; only the latest release is supported.
- `CONTRIBUTING.md`:
  - setup with `mise install && pnpm install`;
  - the commit rules and scopes;
  - squash merges;
  - an SSH-signing how-to;
  - the Apache-2.0 §5 line;
  - an AI-assisted contributions note: welcome, the human submitter is responsible, and trailers are fine.
- `.github/CODEOWNERS` (`* @travistruett`, plus the CI, hook and agent paths above).
- `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1).
- `.github/pull_request_template.md`.
- `.github/ISSUE_TEMPLATE/` with bug and feature forms, plus a `config.yml` that turns off blank issues and points
  security reports at private reporting.
- `AGENTS.md`: its Git section links all of this.

## 7. Rollout

1. **Fold into M0**, by task:
   - Task 1: `mise.toml`.
   - Task 3: the agent-layer additions and the Codex rules.
   - A new task after Task 4: lefthook, commitlint and gitleaks, with tests that the configs reject bad input.
   - Task 12: the `policy`, `dependency-review` and `cargo-deny` jobs and the hardening test.
   - Task 13: release-please config, `CHANGELOG.md` and the community files.
   - Keep decision numbering consistent: M1a hard-codes decisions 27–36 and M1b 37–53, so new rows go after 53
     or into a separate governance table.
2. **New plan, "Go public".** Every step is outward-facing, so Travis is at the keyboard:
   1. Run gitleaks over the full history and grep for private details.
   2. Reword the 3 existing commits (G11).
   3. Create the GitHub repo, and push `main` once. The `main` ruleset would block this push, so it has to
      happen before step 4.
   4. Run `make github-settings`, which applies the rulesets and settings.
   5. Install the Renovate app.
   6. Create the `10db-release-bot` App.
   7. Push the working branch and open the first PR. It must pass every required check.
3. **New plan, "Release",** before v0.1.0: the signed build workflow, the `release` environment and the Apple
   secrets.
4. **Scrub before the first push:** replace the one absolute local path (the user-specific `claude` binary path
   in the spikes plan) with `$(which claude)`.

## 8. Out of scope

- Rules for the target repos that 10db manages; those are product behaviour, defined in the factory-loop spec.
- Auto-updates, npm publishing, Intel builds, a DCO or CLA, and Terraform.
