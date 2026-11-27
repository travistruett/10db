# Evals: try other models and find the cheapest that passes

**Size: Core** (money spent, the live-run sandbox, an env value that reaches a shell, recovery). Index plus one card
per task: `2026-11-27-eval-model-sweep/task-<n>.md`. No spec section: the builder chose this design in chat (option 1,
"10db runs it"); the Design section below is the spec, and cards name its headings.

## Brief

**What changes for you.** A suite's drawer gets two actions beside Run. **Try Other Models** lets you pick models
(10db lists candidates with their intelligence score and price, and estimates each run's cost), then runs the suite
on them through the confirm window you already know. **Find Cheapest Passing** tries models cheaper than the
cheapest one that passes today, cheapest first, and stops at the first that clears every gate, or at the cost cap
you set. Results land as your harness's normal reports, so the table, trend and By Model update as today. When a
model wins, **Switch to <model>** files a task: an agent changes the binding in your code the way your project
does it (ampsio: the slot line in `apps/llm/model_slots.py`), lists every other suite that shares that slot, and
the PR's Evals block offers **Check the Slot**, which runs those suites on the new model before you merge.
10db never edits your code itself and never runs a paid model without your click.

**How a suite takes a model.** The manifest records, per suite, the env var its live command reads for models
(`live.models`). ampsio already works: its Makefile says `MODELS ?=`, so an env `MODELS=google/gemini-3.8-flash`
reaches `make eval TASK=… ` as `--models …`. orgtools works once its task `tsk_01a21eb6-a18b-7330-aefe-b488689f3843`
lands ("Every eval runs through one command that takes its models from the environment": `run_eval --task <name>
--repeat n`, models from a `MODELS` env var). orgtools calls providers directly and keeps its own names
(`gemini_3_7_flash`), so its `live.models` lists `choices` that map each name to the model it is. A suite whose
harness has no models var shows **Let 10db Pick Models**, a task that adds one. Assess Now records `live.models`
when it reads one.

**What it buys.** "Is there a cheaper model that still passes?" becomes one click and a cap, not an afternoon.

**What could go wrong, and how we'd know.**
- *A model id that reaches a shell.* make pastes `$(MODELS)` into a command line. 10db only passes ids that match
  a strict pattern (letters, digits, `/ . _ - : @`, no spaces) or a closed list the manifest names; anything else
  is refused before a run, and a test proves a hostile id never reaches the command.
- *A sweep spends more than the cap.* The cap is checked between runs against the real cost each report states:
  a single run can overshoot its estimate, and the window says so. A report that states no cost stops the sweep.
- *A run grades something else than asked.* After each run 10db reads the newest report for that model; if none
  names it, the sweep stops as "couldn't read the result" rather than guessing.
- *A slot is shared.* Switching ampsio's SMART moves every suite on SMART. The switch task names them and Check
  the Slot runs them all before merge; the PR's Evals block shows any that were not run.
- *10db stops mid-sweep.* The current run ends as interrupted (slice 5's recovery) and the sweep ends with it;
  nothing resumes on its own.

**Calls you might disagree with.**
1. **Estimates scale the last run's cost by price.** A candidate's estimate is this suite's last known cost on a
   model times the ratio of their output prices; with no price it reads "unknown", and Find Cheapest skips
   unknown-price models unless you pick them.
2. **The cap is per sweep, checked between runs**, not a hard stop mid-run (10db can't see spend mid-run).
3. **One live run per project still holds:** a sweep is a queue of ordinary runs, and Run is busy while it goes.
4. **No resume.** An interrupted sweep is started again by hand.

**Needed from you.** Nothing. Screenshots of the picker and the sweep window come before task 5 is reviewed.

## Global constraints

- `.claude/rules/code-style.md` and `testing.md` bind. zod at every boundary: the manifest's `live.models`, the
  sweep routes, the candidates route.
- Every slice 5 constraint still holds (`2026-11-25-evals-live-run.md`, Global constraints): no key passed, env
  files read-only and Docker-only, no hosts for a Docker suite, unslotted gate runner, no `project.id`, process
  ledger, nothing runs without a click.
- **The model env is the only addition to the command's environment.** It is set after the allowlist, under the
  name the manifest records, and only by the live-run path. The name must match `^[A-Z][A-Z0-9_]{0,63}$` and must
  not be a name the sandbox sets or allowlists, nor `PATH`, `HOME`, `SHELL`, `IFS`, `ENV`, `BASH_ENV`, `PS4`,
  `TMPDIR`, `MAKEFLAGS`, `MFLAGS`, `GNUMAKEFLAGS`, `MAKEFILES`, or start with `GIT_`, `DOCKER_`, `COMPOSE_`, `LD_`,
  `DYLD_`, `NODE_`, `npm_`, `PYTHON`.
- **The value is never a free string.** Each id matches `EvalModelId` or is a `name` from the suite's `choices`;
  ids are joined by `,`; at most 10 a run. The command string itself is never changed.
- `previewHash` covers `live.models` and the models of the run, so a window that showed other models is refused.
- A sweep never runs two live runs at once and never starts the next run once spent ≥ cap.
- Lanes still never run a live arm: the switch task's agent edits code and runs free checks only.
- The migration is generated last, after the final merge of `origin/main`.

## Provider parity

| | Claude plan | Bedrock / API key | ChatGPT / Codex plan |
| --- | --- | --- | --- |
| Try / Find Cheapest / Check the Slot | the project's own harness and keys in its containers; no model of 10db's | same | same |
| Candidates and prices | model profiles and the OpenRouter catalogue the daemon already syncs | same | same |
| Assess Now learning `live.models` | the existing assessment read | same | Codex-only: the "Copy a Prompt" path, whose skill step records it |
| Switch task | an ordinary lane on the project's account | same | same |

## Design

### The manifest

`live.models` (optional) says how the live command takes models. `ids: 'openrouter'` passes OpenRouter-style ids
as given; `ids: { choices }` passes only the listed project names, each mapped to the OpenRouter model it is, so
10db can price it and match it in reports. A suite without `live.models` has Run but no Try.

### A sweep

A sweep is one of two kinds over one or more steps `{ suiteKey, model }`:
- `try`: run every step in order (Try Other Models: one suite, the picked models; Check the Slot: every suite on a
  slot, one model).
- `cheapest`: candidates cheapest-estimate first; stop at the first step whose newest report for that model passes
  every gate.

Each step is an ordinary `eval_live_runs` row with its `models` and `sweep_id`. After a step's run ends, 10db reads
the suite's newest result whose `at` is after the step started and whose models include the step's model:
passed, failed, or `unreadable` (none found; the sweep stops). Spent is the sum of the steps' report costs; a step
whose report states no cost stops the sweep (`cost_unknown`). Before each step: `spent + estimate > cap` (or an
unknown estimate in `cheapest`) skips the rest as `capped`.

### Candidates

`GET …/evals/:suiteKey/candidates` lists enabled model profiles and catalogue models with an OpenRouter id, each
with AA intelligence, output price, the estimate for this suite and, when known, its last result here. Estimate =
the suite's latest known cost on a reference model × (candidate output price ÷ reference output price); the
reference is the cheapest passing model of the latest run, else its first model with a cost. For `choices`
suites, only the choices are candidates.

### Switch

`POST …/evals/:suiteKey/switch { model, slot }` files a task "Switch <slot> to <model>": the winning run's report
path, the suites whose latest result names the same slot (from `EvalModelResultDto.slot`), the project's eval
skill as slice 3 names it, and the rule that the lane edits code and runs free checks only. The task's Evals block
(slice 2) offers Check the Slot: a `try` sweep of those suites on the new model, through the same window.

## Interfaces

```ts
// packages/contracts/src/evals.ts (task 1)
export const EvalModelId = z.string().min(1).max(100)
  .regex(/^@?[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._:-]*)?$/i);
export const EvalModelEnvName = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/)
  .refine((n) => !isReservedEnvName(n), 'a name the sandbox or the shell owns');
export const EvalModelChoice = z.strictObject({
  name: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/), model: EvalModelId,
});
export const EvalLiveModels = z.strictObject({
  env: EvalModelEnvName,
  ids: z.union([z.literal('openrouter'), z.strictObject({ choices: z.array(EvalModelChoice).min(1).max(50) })]),
});
// EvalLiveRun gains `models: EvalLiveModels.optional()`.
// apps/daemon/src/sandbox/env-names.ts exports isReservedEnvName(name: string): boolean (contracts re-declares the
// fixed list; the daemon test checks the two agree with the sandbox's allowlist).

export const EvalSweepKind = { Try: 'try', Cheapest: 'cheapest' } as const;
export const EvalSweepState = { Running: 'running', Found: 'found', Done: 'done', Stopped: 'stopped',
  Capped: 'capped', Unreadable: 'unreadable', CostUnknown: 'cost_unknown', Interrupted: 'interrupted' } as const;
export const EvalSweepStepState = { Waiting: 'waiting', Running: 'running', Passed: 'passed', Failed: 'failed',
  Skipped: 'skipped', Unreadable: 'unreadable' } as const;

export const StartEvalSweepBody = z.strictObject({
  kind: z.enum(EvalSweepKind),
  steps: z.array(z.strictObject({ suiteKey: EvalSuiteKey, model: z.string().min(1).max(100) })).min(1).max(20),
  capUsd: z.number().positive().max(500),
  previewHash: z.string().min(1).max(128),
});
export const EvalSweepDto = z.object({
  id: EvalSweepId, projectId: ProjectId, kind: z.enum(EvalSweepKind), state: z.enum(EvalSweepState),
  capUsd: z.number(), spentUsd: z.number(), winner: z.string().nullable(),
  steps: z.array(z.object({ suiteKey: EvalSuiteKey, model: z.string(), state: z.enum(EvalSweepStepState),
    estimateUsd: z.number().nullable(), costUsd: z.number().nullable(), runId: EvalLiveRunId.nullable() })),
  startedAt: z.string(), endedAt: z.string().nullable(),
});
export const EvalCandidateDto = z.object({
  model: z.string(), name: z.string().nullable(), intelligence: z.number().nullable(),
  outputPrice: z.number().nullable(), estimateUsd: z.number().nullable(),
  last: z.object({ passed: z.boolean(), costUsd: z.number().nullable(), at: z.string() }).nullable(),
});
export const EvalSwitchBody = z.strictObject({ model: EvalModelId, slot: z.string().min(1).max(100).nullable() });
// EvalLiveRefusal gains NoModels: 'no_models' (the suite has no live.models) and BadModel: 'bad_model'.
// EvalLivePreviewDto gains `models: EvalLiveModels.nullable()`; previewHash(suite, project, models: readonly string[]).
// EventType.EvalSweepChanged = 'eval.sweep_changed', data { projectId, sweepId, state }

// apps/daemon/src/verify/gate-runner.ts and sandbox/gate-sandbox.ts (task 2)
/** The live run's model env: set after the allowlist; the name is checked again here. */
readonly modelEnv?: { readonly name: string; readonly value: string };

// apps/daemon/src/evals/model-env.ts (task 3): the one place a model list becomes an env value
export function modelEnvValue(models: EvalLiveModels, picked: readonly string[]): string; // throws EvalLiveRefused(BadModel)

// apps/daemon/src/evals/sweep-cost.ts (task 4): pure
export function estimateRunCost(reference: { costUsd: number; outputPrice: number } | null,
  candidateOutputPrice: number | null): number | null;
export function sweepNext(sweep: SweepPlan, spentUsd: number): { step: number } | { end: EvalSweepState };

// apps/daemon/src/evals/sweeps.ts (task 3)
export interface EvalSweeps { start; stop(projectId, sweepId); get(projectId, sweepId); latest(projectId, suiteKey);
  recoverAtStart(): Promise<void> }

// Routes (tasks 3, 4, 6)
// GET  /projects/:projectId/evals/:suiteKey/candidates      -> EvalCandidateDto[] (classify in render-access.ts)
// GET  /projects/:projectId/evals/:suiteKey/live?models=a,b  -> EvalLivePreviewDto for those models
// POST /projects/:projectId/evals/sweeps                      StartEvalSweepBody -> 201 EvalSweepDto | 409 refusal
// POST /projects/:projectId/evals/sweeps/:sweepId/stop        -> 204
// GET  /projects/:projectId/evals/sweeps/:sweepId             -> EvalSweepDto (classify)
// POST /projects/:projectId/evals/:suiteKey/switch            EvalSwitchBody -> 201 TaskDto
// packages/db: table eval_sweeps (steps as rows in eval_sweep_steps); eval_live_runs gains models_json, sweep_id
```

## State table (design, not a test list)

| Sweep state \ event | Start click | Step run ends | Stop | Daemon stop | Daemon start |
| --- | --- | --- | --- | --- | --- |
| none | hash, models and cap valid, no live run → `running`, first step starts; else 409 with the reason | — | — | — | — |
| `running` | 409 `busy` | read the result: `cheapest` and passed → `found` (winner); `unreadable` → `unreadable`; report cost null → `cost_unknown`; else next step, or `capped` when spent + next estimate > cap, or `done` when none left | stop the run (slice 5), rest `skipped` → `stopped` | run ends `interrupted` → sweep `interrupted` | — |
| `running` row after a crash | 409 `busy` until recovery | — | — | — | the run's recovery (slice 5), then sweep `interrupted`, waiting steps `skipped` |
| ended | as none | — | 404 | — | — |

A manual Run while a sweep goes is refused `busy` (one live run per project). A step whose run exits non-zero still
reads the result: a failing eval often exits 1.

## Tracks

- **Track A** (one implementer, integration branch `feat/eval-model-sweep` in `../10db-worktrees.noindex/eval-sweep`):
  task 1, then 3, then 4, then 5, then 6.
- **Track B** (one implementer, own worktree off the integration branch): task 2, merged before task 3 starts.
- Task 5 starts after PR B (`feat/evals-drawer`, the drawer's action row) has merged to `main` and been merged in;
  PRs A and C (`feat/evals-page`, `feat/evals-wizard`) touch other files.

## Tasks

1. Contracts, `live.models` in the manifest, the assessment and the skill learn it. `task-1.md`
2. `modelEnv` in the gate sandbox: set after the allowlist, reserved names refused; seatbelt test. `task-2.md`
3. Live runs take models; the sweep service, its tables, routes, recovery; migration last. `task-3.md`
4. Candidates and the cost estimate; the candidates route. `task-4.md`
5. The drawer: Try Other Models, Find Cheapest Passing, the sweep window; e2e. `task-5.md`
6. Switch to <model>: the task, and Check the Slot in the task's Evals block. `task-6.md`
