# Pull requests may be queued to merge once their required checks pass

- **Date:** 2026-10-28

## Decision

`.github/repo-settings.json` sets `allow_auto_merge: true`, so `gh pr merge --auto --squash` (or the
"Enable auto-merge" button) queues a pull request and GitHub squash-merges it when the `main-protection`
and `main-review` rulesets are satisfied. The rulesets don't change: the same required checks, review-thread
resolution and code-owner review gate a queued merge as gate a manual one.

## Why

A merge attempted while the required checks are still running is refused by the ruleset, and without
auto-merge the only alternatives are waiting at the PR or `--admin`, which skips the checks. Queueing keeps the
checks in charge and removes the wait.

It is also what the batch-delivery design's later "auto-merge on ship" action relies on
(`docs/superpowers/specs/2026-10-21-10db-batch-delivery-design.md`, `gh pr merge --auto --squash`).

Who merges doesn't change: a merge, queued or not, stays the builder's call. Turned down: keeping it off and
merging by hand after CI, which is the wait this removes.
