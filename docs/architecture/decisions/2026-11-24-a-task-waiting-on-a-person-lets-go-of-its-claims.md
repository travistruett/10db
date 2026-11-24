# A task parked on a question to a person lets go of its claims while its checkout is clean

- **Date:** 2026-11-24

## Decision

When a task parks on an `answer` card (a question to the builder or to a routed person), 10db
reads its checkout once (`yieldClaimsWhileWaiting`, `runner/claim-yield.ts`). If no change under any of
its claims is uncommitted (`claimedChanges`) it releases all of them, areas and hazards, and forgets the
`request_claim` grants it recorded, so a repeat of such a call asks again. Otherwise it keeps all of
them, never some: a task holding one claim while another task holds its other and waits on it would
deadlock where no check looks. The answer queues the task, and the scheduler asks for the same claims
as for any queued task: a free claim is granted before the session resumes, a held one shows the usual
claim-wait notice and the task waits in the queue. It never fails for it. A daemon restart does the same
for a waiting task it finds.

A task that depends on the waiting one stays queued. A pass's page, a plan approval and a builder check
keep their claims. Claims are by area, not by file, and a checkpoint commit of the waiting task's work
was turned down, since it would commit ungated work to the builder's branch.

Limits: ignored files the task created (build output, `.env.local`) are not seen as its edits, so they
do not keep its claims. Work the task committed but no gate has verified sits in a released area, and
another task can build on it before the waiting task resumes.

## Why

AMP-134 asked a product question and held Ampsio's `backend` area for hours (AMP-137 for 7 h the
night before), renewing its lease each minute, so every other backend task queued behind one
question to a person. A task that has written nothing in its claims loses nothing by letting go.
Releasing with edits in a shared checkout would let another task commit them
(`2026-11-20-a-session-leaves-another-writers-edits-uncommitted.md`), so that case stays held.
