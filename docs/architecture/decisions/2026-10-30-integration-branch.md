# Tasks land in an integration branch; one pull request into main runs CI

- **Date:** 2026-10-30

## Decision

While 10db builds itself, the tasks it runs land in an integration branch, `next`, through per-task landing
("merge into another branch"), instead of main. A task's pull request into `next` merges once 10db's own
checks before the push pass. GitHub CI (`.github/workflows/ci.yml`) runs only on pull requests into main and
on pushes to main, so a task's pull request into `next` waits on nothing on GitHub. When the builder says so,
one pull request from `next` into main is opened; it runs the full CI, and main's ruleset still requires it.
`next` has no ruleset of its own.

The task "Let GitHub CI decide whether a task ships, with only fast checks on the Mac" designs what checks a
pull request into `next` gets and how a red result on the `next` → main pull request is traced back to the
tasks that caused it. Until it lands, 10db's local gate before the push is the only check a task gets.

## Why

On 2026-10-29 and 2026-10-30 most of a task's time after its work was done went to waiting: about eight
minutes of local gate, then about nine of GitHub CI, then conflicts with every other open branch each time one
merged into main, each resolved by hand. With every task racing main, two lanes produced a conflict on nearly
every pull request. In `next`, tasks build on each other as they land, conflicts are rare and small, and full
CI runs once per batch of work rather than once per task.

Committing straight to main was turned down: main changes only through a pull request (root `AGENTS.md`), and
its ruleset requires the CI checks. The cost of `next` is that breakage collects there until the `next` → main
pull request runs CI, and that pull request is larger to review.
