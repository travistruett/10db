# A handoff that names work left stands, and a run of them with no commit ends the step

- **Date:** 2026-11-08
- **Amends:** `decisions/2026-11-07-a-handoff-nobody-asked-for-ends-a-finished-step.md`, and
  `decisions/2026-11-03-a-drain-refuses-a-claim-wait-on-a-parked-holder.md`, whose "a recorded handoff starts a
  fresh session of the same step" the first record narrowed without saying so

## Decision

When a session's turn ends with a handoff recorded, the runner starts a fresh session on the same step when
`handoffStands` (`runner/handoff-rule.ts`) says so:

- 10db asked for the handoff: the context or account nudge, or a tool's answer, as before;
- or, nobody asking, the step's work is outstanding. For an edit step, the handoff names work left (`workLeftIn`:
  its `progress.notDone` and its `continuity.blockers`), or changes in the step's claims are uncommitted. For a
  read-only step, it has recorded no result and the handoff names work left.

A handoff nobody asked for that names nothing left ends the step, as ending the turn does. A read-only step that
ends so with no result is sent `RESULT_NUDGE` first, as a turn that ends without a result is.

Three handoffs in a row that nobody asked for, written at one commit (`UNASKED_HANDOFF_LIMIT`, `nextUnaskedRun`),
end the step too, as ending the turn would: the gate and the review judge the committed work, and a read-only
step with no result is first sent `RESULT_NUDGE`, then rerun once and failed, as any is. An edit step's move to the
gate gives the reason "step complete after 3 handoffs in a row that nobody asked for", and a read-only step's
no-result failure says it handed off three times in a row. The lane's control state counts the run across its
sessions; a commit between handoffs, an asked handoff or any other session ending resets it, and a move (which
starts no session) or a refused model, retried at once, leaves it.

The `write_handoff` description and reply, the Codex briefing's hand-off line, the update drain's claim refusal
and the harness's `handoff` skill say a handoff continues only when 10db asked for it or it names work left, and
to name that work under `progress.notDone`.

## Why

The first record judged an unasked handoff by git state alone. Its review found what that misses:

- Claude's `handoff` skill invites a handoff "when your context is nearly full". Such a handoff, with half the
  work committed and the rest named under not done, went to the gate as if finished. 10db's database holds
  unasked handoffs like it: Claude review steps handing off at 6–11% context, each listing what was left.
- The "asked" signals live in the session's memory, so a resumed session loses them. A session told by the drain
  to commit and hand off, then parked on a card and resumed, followed that instruction with nothing uncommitted
  and went to the gate. The refusal now says to name what is left under `progress.notDone`, and a blocker counts.
- A read-only step that wrote a handoff instead of `complete_step` still started fresh sessions forever.

What a handoff names as left covers the first two without a stored column. It doesn't bound a model that names
work every time and does none, which is how the Codex loop could start again. The run limit bounds that and
every other handoff loop. At the limit the step ends rather than fails: the run is most often a model saying it
finished, its work committed, and failing it would leave finished work for the builder to clear by hand, where
the gate and review already judge unfinished work.
