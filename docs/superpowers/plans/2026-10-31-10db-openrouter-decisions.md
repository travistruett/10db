# 10db OpenRouter Decisions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The daemon asks fast models for routine decisions through OpenRouter, with the builder's key in the
Keychain and today's rules as the fallback; Settings › Decisions manages it; the first decision skips a review
step a change does not need.

**Spec:** `docs/superpowers/specs/2026-10-31-10db-openrouter-decisions-design.md` (read it in full).
**Decision:** `docs/architecture/decisions/2026-10-31-openrouter-makes-routine-decisions.md`.

## Global constraints

- Root `AGENTS.md` and the `AGENTS.md` of each package you touch, `.claude/rules/code-style.md`,
  `.claude/rules/testing.md`. zod at every boundary (OpenRouter responses, the app setting, HTTP bodies).
- Each task works in its own worktree and branch, named in the task. Commit with explicit paths. Never run
  `make gate`; run the tests, typecheck and lint of the packages you change, and the repo docs tests when you touch
  docs (`pnpm --filter ./tests/repo exec vitest run src/architecture-docs.test.ts src/agent-docs.test.ts`).
- The key is never printed, logged, stored outside the Keychain or returned by the API, including in tests,
  fixtures and your own commands. Tests use an injected `fetch` and a fake `Keychain`; no test calls OpenRouter.
- Migrations are forward-only (`packages/db/AGENTS.md`, from v0.1.0 on): `pnpm --filter @10db/db generate`, never
  hand-edit `packages/db/drizzle/`.

## Interfaces (task 1 makes them; tasks 2 and 3 use them as written)

`@10db/contracts`:

```ts
export const JudgeDecision = { ReviewSize: 'review_size' } as const;
export type JudgeDecision = (typeof JudgeDecision)[keyof typeof JudgeDecision];

export const JudgeOutcome = {
  Acted: 'acted',
  BelowFloor: 'below_floor',
  FallbackOff: 'fallback_off',
  FallbackNoKey: 'fallback_no_key',
  FallbackTimeout: 'fallback_timeout',
  FallbackError: 'fallback_error',
} as const;

// zod schemas with these shapes, types inferred:
JudgeDecisionConfig = { enabled: boolean; model: string; floor: number /* 0..1 */ };
JudgeConfig = { enabled: boolean; decisions: { review_size: JudgeDecisionConfig } };
JudgeStatusDto = { config: JudgeConfig; keySet: boolean; off: boolean /* TENDB_JUDGE=off */ };
JudgeConfigPatch = deep-partial of JudgeConfig;
JudgeKeyInput = { key: string /* non-empty, trimmed */ };
JudgeTestResultDto =
  | { ok: true; model: string; latencyMs: number; costUsd: number | null }
  | { ok: false; error: string };
JudgeCallDto = { id; decision: JudgeDecision; model; question; answer: string | null; confidence: number | null;
  outcome: JudgeOutcome; latencyMs: number | null; costUsd: number | null; workstreamId: WorkstreamId | null;
  taskId: TaskId | null; createdAt: string };
DEFAULT_JUDGE_CONFIG: JudgeConfig  // enabled true; review_size { enabled true, model 'typesafe/jev-1.13', floor 0.8 }
```

