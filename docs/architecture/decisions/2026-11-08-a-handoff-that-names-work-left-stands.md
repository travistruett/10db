# A handoff that names work left stands, and a run of them with no commit stops the step

- **Date:** 2026-11-08
- **Amends:** `decisions/2026-11-07-a-handoff-nobody-asked-for-ends-a-finished-step.md`, and
  `decisions/2026-11-03-a-drain-refuses-a-claim-wait-on-a-parked-holder.md`, whose "a recorded handoff starts a
  fresh session of the same step" the first record narrowed without saying so

## Decision

When a session's turn ends with a handoff recorded, the runner starts a fresh session on the same step when 10db
asked for the handoff (the context or account nudge, or a tool's answer, as before) or the step's work is
outstanding. Outstanding now reads the handoff itself:

- an edit step: the handoff names work under `progress.notDone`, or changes in its claims are uncommitted;
- a read-only step: it has recorded no result and the handoff names work under `progress.notDone`.

A handoff nobody asked for that names nothing left ends the step, as ending the turn does. A read-only step that
ends so with no result is sent `RESULT_NUDGE` first, as a turn that ends without a result is.

Three handoffs in a row that nobody asked for, written at the same commit, fail the step (`handoff_loop`,
`UNASKED_HANDOFF_LIMIT` in `runner/runner.ts`) with a message that names what the last one said was left. The
lane's control state counts the run across its sessions; a commit between handoffs, an asked handoff or any other
session ending resets it.

The `write_handoff` description and its reply, and the harness's `handoff` skill, say a handoff continues only
when 10db asked for it or it names work left.

## Why

The first record judged an unasked handoff by git state alone. Its review found what that misses:

- Claude's `handoff` skill invites a handoff "when your context is nearly full". Such a handoff, with half the
  work committed and the rest named under not done, went to the gate as if finished. 10db's database holds such
  handoffs: Claude review steps handing off at 6–11% context, each listing what was left.
- The "asked" signals live in the session's memory, so a resumed session loses them. A session told by the drain
  to commit and hand off, then parked on a card and resumed, followed that instruction with nothing uncommitted
  and went to the gate.
- A read-only step that wrote a handoff instead of `complete_step` still started fresh sessions forever.

What the handoff names as left covers the first two without a new stored column. It doesn't bound a model that
names work every time and does none, which is how the Codex loop began. The run limit bounds that and every other
handoff loop: a step stopped with what was left named is for the builder to see, where another session would
repeat it. Three, because the database's longest real run of unasked handoffs was three.
