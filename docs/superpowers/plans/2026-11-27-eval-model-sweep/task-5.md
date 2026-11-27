# Task 5: the drawer actions and the sweep window — UI on a Core path

Starts after `feat/evals-drawer` (the drawer's action row) has merged.

**Files:** `apps/desktop/src/views/evals/suite-drawer.tsx`, new `try-models-modal.tsx`, `live-run-modal.tsx` (reuse
its confirm parts, don't fork them), `apps/desktop/src/daemon/evals-queries.ts`, `views/evals/AGENTS.md`, and the
e2e that holds the Run step.

**Implements:** calls the candidates, `?models=` preview, sweep and `sweeps/latest` routes.

- The action row offers **Try Other Models** and **Find Cheapest Passing** when the suite has `live.models`. Without
  it, a dim line says "This suite's command doesn't take models from 10db yet", with **Let 10db Pick Models**.
- The picker lists candidates: model, intelligence, price, estimate, and its last result here. Try is a
  multi-select. Find Cheapest preselects the known-estimate candidates cheaper than today's cheapest pass and asks
  for a cap: by default 3 × the latest run's cost, rounded up to a dollar. Then the confirm window shows the
  models and "Estimated $x, cap $y; one run can cost more than its estimate."
- The sweep window shows one line per step (model, state in words, cost), spent of cap, and Stop. It ends with the
  verdict and reason in words and **Switch to <model>** (task 6). The drawer finds a running or recent sweep
  through `sweeps/latest` after a reopen. `eval.sweep_changed` refetches.

**Tests:** extend the e2e's existing Run step: the picker lists candidates, and Start shows the `no_sandbox`
refusal. Task 3's daemon test covers the real sweep. Before review, click through on the Mac against a real
daemon: Find Cheapest on an ampsio suite with two cheap candidates, with screenshots.

**Index sections:** Brief; Design › A sweep; Design › Candidates.
