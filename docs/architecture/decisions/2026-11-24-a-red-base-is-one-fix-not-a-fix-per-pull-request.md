# A red base is one fix of the base, never a CI fix per pull request

- **Date:** 2026-11-24

## Decision

- Before a CI fix starts, each failing required check is sorted by name against the checks that last
  finished red on the pull request's base branch (`delivery/ci-failure-class.ts`). A check red on the base
  too is the base's: no fix batch and no per-pull-request card start for it. One Inbox card per repository
  and base branch says the base is red and how many pull requests wait on it, and goes when none waits.
  When the base passes the check again, 10db merges the base into a pull request that lands itself and
  pushes it (its own catch-up cause, which skips the "checks never started" guard and keeps the merge-queue,
  running-fix and branch-in-use guards), or runs the failed jobs again for one the builder merges, and starts
  no fix until the new head reports. The wait is stored on the batch (it survives a restart) and ends after an
  hour with the base still red: the failure is then the pull request's own, which bounds a red on a quiet
  main that was only a flaky test. A pull request that leaves the watch waits on nothing, and the base card
  goes when none remains. Checks red only on the pull request still start a fix.
- A job GitHub cancelled for want of a runner is not a failure. It is run again after a backoff of 10, 20 and
  40 minutes, quietly; only a job still without a runner about 90 minutes after it was first seen raises one
  card. The macOS `desktop` job stays a required, blocking check: free open-source runners are the constraint.
- A required check that fails and then passes on the same commit is a flaky test. One Inbox item per check
  name counts the occurrences. The fix is in the code under test or the test, never a retry in the test.

## Why

One broken e2e on main made every open pull request fail the same check, and each started its own fix
lane. Over a week of main's runs, most red runs were runner shortages and flakes, and only a few were a
pull request's own change. The shortage comes in bursts of hours, so an immediate rerun lands in the same
burst. A red base is routed to one real fix of the base, not to a retry.
