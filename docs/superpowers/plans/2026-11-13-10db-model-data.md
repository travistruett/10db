# Model data from AA and OpenRouter (PR 1) Implementation Plan

## Brief

**What changes for the builder:** nothing visible yet. The daemon starts reading OpenRouter's scores and measured
speed once a day (speed hourly per model) with the key of the account decisions run on, and the model list it
serves gains, for every number, where it came from. Decision models gain a cost per million decisions and a time
per decision. Two new reads serve the Decisions page to come: per-decision stats and a filterable call log.

**What it buys:** the data PR 2 (Decisions page) and PR 3 (Models switch) draw, landed and tested on its own.

**What could go wrong, and how we'd know:** OpenRouter's numbers leaking into routing (Task 6's test through
`chooseModel` fails); tripping OpenRouter's rate limit (Task 5's pacing test); a wrong join showing another
model's numbers (Task 4's table); the migration colliding with the playbook PR's (whoever merges second
regenerates, per `10db-worktrees/COORDINATION-models.md`).

**Calls you might disagree with:** the sync reads OpenRouter's full public model list daily to learn which ids
to read speed for; no UI in this PR, so the status line waits for PR 3.

**Needed from you:** nothing.

---

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the daemon combines AA and OpenRouter into model rows whose every number names its source, serves cost
and time for decision models, and serves per-decision stats, with routing unchanged.

**Architecture:** a new OpenRouter sync in `benchmarks/` keeps its own table (`openrouter_measures`); a pure merge
rule in `catalogue/` builds the served rows from the AA profiles and those measures; routing keeps reading
`model_profiles` alone. Judge reads in `packages/db` feed two new routes.

**Tech Stack:** TypeScript, zod, Drizzle on SQLite, Hono, vitest.

**Spec:** `docs/superpowers/specs/2026-11-13-10db-models-and-decisions-design.md` (§3, §5, §8, §9 PR 1, §10).

## Global Constraints

- Branch `feat/model-data` from `origin/main` in `../10db-worktrees/model-data`; root, `apps/daemon`,
  `packages/db` and `packages/contracts` `AGENTS.md` bind.
- Routing reads none of OpenRouter's numbers; `model_profiles` keeps AA's values only (spec §5.4).
- The OpenRouter sync reads a key and calls out only when the daemon runs with neither `TENDB_JUDGE=off` nor
  `TENDB_BENCHMARKS=off` (spec §3). `DaemonOptions.openRouterSync` is off unless given, so an in-process test
  harness never reaches the network.
- The key is the secret of the account decisions run on (`createJudgeKeyReader` with `getJudgeConfig().accountId`),
  never logged, never in a row, response or error text.
- OpenRouter's numbers are never committed, put in fixtures or shipped in a release snapshot; tests use invented
  numbers (spec §3). The same holds for AA numbers.
- `/api/v1/benchmarks`: at most 30 requests a minute and 500 a day per account; the sync stays at or under 20 a
  minute in total.
- Contracts are additive; regenerate with `pnpm --filter @10db/contracts generate`.
- Migrations are forward-only since `v0.1.0`: `pnpm --filter @10db/db generate`, never edited by hand.
- Every new `GET` route is classified in `screens/render-access.ts` and `screens/dev-ui-access.ts`
  (`api/render-reads.test.ts` fails otherwise).
- Files owned by the playbook session until its PR merges are not edited: `routing/**`,
  `contracts/src/rigor.ts`, `ModelSetting` in `contracts/src/catalogue.ts`, and every `views/settings` file.
- Run only the tests the change can break while working (`vitest related`), plus typecheck and lint of what
  changed; never `make gate`. Each new behaviour's commit carries one value card (`.claude/rules/testing.md`).

## Review Focus

1. **A model OpenRouter lists under a dated or Bedrock-style id**: it joins to the catalogue model exactly as an
   account's list would, or not at all. Pinned in Task 4.
2. **The account decisions run on is archived or its key changed mid-day**: the sync reads nothing, keeps its old
   rows and records `no_key`. Pinned in Task 5.
3. **A provider OpenRouter serves without stats** (`throughput_last_30m: null`): that provider is skipped, never
   read as zero. Pinned in Tasks 2 and 6.
4. **A decision model with logged calls but no price** (a `:free` model): cost per million is 0 from your calls,
   and the typical-size estimate skips it rather than dividing by zero. Pinned in Task 7.
