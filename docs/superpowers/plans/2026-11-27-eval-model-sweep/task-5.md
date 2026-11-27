# Task 5: the drawer actions and the sweep window (Track A) — UI on a Core path

Starts after PR B (`feat/evals-drawer`, the drawer's action row) has merged to `main` and `main` is merged in.

**Files:** `apps/desktop/src/views/evals/suite-drawer.tsx`, new `apps/desktop/src/views/evals/try-models-modal.tsx`,
`apps/desktop/src/views/evals/live-run-modal.tsx` (reuse its confirm parts; don't fork them),
`apps/desktop/src/daemon/evals-queries.ts`, `apps/desktop/src/views/evals/AGENTS.md`, one e2e in `apps/desktop/e2e`.

**Implements:** calls the candidates, preview `?models=`, sweep start/stop/get routes (index, Interfaces).

- The action row gets **Try Other Models** and **Find Cheapest Passing** when the suite has `live.models`; without
  it, one dim line "This suite's command doesn't take models from 10db yet" and **Let 10db Pick Models** (a slice 3
  task: "Let <suite> read its models from an env var", naming the live command and, as the pattern, ampsio's
  `MODELS ?=` and orgtools' `run_eval` front door).
- The picker: a table of candidates (model, intelligence, price, estimate, its last result here), multi-select for
  Try; Find Cheapest preselects every known-estimate candidate cheaper than today's cheapest pass and asks for a cap
  (default: 3 × the latest run's cost, rounded up to a dollar). Then the existing confirm window, with the models
  and "Estimated $x, cap $y; a single run can cost more than its estimate."
- The sweep window: one line per step (model, state in words, cost), spent of cap, Stop; at the end the verdict in
  words ("google/gemini-3.6-flash passes every gate at $0.31 a run") and **Switch to <model>** (task 6). The window
  can close; the drawer shows a running sweep's line with Stop. `eval.sweep_changed` refetches.
- DESIGN.md: Title Case buttons, states as text.

**Rows:** the UI side of every state-table row (what each end says).

**Tests:** extend the evals e2e flow (or the loop flow that opens Evals) with one Find Cheapest run against the fake
suite command of task 3: two candidates, the second passes, the window says so and offers Switch. No component tests.

**Index sections:** Brief; Design › A sweep; Design › Candidates.
