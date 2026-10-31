# Later review rounds check only earlier findings, and file new ones as follow-up tasks

- **Date:** 2026-10-30

## Decision

- A review, plan review or QA step (`REVIEW_ROLES`) is briefed by round. The round is one more than the
  rejections in the step's `earlier` results (an approval is not a round). Round 1's brief tells it to list every
  blocking finding it can see in one rejection. A later round's brief shows the newest earlier rejection, titled
  "Findings from your earlier rounds (check only these)", and tells it to check only whether each is fixed plus
  what the fix's own changes broke. The newest rejection is enough: it already holds the older findings that were
  still open, so an older finding it left out was judged fixed. The brief carries this, not only the persona,
  because a builder's edited persona is never overwritten.
- `complete_step` takes an optional `followUps` list (at most `MAX_FOLLOW_UPS`, 10): each has a one-line `title`,
  a `description` and optional `acceptanceCriteria`. It is for review roles only; a plan step that sends one gets an
  error. The step decides what is a follow-up: a finding that is new and not caused by the fix on a later round, or
  a real but non-blocking one on any round. It then approves, or rejects only for the blocking findings, so a
  rejection whose findings are all earlier ones still unfixed or breakage from the fix sends the work back as before.
- 10db files each follow-up in the same write as the step's result, through `insertFollowUpTask`: an open task in
  the source task's project, parked in the Icebox column (the project's first column when the builder renamed it,
  the derived board when it has none), with the source's landing (so it lands on the same branch) and areas, no
  dependencies, and a description that opens with the source task's title and id. The `followUps` arrive in the
  step result, whose summary gets a `Follow-up tasks filed:` heading and one `- <task id> <title>` line each
  (`FOLLOW_UPS_HEADING`), and in the tool's answer. `parseFindings` stops at the heading. An opId replay files
  nothing new; a summary that would pass `MAX_STEP_SUMMARY` with the list added is refused and files nothing.
- The retry-limit and design-sizing work file their follow-ups through `insertFollowUpTask` too.

## Why

A task was rejected eight times because each round read the whole change again and found what an earlier round could
have: each fix moved the target. Listing everything in round 1 lets the fix go in once; checking only the earlier
list afterwards makes the rounds converge; filing the rest keeps a real finding from being lost. The step, not
10db, can tell whether a finding is new and unrelated to the fix, so the schema trusts the step's call and 10db
makes the filing cheap and visible. The Icebox keeps a follow-up from starting by itself, and copying the source's
landing keeps it on the same branch. Putting the list in the result's text means the drawer, which already shows
it, needs no new field.