5. **The call-log filters with an unknown decision or outcome**: 400 without reaching the service. Pinned in Task 8.

---

### Task 1: Contracts for sources, decision-model numbers and decision stats

**Files:**
- Modify: `packages/contracts/src/catalogue.ts` (`ModelEffortDto`, `ModelRowDto` only), `packages/contracts/src/decision-models.ts`, `packages/contracts/src/benchmarks.ts`, `packages/contracts/src/judge.ts` (calls query only), `packages/contracts/src/json-schema.ts`
- Create: `packages/contracts/src/model-sources.ts`, `packages/contracts/src/decision-stats.ts`
- Test: `packages/contracts/src/model-sources.test.ts`

**Interfaces:**
- Produces:
  - `FieldSource = { Aa: 'aa', AaViaOpenRouter: 'aa_via_openrouter', OpenRouter: 'openrouter', YourCalls: 'your_calls', OpenRouterPrice: 'openrouter_price', Assumed: 'assumed' } as const` and its type.
  - `FieldSources = z.object({ intelligence, coding, agentic, costPerTask, speed })`, each `z.enum(FieldSource).nullable()`.
  - On `ModelEffortDto` and `ModelRowDto`: `coding: number | null`, `agentic: number | null`, `sources: FieldSources`, `speedProvider: string | null`; every new field has a `.default()` (null, or an all-null `sources`) so an older response still parses.
  - On `DecisionModelDto`: `costPerMillionUsd: number | null`, `costSource: FieldSource | null`, `secondsPerDecision: number | null`, `timeSource: FieldSource | null`, each defaulted to null.
  - `BenchmarkStatusDto.openRouter`: `{ keyConfigured: boolean, lastSuccessAt: string | null, outcome: 'ok' | 'no_key' | 'unauthorized' | 'rate_limited' | 'failed' | null, message: string | null, off: boolean }`, defaulted to all-null with `off: false`.
  - `DecisionStatsDto = { decision, calls, acted, belowFloor, shadow, fallbacks: Record<'off'|'no_key'|'timeout'|'error'|'stopped', number>, costUsd: number, medianLatencyMs: number | null, confidences: number[] }` and `DecisionStatsListDto = { since: string, decisions: DecisionStatsDto[] }`.
  - `JudgeCallsQuery` (added here; Task 8 switches `api/app.ts` from its local schema to this one): `{ limit, offset, decision?, outcome? }`, `limit` 1..100 read as today (over 100 → 100, not a number → 20), `offset` ≥ 0 default 0, `decision` a `JudgeDecision`, `outcome` a `JudgeOutcome`.

- [ ] **Step 1: Write the failing test** `model-sources.test.ts`: a `ModelRowDto` without the new fields parses with `coding: null`, `sources` all null and `speedProvider: null`; a `DecisionModelDto` from #600 parses with the four new fields null; `JudgeCallsQuery.parse({ decision: 'nope' })` throws; `JudgeCallsQuery.parse({})` is `{ limit: 20, offset: 0 }`.
- [ ] **Step 2: Run** `pnpm --filter @10db/contracts exec vitest run src/model-sources.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Add the schemas** above; register `decision-stats-list-dto` and `judge-calls-query` in `CONTRACT_SCHEMAS`; export from `index.ts`.
- [ ] **Step 4: Run** the test and `pnpm --filter @10db/contracts generate`, then `tsc --noEmit` in contracts, daemon and desktop. Expected: PASS, no type errors (every new field has a default).
- [ ] **Step 5: Commit** with the generated schemas, naming each path.

### Task 2: OpenRouter clients

**Files:**
- Create: `apps/daemon/src/benchmarks/openrouter-client.ts`, `apps/daemon/src/benchmarks/openrouter-client.test.ts`

**Interfaces:**
- Produces:
  - `OPENROUTER_BENCHMARKS_URL = 'https://openrouter.ai/api/v1/benchmarks'`, `OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models'`, `endpointsUrl(id: string): string` (`/api/v1/models/<id>/endpoints`).
  - `type OpenRouterScoreRow = { readonly id: string; readonly source: 'aa' | 'openrouter'; readonly intelligence: number | null; readonly coding: number | null; readonly agentic: number | null; readonly benchmark: string | null; readonly accuracy: number | null; readonly costPerTaskUsd: number | null }`, `id` being the permaslug with its trailing `-YYYYMMDD` dropped.
  - `type EndpointStat = { readonly provider: string; readonly tokensPerSecond: number | null; readonly latencyMs: number | null }` (p50 of each).
  - `type OpenRouterOutcome<T> = { kind: 'ok'; value: T } | { kind: 'unauthorized' | 'rate_limited' | 'failed'; message: string }`.
  - `fetchOpenRouterScores(deps: { fetch; key; signal }): Promise<OpenRouterOutcome<OpenRouterScoreRow[]>>` (two requests: `?source=artificial-analysis` and `?source=openrouter`), `fetchOpenRouterModelIds(deps: { fetch; signal }): Promise<OpenRouterOutcome<string[]>>` (keyless), `fetchEndpointStats(deps: { fetch; key; signal; id }): Promise<OpenRouterOutcome<EndpointStat[]>>`. None throws; no message repeats the key.

