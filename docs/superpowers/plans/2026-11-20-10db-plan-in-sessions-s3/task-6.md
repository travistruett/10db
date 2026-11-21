# Task 6: the e2e

**Spec:** §10 ("Every user-visible piece extends `e2e/sessions.spec.ts`").
**Track:** B. Needs Tasks 1-5 on the branch. Read the New Plan test in `apps/desktop/e2e/sessions.spec.ts` and the
e2e notes in `apps/desktop/AGENTS.md` once.

## Where it stands before this card

The New Plan test accepts four rows (one goal with two tasks, two loose tasks, one decision). Remove Draft Goal
then takes the goal back:
- the goal row is proposed again;
- the two loose task rows still read On the Board, "On the Board · Ready" after Task 5;
- the decision is in Knowledge.

## Steps, added right after the Remove Draft Goal step

1. **Accept, then Undo Accept.**
   - Accept the goal, the only pending row. The goal row reads "On the Board · 2 ready".
   - Open ⋯ → Undo Accept. The confirm says "1 goal, 2 tasks". Press Undo Accept.
   - The goal row is proposed again, with no "On the Board" and its dot Proposed. The two loose rows still read
     "On the Board · Ready", because they were the earlier Accept's.
   - `GET /projects/:id/goals` no longer lists the goal.
2. **Accept and Start.**
   - Open Accept ▾ → Accept and Start. The counts line is visible. Use the fake project's lane cap and the
     goal's dependencies to expect exact words: read the goal's two tasks in `fake-plan-script.ts`. If the
     words can't be made stable, use `/start now|wait for a lane|for other tasks/`.
   - Press "Accept and Start 1". The goal row's line shows a started word: `/queued|running|needs you|in review|done/i`,
     not Queued or Running alone, since the fake lane may finish fast.
3. **Undo is disabled.**
   - Open ⋯. Undo Accept is disabled, and its reason reads "has started; cancel its run and remove it from the
     Board first". Close the menu.
4. **Clean up, where the test already ends the New Plan session** (before the existing `archive()` at about
   line 727; add no earlier archive):
   - for each run this test started (`GET /workstreams?active=true` filtered to the goal's tasks), call `POST
     /workstreams/:id/cancel`;
   - wait until none of them is active, with a deadline and no sleeps;
   - the existing `archive()` then runs.
   - A later spec must find no running lane.

## Red proofs

Each one is local and reverted after the run.

- Step 1 goes red with `undoAccept`'s proposal reset removed.
- Step 2 goes red with `start` not sent by `useConvertShape`.
- Step 3 goes red with the disabled check removed from the ⋯ item.

## Screenshots

Save these to `~/Agents/scratch/10db/2026-11-20/plan-s23/screens-s3/` during the run, then remove the capture
code:

- the Accept ▾ menu open;
- the Accept and Start confirm with its counts;
- rows with live words and the Running or Done dot;
- the Undo Accept confirm;
- Undo disabled with its reason.

## Tests

The spec's existing test is extended. It needs no value card, since it adds no test.

## Done when

- `pnpm e2e e2e/sessions.spec.ts` (the whole file, not `--grep`, so the other tests' open sessions are present)
  passes.
- Each red proof is shown.
- `make precheck` is green, and the push is done.
- If the run finds a production bug, fix it in the smallest commit and say so.
