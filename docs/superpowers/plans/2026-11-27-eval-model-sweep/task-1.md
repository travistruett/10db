# Task 1: contracts and `live.models` (Track A) — Core: what reaches a shell

**Files:** `packages/contracts/src/evals.ts`, `packages/contracts/src/ids.ts` (`EvalSweepId`),
`packages/contracts/src/events.ts`, `apps/daemon/src/evals/assess-prompt.ts`, `apps/daemon/src/evals/assess-answer.ts`,
`packages/agent-skill/src/evals-command.ts`, `packages/agent-skill/skill/SKILL.md`, `apps/daemon/src/evals/AGENTS.md`,
the contracts' generated files (by the repo's generate command, never by hand).

**Implements** (index, Interfaces, quoted there exactly): `EvalModelId`, `EvalModelEnvName`, `EvalModelChoice`,
`EvalLiveModels`, `EvalLiveRun.models`, `EvalSweepKind`, `EvalSweepState`, `EvalSweepStepState`,
`StartEvalSweepBody`, `EvalSweepDto`, `EvalCandidateDto`, `EvalSwitchBody`, the two new `EvalLiveRefusal` values,
`EvalLivePreviewDto.models`, `EventType.EvalSweepChanged`.

- `isReservedEnvName` lives in contracts (the fixed list in the index's Global constraints) so the manifest schema
  refuses a reserved name at the boundary; task 2 checks the sandbox's own allowlist against it.
- The assessment prompt asks, per suite with a live command, whether the command reads its models from an env var
  (a make `?=` variable, `os.environ`, `process.env`) and, when the project names models by its own names, the
  mapping to OpenRouter ids; it records nothing when unsure. The answer parser drops an invalid `live.models` from
  that suite only, never the whole answer.
- The skill's "Assess a project's evals" step documents `live.models` with ampsio's line as the example
  (`{ "env": "MODELS", "ids": "openrouter" }`) and orgtools' once its `run_eval` front door lands
  (`{ "env": "MODELS", "ids": { "choices": [{ "name": "gemini_3_7_flash", "model": "google/gemini-3.7-flash" }] } }`).

**Rows:** none (schema only).

**Tests (core: the manifest is the boundary to a shell):** extend the existing contracts or `assess-answer` test with
one table: ids that pass (`google/gemini-3.8-flash`, `@preset/amps-speed`, `openai/gpt-6-luna:free`) and ids and env
names that are refused (`a b`, `x;rm -rf ~`, `$(id)`, `` `id` ``, `a,b`, `PATH`, `DYLD_INSERT_LIBRARIES`, `GIT_DIR`,
`MAKEFLAGS`, `lowercase`). Prove red first.

**Index sections:** Design › The manifest; Global constraints.
