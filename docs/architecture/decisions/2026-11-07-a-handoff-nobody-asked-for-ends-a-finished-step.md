# A handoff nobody asked for ends a finished step

- **Date:** 2026-11-07

## Decision

When a session's turn ends with a handoff recorded (`write_handoff`), the runner starts a fresh session on the
same step only when one of these holds:

- 10db asked the session to hand off: its context passed the handoff line, or its account neared its usage
  limit (`requestHandoff` in `runner/runner.ts`);
- a tool's answer asked it to: `request_claim`'s refusal for a claim held by a lane the update drain parked tells
  the session to commit and hand off, and calls `McpDeps.askedToHandOff`, which the runner's live session
  records (`LiveSession.askedToHandOff`);
- the step's work is outstanding: an edit step has uncommitted changes in its claims, or a read-only step has
  recorded no result.

Otherwise the handoff ends the step, as ending the turn would (`step_done`). The Codex briefing says ending the
turn finishes a step and never to call `write_handoff` for that (`CODEX_HAND_OFF_RULE` in
`briefing/prompts.ts`), and so does the `write_handoff` tool description. Claude's briefing is unchanged.

## Why

A Codex model on a ChatGPT plan finished its work, committed, then called `write_handoff` to say it was done.
The runner took every recorded handoff as a handoff, so it started a fresh session on the same step. That session
found the work done and handed off again, forever: three sessions were seen at 22% and 10.6% context against a
40% line.

Telling the model alone was turned down: a model that ignores the briefing would still loop. Judging only by the
git state was turned down too: the drain's refusal tells the session to commit before it hands off, so "nothing
uncommitted" can't tell a finished step from one asked to stop. The runner has to know whether 10db asked, by
every route that asks.
