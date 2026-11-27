# Task 4: candidates and the cost estimate (Track A) — Core: money

**Files:** new `apps/daemon/src/evals/sweep-cost.ts`, new `apps/daemon/src/evals/candidates.ts`,
`apps/daemon/src/api/app.ts` (the candidates route), `apps/daemon/src/screens/render-access.ts`,
`apps/daemon/src/evals/AGENTS.md`.

**Implements:** `estimateRunCost`, `sweepNext`, `GET /projects/:projectId/evals/:suiteKey/candidates` →
`EvalCandidateDto[]` (index, Interfaces).

- Candidates: enabled model profiles and catalogue models that have an OpenRouter id (the catalogue the daemon
  already syncs; `apps/daemon/src/catalogue/`), with AA intelligence and output price; for a `choices` suite only
  its choices (priced by their `model`). Each carries `last`, this suite's newest result for it, if any.
- The estimate (Design › Candidates): reference = the latest run's cheapest passing model with a cost, else its
  first model with a cost; `estimate = reference.costUsd × candidate.outputPrice ÷ reference.outputPrice`; null
  when either price or the reference is missing. Sorted cheapest estimate first, unknowns last.
- `sweepNext(plan, spent)`: for `cheapest`, the next waiting step whose estimate is known and fits
  `cap − spent`, else the end (`capped` when one was left out for the cap, `done` when none were left); for `try`,
  the next waiting step, skipping to `capped` when its estimate is known and does not fit (an unknown estimate in
  `try` runs: the builder picked it, and the window says its cost is unknown).

**Rows:** the `running` × "Step run ends" cell's choice of next step or end.

**Tests (core: money, pure):** one table test of `estimateRunCost` and `sweepNext`: known and unknown prices, a
cap that fits exactly, a cap one cent short, `try` with an unknown estimate, `cheapest` with only unknowns. Prove red.

**Index sections:** Design › Candidates; Design › A sweep.
