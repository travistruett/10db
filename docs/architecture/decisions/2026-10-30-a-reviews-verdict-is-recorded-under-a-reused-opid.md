# A review's verdict is recorded even under an opId an earlier session used

- **Date:** 2026-10-30

## Decision

- `complete_step` replays a stored reply only to the session it was given to (a retry of a lost answer). An opId
  that an earlier session of the same task recorded is a new call: the verdict is written to the step and the
  stored op row is handed to the new session (`replaceToolOp`). An opId first used for another tool is still
  refused.
- The Claude adapter's `turn_complete` event carries `text`, the last message the turn wrote (the result
  message's `result`, trimmed, at most `MAX_STEP_SUMMARY` characters; absent when empty or when the turn did not
  end in success). The runner keeps the longest one a session wrote.
- A review that ends without a verdict after its nudge and its one rerun fails as before, and when it wrote
  anything the card says so: the failure reads `... its last turn ended normally. What it wrote is on the card.`,
  and the card carries the text (and the findings parsed from it) in the same `reviewRejection` detail a rejected
  review's card uses, so the builder reads the review there and decides: Retry, or accept the work.
- The nudge itself is unchanged: `RESULT_NUDGE` is sent once, in the same session, after a read-only step's turn
  ends without a result recorded by that session. Tests pin that a verdict given after it is recorded.

## Cause

Shown from the transcripts of sessions 7 and 8 of workstream ws_01a18d71-2a0f-7632-ae69-779a457c2d18, read by the
builder (a lane agent may not read 10db's data directory or `~/.claude`) and given to this task:

1. Each review first wrote its findings as text and ended its turn (`stop_reason: end_turn`).
2. 10db sent `RESULT_NUDGE` in the same session, as designed.
3. Each session then called `mcp__10db__complete_step` with verdict `reject`, a full summary and the opId
   `review-stop-lane-procs-01`, the same in both sessions.
4. The tool answered `{"instruction":"Recorded. End your turn now."}` both times and the session ended.
5. 10db failed the step for ending without calling `complete_step`.

So the two hypotheses "the nudge is not sent" and "the nudge is sent and ignored" are both wrong. The tool call was
made and acknowledged but wrote nothing: tool ops are unique per `(workstream, opId)`, and `complete_step` answered
any repeated opId from the stored op (`prior()`), whichever session stored it. A review that reuses a readable opId
(the first review of the workstream already used it, and every rerun and send-back round reuses it again) is told
"Recorded" while the step keeps no result. The step had no result, so the runner counted it as a review that ended
without a verdict, reran it (same opId, same silent replay) and failed the task. Writing the findings as text first
is a habit of the model at xhigh effort and only matters because the second pass could not record them.

## Why

The idempotency exists for one case: the reply to a call was lost and the same session sends the same call again.
That case is a same-session one; a replay for another session answers a call that was never made by it, and for
a call that changes state (a verdict) the wrong answer is to say it was done. The check stays by session and not by
"is this result still current" because the step's own `result.sessionId` already says which session recorded it,
and a session that repeats its own call after a send-back cannot exist: a send-back starts a new session.

The other tools have the same replay by `(workstream, opId)`. They are left as they are: `ask_human`, `commit` and
the claim calls rely on a replay surviving a session restart (a resumed session asks again for the same card or
commit), and no incident points at them. A reused opId on another tool still gets a replayed answer; if one shows up,
the same session check applies there.

The text on the card is a last resort for a review that really never calls the tool. Nothing about the verdict is
guessed from it: the card shows what the review wrote, and the builder chooses.
