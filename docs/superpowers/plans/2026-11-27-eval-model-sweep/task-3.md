# Task 3: live runs take models, and the sweep service — Core: money, recovery

**Files:**
- New: `apps/daemon/src/evals/model-env.ts`, `apps/daemon/src/evals/sweeps.ts`, `packages/db/src/store/eval-sweeps.ts`,
  the migration (generated last).
- Changed: `apps/daemon/src/evals/live-runs.ts`, `apps/daemon/src/evals/new-eval-task.ts`, `packages/db/src/schema.ts`,
  `packages/db/src/store/eval-live-runs.ts`, `apps/daemon/src/api/app.ts`, `api/services.ts`,
  `apps/daemon/src/screens/render-access.ts`, `apps/daemon/src/daemon/start.ts` (wiring and recovery),
  `daemon/services.ts`, `apps/daemon/src/evals/AGENTS.md`.

**Implements:** `modelEnvValue`, the new `previewHash` and `start`, `EvalSweeps`, the task-3 routes and tables (index,
Interfaces).

- `modelEnvValue` is the one place picks become the value. A choices pick matches a `name` or a `model` and is passed
  as the name. A pick to a suite with no `live.models` is `NoModels`.
- `start` with `opts.models` checks the hash over them, passes `modelEnv` (never to the stop command), and stores
  `models_json` and `sweep_id`. `stopLeftBy` hashes with the row's `models_json`. `opts.onSettled` fires in
  `execute`'s `.finally`, after the row is ended. That callback is how a sweep learns its run settled.
- `refusalOf` also refuses `busy` while the project has a running sweep (read from `eval_sweeps`), unless the
  caller passes that sweep's id. Sweep start refuses the same way.
- The sweep hash is the suite's `previewHash` over the sweep's model list, checked at start and again before each
  step. Each step's row stores the hash over its own models.
- The server sorts a `cheapest` sweep's steps by estimates it recomputes with task 4, never trusting the client's.
- The continuation behaves as in the State table. It re-reads the sweep row in its write before reading a result or
  starting a step. Any throw ends the sweep `stopped`·refused with the error's text, caught and logged as
  `live-runs.ts`'s `execute` catch does. Each change announces `eval.sweep_changed` in the same write.
- `stopAll` runs before `evalLiveRuns.stopAll()` at daemon stop. Archive and remove go through the same path.
  `recoverAtStart` runs after `evalLiveRuns.recoverAtStart()`.
- Let 10db Pick Models: `POST …/evals/tasks` with `NewEvalOrigin.PickModels`. The draft asks the agent to make the
  live command read its models from an env var, names ampsio's `MODELS ?=` as the pattern, and says the agent runs
  free checks only.

**Rows:** every row of the State table.

**Tests (core: money and recovery):** extend `live-runs.test.ts`'s rung (FAKE_SRT, a real temp checkout, a fake suite
command that writes a report naming the model in `$MODELS`, with a chosen pass and cost):
1. A `cheapest` sweep of three models whose second passes ends `found`. The third step is `skipped` and spent is the
   first two costs.
2. A manifest change between steps ends the sweep `stopped`·refused and starts no further step.
3. A restart with a `running` sweep ends it `stopped`·interrupted and starts nothing.

Prove each red first.

**Index sections:** Design › A sweep; State table; Global constraints.
