# Evals: try other models and find the cheapest that passes

**Size: Core** (money spent, the live-run sandbox, an env value that reaches a shell, recovery). Index plus one card
per task: `2026-11-27-eval-model-sweep/task-<n>.md`. No spec section: the builder chose this design in chat (option 1,
"10db runs it"); the Design section below is the spec, and cards name its headings. Fable plan review: round 1
applied.

## Brief

**What changes for you.** A suite's drawer gets two actions beside Run. **Try Other Models** lets you pick models
(10db lists candidates with their intelligence score, price and an estimated run cost) and runs the suite on them
through the confirm window you know. **Find Cheapest Passing** tries models cheaper than today's cheapest pass,
cheapest first, and stops at the first that clears every gate, or before a run that would pass your cost cap.
Results land as your harness's normal reports, so the table and trend update as today. When a model wins, **Switch
to <model>** files a task: an agent changes the binding your project's way (ampsio: the slot line in
`apps/llm/model_slots.py`) and lists every suite on that slot; each suite that covers that file shows
"<suite> · not run" on the task until you run it. 10db never edits your code and never spends without your click.

**How a suite takes a model.** The manifest names the env var a suite's command reads for models (ampsio: `MODELS`,
today). orgtools works once its task `tsk_01a21eb6-a18b-7330-aefe-b488689f3843` lands; any other suite offers **Let
10db Pick Models**, a task that adds the var.

**What it buys.** "Is there a cheaper model that still passes?" becomes one click and a cap.

**What could go wrong, and how we'd know.**
- *A model id reaches a shell* (make pastes `$(MODELS)` into a command line). Only strict ids or the manifest's
  closed list pass; anything else is refused before a run, and tests prove a hostile id or env name never runs.
- *Spend passes the cap.* The cap is checked between runs against each report's real cost, so one run can
  overshoot its estimate; the window says so.
