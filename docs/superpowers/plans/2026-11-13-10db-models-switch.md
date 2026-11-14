# The Models switch (PR 3) Implementation Plan

## Brief

**What changes for the builder:** Settings › Models gets an **Agents | Decisions** switch under its title. Agents is
today's page (the playbook, Intelligence and cost, All models) with every number saying where it came from when
hovered or focused, a status line for OpenRouter beside AA's, and a model drawer that adds Coding and Agentic where
known, OpenRouter's eval costs (each labelled with its benchmark) and speed by provider. Decisions shows which
model each decision uses, a chart of time per decision against cost per million decisions with the 4 s cutoff, and
every OpenRouter decision model in the same kind of table, each opening a small drawer.

**What it buys:** the three numbers for every model, agent or decision, in one place, each with its source; and a
way to pick a decision model by what it costs and how fast it answers.

**What could go wrong, and how we'd know:**

- A number shows without its source, or with the wrong one: Task 2's table of source words, and Task 3's drawer
  test hovers each number.
- The page waits on OpenRouter: the Agents view never does (Task 1 reads stored `openrouter_measures` only, and its
  route test counts no request). The Decisions view's model list comes from `GET /judge/models`, which on a cold
  daemon waits for OpenRouter's list (up to 10 s); its chart and list show their own loading state while the
  decisions table draws at once.
- OpenRouter's latency unit is wrong (PR 1's QA item 2): the decision-model drawer shows the measured latency
  beside your calls' median, so a 1000× gap is visible in the first click-through, and the fix is in
  `apps/daemon/src/benchmarks/openrouter-client.ts`.
- The playbook PR's files clash: this PR starts from `main` after both the playbook PR and PR 2 merge; nothing here
  is built on `feat/rigor-playbook`.
- A free decision model vanishes from a log axis: free models sit in a "Free" column at the chart's left edge
  (Task 5's series table).

**Calls you might disagree with:** the switch is page state, not in the address; the Decisions view's Account select
shows the account decisions are paid by and does not change it (Paid by on Settings › Decisions does); "Calls run"
on a decision model counts its answered calls over 30 days, the only per-model count the stats carry; a decision
model with no cost or no time is listed but not drawn on the chart.

**Needed from you:** nothing. This plan waits for the playbook PR and PR 2 to merge before its build starts.

---

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Settings › Models shows agent and decision models behind an Agents | Decisions switch, every number with
its source, and a model's eval costs and speed by provider in its drawer.

**Architecture:** one daemon read, `GET /models/measures?model=<id>`, serves a model's stored OpenRouter rows (evals,
and speed and latency per provider) for both kinds of model; the rest is desktop. `models-section.tsx` keeps the
header and the switch, and its body moves to `agents-view.tsx`; the Decisions view reuses PR 2's `DecisionsTable`
and `DecisionDrawer`.

