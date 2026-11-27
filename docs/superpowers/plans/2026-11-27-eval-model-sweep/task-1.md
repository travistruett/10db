# Task 1: contracts and `live.models` — Core: what reaches a shell

Starts after `feat/evals-wizard` (it changes `NewEvalBody`) has merged; rebase onto it.

**Files:** `packages/contracts/src/evals.ts`, `ids.ts` (`EvalSweepId`), `events.ts`, the contracts' generated files
(by the repo's command), `apps/daemon/src/evals/assess-prompt.ts`, `assess-answer.ts`,
`packages/agent-skill/src/evals-command.ts`, `packages/agent-skill/skill/SKILL.md`, `apps/daemon/src/evals/AGENTS.md`.

**Implements:** the task-1 block of the index's Interfaces, and `isReservedEnvName` over Design › The manifest's
fixed list (contracts holds only that list).

- The assessment asks, per suite with a live command, whether it reads models from an env var and, for project
  names, their models; it records nothing when unsure, and drops an invalid `live.models` from that suite only. It
  adds the file that binds the suite's model to its covered paths (Design › The manifest).
- The skill's assess step shows ampsio's `{ "env": "MODELS", "ids": "openrouter" }` and orgtools'
  `{ "env": "MODELS", "ids": { "choices": [{ "name": "gemini_3_7_flash", "model": "google/gemini-3.7-flash" }] } }`.

**Tests (core: the boundary to a shell):** one table in the existing contracts or `assess-answer` test. Passing ids:
`google/gemini-3.8-flash`, `@preset/amps-speed`, `openai/gpt-6-luna:free`. Refused ids and names: `a b`,
`x;rm -rf ~`, `$(id)`, `` `id` ``, `a,b`, `PATH`, `DYLD_INSERT_LIBRARIES`, `GIT_DIR`, `MAKEFLAGS`, `lowercase`.
Refused choice name: `-rf`. Prove it red first.

**Index sections:** Design › The manifest; Global constraints.