- *A result can't be read, or the manifest changes mid-sweep.* The sweep stops and says why, rather than guess.
- *10db stops or the project is archived mid-sweep.* The run ends as interrupted (slice 5's recovery), the sweep
  stops, and nothing resumes.

**Calls you might disagree with.**
1. **Estimates scale the last run's cost by output price**; "unknown" without prices.
2. **The cap counts known costs.** Try Other Models runs a model whose cost turns out unknown and goes on; Find
   Cheapest stops on an unknown cost, since it can't keep to the cap.
3. **One live run per project still holds**, so Run is busy during a sweep.
4. **No resume, and no slot-wide run**: the switch task lists the slot's suites; you run them from its Evals block.

**Needed from you.** Nothing. Screenshots of the picker and the sweep window come before task 5 is reviewed.

## Global constraints

- `.claude/rules/code-style.md` and `testing.md` bind. zod at every boundary: `live.models`, the sweep and candidates
  routes.
- Every slice 5 constraint holds (`2026-11-25-evals-live-run.md`, Global constraints).
- **The model env is the only addition to the command's environment**, set after the allowlist, by the live-run path
  only, never on the stop command. Its name is **refused when reserved** (Design › The manifest).
- **The value is never a free string**: each pick is an `EvalModelId` or a `choices` name; joined by `,`; at most 10.
  The command string itself never changes.
- `previewHash` covers `live.models` and the run's models.
- A sweep is one suite, runs one live run at a time, and never starts a step once spent + its estimate > cap.
- Lanes never run a live arm.
- Migrations are forward-only since `v0.1.0` (`packages/db/AGENTS.md`): one new generated file, made last, after the
  final merge of `origin/main`; no baseline regeneration.

## Provider parity

| | Claude plan | Bedrock / API key | ChatGPT / Codex plan |
| --- | --- | --- | --- |
| Try / Find Cheapest | the project's harness and keys in its containers; no model of 10db's | same | same |
| Candidates and prices | model profiles and the synced OpenRouter catalogue | same | same |
| Assess Now learning `live.models` | the existing assessment read | same | Codex-only: "Copy a Prompt", whose skill step records it |
| Switch and Let 10db Pick Models | an ordinary lane on the project's account | same | same |

## Design

### The manifest

`live.models` names the env var (`env`) and the ids: `'openrouter'` passes ids as given; `{ choices }` passes only
the listed project names (alphanumeric first), each mapped to the model it is, for pricing and matching. A suite
without it has Run but no Try. The assessment also records the file that binds a suite's model among its covered
paths, so a switch task gets slice 2's marker.

An env name is reserved, and refused by contracts, when it is `PATH`, `HOME`, `SHELL`, `IFS`, `ENV`, `BASH_ENV`,
`PS4`, `TMPDIR`, `MAKEFLAGS`, `MFLAGS`, `GNUMAKEFLAGS`, `MAKEFILES` or starts `GIT_`, `DOCKER_`, `COMPOSE_`, `LD_`,
`DYLD_`, `NODE_`, `npm_`, `PYTHON`. The sandbox refuses it again unless `deniedEnvNames({ [name]: '' })` denies it,
it doesn't look like a secret, and it isn't already a key of the command env.

### A sweep

One suite, `kind` `try` (every picked model, in order) or `cheapest` (the server sorts by its own estimates and stops
at the first pass). Each step is an ordinary `eval_live_runs` row carrying its own `models_json` and the
`sweep_id`. When a step's run settles, the sweep re-reads its row, and only if still running reads the suite's
newest result after the step started that names the step's model (a `choices` step matches the name or the model):
passed, failed or unreadable (stops the sweep). Spent sums known report costs. Then task 4's `sweepNext` picks the
next step or the end.

### Candidates

Enabled model profiles and catalogue models with an OpenRouter id (only the choices for a `choices` suite), each with
intelligence, output price, the estimate and its last result here. Estimate = the reference run's cost × candidate
output price ÷ reference output price; the reference is the latest run's cheapest passing model with a cost, else
its first with a cost.

### Switch

`POST …/switch` files "Switch <slot or suite> to <model>": the winning report and cost, every suite whose latest
result names the same slot, the project's eval skill as slice 3 names it, and "edit code and run free checks only".

## Interfaces

```ts
// packages/contracts/src/evals.ts (task 1)
export const EvalModelId = z.string().min(1).max(100)
  .regex(/^@?[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._:-]*)?$/i);
export const EvalModelEnvName = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/)
  .refine((n) => !isReservedEnvName(n), 'a name the shell or a tool reads');
export const EvalModelChoice = z.strictObject({ name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/), model: EvalModelId });
export const EvalLiveModels = z.strictObject({
  env: EvalModelEnvName,
  ids: z.union([z.literal('openrouter'), z.strictObject({ choices: z.array(EvalModelChoice).min(1).max(50) })]),
});
// EvalLiveRun gains `models: EvalLiveModels.optional()`. NewEvalOrigin gains PickModels: 'pick_models'.
// EvalLiveRefusal gains NoModels: 'no_models', BadModel: 'bad_model'. EvalLivePreviewDto gains `models: EvalLiveModels.nullable()`.

export const EvalSweepKind = { Try: 'try', Cheapest: 'cheapest' } as const;
export const EvalSweepState = { Running: 'running', Found: 'found', Done: 'done', Stopped: 'stopped' } as const;
export const EvalSweepReason = { Capped: 'capped', Unreadable: 'unreadable', CostUnknown: 'cost_unknown',
  Interrupted: 'interrupted', Refused: 'refused', ByYou: 'by_you' } as const;
export const EvalSweepStepState = { Waiting: 'waiting', Running: 'running', Passed: 'passed', Failed: 'failed',
  Unreadable: 'unreadable', Stopped: 'stopped', Skipped: 'skipped' } as const;

export const StartEvalSweepBody = z.strictObject({
  kind: z.enum(EvalSweepKind), models: z.array(z.string().min(1).max(100)).min(1).max(10),
  capUsd: z.number().positive().max(500), previewHash: z.string().min(1).max(128),
});
export const EvalSweepDto = z.object({
  id: EvalSweepId, projectId: ProjectId, suiteKey: EvalSuiteKey, kind: z.enum(EvalSweepKind),
  state: z.enum(EvalSweepState), reason: z.enum(EvalSweepReason).nullable(), reasonText: z.string().nullable(),
  capUsd: z.number(), spentUsd: z.number(), winner: z.string().nullable(),
  steps: z.array(z.object({ model: z.string(), state: z.enum(EvalSweepStepState),
    estimateUsd: z.number().nullable(), costUsd: z.number().nullable(), runId: EvalLiveRunId.nullable() })),
  startedAt: z.string(), endedAt: z.string().nullable(),
});
export const EvalCandidateDto = z.object({
  model: z.string(), name: z.string().nullable(), intelligence: z.number().nullable(),
  outputPrice: z.number().nullable(), estimateUsd: z.number().nullable(),
  last: z.object({ passed: z.boolean(), costUsd: z.number().nullable(), at: z.string() }).nullable(),
});
export const EvalSwitchBody = z.strictObject({ model: EvalModelId, slot: z.string().min(1).max(100).nullable() });
// EventType.EvalSweepChanged = 'eval.sweep_changed', data { projectId, suiteKey, sweepId, state }

// gate-runner.ts GateRequest and gate-sandbox.ts GateRunInput (task 2)
readonly modelEnv?: { readonly name: string; readonly value: string };

// apps/daemon/src/evals/model-env.ts (task 3)
export function modelEnvValue(models: EvalLiveModels, picked: readonly string[]): string; // throws EvalLiveRefused(BadModel)
// live-runs.ts (task 3): previewHash(suite, project, models: readonly string[]); start gains
start(projectId: ProjectId, suiteKey: EvalSuiteKey, previewHash: string,
  opts?: { models?: readonly string[]; sweepId?: EvalSweepId; onSettled?: (run: EvalLiveRunDto) => void }): Promise<EvalLiveRunDto>;

// apps/daemon/src/evals/sweep-cost.ts (task 4), pure
export interface SweepPlan { readonly kind: EvalSweepKind; readonly capUsd: number;
  readonly steps: readonly { readonly state: EvalSweepStepState; readonly estimateUsd: number | null;
    readonly costUsd: number | null }[] }
export function estimateRunCost(reference: { costUsd: number; outputPrice: number } | null,
  candidateOutputPrice: number | null): number | null;
export function sweepNext(plan: SweepPlan): { step: number } | { end: EvalSweepState; reason: EvalSweepReason | null };

// apps/daemon/src/evals/sweeps.ts (task 3)
export interface EvalSweeps {
  start(projectId: ProjectId, suiteKey: EvalSuiteKey, body: StartEvalSweepBody): Promise<EvalSweepDto>;
  stop(projectId: ProjectId, sweepId: EvalSweepId): Promise<void>;
  get(projectId: ProjectId, sweepId: EvalSweepId): EvalSweepDto;
  latest(projectId: ProjectId, suiteKey: EvalSuiteKey): EvalSweepDto | null;
  recoverAtStart(): void;
  stopAll(): Promise<void>;
}

// Routes
// GET  /projects/:projectId/evals/:suiteKey/candidates      -> EvalCandidateDto[] (task 4; classify in render-access.ts)
// GET  /projects/:projectId/evals/:suiteKey/live?models=a,b  -> EvalLivePreviewDto (task 3)
// POST /projects/:projectId/evals/:suiteKey/sweeps           StartEvalSweepBody -> 201 EvalSweepDto | 409 refusal (task 3)
// GET  /projects/:projectId/evals/:suiteKey/sweeps/latest    -> EvalSweepDto | null (task 3; classify)
// GET  /projects/:projectId/evals/sweeps/:sweepId            -> EvalSweepDto (task 3; classify)
// POST /projects/:projectId/evals/sweeps/:sweepId/stop       -> 204 (task 3)
// POST /projects/:projectId/evals/:suiteKey/switch           EvalSwitchBody -> 201 TaskDto (task 6)
// packages/db: table eval_sweeps (steps_json); eval_live_runs gains models_json, sweep_id (task 3)
```

## State table (design, not a test list)

| Sweep \ event | Start | Step settles | Next step refused | Stop | Project archived/removed, daemon stop | Daemon start |
| --- | --- | --- | --- | --- | --- | --- |
| none | hash, models, cap valid; no live run or sweep → `running`, first step starts; else 409 | — | — | 404 | — | — |
| `running`, a step running | 409 `busy` | re-read the row; if still running, read the result → `found` (cheapest pass), `stopped`·unreadable, `stopped`·cost_unknown (cheapest), next step, `done`·capped, or `done` | — | stop the run; that step `stopped`, rest `skipped` → `stopped`·by_you | sweeps end first: that step `stopped`, rest `skipped` → `stopped`·interrupted; then the runs end (slice 5) | — |
| `running`, between steps or verdict decided but not written | 409 `busy` | — | any throw (hash changed, refusal, db) → `stopped`·refused with its text, rest `skipped` | rest `skipped` → `stopped`·by_you, 204 | as above | — |
| `running` row after a crash | 409 `busy` | — | — | — | — | after slice 5's run recovery: running step `stopped`, rest `skipped` → `stopped`·interrupted |
| ended | as none | late settle: ignored | — | 404 | — | — |

A manual Run while a sweep runs is refused `busy`. A step whose run exits non-zero still reads the result.

## Tracks

One implementer, integration branch `feat/eval-model-sweep` in `../10db-worktrees.noindex/eval-sweep`, in order 1, 2,
4, 3, 5, 6. Task 1 starts after `feat/evals-wizard` (which changes `NewEvalBody`) has merged; task 5 after
`feat/evals-drawer` (the drawer's action row) has merged.

## Tasks

1. Contracts, `live.models`, the assessment and the skill learn it. `task-1.md`
2. `modelEnv` in the gate sandbox. `task-2.md`
4. Candidates and the cost estimate (pure, then the route). `task-4.md`
3. Live runs take models; the sweep service, table, routes, recovery, Let 10db Pick Models' draft; migration last. `task-3.md`
5. The drawer: Try Other Models, Find Cheapest Passing, the sweep window; e2e. `task-5.md`
6. Switch to <model>. `task-6.md`
