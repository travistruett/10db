# A pull request's required checks decide whether a task ships; the Mac runs a per-project pre-check

- **Date:** 2026-10-31
- **Amends:** `decisions/2026-10-29-sandbox-is-the-boundary.md` (item 3, designed only until now),
  `decisions/2026-10-30-changed-packages-check-per-step.md` (the pre-check replaces that check where set),
  `decisions/2026-10-29-where-a-pull-request-lands.md` as amended by #174 (no merge at once on a pre-check alone),
  `decisions/2026-10-30-integration-branch.md` (`next` is retired once this is built)

## Decision

Design: `docs/superpowers/specs/2026-10-31-10db-ci-decides-design.md`.

- **A per-project pre-check** (`projects.precheck_command`, unset by default, refused without a gate command)
  runs on the Mac in place of the gate, after each implement step and before the push, for pull request
  delivery. Unset, everything runs as before. 10db reads no rulesets or branch protection to choose it.
- **GitHub's required checks decide** through what main already has: auto-merge waits for them, and a task is Done
  when its pull request merges. When only the pre-check ran, GitHub answers "clean status" and the pull request
  has no required checks, 10db does not merge at once; it raises a card and leaves the pull request for the
  builder. Required checks that already passed are merged at once, as before.
- **A failed required check starts a fix**: the pull request watch reads `gh pr checks --required`, and for a
  failing head reads the failing Actions job's log and makes a fix task in a follow-up batch cut from the pull
  request's branch at that head, which pushes to the same pull request. No batch state is added: the batch that
  opened the pull request stays `SHIPPED`. A unique `(ci_fix_of, ci_fix_head)` makes one fix per head.
- **At most two fixes per pull request.** A fix with no commits of its own, a third failure, a failure with no
  log to read, or a fix batch that cannot be cut stops fixing: the task is Blocked, and a card offers a rerun of the failed jobs. A passing or newer
  run, or the pull request closing, clears it. Auto-merge stays armed during a fix.
- **The card's pull request line** says CI running, passed or failed (with the job and the fix), or conflicts,
  with a link to the job or the checks page.
- **One function, `ciFailureAction`, decides wait, fix or stop**, so a decision model can later add a rerun
  choice without touching the rest.

## Why

The full gate ran twice per task on a saturated Mac, then GitHub ran the same checks. GitHub already waits for
required checks before auto-merge, and #156 already makes Done mean merged, so CI decides once 10db stops running
the full gate in front of it.

Turned down: a `CHECKING` batch state with the batch reopened for a fix, which needed a guard on every reader of
"pushed, pull request open", a reopen protocol and its own recovery (the 2026-10-30 design, 1,123 lines, rejected
at QA after eleven rounds); reading the base's rules before each ship, which needs classic-protection rights and a
per-step cache, where the builder's setting plus GitHub's own "clean status" answer cover the same cases; running
the changed-packages command in a "CI mode" switched by an environment variable, where a command of its own is
plainer; disarming auto-merge during a fix, since a rerun that passes is CI approving the merge; and the
integration branch and its cuts, a stopgap for slow runs that this replaces.
