# A review's complete_step follow-ups are outside the per-step filing cap

- **Date:** 2026-11-04
- **Amends:** `decisions/2026-11-04-a-step-files-at-most-the-follow-up-cap-by-itself.md`

## Decision

`complete_step`'s `followUps` do **not** count toward `MAX_FOLLOW_UPS` through `propose` and `file_follow_up`
(`stepFilings`, `apps/daemon/src/mcp/tools.ts`), and that cap does not refuse them. They are a separate
allowance: the schema limits one call to `MAX_FOLLOW_UPS` (`packages/contracts/src/mcp-tools.ts`), and only a
review, plan review or QA step may send them. No code behaviour changes; two tests now hold it (a review step that
has filed the shared cap through `file_follow_up` still files its `followUps`, and a review step that has filed
`followUps` can still file the whole shared cap afterwards).

- A review step can therefore file up to `MAX_FOLLOW_UPS` through `propose` and `file_follow_up` together, and
  up to `MAX_FOLLOW_UPS` more with its `complete_step`. The earlier decision said this under "Not done"; this
  makes it a choice.
- The `propose`, `file_follow_up` and `complete_step` tool descriptions say that `followUps` are neither counted
  nor refused by the cap, so a lane is not told the limit is one number for everything.

## Why

A review's findings are the product of the step. Counting them would mean a review that used its ten on
mid-review `file_follow_up` calls could not hand over what it found when it finishes, and refusing the call would
throw the whole verdict away or lose findings; a card instead (as `propose` does) has no place in the result, which
10db writes atomically with the filing. The filing is also bounded in other ways: it is one call at the end of a
step, a step ends with it (the lane is told to end its turn), a replayed `opId` in the same session files once, and
the tasks go to the Icebox where a person decides what starts. Counting them but never refusing would add a number that bounds
nothing. A per-step total across `complete_step` calls was turned down: a rerun review in a new session of the same
step replaces its earlier result, so counting what an earlier call filed would punish the rerun for findings the
first run's builder may already have triaged, and it needs more bookkeeping than the risk warrants.

## Not done

- Several `complete_step` calls with different `opId`s in one step could each file up to the schema limit. Nothing
  bounds that, and nothing has been seen to do it; revisit it with a per-step count if it happens.
- The same `opId` from a later session is not a replay: `complete_step` treats it as a new verdict, so its
  `followUps` file again. The replay bound above does not hold across sessions.
