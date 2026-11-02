# Main has no merge queue, because a user-owned repository can't have one

- **Date:** 2026-11-02
- **Supersedes:** decisions/2026-11-02-merge-queue.md

## Decision

`main` no longer merges through a GitHub merge queue. The `merge_queue` rule is removed from
`.github/rulesets/main-protection.json`, which keeps `deletion`, `non_fast_forward`, `required_linear_history`,
`pull_request` (squash only) and `required_status_checks`. A pull request merges when its required checks pass
on its own head, as it did before the queue; "Merge when ready" and `gh pr merge --auto --squash` arm auto-merge
as usual.

Everything else in `decisions/2026-11-02-merge-queue.md` that is not the queue rule itself stays:

- `.github/workflows/ci.yml` still runs on `merge_group`, and `dependency-review`, `policy` and the title lint
  keep their `merge_group` handling. Without a queue the trigger never fires, so it is inert.
- The daemon's handling of a queued pull request (`decisions/2026-11-02-a-queued-pull-request-is-never-pushed-to.md`)
  is unchanged. A pull request is never in a queue, so it never takes that path.
- The ruleset is still applied by hand with `make github-settings`.

## Why

The builder ran `make github-settings` on 2026-11-02. Every step applied except `main-protection`, which GitHub
refused with HTTP 422 Validation Failed on the PUT to `repos/travistruett/10db/rulesets/25214393`. The only
rule in that file GitHub does not offer here is `merge_queue`: merge queues are available only on repositories
owned by an organization (GitHub's documentation on managing a merge queue says so), and `travistruett/10db` is
owned by a user account. The 422 is the observed failure; the ownership limit is the documented cause, taken
from GitHub's documentation, not tested by applying a ruleset without the rule before this change.

The alternative was to move the repository into an organization. The builder turned that down. They now land
work in few, large batches, so pull requests rarely race each other to merge, and the failure the queue was
added for (two pull requests that were each green alone breaking `main` together, #414 and #422 on the night of
2026-11-01) is now unlikely enough not to justify moving the repository. The ruleset still does not require
branches to be up to date (`strict_required_status_checks_policy` is false), so that failure is possible in
principle; when it happens, the push run on `main` shows it and the fix is a new pull request.

The `merge_group` trigger and the daemon's queue handling stay because they cost nothing without a queue and
would be needed again the day a queue returns; removing them would be a second change to undo.

## What would bring it back

Moving `travistruett/10db` into an organization. Then the `merge_queue` rule from
`decisions/2026-11-02-merge-queue.md` (parameters in its Decision section) is added back to
`main-protection.json`, the governance test for it is restored, and a new decision supersedes this one. The CI
trigger and the daemon need no change. Pull requests starting to race each other again, so that two green ones
break `main`, is the reason to make that move.