**Tech Stack:** TypeScript, zod 4, Hono, Drizzle on SQLite (read only), React 19, Mantine 9.8, `@mantine/charts`,
mantine-datatable 9.4, vitest, Testing Library + MSW, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-13-10db-models-and-decisions-design.md` (§5.2, §5.4, §5.5, §7, §8, §9 PR 3,
§10). Decision record: `docs/architecture/decisions/2026-11-13-model-numbers-come-from-aa-and-openrouter.md`.

## Global Constraints

- **Starts only after both the playbook PR (`feat/rigor-playbook`) and PR 2 (`feat/decisions-page`) merge** (Task 5
  uses PR 2's `DecisionsTable`, `DecisionDrawer`, `decision-catalogue.ts` and judge queries; Task 2 links to its
  `?focus=paid-by`), from `main` then, in
  `../10db-worktrees/models-switch` on `feat/models-switch`. This plan was written against that branch at
  `6fbbe740`; re-read `models-section.tsx` on `main` before Task 4 and follow its shape, not this plan's line
  references.
- Root, `apps/daemon`, `apps/desktop`, `views/settings`, `packages/contracts` `AGENTS.md` bind, with
  `.claude/rules/*.md`.
- No migration. Contracts are additive (`packages/contracts/AGENTS.md`).
- The new `GET` route is classified in `apps/daemon/src/screens/render-access.ts` ("No screen draws the model
  list.") and listed in `screens/dev-ui-access.ts`, beside `/models/status`.
- Routing reads none of this (spec §5.4); nothing under `routing/` reads `openrouter_measures`.
- Every externally visible schema is registered in `CONTRACT_SCHEMAS` (`packages/contracts/src/json-schema.ts`), and
  `pnpm --filter @10db/contracts generate` runs after a contract change (`packages/contracts/AGENTS.md`).
- Source words, exact (spec §12): `aa` → "Artificial Analysis"; `aa_via_openrouter` → "Artificial Analysis, via
  OpenRouter"; `openrouter` → "OpenRouter" (speed: "OpenRouter, measured on <provider>", or "OpenRouter, median
  across providers" when `speedProvider` is null); decision numbers: `your_calls` → "Your calls, last 30 days",
  `openrouter_price` → "OpenRouter's price for your typical decision", `openrouter` → "OpenRouter, measured",
  `assumed` → "OpenRouter's price for a 300-token decision".
- AA's attribution stays wherever an AA number shows: the page's credit line (`ArtificialAnalysisCredit`) stays
  on Agents, and the drawer shows it when it shows Coding or Agentic.
- Provider parity (spec §8, root `AGENTS.md`). Speed is measured on the provider the page's account runs on, as
  `speedProviderFor` (`apps/daemon/src/catalogue/model-facts.ts`) maps it; the desktop never maps it itself (the
  daemon answers `accountProvider`, Task 1):

  | Account the Agents view is costed on | Provider marked "This account's" | Speed shown |
  | --- | --- | --- |
  | Claude plan, Anthropic API key | Anthropic | its p50, else the median |
  | Claude through Bedrock | Amazon Bedrock | its p50, else the median |
  | ChatGPT or Codex plan, OpenAI key | OpenAI | its p50, else the median |
  | a gateway or OpenRouter account | none | median across providers |

  And by what the builder has (spec §8): no OpenRouter account → the Decisions view keeps "Which model each decision
  uses" and asks for an OpenRouter account in place of the chart and list, with a link to Settings › Decisions ›
  Paid by (`?focus=paid-by`); Agents shows AA's numbers alone and the OpenRouter line says "Add an OpenRouter account
  for measured speed and more scores". An OpenRouter account and no AA key → OpenRouter's scores at max effort only,
  and both status lines say so (Task 2).
- Tests use invented numbers; no AA or OpenRouter numbers in fixtures. Name test files and use `--maxWorkers=2`.

## Review Focus

1. A model with no OpenRouter rows (unjoined, or no key), or speed rows but no evals (the common case): each of the
   drawer's two sections says why it is empty, never shows zeros. Task 1 and Task 3.
2. Speed rows older than the sync's staleness: the drawer shows each provider's "read <when>", so an old row reads
   as old. Task 3.
3. Decision models with a null cost or time: listed with a dash, left off the chart, and the chart says how many
   it left out. Task 5.
4. `TENDB_JUDGE=off` (the e2e daemon): `/judge/models` answers 409; the Decisions view says decisions are off and
   still shows the decisions table. Task 5 (a render test) and Task 6.
5. A `/models` failure hides only the Agents view: the Decisions view still draws. Task 4.

---

### Task 1: A model's stored OpenRouter rows (daemon + contract)

**Files:**
- Create: `packages/contracts/src/model-measures.ts` (exported from `index.ts`, registered in `json-schema.ts`'s
  `CONTRACT_SCHEMAS` as `model-measures-dto`, and its query as `model-measures-query`, as `models-query` is; run
  `pnpm --filter @10db/contracts generate`)
- Create: `apps/daemon/src/catalogue/model-measures.ts`, `model-measures.test.ts`
- Modify: `apps/daemon/src/daemon/services.ts` (or the service file that serves `/models/status`),
  `apps/daemon/src/api/app.ts` (one `.get`), `apps/daemon/src/screens/render-access.ts`,
  `apps/daemon/src/screens/dev-ui-access.ts`, `apps/daemon/src/api/app.test.ts` (the path's row and the 400),
  `apps/daemon/test/models-api.test.ts` (a real daemon with seeded rows; it already seeds with
  `replaceEndpointStats` and counts fetches; start it with `openRouterSync: false` so the count is per request)

**Interfaces:**
- Produces:
  ```ts
  export const ModelMeasuresQuery = z.strictObject({ model: z.string().trim().min(1), account: AccountId.optional() });
  export const ModelEvalDto = z.object({ benchmark: z.string(), accuracy: z.number().nullable(), costPerTaskUsd: z.number().nullable(), measuredAt: z.iso.datetime() });
  export const ProviderSpeedDto = z.object({ provider: z.string(), tokensPerSecond: z.number().nullable(), latencyMs: z.number().nullable(), measuredAt: z.iso.datetime() });
  export const ModelMeasuresDto = z.object({
    /** The OpenRouter ids the rows are joined from, sorted; empty when the model joins to none. */
    openRouterIds: z.array(z.string()),
    /** The provider the account's speed is measured on (`speedProviderFor`); null for a gateway or no account. */
    accountProvider: z.string().nullable(),
    evals: z.array(ModelEvalDto),
    speeds: z.array(ProviderSpeedDto), // fastest p50 first
    /** Why `evals` is empty, in the builder's words; null when it isn't. */
    evalsMissing: z.string().nullable(),
    /** Why `speeds` is empty; null when it isn't. */
    speedsMissing: z.string().nullable(),
  });
  // apps/daemon/src/catalogue/model-measures.ts
  export function modelMeasures(input: { model: string; rows: readonly OpenRouterMeasure[]; catalogue: Catalogue | null; keyed: boolean; off: boolean; accountProvider: string | null }): ModelMeasuresDto;
  ```

`model` is a catalogue model id (an agent model) or an OpenRouter id (a decision model): rows whose `id` equals it
are taken as they are; otherwise `groupMeasuresByModel` joins them (`openrouter-join.ts`). Eval rows are the
`openrouter` source's benchmark rows (`kind`/`key` as PR 1 stores them; read `packages/db/src/openrouter-measure-kind.ts`).
Off or unkeyed, no rows are returned at all, even stored ones, as `GET /models` leaves them out
(`openRouterOn()` in `daemon/services.ts`); the service passes `off` from the daemon's kill switches
(`TENDB_JUDGE=off` or `TENDB_BENCHMARKS=off`) and `keyed` from the OpenRouter sync status's `keyConfigured`, and
`accountProvider` from `speedProviderFor(account.kind)` when `account` is given and found (404 when unknown).
Reasons, the same for both sections unless said: off → "OpenRouter isn't read while 10db runs with TENDB_JUDGE=off
or TENDB_BENCHMARKS=off."; no key → "Add an OpenRouter account for measured speed and eval costs."; no catalogue
(`catalogue` null) and no exact rows → "The model catalogue hasn't been read yet."; no join and no rows →
"OpenRouter lists no model that matches this one."; joined, nothing stored yet → "Not read from OpenRouter yet.";
speeds but no evals → evalsMissing "OpenRouter has run no evals on this model.".

- [ ] **Step 1: Write the failing tests.** `model-measures.test.ts`, one named row each: exact OpenRouter id;
  catalogue id joined through a dated permaslug; two OpenRouter ids joined to one model both listed; a
  `~maker/...-latest` router id joins nothing; each reason, including off with stored rows (no rows returned) and a
  null catalogue; speeds ordered fastest first; an eval row and a speed row for the same model both returned. In
  `models-api.test.ts`: `GET /models/measures?model=…&account=…` answers seeded rows with `accountProvider` for an
  account of each `AccountKind` (`it.each` over every kind, each row's provider from the Global Constraints' table), and makes no
  request. In `app.test.ts`: the path's row and a missing `model` → 400.
- [ ] **Step 2: Run** `pnpm --filter @10db/daemon exec vitest run src/catalogue/model-measures.test.ts <route test>
  --maxWorkers=2` and see them fail.
- [ ] **Step 3: Implement** the contract, the pure function, the service and the route; classify the route in both
  screens files (the render-access test fails until it is).
- [ ] **Step 4: Run** them again, plus `src/screens/render-access.test.ts`, contracts' tests, typecheck and lint
  of the changed packages; `pnpm --filter @10db/contracts generate` and commit what it writes.
- [ ] **Step 5: Commit** — `feat(daemon): a model's openrouter evals and speed by provider are served from the
  stored rows` with the value card:
  `Value: protects=a model's stored OpenRouter evals and per-provider speeds, joined as the rows are, with the
  account's provider and why a section is empty; fails_when=rows of another model show, stored rows show while off or
  unkeyed, a request reaches OpenRouter, or a provider is mapped wrong for an account kind; why_new=model-facts tests
  cover the merged figure only, not the rows behind it; no_claim=that OpenRouter's numbers are right (QA item 2).`