HTTP (daemon, under the existing API's auth and route conventions; check `apps/daemon/src/api/` for naming):

| Route                    | Body / answer                                     |
| ------------------------ | ------------------------------------------------- |
| `GET /judge`             | `JudgeStatusDto`                                  |
| `PATCH /judge`           | `JudgeConfigPatch` → `JudgeStatusDto`             |
| `PUT /judge/key`         | `JudgeKeyInput` → `JudgeStatusDto` (never echoes) |
| `DELETE /judge/key`      | → `JudgeStatusDto`                                |
| `POST /judge/test`       | → `JudgeTestResultDto`                            |
| `GET /judge/calls?limit` | → `JudgeCallDto[]`, newest first, limit ≤ 100     |

Daemon (`apps/daemon/src/judge/index.ts` is the entry point):

```ts
interface Judge {
  choose(req: { decision: JudgeDecision; state: string; question: string;
    options: readonly [string, ...string[]]; workstreamId?: WorkstreamId; taskId?: TaskId;
    signal?: AbortSignal }): Promise<JudgeAnswer>;
}
type JudgeAnswer =
  | { kind: 'answered'; choice: string; confidence: number; model: string; latencyMs: number;
      costUsd: number | null; callId: string }
  | { kind: 'fallback'; reason: 'off' | 'no_key' | 'timeout' | 'error'; detail: string; callId: string };
```

`choose` reads the config and the key itself, logs the call, never throws. The caller records the outcome it acted
on with `recordJudgeOutcome(callId, outcome)` (a db store function), so `below_floor` and `acted` are written by
the decision, not the judge.

## Tasks

### Task 1: The judge, its config, its log and its API

Worktree `/Users/travistruett/Projects/10db-worktrees/decisions`, branch `feat/openrouter-decisions`.

- [ ] Contracts: the Interfaces block above, with tests for the schemas (defaults, an invalid floor, a patch).
- [ ] Db: table `judge_calls` (spec §2 "Log"), store functions to insert a call, record its outcome, list recent
      calls, and delete rows older than 30 days; the forward-only migration; the `judge` app setting read with
      zod and defaults. Real SQLite in a temp dir in tests.
- [ ] Daemon `judge/`: the client with both call shapes (spec §2). Before writing the systemone parser, read
      TypeSafe's API page (https://docs.typesafe.ai/api.md) and OpenRouter's TypeSafe guide
      (https://openrouter.ai/docs/guides/community/typesafe-sdk) for the exact request and response shapes,
      and cite them in a comment. Confidence for a System One `choice` is the chosen option's probability; for a
      chat model it is the `confidence` field of its JSON answer. Fallbacks per the spec. `TENDB_JUDGE=off` read
      where `TENDB_BENCHMARKS` is (`apps/daemon/src/daemon/options-from-env.ts`), and set wherever
      `TENDB_BENCHMARKS=off` is set (test projects, live acceptance, `scripts/dev.sh`); extend the repo test that
      checks `TENDB_BENCHMARKS` the same way if one exists. The startup deletes old log rows.
- [ ] Keychain: an `OPENROUTER_KEY_ACCOUNT = 'openrouter-api-key'` constant beside `AA_KEY_ACCOUNT`; writing and
      deleting through the existing `Keychain` (add `remove` if it lacks one, tested like `write`).
- [ ] API: the routes above, tested through `app.request()`; a test asserts no response body contains the key.
- [ ] One real call, by hand, after the tests pass: a script in the worktree's gitignored `scratch/` that reads the
      key from the Keychain inside the script (never printed) and calls `choose` once on
      `typesafe/jev-1.13` and once on a cheap chat model (e.g. `anthropic/claude-haiku-5.5`; check OpenRouter's
      model list for an exact id). Report the latency, cost and whether each parsed. If the systemone endpoint or
      the model id is wrong, fix the default and the spec, and say so in your report.
- [ ] Docs: `apps/daemon/AGENTS.md` (the `judge/` module in the layer list and its own bullet, `TENDB_JUDGE`),
      `docs/architecture/03-trust-boundaries.md` (what leaves the machine for OpenRouter, spec §5).

### Task 2: Settings › Decisions

Worktree `/Users/travistruett/Projects/10db-worktrees/decisions-ui`, branch `feat/openrouter-decisions-ui`, made
from task 1's last commit. Desktop only.

- [ ] A new app-wide section `Decisions` in `apps/desktop/src/views/settings/sections.ts` and the nav, laid out
      as spec §3 says, with the existing setting-row components and Mantine (use the Mantine MCP for component
      props). The key field is a password input that is cleared after sending; the section shows only "Set" or
      "Not set". When the daemon reports `off`, the section says the daemon was started with `TENDB_JUDGE=off` and
      disables its controls.
- [ ] The API client calls for the routes above, through the desktop's existing API client module.
- [ ] Tests (Testing Library, the desktop's existing patterns): key set and not set; setting a key clears the
      field and never renders it; Remove; test success shows model and latency, failure shows the error; the
      master and per-decision switches send patches; recent calls render with their outcome and task link.

### Task 3: Review size

Worktree `/Users/travistruett/Projects/10db-worktrees/decisions-review`, branch
`feat/openrouter-decisions-review`, made from task 1's last commit. Daemon only.

- [ ] A pure module (`apps/daemon/src/runner/review-size.ts` or under `routing/`, wherever `skip-rules.ts`'s
      neighbours suggest) with `reviewSizeRule(task, diff, step): 'review' | 'ask'` (spec §4's rule rows, a table
      test with one named row each) and `reviewSizeState(task, diff, gate): string` (the capped state, tested
      for the 24 KB cap).
- [ ] The runner: at the `gate passed; next:` transition, when the next step is `review` and the rule says `ask`,
      call `judge.choose` (injected into the runner like `baseUpdates`) outside any db write. `skip` at or above
      the configured floor → mark the review step skipped with the spec's reason and move to the step after it,
      or finish, exactly as the docs-only QA skip does; record `acted`. Below the floor → `below_floor`, review
      runs. Any fallback → review runs. The diff is read the way the runner already reads a step's changes
      (find it; don't add a second git path).
- [ ] Runner tests with a fake judge: skip above the floor (review step shows skipped with the reason; the next
      step or done follows), below the floor, each fallback, and each forcing rule making no call.
- [ ] Docs: the review rule in `docs/architecture/02-batch-delivery.md` or wherever the docs-only QA skip is
      described (find it with grep), and the step's skipped reason in any user-facing docs that list reasons.
