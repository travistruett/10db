# Task 8: migration, replay and click-through

**Size: Feature.** Read the index's Brief and Global Constraints first. Needs tasks 1–7.

## Files

- **The migration:** after the final merge of `main`, generate the `evidence.detail` migration with drizzle-kit, per
  `packages/db/AGENTS.md`. Only one open PR may add migrations at a time, so check before generating.
- **`apps/daemon/scripts/acceptance-replay.ts`**, shaped like `crosses-limit-replay.ts`. It reads a database copy
  (`--db`) and the project checkout (`--repo`), and accepts `--model` and `--second`.
  - **Sample:** every run with a Review step whose last `commit.recorded` before the review step started is still
    in git, plus every task reopened after Done (`task.changed` done → not done).
  - **State:** rebuilt at that head; it calls `checkAcceptance` with a real judge.
  - **Output:**
    - agreement with the reviewer's first verdict;
    - the share of reviewer-approved runs it would send back;
    - the unclear rate on runs with no Review;
    - each reopened task's result, for hand labelling.

## The run

1. Run the replay on a fresh copy of the live database (in the session scratchpad).
2. Write the results to `~/Agents/notes/10db/` and put a summary in the PR body.
3. If the bar fails, tune `OPENROUTER_ACCEPTANCE_SECOND_MODEL` and the floors, then run it again.
4. Click-through in the dev window against the stub OpenRouter: a task sent back once, then a Light task that leaves
   an acceptance card. Answer Accept on one, and Send back on another. Take screenshots of the card and the Board
   counts for the builder (the `screens` skill).

## Spec sections

"Replay and launch bar", and the daemon-and-desktop line of "Tests".

## Tests

None. The replay is a script, not a test.
