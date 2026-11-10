# An Abandon takes over a closing pass until its close has moved the return branch

- **Date:** 2026-11-09
- **Amends:** `decisions/2026-11-09-abandon-pass-puts-unsigned-pages-back.md`

## Decision

`POST /passes/:passId/abandon` also accepts a `CLOSING` pass. Its step 1 is written at once, outside the
project's delivery key: the pass becomes `ABANDONING`, refused (409, "the pass is landing") once the close has
finished D8's fast-forward (`close_step` 7 or more). The pull request's checks and the close's job are then
aborted and waited for, still outside the key, since the close holds it; the close stops at its next conditional
write. Step 2 moves a `SHIPPING` batch to `FAILED`, so step 7 can make it `ABANDONED`. Step 5 takes out only the
pages that are not signed off; signed-off pages stay as landed and are named in the answer's `stays`.

## Why

Spec §5.4: an Abandon is the exit that always works, also while a close is stuck in a long gate. Once the return
branch has moved, the pass's work is on the folder's own branch and an Abandon could only take it off the screen,
so the close is left to finish. Queueing the Abandon's abort behind the close it aborts would wait out the whole
gate.