### Task 2: Every number names its source

**Files:**
- Create: `apps/desktop/src/views/settings/number-source.ts`, `number-source.test.ts`, `sourced-number.tsx`,
  `openrouter-status-line.tsx`, `openrouter-status-line.test.tsx`
- Modify: `apps/desktop/src/views/settings/models-table.tsx` (Intelligence and Cost per task cells),
  `models-section.tsx` (mount the status line under AA's), `artificial-analysis-status-line.tsx` and its test (the
  no-AA-key state with OpenRouter scores), `rightsizing-series.ts` and its test (each point carries its
  Intelligence source), `rightsizing-chart.tsx` (the tooltip prints it)

**Interfaces:**
- Produces:
  ```ts
  export function modelSourceText(source: ModelSource, field: 'intelligence' | 'coding' | 'agentic' | 'costPerTask' | 'speed', speedProvider: string | null): string;
  export function decisionSourceText(source: DecisionNumberSource): string;
  export function SourcedNumber(props: { readonly text: string; readonly source: string | null }): JSX.Element;
  // a Tooltip (openDelay 300) over the text; the text carries `aria-describedby` to a visually hidden span with
  // the same words, so a screen reader hears the source with the number. No extra tab stop: a cell is not made
  // focusable for its tooltip. No source: the text alone.
  export function OpenRouterStatusLine(): JSX.Element | null; // from useBenchmarkStatus().data.openRouter
  ```
