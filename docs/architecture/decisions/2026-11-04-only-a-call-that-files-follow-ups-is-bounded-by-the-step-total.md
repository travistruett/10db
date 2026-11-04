# Only a complete_step call that files follow-ups is bounded by the step total

- **Date:** 2026-11-04
- **Amends:** `decisions/2026-11-04-complete-step-follow-ups-are-bounded-per-step.md`

## Decision

That decision bounds a step to `MAX_FOLLOW_UPS` (10) follow-ups through `complete_step`. Its code refused a call
with no `followUps` when the step's result already seemed to list more than the bound, which its text said never
happens. This states what holds now, and corrects three statements.

- **The bound applies only to a call that files something.** A call is refused for the total only when it has at
  least one follow-up to file (one not already filed under its `opId`) and the lines the step's result lists plus
  those would pass `MAX_FOLLOW_UPS`. A call with no `followUps`, or whose `followUps` all match what its `opId`
  already filed, is never refused for the total, however many lines the result seems to list. The list is read
  back from the notes (`filedFollowUpLines` takes every `- ` line after the first "Follow-up tasks filed:"
  heading), so notes that hold such a heading and bullets, or a step that pastes its previous result into its
  notes, can make the count too high. That overcount no longer stops a step replacing its result. It still
  refuses a call that files follow-ups, which errs towards filing fewer.
- **A call with no `followUps` can be refused for summary length.** The result is the notes plus the carried list
  (and anything the call files). Notes up to `MAX_STEP_SUMMARY` that fitted alone can pass it once the list is
  added, and the call is refused with "send shorter notes". That is the only refusal such a call can get besides
  the missing verdict of a review role. The error text says the list is the step's, so a step knows why.
- **A review sent back to itself keeps its list and total.** The earlier decision said a step run again after a
  rejection starts with no result. That holds when an implement step comes before it. A review or QA step with
  no implement step before it sends back to itself (`sendBackTarget` returns its own index) and `sendBackSteps`
  keeps a read-only target's result, so its list, and its total, carry over to the next run. The bound is then
  per task for that step, not per attempt. This errs on the safe side and is kept.

The "Not done" note of the earlier decision, that an overcount is harmless, is withdrawn: it was harmless only
if no call without `followUps` was refused for it, which is what this fixes.

## Why

A refusal that says "send at most 0 followUps" to a call that sends none cannot be acted on, and it left a step
unable to replace its result. Bounding only calls that file keeps the aim of the bound, a step cannot file more
than ten, and the overcount can only make a filing call fail, never let one through. Narrowing the count to
lines 10db wrote (a stored count, or a marker in the heading) was left out: it needs new storage or a format
change for a case the first rule already makes harmless.
