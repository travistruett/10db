# Main merges through a GitHub merge queue, not an integration branch

- **Date:** 2026-11-02
- **Supersedes:** decisions/2026-10-30-integration-branch.md

## Decision

Pull requests reach `main` through a GitHub merge queue. A queue entry is a pull request combined with
every entry ahead of it, and it merges only when the required checks pass on that combination.

- `.github/rulesets/main-protection.json` has a `merge_queue` rule: `merge_method` SQUASH, `grouping_strategy`
  ALLGREEN, `max_entries_to_build` and `max_entries_to_merge` 5, `min_entries_to_merge` 1 with a
  `min_entries_to_merge_wait_minutes` of 1, and a `check_response_timeout_minutes` of 30, the longest a CI job
  may run (`timeout-minutes` in `ci.yml`). Squash-only stays: the `pull_request` rule's allowed methods and the
  repository's merge settings are unchanged, and the PR title is still the commit on `main`.
- `.github/workflows/ci.yml` runs on `merge_group` (`checks_requested`) as well as on pull requests and pushes
  to `main`. All five required checks report on a queue entry: `gate`, `desktop`, `policy` and `cargo-deny`
  run; `dependency-review` is skipped by its `if: github.event_name == 'pull_request'`, and a required check
  skipped that way counts as passing (the pull request already ran it, and the action has no pull request to
  diff on a queue entry). `policy` diffs the entry's own `merge_group.base_sha` to `merge_group.head_sha`. The
  PR title lint stays pull-request-only. `codeql.yml` is not a required check, so it is left as it is.
- The ruleset is applied by hand, with admin rights, by `make github-settings`. No workflow, hook or lane
  applies it, and a lane never runs it (the git guard asks before it does).
- Tasks no longer land in an integration branch `next`. A task's pull request goes to `main` and is queued
  (`gh pr merge --auto --squash` queues it). The daemon's `next` handling is changed by its own task; this
  record covers the repository's rules and CI.

## Why

On the overnight run of 2026-11-01 to 2026-11-02, pull requests that each passed CI alone broke `main` together:
#414 and #422 each merged green, and their combination left `main` failing typecheck at
`apps/daemon/src/watcher/watcher.ts:866`. `main`'s ruleset does not require a branch to be up to date
(`strict_required_status_checks_policy` is false), so a pull request's CI never saw the other's change.
Requiring up-to-date branches instead would make every pull request rebase and rerun after each merge, which
is the per-task wait and conflict churn that `next` was made to remove.

The integration branch addressed that churn but not this: breakage collects in `next` and shows up only when
the one pull request from `next` into `main` runs CI, after the tasks that caused it have finished, and the red
result has to be traced back to them. A merge queue tests the combination before it merges, so a red `main`
from two green pull requests cannot happen, the failing entry is the one that is removed, and tasks keep their
own pull requests, each squash-merged into `main` with its own title as the commit. It also needs no second
branch, no `next` ruleset (the earlier plan needed one so the first cut would not delete `next`), no merge-back
and no cut procedure.

The cost is CI time: every entry runs the required checks again on the queue branch, about ten minutes for
`gate`, and entries build in parallel up to 5 so the wait does not multiply. ALLGREEN means an entry merges
only when the whole group ahead of it is green, so one red entry cannot land with its neighbours. `main`
still gets the push run after the merge. `check_response_timeout_minutes` is 30, not 10: `desktop` may take
that long with a cold Rust cache, and a required check that has not reported by the timeout removes the entry.

Turned down: an integration branch, for the reason above; and requiring branches to be up to date, for the
churn.