`OpenRouterStatusLine` (spec §5.2), an exhaustive switch: ok → "Speed and more scores from OpenRouter · read
<fromNow>"; ok with no AA key (`useBenchmarkStatus().data.keyConfigured` false) → "Scores at max effort only, from
Artificial Analysis through OpenRouter, and speed · read <fromNow>"; no key → "Add an OpenRouter account for
measured speed and more scores" with a link to Settings › Decisions (`?focus=paid-by`); keyed, not read yet
(`outcome` null) → "Reading OpenRouter…"; unauthorized → "OpenRouter refused the key of the account decisions are
paid by." with the same link; failed or rate limited → the daemon's `message`; off → "OpenRouter isn't read while
10db runs with TENDB_JUDGE=off or TENDB_BENCHMARKS=off.". The AA line's no-key state, when OpenRouter's read is ok,
says "No Artificial Analysis key: scores at max effort only, through OpenRouter" instead of "compared without
scores". Each chart point carries its Intelligence and Cost per task sources (`rightsizing-series.ts`), and the
chart's tooltip adds each one's words under its number.

- [ ] **Step 1: Write the failing tests:** a table over every `ModelSource` × field and every
  `DecisionNumberSource` with the Global Constraints' words; `SourcedNumber` exposes its source through its
  description; one row per status-line state above; the AA line's no-key row with OpenRouter ok; a
  `rightsizing-series` row whose Max point is `aa_via_openrouter` carries that source.
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement**, and wrap the table's Intelligence and Cost per task cells.
- [ ] **Step 4: Run** the new tests and `models-section.test.tsx`, `models-table` tests if any; typecheck; lint.
- [ ] **Step 5: Commit** — `feat(desktop): every number on models says where it came from` with the value card:
  `Value: protects=every number on Models names its source, in the table, the chart and the status lines;
  fails_when=a source maps to the wrong words, a relayed score reads as AA's own, or a status state has no words;
  why_new=models-section tests check values, not where they came from; no_claim=the tooltip's look (click-through).`

