# Model data from AA and OpenRouter (PR 1) Implementation Plan

## Brief

**What changes for the builder:** nothing visible yet. The daemon starts reading OpenRouter's scores once a day
and measured speed at most hourly per model, with the key of the account decisions run on, and the model list it
serves gains, for every number, where it came from. Decision models gain a cost per million decisions and a time
per decision. Three new reads serve the Decisions page to come: per-decision stats, a filtered page of calls, and
the OpenRouter status.

**What it buys:** the data PR 2 (Decisions page) and PR 3 (Models switch) draw, landed and tested on its own.

**What could go wrong, and how we'd know:**

- OpenRouter's numbers leak into routing: Task 6 runs the real sync against a database of profiles and checks the
  profiles and `chooseModel`'s pick are unchanged.
- A daemon with no OpenRouter account calls openrouter.ai: Task 5 starts a real daemon with the sync on and no
  OpenRouter account and counts zero requests.
- OpenRouter's rate limit trips: Task 5's pacing test.
- A model shows another model's numbers: Task 4's join table and Task 6's test through `GET /models`.
- The migration collides with the playbook PR's: whoever merges second regenerates its own
  (`10db-worktrees/COORDINATION-models.md`).

**Calls you might disagree with:** the sync reads OpenRouter's public model list daily to learn which ids to read
speed for; the status line on Models waits for PR 3 (the playbook session owns that file until its PR merges), so
this PR serves the status and shows nothing; a model with no Max effort (a ChatGPT plan's list, say) gets no
OpenRouter score, as AA's bare slug is treated today.

**Needed from you:** nothing.

---

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the daemon combines AA and OpenRouter into model rows whose every number names its source, serves cost
and time for decision models, and serves per-decision stats, with routing unchanged.

**Architecture:** a new OpenRouter sync in `benchmarks/` keeps its own table (`openrouter_measures`); a pure merge
rule in `catalogue/` builds the served rows from the AA profiles and those measures; routing keeps reading
`model_profiles` alone. Judge reads in `packages/db` feed new routes.

**Tech Stack:** TypeScript, zod 4, Drizzle on SQLite, Hono, vitest.

**Spec:** `docs/superpowers/specs/2026-11-13-10db-models-and-decisions-design.md` (§3, §5, §8, §9 PR 1, §10).

## Global Constraints

- Branch `feat/model-data` from `origin/main` in `../10db-worktrees/model-data`; root, `apps/daemon`,
  `packages/db` and `packages/contracts` `AGENTS.md` bind.
- Routing reads none of OpenRouter's numbers; `model_profiles` keeps AA's values only (spec §5.4).
- The OpenRouter sync reads a key and calls out only when the daemon runs with neither `TENDB_JUDGE=off` nor
  `TENDB_BENCHMARKS=off` (spec §3), and **reads the key before any request, keyless ones included**: no OpenRouter
  account, no request. `DaemonOptions.openRouterSync` is off unless given, so an in-process harness never reaches
  the network; `daemonOptionsFromEnv` turns it on as it does `catalogueSync`.
- The key is the secret of the account decisions run on (`createJudgeKeyReader` with `getJudgeConfig().accountId`),
  never logged, never in a row, response or error text.
- OpenRouter's numbers are never committed, put in fixtures or shipped in a release snapshot; tests use invented
  numbers (spec §3). The same holds for AA numbers.
- `/api/v1/benchmarks`: at most 30 requests a minute and 500 a day per account; every request the sync makes,
  keyless ones included, goes through one pacer at 20 a minute.
- Contracts are additive; regenerate with `pnpm --filter @10db/contracts generate`. In zod 4 a `.default()` field
  is required in the output type, so every daemon site that builds a changed DTO as a literal changes in the same
  task.
- Migrations are forward-only since `v0.1.0`: `pnpm --filter @10db/db generate`, never edited by hand.
- Every new `GET` route is classified in `screens/render-access.ts` and `screens/dev-ui-access.ts`.
- Files owned by the playbook session until its PR merges are not edited: `routing/**`,
  `contracts/src/rigor.ts`, `ModelSetting` in `contracts/src/catalogue.ts`, and every `views/settings` file.
- While working, run only the tests the change can break (`vitest related`), plus typecheck and lint of what
  changed. The full gate runs once, at the end (Task 9), unless the builder says CI is the gate for this run.
- Each new behaviour's commit carries the value card written in its task below.

## Provider parity (spec §8)

| Account a project runs on | Speed shown | OpenRouter scores shown |
| --- | --- | --- |
| Claude plan, Anthropic API key | OpenRouter p50 on `Anthropic`, else the median, else AA | on the Max effort row |
| Bedrock | OpenRouter p50 on `Amazon Bedrock`, else the median, else AA | on the Max effort row |
| Gateway | median across providers, else AA | on the Max effort row |
| ChatGPT or Codex plan, OpenAI API key | OpenRouter p50 on `OpenAI`, else the median, else AA | on the Max effort row; a model the account lists without a Max effort shows none |
| No account chosen on the page | median, else AA | on the Max effort row |

All of it needs an OpenRouter account picked for decisions; without one, rows are AA's alone, as today.
Decision models behave the same on every account kind: decisions always run on the OpenRouter account.

## Review Focus

1. **A model OpenRouter lists under a dated or Bedrock-style id** joins to the catalogue model exactly as an
   account's list would, or not at all. Task 4.
2. **The account decisions run on is archived or its key changed mid-day**: the sync sends nothing, keeps its old
   rows and records `no_key`. Task 5.
3. **A provider OpenRouter serves without stats** (`throughput_last_30m: null`) is skipped, never read as zero.
   Tasks 2 and 6.
4. **A decision model with logged calls and no price** (a `:free` model): cost per million is 0 from your calls, and
   the typical-size estimate skips it rather than dividing by zero. Task 7.
5. **A speed read days ago** (a model no longer wanted) is not shown as current: rows older than a day are ignored.
   Task 6.

---

### Task 1: Contracts, with interim values at every site that builds them

**Files:**
- Modify: `packages/contracts/src/catalogue.ts` (`ModelEffortDto`, `ModelRowDto` only), `decision-models.ts`,
  `benchmarks.ts`, `judge.ts`, `json-schema.ts`, `index.ts`, and the existing tests `catalogue.test.ts`,
  `judge.test.ts`, `benchmarks.test.ts` in `packages/contracts/src`
- Create: `packages/contracts/src/model-sources.ts`, `packages/contracts/src/decision-stats.ts`
- Modify (interim values only): `apps/daemon/src/judge/decision-models.ts`, `apps/daemon/src/catalogue/model-rows.ts`,
  `apps/daemon/src/benchmarks/sync.ts` (`NEVER`, the two status literals, and `StoredStatus` omitting `openRouter`),
  `apps/daemon/src/daemon/benchmark-services.ts` if it builds a literal

**Interfaces:**
- Produces:
  - `ModelSource = { Aa: 'aa', AaViaOpenRouter: 'aa_via_openrouter', OpenRouter: 'openrouter' } as const` for agent
    model fields, and `DecisionNumberSource = { YourCalls: 'your_calls', OpenRouterPrice: 'openrouter_price',
    OpenRouter: 'openrouter', Assumed: 'assumed' } as const` for decision-model fields, each with its type.
  - `ModelSources = z.object({ intelligence, coding, agentic, costPerTask, speed })`, each
    `z.enum(ModelSource).nullable()`.
  - On `ModelEffortDto` and `ModelRowDto`: `coding: number | null`, `agentic: number | null`, `sources:
    ModelSources`, `speedProvider: string | null`, each with a `.default()` (null, or all-null `sources`).
  - On `DecisionModelDto`: `costPerMillionUsd`, `secondsPerDecision` (`number | null`), `costSource`, `timeSource`
    (`DecisionNumberSource | null`), each defaulted to null.
  - `OpenRouterSyncStatusDto = { keyConfigured: boolean; lastSuccessAt: string | null; outcome: 'ok' | 'no_key' |
    'unauthorized' | 'rate_limited' | 'failed' | null; message: string | null; off: boolean }`, and
    `BenchmarkStatusDto.openRouter`, defaulted to `{ keyConfigured: false, lastSuccessAt: null, outcome: null,
    message: null, off: false }`.
  - `DecisionStatsDto = { decision; calls; acted; belowFloor; shadow; stopped; fallbacks: Record<'off' | 'no_key'
    | 'timeout' | 'error', number>; costUsd: number; medianLatencyMs: number | null; answers: { model: string;
    confidence: number }[] }` and `DecisionStatsListDto = { since: string; decisions: DecisionStatsDto[] }`.
  - `JudgeCallsPageQuery = { limit, offset, decision?, outcome? }` (`limit` 1..100, over 100 read as 100 and not a
    number as 20, as today; `offset` ≥ 0, default 0) and `JudgeCallsPageDto = { calls: JudgeCallDto[]; total:
    number }`. `GET /judge/calls` keeps its array answer; the page is a new route (Task 8).
- Interim daemon values: `coding`, `agentic`, `speedProvider` null; `sources` with `intelligence`, `costPerTask`
  and `speed` set to `'aa'` wherever the AA value is non-null, else null; decision-model numbers null; the AA sync's
  status carries the default `openRouter`.

- [ ] **Step 1: Extend the existing tests** with rows: a `ModelRowDto` without the new fields parses with the
  defaults (`catalogue.test.ts`); a `DecisionModelDto` from #600 parses with null numbers; `JudgeCallsPageQuery`
  rejects `decision: 'nope'` and reads `{}` as `{ limit: 20, offset: 0 }` (`judge.test.ts`); a `BenchmarkStatusDto`
  without `openRouter` parses with the default (`benchmarks.test.ts`).
- [ ] **Step 2: Run** `pnpm --filter @10db/contracts exec vitest run`. Expected: FAIL on the new rows.
- [ ] **Step 3: Add the schemas**, register `decision-stats-list-dto`, `judge-calls-page-query`,
  `judge-calls-page-dto` and `openrouter-sync-status-dto`, export them, regenerate, and set the interim daemon
  values.
- [ ] **Step 4: Run** the contracts tests and `tsc --noEmit` in contracts, daemon and desktop, then
  `npx vitest related` over the daemon files touched. Expected: PASS, no type errors.
- [ ] **Step 5: Commit** (paths named), no value card: schemas only.

### Task 2: OpenRouter clients

**Files:**
- Create: `apps/daemon/src/benchmarks/openrouter-client.ts`, `apps/daemon/src/benchmarks/openrouter-client.test.ts`

**Interfaces:**
- Produces:
  - `OPENROUTER_BENCHMARKS_URL = 'https://openrouter.ai/api/v1/benchmarks'`, `OPENROUTER_MODELS_URL =
    'https://openrouter.ai/api/v1/models'`, `endpointsUrl(id: string): string` (`/api/v1/models/<id>/endpoints`).
  - `type OpenRouterScoreRow = { readonly id: string; readonly source: 'aa' | 'openrouter'; readonly intelligence:
    number | null; readonly coding: number | null; readonly agentic: number | null; readonly benchmark: string | null;
    readonly accuracy: number | null; readonly costPerTaskUsd: number | null }`, `id` being the permaslug with its
    trailing `-YYYYMMDD` dropped.
  - `type EndpointStat = { readonly provider: string; readonly tokensPerSecond: number | null; readonly latencyMs:
    number | null }`, each the p50.
  - `type OpenRouterOutcome<T> = { kind: 'ok'; value: T } | { kind: 'unauthorized' | 'rate_limited' | 'failed';
    message: string }`.
  - `fetchOpenRouterScores({ fetch, key, signal })` (`?source=artificial-analysis` then `?source=openrouter`),
    `fetchOpenRouterModelIds({ fetch, signal })` (keyless), `fetchEndpointStats({ fetch, key, signal, id })`, each
    `Promise<OpenRouterOutcome<…>>`. None throws; no message repeats the key.

- [ ] **Step 1: Write the failing tests**, table-driven with invented numbers: an AA item reads with the date
  dropped and `benchmark`, `accuracy`, `costPerTaskUsd` null; an OpenRouter item reads `benchmark`, `accuracy` and
  `costPerTaskUsd` from `avg_cost_per_task`; one malformed item among good ones is dropped alone; stats read the
  p50s, and `throughput_last_30m: null` reads `tokensPerSecond: null`; 401 → `unauthorized`, 429 →
  `rate_limited`, other non-2xx or unparseable → `failed`; a body echoing the key → message with `[key]`; keyed
  requests carry `Authorization: Bearer <key>`, the model list none.
- [ ] **Step 2: Run** `cd apps/daemon && npx vitest run src/benchmarks/openrouter-client.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**, zod at the boundary, each item `safeParse`d on its own as `aa-client.ts` does.
- [ ] **Step 4: Run** it. Expected: PASS.
- [ ] **Step 5: Commit** with:
  `Value: protects=reading OpenRouter's scores and per-provider speed; fails_when=one bad item hides the rest, a
  null throughput reads as 0, or the key reaches a message; why_new=no OpenRouter client existed;
  no_claim=OpenRouter keeps these shapes.`

### Task 3: The `openrouter_measures` table and its store

**Files:**
- Modify: `packages/db/src/schema.ts`, `packages/db/src/store/index.ts`, `packages/db/AGENTS.md`
- Create: `packages/db/src/store/openrouter-measures.ts`, `packages/db/src/store/openrouter-measures.test.ts`, the
  generated migration under `packages/db/drizzle/`

**Interfaces:**
- Produces:
  - Table `openrouter_measures`: `id` text (OpenRouter id), `kind` text (`'score_aa' | 'score_openrouter' |
    'speed'`), `key` text (benchmark name, provider, or `''`), `intelligence`, `coding`, `agentic`, `accuracy`,
    `cost_per_task_usd`, `tokens_per_second`, `latency_ms` (real, nullable), `measured_at` text; primary key
    `(id, kind, key)`.
  - `OpenRouterScoreInput` and `EndpointStatInput`: the store's own input types, the same fields as Task 2's
    (packages never import apps).
  - `replaceOpenRouterScores(ctx, rows, at): void` (every `score_*` row replaced, one transaction);
    `replaceEndpointStats(ctx, id, stats, at): void` (that id's `speed` rows only);
    `listOpenRouterMeasures(db): OpenRouterMeasure[]`; `endpointStatsReadAt(db): ReadonlyMap<string, string>`.

- [ ] **Step 1: Write the failing test** on a real SQLite file: replacing scores twice keeps only the second set;
  replacing one id's speed leaves another id's; `endpointStatsReadAt` answers each id's time.
- [ ] **Step 2: Run** `pnpm --filter @10db/db exec vitest run src/store/openrouter-measures.test.ts`. Expected: FAIL.
- [ ] **Step 3: Add the table**, run `pnpm --filter @10db/db generate`, implement the store, and add the table to
  `packages/db/AGENTS.md`'s list of stores.
- [ ] **Step 4: Run** the test and the package's migration tests. Expected: PASS.
- [ ] **Step 5: Commit** with `Value: protects=OpenRouter measures persist per model, kind and key; fails_when=a
  score refresh drops speed rows or one model's speed write clears another's; why_new=new table; no_claim=the
  sync writes the right rows (Task 5).` Then record the migration number in the coordination file and tell
  10db-98.

### Task 4: Joining an OpenRouter id to a catalogue model

**Files:**
- Create: `apps/daemon/src/catalogue/openrouter-join.ts`, `apps/daemon/src/catalogue/openrouter-join.test.ts`
- Modify: `apps/daemon/src/catalogue/index.ts`

**Interfaces:**
- Consumes: `joinModel(id, provider, catalogue)` and `RUNTIME_MAKER` from `join.ts`; `Provider` (`{ Claude:
  'claude', Codex: 'codex' }`).
- Produces: `openRouterProvider(id: string): Provider | null` (the inverse of `RUNTIME_MAKER`: the catalogue maker
  `RUNTIME_MAKER[Provider.Claude]` names, as OpenRouter's `anthropic/` prefix, → `Provider.Claude`; OpenRouter's
  `openai/` → `Provider.Codex`; any other prefix null) and `joinOpenRouterId(id: string, catalogue: Catalogue):
  string | null` (the catalogue model id, or null).

- [ ] **Step 1: Write the failing table test**, one named row each: `anthropic/claude-sonnet-5.5` → that catalogue
  id; the dated permaslug → the same; an `openai/` model → its catalogue id; `~anthropic/claude-sonnet-latest` →
  null; `google/gemini-x` → null; an id two catalogue entries normalise to → null; an unknown model → null.
- [ ] **Step 2: Run** it. Expected: FAIL.
- [ ] **Step 3: Implement**: a `~` router is null; drop `-YYYYMMDD` and the `maker/` prefix; `joinModel` with that
  maker's provider; never fuzzy.
- [ ] **Step 4: Run** it. Expected: PASS.
- [ ] **Step 5: Commit** with `Value: protects=an OpenRouter row lands on the right catalogue model;
  fails_when=a dated or router id joins wrongly or fuzzily; why_new=join.ts joins account ids, not OpenRouter's;
  no_claim=OpenRouter's naming stays maker/model.`

### Task 5: The OpenRouter sync and its wiring

**Files:**
- Create: `apps/daemon/src/benchmarks/openrouter-sync.ts`, `apps/daemon/src/benchmarks/openrouter-sync.test.ts`,
  `apps/daemon/test/openrouter-sync-daemon.test.ts`
- Modify: `apps/daemon/src/benchmarks/index.ts`, `apps/daemon/src/daemon/start.ts`,
  `apps/daemon/src/daemon/options-from-env.ts` and its test, `apps/daemon/src/daemon/benchmark-services.ts`,
  `apps/daemon/src/daemon/judge-services.ts` (an account change asks the sync to run)

**Interfaces:**
- Consumes: Task 2 clients, Task 3 store, Task 4 `joinOpenRouterId`; `createJudgeKeyReader`;
  `DecisionModelList.list()`.
- Produces:
  - `createOpenRouterSync(deps: { state; clock; fetch; readKey: () => Promise<string | null>; offered: () =>
    ReadonlySet<string>; decisionModelIds: () => Promise<readonly string[]>; logger }): OpenRouterSync`, with
    `start()`, `stop()`, `poke()` (run now, joining one in flight), `idle(): Promise<void>` and `status():
    OpenRouterSyncStatusDto`. `offered` is the catalogue ids live accounts offer; the sync itself reads the model
    ids (daily, paced), keeps those whose `joinOpenRouterId` is offered, adds `decisionModelIds()` minus `~`
    routers, and reads stats for any not read within the hour.
  - Constants `SCORES_EVERY_MS = 24 h`, `SPEED_EVERY_MS = 1 h`, `MAX_PER_MINUTE = 20`, `RETRY_AFTER_FAILURE_MS = 1 h`
    (after `unauthorized`, `rate_limited` or `failed`; `no_key` is checked again on the hourly tick and on `poke`).
  - `DaemonOptions.openRouterSync?: boolean`; `EnvDaemonOptions` gains it, set by `daemonOptionsFromEnv` to
    `TENDB_JUDGE !== 'off' && TENDB_BENCHMARKS !== 'off'`.
  - `createBenchmarkServices` gains `openRouter: () => OpenRouterSyncStatusDto` and puts it in `status.openRouter`;
    with the sync not created it answers `{ ...default, off: judgeOff || benchmarksOff }`.
  - `createJudgeServices` gains an optional `onAccountChanged: () => void`, which `patchJudge` calls when
    `accountId` changes; `start.ts` passes the sync's `poke`.

- [ ] **Step 1: Write the failing unit tests** with an injected `fetch` and `ManualClock`: the key is read before
  any request, and with no key nothing is requested (the model list included) and the outcome is `no_key`; one run
  reads scores once and each wanted id's stats once; a second run within the hour reads no stats; a day later the
  scores again; with 50 wanted ids no 60 s window holds more than 20 requests; a 401 keeps old rows, records
  `unauthorized` and retries an hour later; `poke` runs at once; `stop()` mid-run starts no further request.
- [ ] **Step 2: Write the failing daemon test** `test/openrouter-sync-daemon.test.ts`: `startDaemon` with
  `openRouterSync: true`, an injected `fetch` counting requests and no OpenRouter account makes zero requests;
  after an OpenRouter account is picked through `PATCH /judge`, the sync runs and `GET /benchmarks/status` answers
  `openRouter.outcome: 'ok'`; with `judgeOff: true` it answers `openRouter.off: true` and no request is made; and
  `model_profiles` is unchanged by a sync (see Task 6 for the routing half).
- [ ] **Step 3: Run** both. Expected: FAIL.
- [ ] **Step 4: Implement** the schedule on the injected clock, every request through the pacer, status under app
  setting `openrouter.sync_status`; wire it in `start.ts` only when `openRouterSync && !judgeOff && !benchmarksOff`,
  with `offered` from `listAccountModels` joined through the catalogue; shutdown calls `stop()` and awaits `idle()`.
- [ ] **Step 5: Run** the tests, `options-from-env.test.ts`, `test/judge-api.test.ts` and the benchmarks tests.
  Expected: PASS.
- [ ] **Step 6: Commit** with `Value: protects=OpenRouter is read daily and hourly within its limits, only with the
  decisions account's key, and never under the kill switches; fails_when=a daemon with no OpenRouter account calls
  out, the rate limit trips, or a new key waits a day; why_new=new sync; no_claim=OpenRouter's limits stay as
  documented.`

### Task 6: The merge rule in the model rows

**Files:**
- Create: `apps/daemon/src/catalogue/model-facts.ts`, `apps/daemon/src/catalogue/model-facts.test.ts`,
  `apps/daemon/test/openrouter-not-routed.test.ts`
- Modify: `apps/daemon/src/catalogue/model-rows.ts`, `apps/daemon/src/catalogue/model-rows.test.ts`,
  `apps/daemon/src/daemon/services.ts` (`listModels` passes the measures), and the daemon's `GET /models` API test

**Interfaces:**
- Consumes: `OpenRouterMeasure` (Task 3), `joinOpenRouterId` (Task 4), `ModelSource` (Task 1).
- Produces:
  - `speedProviderFor(kind: AccountKind): string | null`: `claude_subscription`, `anthropic_api_key` →
    `'Anthropic'`; `bedrock` → `'Amazon Bedrock'`; `codex_signin`, `openai_api_key` → `'OpenAI'`; `gateway`,
    `openrouter` → null.
  - `SPEED_STALE_MS = 24 h`: a speed row older than that, on the injected clock, is ignored.
  - `effortFacts(input: { aa: ModelProfileDto; isMax: boolean; openRouter: readonly OpenRouterMeasure[]; provider:
    string | null; now: Date }): Pick<ModelEffortDto, 'intelligence' | 'coding' | 'agentic' | 'costPerTaskUsd' |
    'outputTokensPerSecond' | 'sources' | 'speedProvider'>` by spec §5.4: Intelligence, Coding and Agentic from
    AA, else AA via OpenRouter on the Max effort only; cost per task from AA only; speed from the p50 on `provider`,
    else the median of fresh providers with a value (`speedProvider` null), else AA's.
  - `ModelRowsInput.openRouter?: ReadonlyMap<string, readonly OpenRouterMeasure[]>` keyed by **catalogue model id**,
    and `ModelRowsInput.now: Date`. With a null catalogue nothing joins and rows are AA's alone.

- [ ] **Step 1: Write the failing table test** `model-facts.test.ts`, one named row each: AA present wins; AA
  absent on Max takes AA via OpenRouter; AA absent on a non-Max effort stays null; a model with no Max effort
  shows no OpenRouter score; Coding from OpenRouter when AA's is null; cost never from OpenRouter; speed on the
  account's provider; a provider with null throughput falls to the median of the others; a stale row is ignored;
  no OpenRouter speed falls to AA's with source `aa`; and one row per `AccountKind` for `speedProviderFor`.
- [ ] **Step 2: Write the failing routing test** `test/openrouter-not-routed.test.ts` over a real SQLite file:
  profiles where AA ranks A over B; run `createOpenRouterSync` with an injected `fetch` answering scores and speeds
  that rank B over A; assert every `model_profiles` row is unchanged and `chooseModel` (imported, not edited) still
  picks A. To see it fail, temporarily make the sync call `applyAaMeasurement` with its score, watch the test go
  red, and remove it; say so in the commit.
- [ ] **Step 3: Write the failing wiring test**: in the daemon's `GET /models` test, seed `openrouter_measures` for
  a model a Bedrock account offers; `GET /models?account=<bedrock>` answers it with `sources.speed:
  'openrouter'` and `speedProvider: 'Amazon Bedrock'`.
- [ ] **Step 4: Run** the three. Expected: FAIL.
- [ ] **Step 5: Implement** `model-facts.ts`, use it in `buildModelRows`, and in `services.ts` group
  `listOpenRouterMeasures` by `joinOpenRouterId` (dropping unjoined rows) and pass `speedProviderFor` of the asked
  account's kind.
- [ ] **Step 6: Run** `npx vitest related src/catalogue/model-rows.ts src/catalogue/model-facts.ts --run` and the
  two daemon tests. Expected: PASS.
- [ ] **Step 7: Commit** with `Value: protects=each number on a model row comes from the right source and names
  it, and routing ignores OpenRouter; fails_when=OpenRouter's max-effort score appears on another effort, a stale
  or null speed shows, or a sync changes a profile; why_new=model-rows.test.ts covers AA only; no_claim=the UI
  shows the sources (PR 3).`

### Task 7: Cost and time for decision models

**Files:**
- Create: `apps/daemon/src/judge/decision-model-numbers.ts`, `apps/daemon/src/judge/decision-model-numbers.test.ts`,
  `packages/db/src/store/judge-call-stats.ts`, `packages/db/src/store/judge-call-stats.test.ts`
- Modify: `apps/daemon/src/daemon/judge-services.ts` (`listDecisionModels` enriches a copy; takes a `clock`),
  `apps/daemon/src/daemon/start.ts` (passes the clock), `packages/db/src/store/index.ts`, `packages/db/AGENTS.md`,
  `apps/daemon/test/judge-api.test.ts`

**Interfaces:**
- Consumes: `DecisionModelDto` (Task 1), `listOpenRouterMeasures` (Task 3). A decision model's OpenRouter latency
  is the median `latencyMs` of its fresh `speed` rows that have one.
- Produces:
  - `judgeCallModelStats(db, since: string): JudgeCallModelStat[]`, `{ model; calls; costedCalls; totalCostUsd;
    medianLatencyMs }` over answered calls since `since`.
  - `TYPICAL_TOKENS_FALLBACK = 300`; `typicalDecisionTokens(stats, inputPricePerMillion: (model) => number |
    null): number` = Σ cost ÷ Σ (price per token × costed calls) over models priced above 0 with a cost, else the
    fallback.
  - `decisionModelNumbers(model, stat, typicalTokens, latencyMs, tokensAreFallback): Pick<DecisionModelDto,
    'costPerMillionUsd' | 'costSource' | 'secondsPerDecision' | 'timeSource'>`: cost from your calls
    (`your_calls`) when it has costed calls, else price × tokens (`openrouter_price`, or `assumed` when the tokens
    are the fallback); time from your median latency (`your_calls`), else OpenRouter's (`openrouter`), else null.
  - `createJudgeServices` gains `clock: Clock`; `listDecisionModels` answers a new object each time, never mutating
    the cached list.

- [ ] **Step 1: Write the failing tests**: on a real SQLite file, seeded calls on two models give each model's
  count, total cost and median latency, and a fallback row is not counted; pure rows for `typicalDecisionTokens`
  (a `:free` model skipped, nothing priced → 300) and for `decisionModelNumbers`, one per source.
- [ ] **Step 2: Extend** `judge-api.test.ts`'s `GET /judge/models` case: with a seeded call on `liquid/d1` its row
  has `costSource: 'your_calls'`, and two reads still answer equal lists.
- [ ] **Step 3: Run** them. Expected: FAIL.
- [ ] **Step 4: Implement**, over 30 days on the clock.
- [ ] **Step 5: Run** them. Expected: PASS.
- [ ] **Step 6: Commit** with `Value: protects=each decision model's cost per million decisions and time, with
  their source; fails_when=a free model divides by zero, your own calls are ignored, or the cached list is
  mutated; why_new=GET /judge/models served prices only; no_claim=300 tokens fits a builder with no calls.`

### Task 8: Decision stats and the paged call log

**Files:**
- Modify: `packages/db/src/store/judge-calls.ts` and its test, `packages/db/src/store/judge-call-stats.ts`,
  `apps/daemon/src/api/app.ts`, `apps/daemon/src/api/services.ts`, `apps/daemon/src/api/app.test.ts`,
  `apps/daemon/test/api-stub.ts`, `apps/daemon/src/daemon/judge-services.ts`,
  `apps/daemon/src/screens/render-access.ts`, `apps/daemon/src/screens/dev-ui-access.ts`,
  `apps/daemon/test/judge-api.test.ts`

**Interfaces:**
- Consumes: `JudgeCallsPageQuery`, `JudgeCallsPageDto`, `DecisionStatsListDto` (Task 1).
- Produces:
  - `listJudgeCalls(db, limit)` unchanged; new `pageJudgeCalls(db, q: { limit; offset; decision?; outcome? }):
    JudgeCallsPageDto`.
  - `judgeDecisionStats(db, since): DecisionStatsDto[]`, one per decision with any call; `answers` from answered
    calls, each with the model that answered.
  - `ApiServices.pageJudgeCalls(q)` and `ApiServices.judgeDecisionStats(): DecisionStatsListDto` (30 days on the
    clock); routes `GET /judge/calls/page` and `GET /judge/decisions`, both classified "No screen draws a setting."
    and allowed for the dev UI.

- [ ] **Step 1: Write the failing tests**: `pageJudgeCalls` filters by decision and outcome, pages by offset and
  answers the total; `judgeDecisionStats` counts acted, below the floor, shadow, stopped and each fallback, sums
  cost, takes the median latency, and lists each answer's model and confidence; `app.test.ts` rows for both routes
  behind the token, and `?decision=nope`, `?outcome=nope` answer 400 without reaching a service;
  `judge-api.test.ts` reads seeded calls back filtered and paged.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** them and `src/api/render-reads.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** with `Value: protects=per-decision 30-day numbers and a filtered, paged call log;
  fails_when=a stopped call counts as a failure, a filter is ignored, or the total misses the filter;
  why_new=GET /judge/calls has no filters or total; no_claim=the Decisions page reads them (PR 2).`

### Task 9: Docs, the decision record, the gate and the PR

**Files:**
- Create: a decision file in `docs/architecture/decisions/` dated the day it merges, slug `model-numbers-come-from-aa-and-openrouter`
- Modify: `apps/daemon/AGENTS.md` (the `benchmarks/`, `judge/` and flag paragraphs), `docs/architecture/03-trust-boundaries.md`
  (line 62's "read for each judge call": also read by the sync; §4.12's "the judge is the only code that calls
  OpenRouter": the sync now does too, sending the key and model ids only)

- [ ] **Step 1: Write** the decision: numbers shown, not routed on; spec §5.4's precedence; OpenRouter's terms
  (spec §3) and that its numbers are never committed or shipped; the parity table above.
- [ ] **Step 2: Run** `cd tests/repo && npx vitest run src/architecture-docs.test.ts src/agent-docs.test.ts
  src/benchmarks-off.test.ts`. Expected: PASS. Commit.
- [ ] **Step 3: Run the gate once**: `make gate`. Expected: `GATE PASS` (skip only if the builder says CI is the
  gate for this run, and say so in the PR).
- [ ] **Step 4: Push, open the PR** (`feat(daemon): …`, under 100 characters), and tell 10db-98. Turn on
  `gh pr merge --squash --auto` only after the whole-branch review passes.
