# 01 Factory loop

- **Status:** Locked
- **Scope:** The first slice of 10db (milestones M0–M4) and the repo baseline it is built on.
- **Summary:** The design is the spec at
  `docs/superpowers/specs/2026-10-13-10db-factory-loop-design.md`. Its decisions are rows 1–20 of
  `decisions.md`. Changes to it are new rows in `decisions.md` that name what they supersede; the
  spec text itself is not edited after this section was locked.

## The builder's check

A project with no gate command has no program to verify finished work, so the builder does
(`decisions/2026-10-28-optional-gate.md`, built).

- **Waiting.** When the last step is done, the workstream goes `RUNNING → VERIFYING → WAITING_HUMAN` with
  `nextAction.kind = 'builder_review'`, no session and no lease, and one `check` card that targets it and shows
  its changes. It holds its claims, and so its areas, while it waits. A second verify
  finds the live card and raises no second one, and brings a card that shows an older head up to the head
  being checked. A restart does not refresh a stale card: recovery raises a card only when none is live.
- **Approve.** In the write that resolves the card the workstream goes `WAITING_HUMAN → VERIFYING → DONE`, its
  claims are released and its lane is freed. Only this completes it.
- **Send back.** A note is required. It is recorded as builder evidence, the card resolves, and the workstream
  is queued as a fix on the step that did the work, one attempt on. The fix prompt carries the note, and the
  finished fix comes back for a check. Past the retry limit the workstream fails with the note kept; Retry
  restarts that step on its own model with the note still outstanding.
- **Recovery.** A restart finds the workstream parked on its card and leaves it, raising the card again only if
  it was closed some other way. It reads git only when the card has to be raised, and never completes or starts
  anything. A send back that was committed is queued as a fix and recovery keeps its note for a fresh session
  until a step that started later has acted on it.
