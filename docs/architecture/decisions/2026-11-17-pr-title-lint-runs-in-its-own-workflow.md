# The pull request title lint runs in its own workflow, and CodeQL leaves pull requests

- **Date:** 2026-11-17
- **Amends:** `decisions/2026-11-06-ci-splits-the-gate-into-required-jobs.md` (the required checks) and
  `decisions/2026-11-02-merge-queue.md` (CodeQL is left as it is)

## Decision

- The title lint (`printf '%s\n' "$PR_TITLE" | pnpm exec commitlint`, the title passed through `env`) leaves
  `ci.yml`'s `policy` job for `.github/workflows/pr-title.yml`, whose one job is `pr-title`. It runs on
  `pull_request` into `main` for `opened`, `synchronize`, `reopened` and `edited`, and on `merge_group`, where its
  `if` skips it as `dependency-review`'s does.
- `ci.yml` runs on `pull_request` for `opened`, `synchronize` and `reopened` only. A title edit starts `pr-title`
  and nothing else.
- `pr-title` is a required check in `.github/rulesets/main-protection.json`, after the thirteen from `ci.yml`:
  fourteen in all. The maintainer applies it with `make github-settings` after the pull request that adds the
  workflow merges.
- `codeql.yml` runs on pushes to `main` and on its weekly schedule, not on pull requests.
- `tests/repo/src/ci.test.ts` fails when a workflow other than `pr-title.yml` runs on `edited`, when `pr-title.yml`
  gains a job, when another workflow reports a `pr-title` check, or when CodeQL runs on a pull request again.
  `tests/repo/src/governance.test.ts` keeps the ruleset equal to `ci.yml`'s checks plus `pr-title.yml`'s.

## Why

- Squash merge makes the title the commit on `main`, so the title must be linted again when it changes. With the
  lint in `ci.yml`, an edit reran all of the gate's jobs.
- GitHub rolls up required checks by name on the head commit, and a skipped job counts as passing. A gate job
  skipped on `edited` would replace an earlier red result with a green one, so the edit cannot be filtered inside
  `ci.yml`. A workflow of its own is the one way for an edit to start the title check alone while every gate job
  keeps its last result.
- Without `pr-title` in the ruleset, a bad title would not block a merge. Until the ruleset is applied, it does
  not.
- Retargeting a pull request's base to `main` fires only `edited`, so `ci.yml` waits for the next push, or a close
  and reopen. Its required checks are missing until then, so the pull request is blocked, not falsely green.
- CodeQL is advisory, not required, and took about nine minutes of every pull request. Pushes to `main` and the
  weekly run still analyse everything that merges.
