# Task 3: live runs take models, and the sweep service (Track A) — Core: money, recovery

**Files:** `apps/daemon/src/evals/live-runs.ts`, new `apps/daemon/src/evals/model-env.ts`, new
`apps/daemon/src/evals/sweeps.ts`, `packages/db/src/schema.ts`, new `packages/db/src/store/eval-sweeps.ts`,
`packages/db/src/store/eval-live-runs.ts`, `apps/daemon/src/api/app.ts` (routes), `apps/daemon/src/screens/render-access.ts`
(classify the GETs), `apps/daemon/src/daemon/services.ts` (wire, start's recovery, stop's `stopAll`),
`apps/daemon/src/evals/AGENTS.md`, the migration (generated last, after the final merge of `origin/main`).

**Implements:** `modelEnvValue`, `previewHash(suite, project, models)`, `EvalSweeps`, the sweep routes and the
`?models=` preview (index, Interfaces).

- `modelEnvValue` is the one place a model list becomes the env value: every pick is an `EvalModelId` (for
  `ids: 'openrouter'`) or a choice's `name` (for `choices`, the model given is looked up by `model` or `name`);
  at most 10; joined by `,`. Anything else throws `EvalLiveRefused(BadModel)`. A suite with no `live.models` and
  a non-empty pick is `NoModels`.
- `live-runs.ts` `start` takes `models: readonly string[]` (empty = as today, no env), checks the hash over them,
  passes `modelEnv` to the gate request and stores `models_json` and `sweep_id`.
- `sweeps.ts` owns the queue: it holds the project's one live run across its steps (Run is `busy` meanwhile, via
  the existing `refusalOf`), starts each step through `live-runs.ts`, reads the step's verdict with the existing
  results reader (Design › A sweep), sums spent from report costs, and uses task 4's pure `sweepNext` to pick the
  next step or the end. Stop stops the current run and skips the rest. `recoverAtStart` ends `running` sweeps as
  `interrupted` after slice 5's run recovery; nothing resumes.
- Each state change writes its row and announces `eval.sweep_changed` in one write.
- Until task 4 lands, `sweepNext` and `estimateRunCost` are task 4's; build task 3 against their signatures and
  take task 4 first if one implementer runs both (the track's order is 1, 3, 4, but 4's pure module can be written
  at the start of 3).

**Rows:** every row of the index's state table.

**Tests (core: money and recovery), on the real pipeline rung** (real SQLite in a temp dir, a real temp git checkout,
a fake suite command that writes a report naming the model from `$MODELS` with a chosen pass and cost):
1. A `cheapest` sweep over three candidates whose second passes ends `found` with that winner, the third
   `skipped`, and spent equal to the first two reports' costs.
2. A sweep whose next estimate exceeds the remaining cap ends `capped` without starting that step; a step whose
   report states no cost ends `cost_unknown`.
3. A daemon restart with a `running` sweep ends it `interrupted`, its waiting steps `skipped`, and starts nothing.
Prove each red first. No test per row beyond these.

**Index sections:** Design › A sweep; State table; Global constraints.