- [ ] **Step 1: Write the failing tests**, table-driven with invented numbers: an AA item `{ model_permaslug: 'maker/model-x-20261109', display_name, intelligence_index: 50, coding_index: null, agentic_index: 40, pricing }` reads as `{ id: 'maker/model-x', source: 'aa', intelligence: 50, coding: null, agentic: 40, benchmark: null, accuracy: null, costPerTaskUsd: null }`; an OpenRouter item reads `benchmark`, `accuracy` and `costPerTaskUsd` from `avg_cost_per_task`; one malformed item among good ones is dropped alone; endpoint stats read `throughput_last_30m.p50` and `latency_last_30m.p50`, and a provider with `throughput_last_30m: null` reads `tokensPerSecond: null`; HTTP 401 → `unauthorized`, 429 → `rate_limited`, a body echoing the key → message with `[key]`; every keyed request carries `Authorization: Bearer <key>`, the model list carries none.
- [ ] **Step 2: Run** `cd apps/daemon && npx vitest run src/benchmarks/openrouter-client.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** with zod at the boundary, each item `safeParse`d on its own (as `aa-client.ts` does).
- [ ] **Step 4: Run** the test. Expected: PASS.
- [ ] **Step 5: Commit** with a value card.

### Task 3: The `openrouter_measures` table and its store

**Files:**
- Modify: `packages/db/src/schema.ts`, `packages/db/src/store/index.ts`
- Create: `packages/db/src/store/openrouter-measures.ts`, `packages/db/src/store/openrouter-measures.test.ts`, the generated migration under `packages/db/drizzle/`

**Interfaces:**
- Consumes: `OpenRouterScoreRow`, `EndpointStat` shapes (redeclared as the store's own input types; packages never import apps).
- Produces:
  - Table `openrouter_measures`: `id` text (OpenRouter id), `kind` text (`'score_aa' | 'score_openrouter' | 'speed'`), `key` text (benchmark name, provider, or `''`), `intelligence`, `coding`, `agentic`, `accuracy`, `cost_per_task_usd`, `tokens_per_second`, `latency_ms` (real, nullable), `measured_at` text; primary key `(id, kind, key)`.
  - `replaceOpenRouterScores(ctx, rows: readonly OpenRouterScoreInput[], at: string): void` (deletes every `score_*` row, inserts these, one transaction).
  - `replaceEndpointStats(ctx, id: string, stats: readonly EndpointStatInput[], at: string): void` (that id's `speed` rows only).
  - `listOpenRouterMeasures(db): OpenRouterMeasure[]`, `endpointStatsReadAt(db): ReadonlyMap<string, string>` (id → latest `measured_at`).

- [ ] **Step 1: Write the failing test** on a real SQLite file: replacing scores twice keeps only the second set; replacing one id's speed leaves another id's; `endpointStatsReadAt` answers each id's time.
- [ ] **Step 2: Run** `pnpm --filter @10db/db exec vitest run src/store/openrouter-measures.test.ts`. Expected: FAIL.
- [ ] **Step 3: Add the table** to `schema.ts`, run `pnpm --filter @10db/db generate`, implement the store.
- [ ] **Step 4: Run** the test and the db package's migration tests. Expected: PASS.
- [ ] **Step 5: Commit**, then message 10db-98 that the migration number is taken if this merges first (coordination file).

### Task 4: Joining an OpenRouter id to a catalogue model

**Files:**
- Create: `apps/daemon/src/catalogue/openrouter-join.ts`, `apps/daemon/src/catalogue/openrouter-join.test.ts`
- Modify: `apps/daemon/src/catalogue/index.ts`

**Interfaces:**
- Consumes: `joinModel(id, provider, catalogue)` and `RUNTIME_MAKER` from `join.ts`.
- Produces: `openRouterMaker(id: string): Provider | null` (the `maker/` prefix to a runtime provider: `anthropic` → Anthropic, `openai` → OpenAI; others null) and `joinOpenRouterId(id: string, catalogue: Catalogue): string | null` (the catalogue model id, or null).

- [ ] **Step 1: Write the failing table test**, one row each: `anthropic/claude-sonnet-5.5` → the catalogue's Sonnet 5.5 id; a dated permaslug joins the same; `~anthropic/claude-sonnet-latest` → null; `google/gemini-x` with no runtime maker → null; an id two catalogue entries normalise to → null; an unknown model → null.
- [ ] **Step 2: Run** it. Expected: FAIL.
- [ ] **Step 3: Implement**: drop a leading `~`-router (null), the `-YYYYMMDD` suffix and the `maker/` prefix, then `joinModel` with that maker's provider. Never fuzzy.
- [ ] **Step 4: Run** it. Expected: PASS.
- [ ] **Step 5: Commit** with a value card.

### Task 5: The OpenRouter sync

**Files:**
- Create: `apps/daemon/src/benchmarks/openrouter-sync.ts`, `apps/daemon/src/benchmarks/openrouter-sync.test.ts`
- Modify: `apps/daemon/src/benchmarks/index.ts`, `apps/daemon/src/benchmarks/sync.ts` (status only: `status().openRouter`), `apps/daemon/src/daemon/start.ts`, `apps/daemon/src/env.ts` only if a flag read is missing

**Interfaces:**
- Consumes: Task 2 clients, Task 3 store, Task 4 `joinOpenRouterId`; `createJudgeKeyReader` (`daemon/judge-services.ts`); `DecisionModelList.list()` (`judge/`).
- Produces: `createOpenRouterSync(deps: { state; clock; fetch; readKey: () => Promise<string | null>; wanted: () => Promise<readonly string[]>; logger }): OpenRouterSync` with `start(): void`, `stop(): void`, `status(): BenchmarkStatusDto['openRouter']`, `idle(): Promise<void>`. Constants `SCORES_EVERY_MS = 24 h`, `SPEED_EVERY_MS = 1 h`, `MAX_PER_MINUTE = 20`.
- `wanted` in `start.ts`: OpenRouter ids from `fetchOpenRouterModelIds` (read with the scores, daily) whose `joinOpenRouterId` is a model some live account offers, plus every callable id in `/judge/models` that is not a `~` router.

- [ ] **Step 1: Write the failing tests** with an injected `fetch` and `ManualClock`: one run reads scores once and each wanted id's stats once; a second run within the hour reads no stats, a day later reads scores again; with 50 wanted ids no 60 s window has more than 20 requests; no key → outcome `no_key`, no request, old rows kept; a 401 → `unauthorized`, old rows kept; `stop()` mid-run starts no further request.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** the schedule on the injected clock (never `setTimeout`), pacing requests by `MAX_PER_MINUTE`, recording status under app setting `openrouter.sync_status`.
- [ ] **Step 4: Wire it in `start.ts`**: create it only when neither `judgeOff` nor `benchmarksOff` and `opts.openRouterSync !== false`; `DaemonOptions.openRouterSync` defaults to off for in-process harnesses as `catalogueSync` does; `main.ts` turns it on; shutdown calls `stop()` and awaits `idle()`. Add `apps/daemon/test/openrouter-off.test.ts` (or a row in the existing benchmarks-off daemon test): a daemon started with either flag makes no OpenRouter request and reads no `account:` Keychain item.
- [ ] **Step 5: Run** the sync tests, `test/judge-api.test.ts` and the benchmarks tests. Expected: PASS.
- [ ] **Step 6: Commit** with a value card.

### Task 6: The merge rule in the model rows

**Files:**
- Create: `apps/daemon/src/catalogue/model-facts.ts`, `apps/daemon/src/catalogue/model-facts.test.ts`, `apps/daemon/src/catalogue/openrouter-not-routed.test.ts`
- Modify: `apps/daemon/src/catalogue/model-rows.ts`, `apps/daemon/src/catalogue/model-rows.test.ts`, `apps/daemon/src/daemon/services.ts` (`listModels` passes the measures)

**Interfaces:**
- Consumes: `OpenRouterMeasure` (Task 3), `joinOpenRouterId` (Task 4), `FieldSource` (Task 1).
- Produces:
  - `speedProviderFor(kind: AccountKind): string | null`: `claude_subscription`, `anthropic_api_key` → `'Anthropic'`; `bedrock` → `'Amazon Bedrock'`; `codex_signin`, `openai_api_key` → `'OpenAI'`; `gateway`, `openrouter` → null (median).
  - `effortFacts(input: { aa: ModelProfileDto; isMax: boolean; openRouter: readonly OpenRouterMeasure[]; provider: string | null }): Pick<ModelEffortDto, 'intelligence' | 'coding' | 'agentic' | 'costPerTaskUsd' | 'outputTokensPerSecond' | 'sources' | 'speedProvider'>`, by spec §5.4's table: Intelligence from AA, else AA-via-OpenRouter on the Max effort only; Coding and Agentic the same; cost per task from AA only; speed from OpenRouter p50 on `provider`, else the median of providers with a value, else AA.
  - `ModelRowsInput.openRouter?: ReadonlyMap<string, readonly OpenRouterMeasure[]>` keyed by catalogue model id; `buildModelRows` fills every effort with `effortFacts` and the row from its first effort, as today.

- [ ] **Step 1: Write the failing table test** `model-facts.test.ts`, one named row per case of spec §5.4: AA present wins; AA absent on Max takes AA-via-OpenRouter; AA absent on a non-Max effort stays null; coding from OpenRouter when AA's is null; cost never from OpenRouter; speed on the account's provider; a provider with null throughput falls to the median of the others; no OpenRouter stats falls to AA's speed with source `aa`; `gateway` uses the median.
- [ ] **Step 2: Write the failing routing test** `openrouter-not-routed.test.ts`: profiles where AA ranks model A over B, plus OpenRouter measures that would rank B over A; `chooseModel` (imported, not edited) picks A, the same as with no measures.
- [ ] **Step 3: Run** both. Expected: the facts test FAILS (module missing). The routing test runs over the daemon's
  real wiring (seeded `model_profiles` and `openrouter_measures` in a real SQLite file, `chooseModel` fed from
  `listModelProfiles`), so to see it fail, temporarily copy an OpenRouter Intelligence into B's profile in the
  seed, watch it pick B, and put the seed back; say so in the commit.
- [ ] **Step 4: Implement** `model-facts.ts`, use it in `buildModelRows`, and pass `listOpenRouterMeasures` grouped by `joinOpenRouterId` from `services.ts`. Add a `model-rows.test.ts` row: a model with an OpenRouter speed shows it with `sources.speed: 'openrouter'` and `speedProvider`.
- [ ] **Step 5: Run** `npx vitest related src/catalogue/model-rows.ts src/catalogue/model-facts.ts --run` and the routing test. Expected: PASS.
- [ ] **Step 6: Commit** with a value card.

### Task 7: Cost and time for decision models

**Files:**
- Create: `apps/daemon/src/judge/decision-model-numbers.ts`, `apps/daemon/src/judge/decision-model-numbers.test.ts`, `packages/db/src/store/judge-call-stats.ts`, `packages/db/src/store/judge-call-stats.test.ts`
- Modify: `apps/daemon/src/daemon/judge-services.ts` (`listDecisionModels` enriches), `packages/db/src/store/index.ts`

**Interfaces:**
- Consumes: `DecisionModelDto` (Task 1), `listOpenRouterMeasures` (Task 3). A decision model's OpenRouter latency is
  the median `latencyMs` of its `speed` rows that have one.
- Produces:
  - `judgeCallModelStats(db, since: string): JudgeCallModelStat[]` with `{ model, calls, costedCalls, totalCostUsd, medianLatencyMs }` over calls with an answer since `since`.
  - `TYPICAL_TOKENS_FALLBACK = 300`.
  - `typicalDecisionTokens(stats, priceOf: (model) => number | null): number`: Σ cost ÷ Σ (input price per token × calls) over models with a price above 0 and a cost; `TYPICAL_TOKENS_FALLBACK` when nothing qualifies.
  - `decisionModelNumbers(model: DecisionModelDto, stat: JudgeCallModelStat | undefined, typicalTokens: number, latencyMs: number | null): Pick<DecisionModelDto, 'costPerMillionUsd' | 'costSource' | 'secondsPerDecision' | 'timeSource'>`: cost from your calls (`your_calls`) when it has costed calls, else price × tokens (`openrouter_price`, or `assumed` when `typicalTokens` is the fallback); time from your median latency, else OpenRouter's p50 latency, else null.

- [ ] **Step 1: Write the failing tests**: on a real SQLite file, seeded calls on two models give each model's count, total cost and median latency, and a fallback row (no answer) is not counted; pure rows for `typicalDecisionTokens` (a `:free` model with price 0 is skipped, nothing priced → 300) and `decisionModelNumbers` (each source in turn).
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement**, then enrich `listDecisionModels` over 30 days on the injected clock.
- [ ] **Step 4: Extend** `test/judge-api.test.ts`'s `GET /judge/models` case: with a seeded call on `liquid/d1` its row has `costSource: 'your_calls'`.
- [ ] **Step 5: Run** the tests. Expected: PASS.
- [ ] **Step 6: Commit** with a value card.

### Task 8: Decision stats and the filtered call log

**Files:**
- Modify: `packages/db/src/store/judge-calls.ts`, its test, `packages/db/src/store/judge-call-stats.ts`, `apps/daemon/src/api/app.ts`, `apps/daemon/src/api/services.ts`, `apps/daemon/src/api/app.test.ts`, `apps/daemon/test/api-stub.ts`, `apps/daemon/src/daemon/judge-services.ts`, `apps/daemon/src/screens/render-access.ts`, `apps/daemon/src/screens/dev-ui-access.ts`, `apps/desktop/src/daemon/judge-queries.ts` (the existing calls query passes `limit` as before)
- Test: `apps/daemon/test/judge-api.test.ts`

**Interfaces:**
- Consumes: `JudgeCallsQuery`, `DecisionStatsListDto` (Task 1).
- Produces:
  - `listJudgeCalls(db, q: { limit: number; offset: number; decision?: JudgeDecision; outcome?: JudgeOutcome }): JudgeCallDto[]` (the one caller updated).
  - `judgeDecisionStats(db, since: string): DecisionStatsDto[]`, one per decision with any call, `confidences` from answered calls.
  - `ApiServices.listJudgeCalls(q: JudgeCallsQuery)` and `ApiServices.judgeDecisionStats(): DecisionStatsListDto` (30 days on the clock); routes `GET /judge/calls` (now validated by `JudgeCallsQuery`) and `GET /judge/decisions`, both classified as "No screen draws a setting." and allowed for the dev UI.

- [ ] **Step 1: Write the failing tests**: store rows for `decision`, `outcome` and `offset`; `judgeDecisionStats` counts acted, below floor, shadow and each fallback, sums cost, takes the median latency and lists confidences; `app.test.ts` rows: `GET /judge/decisions` reaches its service behind the token, `?decision=nope` and `?outcome=nope` answer 400 without reaching a service; `judge-api.test.ts`: seeded calls come back filtered and paged.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** the tests, `src/api/render-reads.test.ts` and `src/views/settings/decisions-section.test.tsx` in desktop. Expected: PASS.
- [ ] **Step 5: Commit** with a value card.

### Task 9: Docs and the decision record

**Files:**
- Create: `docs/architecture/decisions/2026-11-13-model-numbers-come-from-aa-and-openrouter.md`
- Modify: `apps/daemon/AGENTS.md` (the `benchmarks/` and `judge/` paragraphs, the flag paragraphs), `docs/architecture/03-trust-boundaries.md` (§4.12: the sync's reads, which key, what leaves the machine: nothing but the key and model ids)

- [ ] **Step 1: Write** the decision: numbers shown, not routed on; the precedence of spec §5.4; OpenRouter's terms (spec §3) and its consequence that its numbers are never committed or shipped; provider parity per spec §8.
- [ ] **Step 2: Run** `cd tests/repo && npx vitest run src/architecture-docs.test.ts src/agent-docs.test.ts src/benchmarks-off.test.ts`. Expected: PASS.
- [ ] **Step 3: Commit**, push, open the PR (`feat(daemon): …`, under 100 characters), `gh pr merge --squash --auto`, and message 10db-98 that it is open.