### Task 3: The model drawer adds Coding, Agentic, eval costs and speed by provider

**Files:**
- Modify: `apps/desktop/src/views/settings/model-drawer.tsx`, `apps/desktop/src/daemon/model-queries.ts`
  (`useModelMeasures(model: string | null, account: AccountId | null)`: the account is in the query key and sent as
  `account`, so the daemon can answer `accountProvider`), its fixtures in `test/` (the fixture answers
  `accountProvider` only when the request carries `account`)
- Create: `apps/desktop/src/views/settings/model-measures-panel.tsx`, `model-drawer.test.tsx` (or extend the
  drawer cases in `models-section.test.tsx` if they live there)

**Interfaces:**
- Consumes: Task 1's `ModelMeasuresDto`, Task 2's `SourcedNumber`.
- Produces: `export function ModelMeasuresPanel(props: { readonly model: string; readonly account: AccountId | null }): JSX.Element` (reused by Task 5's decision-model drawer with `account: null`); it marks the provider the daemon answers in `accountProvider`.

Drawer additions: "Coding" and "Agentic" beside Intelligence in the effort table's header line when the row has
them (row-level, from Max effort, each `SourcedNumber`), with AA's credit; the effort table's Intelligence and Cost
per task cells as `SourcedNumber`; speed in the price line as `SourcedNumber`; then `ModelMeasuresPanel`: "Eval
costs (OpenRouter)" — Benchmark, Accuracy, Average cost per task — with the line "OpenRouter's own evals; not the
cost per task routing uses."; "Speed by provider" — Provider, Tokens a second, Latency, Read — the account's
provider marked "This account's" (from the answer's `accountProvider`); `evalsMissing` and `speedsMissing` under
their own headings when empty.

- [ ] **Step 1: Write the failing tests:** a row with coding and agentic sourced `aa_via_openrouter` shows both and
  their source; a row with neither shows neither; the measures request carries `account=<the page's account id>`;
  evals and speeds render from the fixture with the account's provider marked; speeds with no evals shows `evalsMissing` under Eval costs; a read older than a day shows its age.
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the drawer tests and `models-section.test.tsx`; typecheck; lint.
- [ ] **Step 5: Commit** — `feat(desktop): a model's drawer shows coding, agentic, eval costs and speed by
  provider` with the value card:
  `Value: protects=the drawer's Coding, Agentic, eval costs and speeds by provider with sources and empty reasons;
  fails_when=an empty section shows zeros or nothing, the wrong provider is marked, or eval cost reads as cost per
  task; why_new=the drawer's tests cover efforts and offers only; no_claim=the numbers' accuracy.`

### Task 4: The Agents | Decisions switch

**Files:**
- Create: `apps/desktop/src/views/settings/agents-view.tsx` (today's page body, moved unchanged, with its early
  returns: accounts loading or failed, no account, `/models` loading or failed), and
  `decisions-models-view.tsx` holding only PR 2's `DecisionsTable` (`withStatus={false}`) and `DecisionDrawer`, which
  Task 5 fills in
- Modify: `apps/desktop/src/views/settings/models-section.tsx`, `models-section.test.tsx`,
  `apps/desktop/src/views/settings/decisions-table.tsx` (a `withStatus` prop, default true; with it off the Status
  column goes and the group row's `colSpan` becomes the column count, not today's fixed 5), and a case in
  `decisions-section.test.tsx` that Settings › Decisions still shows Status

**Interfaces:**
- Produces: `ModelsView = { Agents: 'agents', Decisions: 'decisions' } as const` (+ type) in
  `models-section.tsx`; `AgentsView(props: { account: AccountDto; … })` takes what the body reads today.

A `SegmentedControl` (`aria-label="Models view"`, Agents | Decisions, Agents first) under the title. Agents draws
`AgentsView`; Decisions draws `DecisionsModelsView`. The header (title, switch, Account select) draws above both,
so a `/models` failure hides only the Agents view. The header's Account select in the Decisions view
shows the account decisions are paid by (`useJudgeStatus().data.account`), disabled, with "Paid by" as its left
label and a tooltip "Change it under Settings › Decisions"; with none it reads "No OpenRouter account". The refresh
button and the AA lines show on Agents only.

- [ ] **Step 1: Write the failing tests:** the switch shows Agents first with the playbook; Decisions shows the
  decisions table and the paid-by account in a disabled select; switching back keeps the Agents account chosen; a
  failed `/models` read still lets Decisions draw.
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement**; the move to `agents-view.tsx` changes no behaviour (its tests pass untouched).
- [ ] **Step 4: Run** `models-section.test.tsx`, `decisions-section.test.tsx` and the playbook's tests
  (`playbook-table.test.tsx`); typecheck; lint.
- [ ] **Step 5: Commit** — `feat(desktop): models has an agents and a decisions view` with the value card:
  `Value: protects=the switch between the two views and the account each reads; fails_when=Decisions reads a project
  account, the Agents account resets, or an Agents failure hides Decisions; why_new=models-section tests cover one
  view; no_claim=the Decisions view's contents (Task 5).`

### Task 5: The Decisions view

**Files:**
- Fill: `apps/desktop/src/views/settings/decisions-models-view.tsx` (Task 4's)
- Create: `decision-model-series.ts`,
  `decision-model-series.test.ts`, `decision-models-chart.tsx`, `decision-models-table.tsx`,
  `decision-model-drawer.tsx`, `decisions-models-view.test.tsx`

**Interfaces:**
- Consumes: PR 2's `DecisionsTable` (`withStatus={false}`, Task 4; `shadow` from `useShapeMeasures().data?.shadow`),
  `DecisionDrawer` (its props as `decisions-section.tsx` passes them: `statsFailed={stats.isError}` and `shadow` as
  that decision's entry of the agreement list), `DECISIONS`,
  `modelName`, `formatDecisionUsd`, `statsFor`, `useDecisionStats`, `useDecisionModels`, `useJudgeStatus`; Task 2's `SourcedNumber`/`decisionSourceText`; Task 3's
  `ModelMeasuresPanel`.
- Produces:
  ```ts
  export interface DecisionModelPoint { readonly id: string; readonly name: string; readonly costPerMillionUsd: number; readonly free: boolean; readonly x: number; readonly secondsPerDecision: number; readonly usedBy: readonly JudgeDecision[] }
  export function decisionModelSeries(models: readonly DecisionModelDto[], config: JudgeConfig): { readonly points: readonly DecisionModelPoint[]; readonly omitted: number; readonly freeX: number | null };
  export function answersByModel(stats: DecisionStatsListDto): ReadonlyMap<string, number>;
  // packages/contracts/src/judge.ts: export const JUDGE_TIMEOUT_MS = 4000; the daemon's judge.ts imports it in place
  // of its own constant, so the chart's line and the real cutoff can't drift.
  ```

Top to bottom: "Which model each decision uses" (`DecisionsTable` with `withStatus={false}`; a row opens
`DecisionDrawer`); "Time and cost" (`ScatterChart`, cost per million decisions on a log X, seconds per decision on a
log Y, a gray dot per model, a dashed reference line at `JUDGE_TIMEOUT_MS / 1000` s labelled "4 s: 10db falls back
past this", a violet ring on each model a decision uses labelled with the decisions' names, as the playbook's rings
are; a free model (cost 0, which a log axis can't place) is drawn at `freeX`, a quarter of the cheapest paid cost, or
0.01 with none, and its X tick reads "Free"; the tooltip shows the model, its cost and time each with its source
words; "N models with no cost or time are not drawn." for nulls only); "All decision models" (`DataTable`: Model
(name, then maker dimmed), Cost per million decisions and Time per decision as `SourcedNumber`, Used by (decision
labels), Answers (30 days) (`answersByModel`: answered calls only, as the stats carry them),
sortable on the numbers, paged 25 with the shared pager; a model with `cantCall` is dimmed with its reason under its
name). A row opens `DecisionModelDrawer` (`Drawer` right, `size="md"`): price in and out per million tokens, cost
and time with their sources, the decisions using it, then `ModelMeasuresPanel` with the OpenRouter id and no
account. No key, or the judge off: the view keeps "Which model each decision uses" and replaces the chart and list
with the daemon's reason and a link to Paid by.

- [ ] **Step 1: Write the failing tests.** `decision-model-series.test.ts` (table): both numbers → a point; cost 0 →
  drawn at `freeX`, marked free, not omitted; a null cost or time → omitted and counted; `usedBy` from the config; a
  `~latest` router and its target both drawn. `decisions-models-view.test.tsx`: the three blocks render from
  fixtures; a row opens the decision drawer; a model row opens its drawer with speeds; with no key the chart and
  list are replaced by the ask and the link; with `off: true` (`/judge/models` 409) the view says decisions are off
  and the decisions table still draws.
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the new tests, `decisions-section.test.tsx` (the table prop), `models-section.test.tsx`;
  typecheck; lint.
- [ ] **Step 5: Commit** — `feat(desktop): the decisions view compares decision models by time and cost` with the
  value card:
  `Value: protects=each decision model placed by time and cost with its sources, free ones included, and the list
  and drawers; fails_when=a free model vanishes, a null is drawn, a model's users are wrong, or the view breaks with
  the judge off; why_new=no test covered decision models beyond the picker; no_claim=OpenRouter's latency unit (QA
  item 2).`

### Task 6: e2e and click-through

**Files:**
- Modify: `apps/desktop/e2e/settings.spec.ts`

- [ ] **Step 1: Write the spec** `Models switches between agents and decisions`: open `/settings/models`, Agents
  shows the playbook; switch to Decisions: the decisions table lists every decision and the view says decisions
  are off (`TENDB_JUDGE=off` in the e2e daemon); axe dark and light on both views.
- [ ] **Step 2: Run** `pnpm --filter @10db/desktop e2e -- settings.spec.ts`. Expected: PASS.
- [ ] **Step 3: Click through by hand** with `pnpm dev` and an OpenRouter account: hover each number on both views;
  open a model's drawer and a decision model's drawer; compare OpenRouter's measured latency with your calls'
  median (PR 1's QA item 2). Note in the ledger (outside the repo) whether each looks plausible, never the numbers
  themselves (spec §3).
- [ ] **Step 4: Commit** — `test(desktop): the models switch through the real daemon` with the value card:
  `Value: protects=the switch and both views through the real daemon with the judge off, axe-clean in both themes;
  fails_when=the switch, the decisions table or the judge-off notice breaks against the real backend; why_new=Task 4
  and 5's render tests use MSW fixtures; no_claim=the chart and list with a live OpenRouter key (click-through).`

### Task 7: Docs

- Modify: `apps/desktop/src/views/settings/AGENTS.md` (the Models bullet: the switch, sources on hover, the drawer's
  additions, the Decisions view), `apps/daemon/src/catalogue/AGENTS.md` (`GET /models/measures`).
- [ ] **Step 1: Update the notes**, timeless wording.
- [ ] **Step 2: Run** prettier on them and `tests/repo/src/agent-docs.test.ts`.
- [ ] **Step 3: Commit** — `docs: the models switch and where each number comes from`.
