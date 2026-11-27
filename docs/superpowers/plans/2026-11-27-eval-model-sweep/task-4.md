# Task 4: candidates and the cost estimate — Core: money

**Files:** new `apps/daemon/src/evals/sweep-cost.ts` and `apps/daemon/src/evals/candidates.ts`,
`apps/daemon/src/api/app.ts` and `api/services.ts` (the route), `apps/daemon/src/screens/render-access.ts`,
`apps/daemon/src/evals/AGENTS.md`.

**Implements:** `SweepPlan`, `estimateRunCost`, `sweepNext`, the candidates route (index, Interfaces). Candidates
come from the daemon's catalogue (`apps/daemon/src/catalogue/`) and model profiles, as in Design › Candidates.

`sweepNext(plan)` owns every end, `found` included:
- After a settled step that passed in `cheapest`, the end is `found`.
- `cheapest`: the next waiting step if its estimate is known and fits `cap − spent`. Otherwise the end: `done`·capped
  when a step was left out for the cap, else `done`.
- `try`: the next waiting step, unless its known estimate doesn't fit (`done`·capped). An unknown estimate runs.
- Spent counts known costs only. In `cheapest`, a settled step with an unknown cost ends the sweep `stopped`·cost_unknown.

**Rows:** the choice of next step or end in "Step settles".

**Tests (core: money, pure):** one table over `estimateRunCost` and `sweepNext`: known and unknown prices, a cap that
fits exactly, one a cent short, `try` with an unknown estimate and an unknown cost, `cheapest` with an unknown cost.
Prove it red first.

**Index sections:** Design › Candidates; Design › A sweep.
