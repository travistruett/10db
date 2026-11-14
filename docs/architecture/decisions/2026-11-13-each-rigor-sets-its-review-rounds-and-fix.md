# Each rigor sets its review rounds, how a send-back is fixed and whether the builder approves the plan

- **Date:** 2026-11-13
- **Amends:** `decisions/2026-11-13-work-is-sized-by-rigor-and-one-playbook.md`; and
  `decisions/2026-10-29-review-findings-on-the-builders-screens.md`, whose card showed the sum of every step's
  send-backs against `FIX_ATTEMPT_LIMIT`: it now shows each reviewing step's own count against its rounds

## Decision

A rigor's playbook row carries three process settings beside its steps, set globally or per project field by
field: **review rounds** (Light 1, Standard 1, Careful 2, Critical 2), **a send-back is fixed by** (the build
session resumed for Light and Standard, a fresh build session for Careful and Critical) and **the builder approves
the plan** (Critical).

- Rounds count per reviewing step (`WorkstreamStep.sentBack`): Review, QA and Plan Review each get the row's
  rounds. A reviewer's send-backs never use `attempt`; the gate's, a merge's and the builder's keep
  `FIX_ATTEMPT_LIMIT`. At the limit the work ships with its findings as a follow-up task, or fails for a kind
  that fails at its limit.
- A resumed fix runs on the session's own model, never another; a fix that cannot resume (a crash, another
  account, a model no longer offered) runs fresh, one profile up, once.
- Light's rounds and fix apply only to a review its safety net adds; the spec's table showed them as none.
- The plan card is its own Inbox kind, `plan`, raised when Build is next and a Plan ran; approving it gives Build
  its whole gate budget (`attempt` 0).
- A rigor change, by the builder or a project's default, applies at the next step boundary: the runner re-plans
  the steps still to come inside the write that ends a step. A task waiting on a plan card keeps its card.
- `review_size` is retired: rigor decides review up front, and Light's safety net (big diff, binary file, hazard,
  manifest, lockfile, migration, CI or agent-instruction path, an always-reviewed kind, an unreadable diff) adds
  a review where the change calls for one.

## Why

A Standard task's two-line finding no longer pays for a session that re-reads everything; Careful and Critical
keep fresh eyes. Counting per step reuses the count the board already shows. A resumed session on its own model
needs nothing of either provider that it does not already do for crash recovery, so the Codex question in the spec
does not arise. Deciding the move inside the write is the only way a change made while a gate runs is not
overwritten by the runner's earlier read.
