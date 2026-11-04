# A step files at most MAX_FOLLOW_UPS tasks through complete_step in all, across calls and sessions

- **Date:** 2026-11-04
- **Amends:** `decisions/2026-11-04-a-reviews-complete-step-follow-ups-are-outside-the-step-cap.md`

## Decision

That decision made `complete_step`'s `followUps` a separate allowance from the cap `propose` and
`file_follow_up` share, and left "several `complete_step` calls with different `opId`s" unbounded, and a rerun
session's reuse of an `opId` filing again. This bounds both. Its other rules stand: `followUps` are still not
counted in `stepFilings` and still not refused by that cap.

- **One total per step.** A review, plan review or QA step files at most `MAX_FOLLOW_UPS` (10) tasks through
  `followUps` over all its `complete_step` calls, whatever their `opId`s and whichever session makes them.
  The count is the number of lines in the follow-up list of the step's current result
  (`filedFollowUpLines`, `packages/contracts/src/review-rounds.ts`), so it needs no new storage.
- **The list is carried forward.** A later call still replaces the step's notes and verdict, but its result
  keeps the list the earlier calls wrote and appends the tasks it files. Every follow-up a step filed through
  `complete_step` therefore stays named in the step's result.
- **Past the total, the call is refused.** A call whose `followUps` would take the list past `MAX_FOLLOW_UPS`
  answers an error saying how many the step can still send and to put the rest in its notes. Nothing is
  filed and the earlier result is kept (the filing and the result are one transaction). A call with no
  `followUps` is never refused.
- **A rerun is counted too.** A session of the same step that reuses an `opId` an earlier session used is a
  new verdict (the opId's reply is only replayed to the session it was given to). Its `followUps` file
  again, so they count against the same list: a rerun can add to what the first run filed up to the total, not
  to ten more. A step run again after a rejection starts with no result, so its list, and its total, start
  again; the earlier results (with their lists) stay in `earlier`.
- The tool description of `complete_step` states the bound.

## Why

The earlier decision accepted the gap because nothing had been seen to use it. The task "complete_step files a
step's followUps once, or they count against a step-wide bound" found that the second call also overwrote the
step's result, so the list of tasks the first call filed was lost and those tasks were no longer named
anywhere the builder reads. Counting from the result list fixes both at once: it is the record the builder
already reads, it is written in the same transaction as the filing, and it cannot disagree with it. Counting
`complete_step` tool-op results instead would not hold across a rerun, because a rerun with a used `opId` replaces that
op's result. Counting from the result instead of refusing any second filing keeps a legitimate second
verdict (a nudged review that adds a finding) working. The bound is the schema's own per-call limit, applied to
the step, so a review has one number to remember.

## Not done

- Notes that themselves contain the line "Follow-up tasks filed:" followed by `- ` lines are read as part of
  the list on the next call. This can only make the step's own count too high, never lower, and the notes are
  the step's own text.
- A step run again after a rejection files up to `MAX_FOLLOW_UPS` again. Each run is a separate step attempt;
  the bound is per attempt, not per task.
