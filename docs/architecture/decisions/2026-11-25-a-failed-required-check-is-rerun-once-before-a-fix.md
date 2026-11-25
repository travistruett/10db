# A failed required check is rerun once before a fix

- **Date:** 2026-11-25
- **Amends:** `decisions/2026-11-24-a-red-base-is-one-fix-not-a-fix-per-pull-request.md`

## Decision

When a required check fails on an open pull request's head and its base doesn't fail it (`Change` in
`ci-failure-class.ts`), the pull request watch first runs that Actions job again, once per head
(`gh run rerun --failed` for each run it belongs to). Until the rerun settles, no CI fix starts and the
"Pull request checks failed" card leaves the check out. `ci-rerun.ts` holds the rule and `followFailedRerun`
in `pr-watch.ts` does the work.

- The rerun is stored on the root batch as the notice `checks-failed-rerun:<head>`. Its record holds the
  runs, the failing job ids at the rerun, the check names, the time and the outcome (`rerun`, `failed`,
  `flaked`, `refused`). It is written as soon as GitHub takes each run, so a restart never reruns the head
  a second time. A new head clears it.
- If a rerun check then fails with a job id that isn't in the record, it **failed again**: the failure is
  the change's, and a fix or the card follows as before. A check still listed only by its old job ids
  10 minutes after the rerun (`CHECKS_START_MS`) counts as failed again too, because the rerun never took.
- If no rerun check fails or runs, it **flaked**: the pull request merges as usual, the notice turns into
  a warning naming the check and the head, and the "Flaky check" Inbox card counts one more time and names
  the head and the pull request.
- GitHub refusing the rerun (other than "already running", which waits for the next round) is stored as
  `refused`, and the failure goes on as the change's.
- These are never rerun: a check the base fails too (including one that waited on the base), a check
  that isn't an Actions job (it has no job id, so there's no way to tell its rerun apart), a pull request
  in the merge queue or with a conflict, a fix batch's own reads, and a pass's pull request.

## Why

On PR #851, `gate-e2e-2` failed three times on one commit, each time in a different WebKit spec. The
first failure started a CI-fix run and a later one raised the card asking the builder to fix and push.
A fix run on a flaky failure risks a needless code change, and the card asks the builder for work a
rerun does. One rerun costs a real failure one more CI run before its fix.

GitHub gives each rerun attempt new job ids, so a new id is a fact about the rerun. Waiting to see a
pending read in between would miss a short job that finishes inside one two-minute round. Rerunning a
second time, or on the base's failures, would only hide a real failure longer.
