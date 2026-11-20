# Task 6: the e2e

**Spec:** §10 ("Every user-visible piece extends `e2e/sessions.spec.ts`").
**Track:** B. Needs Tasks 1-5 on the branch. Read the New Plan test in `apps/desktop/e2e/sessions.spec.ts` and the
e2e notes in `apps/desktop/AGENTS.md` once.

## Steps, added to the New Plan test after its Remove Draft Goal step

1. **Undo Accept.**
   - Accept the remaining rows. Each accepted task row reads "On the Board · Ready".
   - Open ⋯ → Undo Accept. The confirm names the counts. Press Undo Accept.
   - The rows are proposed again: no "On the Board", and the Accept button is enabled. `GET /projects/:id/goals`
     no longer lists the goal.
2. **Accept and Start.**
   - Open Accept ▾ → Accept and Start. The counts line is visible and matches `/start now|wait for a lane/`.
     Prefer exact words when the fake project's lane cap and the plan's dependencies make them stable: the
     fake's plan is one goal with two tasks and two loose tasks.
   - Press Accept and Start. At least one task row reads "On the Board · Queued" or "On the Board · Running".
3. **Undo refused.**
   - Open ⋯ → Undo Accept → press it. The modal shows "has started" in the daemon's words and stays open. Close
     it.
4. **Clean up.**
   - Stop every run this test started, through the daemon's API (the routes Factory's Stop uses), and wait until
     none is active.
   - Then archive the session.
   - A later spec must find no running lane.

## Red proofs

Each one is local and reverted after the run.

- Step 1 goes red with `undoAccept`'s proposal reset removed.
- Step 2 goes red with `start` not sent by `useConvertShape`.
- Step 3 goes red with the started check skipped in `undoAccept`.

## Screenshots

Save these to `~/Agents/scratch/10db/2026-11-20/plan-s23/screens-s3/` during the run, then remove the capture
code:

- the Accept ▾ menu open;
- the Accept and Start confirm with its counts;
- rows with live words;
- the Undo Accept confirm;
- Undo's refusal.

## Tests

The spec's existing test is extended. It needs no value card, since it adds no test.

## Done when

- `pnpm e2e e2e/sessions.spec.ts` (the whole file, not `--grep`, so the other tests' open sessions are present)
  passes.
- Each red proof is shown.
- `make precheck` is green, and the push is done.
- If the run finds a production bug, fix it in the smallest commit and say so.
