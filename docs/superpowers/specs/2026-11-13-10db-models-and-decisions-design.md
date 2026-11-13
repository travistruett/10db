# 10db models and decisions: one place to compare every model, and a Decisions page that reads clearly

## Brief

**What changes for the builder**

- Every agent model on Settings › Models shows an intelligence score, a cost and a speed wherever any source has
  one, and says where each number came from. Speed becomes OpenRouter's live measurement on the account's own
  provider (Bedrock, Anthropic, OpenAI…).
- Settings › Models gets an **Agents | Decisions** switch. Decisions shows which model each decision uses, a chart
  of time per decision against cost, and every OpenRouter decision model in the same table Agents uses.
- Settings › Decisions becomes one grouped table of every decision 10db makes, each opening a drawer: what it
  asks, what 10db does with each answer, its model, how sure the model must be (with "at 80%, it would have
  acted on 62 of your last 120"), and its recent calls. Recent decisions becomes a table of fixed height.
- Sizing and Questions move to Plan's own view.

**What it buys:** the three numbers the builder wants for every model; a coding score where any source has one;
a Decisions page where each setting sits with the decision it belongs to; and all ten decisions on one page.

**What could go wrong, and how we'd know**

- A number from OpenRouter is read as AA's per-effort figure: every number names its source, and routing never
  reads OpenRouter's (§5.4). A routing test pins that.
- OpenRouter's rate limits (30 requests a minute on benchmarks) slow the Models page: the daemon reads once a
  day and per model at most hourly, never on a page view (§5.2).
- A model joins to the wrong OpenRouter row: the join is exact, then canonical, never fuzzy, as the catalogue's
  own (§5.3); an unjoined model shows no OpenRouter number.
- OpenRouter's terms: read on 2026-11-13. They allow this use (the builder's own key, shown to that builder) and
  forbid scraping and redistribution, so its numbers are never committed or shipped (§3).

**Calls the builder might disagree with:** routing stays on AA alone; Coding shows only in a model's drawer, not
as a column; decision models get no quality axis until the replay task lands; Plan's measures leave Settings.

**Needed from the builder:** nothing. PR 1 can start now; PR 3 waits for the playbook PR.

---

**Status:** designed on 2026-11-13 with the builder. Nothing in it is built. Calls the builder has not made are
marked **(call)**.

**Starts from:** the builder's QA of Settings › Decisions after #600, which found the page hard to read and asked
whether OpenRouter could supply the intelligence, cost and speed the Models page takes from Artificial Analysis.

**Lands beside:** the right-sized work spec (`2026-11-13-10db-right-sized-work-design.md`), built by another
session. Its PR 2 replaces "Who each role gets" on Models with the **playbook** and rewrites
`models-section.tsx`; its PR 3 adds the judge decisions `task_rigor` and `task_kinds`. File ownership and order
between the two sessions are in `10db-worktrees/COORDINATION-models.md` (outside the repo).

**Keeps:**

- Routing on AA's per-effort scores and cost per task (`decisions/2026-11-13-models-are-ranked-in-four-rungs.md`).
- The judge and its record (`decisions/2026-10-31-openrouter-makes-routine-decisions.md`,
  `decisions/2026-11-13-a-decisions-model-is-picked-from-openrouters-list.md`).
- The model picker for a decision and its test before saving (`DecisionModelPicker`, #600).
- AA's attribution wherever an AA number shows, and its rule that AA data never enters the repo.

## 1. Intent

The builder wants three numbers for every model 10db can run, agent or decision: an **intelligence score**
(ideally for coding), its **cost** and its **speed**, from whichever source has them, and wants the settings that
use those numbers to be obvious. Today the Models page takes everything from AA's free API, which has no coding
or agentic values and covers only the efforts AA measured, and the Decisions page is a flat list in which a
decision's model and floor read as if they belonged to every decision.

## 2. Goals, non-goals, anti-goals

**Goals**

- Each agent model and effort shows intelligence, cost per task and speed, each with its source, from AA and
  OpenRouter combined by a fixed rule.
- Each decision model shows cost per million decisions and time per decision, with its source.
- One Models page holds both kinds of model behind an Agents | Decisions switch, in the same table and chart
  grammar.
- Settings › Decisions shows every decision, grouped, each with its status, model, threshold and recent numbers,
  and opens a drawer to change it.
- Recent decisions is a bounded, filterable table.

**Non-goals**

- Changing which model a role or step gets. Routing reads what it reads today (§5.4).
- A quality score for decision models. No source publishes one; the replay task
  (`tsk_01a1d6ea-20dc-75c3-95ba-96237db7940a`) adds one later, as the Decisions chart's quality toggle.
- Removing the AA integration. AA alone gives a score per effort, which routing needs.
- The playbook, rigor and kinds (right-sized work spec).

**Anti-goals** (failures even if it technically works)

- A role getting a different model because OpenRouter's numbers arrived.
- A number on screen whose source the builder can't tell.
- A page view that waits on OpenRouter, or a burst of requests that trips its rate limit.
- A decision's settings looking as if they apply to other decisions.

## 3. Constraints

- **Provider parity** (`AGENTS.md`). Agent models run on every account kind; decisions always run on an
  OpenRouter account. OpenRouter's numbers need an OpenRouter key: the key of the account decisions run on
  (`JudgeConfig.accountId`). A builder with none sees AA's numbers alone and a line saying what an OpenRouter key
  adds. A builder with an OpenRouter key and no AA key sees OpenRouter's numbers, max effort only, said so.
- **Kill switches.** The OpenRouter sync reads a key and calls out only when the daemon runs with neither
  `TENDB_JUDGE=off` (which keeps a daemon from reading any OpenRouter key) nor `TENDB_BENCHMARKS=off`.
  `tests/repo/src/benchmarks-off.test.ts` covers the launchers already; the sync's own test checks both.
- **Rate limits.** `/api/v1/benchmarks`: 30 requests a minute per key, 500 a day per account.
- **zod at every boundary**: OpenRouter's benchmarks and endpoint-stats responses, each item parsed on its own so
  one bad row hides nothing else.
- **AA data stays on the machine**: never in fixtures, docs or the repo, including AA numbers that arrive through
  OpenRouter. Tests use invented numbers.
- **OpenRouter's data stays the builder's own** (its Terms of Service, updated 2026-08-31, read 2026-11-13):
  §12 makes its data and compilations OpenRouter's or its licensors' and allows use only as OpenRouter
  authorizes; §6 forbids scraping the site, reselling API access and building a competing service. 10db reads the
  documented API with the builder's own key and shows the result to that builder only, which is the use the API
  is offered for. So: never scrape openrouter.ai pages; never commit OpenRouter numbers, put them in fixtures or
  ship them in a release snapshot (unlike the models.dev catalogue); every builder reads with their own key. The
  CC BY 4.0 grant covers only OpenRouter's Datasets endpoints, not Benchmarks. AA numbers that arrive through
  OpenRouter keep AA's attribution and AA's own rules.
- **Contracts are additive** (`packages/contracts/AGENTS.md`).
- **Ownership** with the playbook session, per `COORDINATION-models.md`: this work owns `benchmarks/`,
  `catalogue/`, `judge/`, `model-profiles.ts`, `ModelRowDto` and `decisions-section*`; the playbook PR owns
  `models-section.tsx`, `sections.ts`, `section-body.tsx`, routing and `ModelSetting` until it merges.

## 4. Approaches

- **A. The daemon combines the sources; routing never sees the result (chosen).** The AA sync stays as it is
  and keeps writing the routing profiles. A new OpenRouter sync keeps its own rows in its own table. One pure rule
  builds the Models page's rows from both, field by field, each value carrying its source.
- **B. Write OpenRouter's numbers into the routing profiles, marked by source.** Turned down: routing would read
  them unless every reader filtered them, which breaks "show only".
- **C. The desktop merges two daemon endpoints.** Turned down: the rule would live in the UI, be harder to test,
  and the playbook's screens would repeat it.

The builder chose "show only" for this round: OpenRouter's numbers are shown, never routed on.

## 5. Data

### 5.1 What each source gives (checked live 2026-11-13)

| | AA free API (builder's AA key) | OpenRouter (OpenRouter key) |
| --- | --- | --- |
| Intelligence | per effort | AA's, re-served: one row per model, at max effort |
| Coding, Agentic | none (fields empty) | AA's, for most models it lists, none for the Claude 5.5 family |
| Cost per task | AA's cost to run its index, per effort | OpenRouter's own evals (GPQA Diamond, tau-bench): average cost per task |
| Speed | AA's median output tokens a second | measured per provider, last 30 minutes, p50 to p99 (`/models/{id}/endpoints`) |
| Decision models | none | price; per-provider latency; no score in any source |

`GET /api/v1/benchmarks?source=artificial-analysis` answers items `{ model_permaslug, display_name,
intelligence_index, coding_index, agentic_index, pricing }`; `?source=openrouter` answers `{ model_permaslug,
benchmark_type, accuracy, avg_cost_per_task, total_tasks, last_run_timestamp }`. Endpoint stats carry
`provider_name`, `throughput_last_30m` and `latency_last_30m` as `{ p50, p75, p90, p99 }` and need a key (without
one they are null).

### 5.2 The OpenRouter sync

- `benchmarks/openrouter-*.ts` (owned here): reads both benchmark sources once a day, and endpoint stats for
  each model some live account offers and each callable decision model in `/judge/models` (not the
  `~maker/...-latest` routers, which share their target's stats), at most once an hour per model, spread to stay under 30 requests a
  minute. Never on a page view; never with a kill switch on (§3).
- Rows go to a new table (`openrouter_measures`; the schema change follows `packages/db/AGENTS.md`, which
  regenerates the migration baseline until the first release), keyed by OpenRouter model id and source: score
  fields, cost per task with its benchmark, and per-provider p50 throughput and latency with when they were read.
  A failed read keeps the last rows and records why, as the AA sync does.
- Its status joins the AA line on Models: "Speed and more scores from OpenRouter · read 2 h ago", or what is
  missing ("Add an OpenRouter key for measured speed").

### 5.3 Joining an OpenRouter row to a model

An OpenRouter id is `maker/model` (`anthropic/claude-sonnet-5.5`) and a permaslug adds a date
(`…-20261109`). The join drops the date and goes through `catalogue/join.ts` as an account's list does: exact,
then canonical, then normalised, never fuzzy. A model with no join shows no OpenRouter number. Its row is not
guessed.

### 5.4 The merge rule

A pure function (`catalogue/model-facts.ts` or beside `model-rows.ts`) takes a model's AA profile per effort,
its OpenRouter rows and the account the page is costed on, and answers each field with a value and a source.
First match wins:

| Field | 1st | 2nd | 3rd |
| --- | --- | --- | --- |
| Intelligence (per effort) | AA, that effort | AA via OpenRouter, max effort only, shown on the Max effort row alone | none |
| Coding, Agentic | AA | AA via OpenRouter, max effort | none |
| Cost per task (per effort) | AA, that effort, scaled to the account as today | none: OpenRouter's eval cost is shown in the drawer, labelled with its benchmark, never as cost per task | none |
| Speed (tokens a second) | OpenRouter p50 on the account's provider | OpenRouter median across providers | AA |

- The account's provider: Claude plan and Anthropic API key → `Anthropic`; Bedrock → `Amazon Bedrock`; ChatGPT or
  Codex plan → `OpenAI`. A gateway account, which has no single provider, and no account chosen both take the
  median across providers. **(my call)**
- OpenRouter's re-served Intelligence shows on a model's Max effort row only; a model with no Max profile shows
  none, as AA's bare slug is treated today. **(my call)**
- Speed is a model's, not an effort's: every effort of a model shows the same speed.
- **Routing reads none of this.** `model_profiles` keeps AA's values only. A routing test fixes a profile set,
  adds OpenRouter rows that would change the pick if read, and asserts the pick is unchanged.

`ModelRowDto` and `ModelEffortDto` gain, additively, a `sources` object naming each field's source
(`aa`, `aa_via_openrouter`, `openrouter`, or null), plus `coding` and `agentic` with their sources, and
`speedProvider` (the provider the speed was measured on, or null).

### 5.5 Decision models

For each OpenRouter decision model (`GET /judge/models`, #600), the Decisions view needs two numbers:

- **Cost per million decisions:** the mean logged cost of this builder's calls on that model over 30 days,
  times a million. For a model never called: its input price times this builder's typical decision size, where
  the typical size is total logged cost over total logged input price for calls whose model has a price. With no
  logged calls at all, 300 tokens.
- **Time per decision:** the median logged latency on that model over 30 days; else OpenRouter's p50 latency for
  it; else none.
- Each number carries its source ("your calls", "OpenRouter price", "OpenRouter measured").

`DecisionModelDto` gains these fields additively.

### 5.6 Decision stats

`GET /judge/decisions` (new) answers, per decision, over the last 30 days: calls, acted, below the floor,
fallbacks by reason, shadow, total cost, median latency, and the confidences of its answered calls (for the
threshold preview, §6.3). `GET /judge/calls` gains `decision`, `outcome` and `offset` filters for the table.

## 6. Settings › Decisions

### 6.1 The page

```
Decisions                                        Fast-model decisions [on]
Routine calls 10db makes with a fast model.       Paid by: Personal OpenRouter ● Key set

Decision                          Status    Model       Sure enough  Last 30 days
DELIVERY
  Skip review for small changes   Acting    Jev 1.13    80%          120 calls · 62 acted · $0.01
SIZING                                       (rows arrive with task_rigor, task_kinds)
PLAN
  Enough to propose               Shadow    Jev 1.13    80%          14 calls · 0 of 20 scored
  Record as a decision?           Shadow    …
  Question for someone else?      Shadow    …
STAKEHOLDER QUESTIONS
  Who a question goes to          Acting    …
  Which option a conversation chose, Which question a reply answers, Whether a reply approves

Recent decisions                 [Decision ▾] [Outcome ▾]
When · Decision · Model · Answer (sure) · What 10db did · Task      ← fixed height, header stays put
```

- **The decisions table** uses the Models page's table (`mantine-datatable`, `withColumnHeader`), grouped by a
  table of groups keyed by `JudgeDecision`, so a new decision is a new row in that table, not new layout. The
  Sizing group shows only when it has rows.
- **Status:** Acting (10db follows answers at or above the threshold), Shadow (answers are logged and scored,
  never shown), or Off. While the master switch is off every status reads "Off (all decisions)".
- **If `review_size` retires** (the playbook session moves its retirement to its PR 2b), the Delivery group empties
  and is not shown; its old calls keep their label in Recent decisions, and the contract value stays.
- **Sure enough** is the floor as a percentage. "Confidence needed 0.8" goes.
- **Paid by** is today's Runs on, renamed **(my call)**, with its key state, at the top beside the master switch.
- **Recent decisions** is a `DataTable` with `maxHeight` (about 420 px) and a sticky header, paged by the
  daemon, filtered by decision and outcome, newest first; a task's link opens it on the Board.

### 6.2 Each decision's drawer

Opens from a row, like a model from All models:

- What it asks, in plain words, and what 10db does on each answer and when the model is unsure (today's rule).
- Its switch.
- Its model: `DecisionModelPicker` as built, with the test before saving.
- **Sure enough:** a slider from 50% to 99%. Under it: "At 80%, 10db would have acted on 62 of your last 120
  answers." The count is over the confidences the stats return (§5.6), from whatever model answered them, which
  the line says when the model has since changed.
- Its numbers over 30 days, and its own recent calls (the same table, filtered).

### 6.3 Plan's measures

Sizing and Questions leave Settings for Plan's own view (`views/shape/`), with the same text and the same
`/shape-measures` data. Where in Plan's view is the builder's call to make in the plan; the default is beside the
conversation list.

## 7. Settings › Models

After the playbook PR merges.

- An **Agents | Decisions** `SegmentedControl` under the title.
- **Agents:** the playbook (the playbook PR's), the Intelligence and cost chart, All models. Each number shows its
  source on hover; a model's drawer adds Coding and Agentic where known, OpenRouter's eval costs, and speed by
  provider.
- **Decisions:**
  - "Which model each decision uses": decision, model, sure enough, last 30 days; a row opens the decision's
    drawer (§6.2).
  - **Time and cost:** a chart of time per decision (y, log) against cost per million decisions (x, log), a dot
    per decision model, a line at the 4 s cutoff, a ring on each decision's model, labelled like the playbook's
    rings. When the replay task lands, a toggle adds its quality axis.
  - **All decision models:** the same table as All models: model, maker, cost per million decisions, time per
    decision, used by, calls run; one 10db can't call is greyed with its reason. A row opens a small drawer: price,
    speeds by provider, the decisions using it, and where each number came from.
- The Account select reads the decisions account in the Decisions view, since decisions never use a project's
  account.

## 8. Provider parity

| Account the builder has | Agents view | Decisions view |
| --- | --- | --- |
| AA key and an OpenRouter account | AA per effort; OpenRouter speed and fills | everything |
| AA key, no OpenRouter account | as today | asks for an OpenRouter account, as Decisions does |
| OpenRouter account, no AA key | OpenRouter's scores at max effort, said so; no cost per task; routing has nothing to route on, as today without AA | everything |
| Neither | as today | asks for an OpenRouter account |

Speed is measured on the account's own provider whatever its kind; a gateway account, which has no single
provider, takes the median across providers.

## 9. Pull requests

1. **Data** (now): the OpenRouter sync and table, the join, the merge rule, the additive contract fields, the
   decision-model cost and time, `GET /judge/decisions` and the `/judge/calls` filters. No UI beyond the status
   line. Daemon, db, contracts.
2. **Decisions page** (after 1): §6, and Plan's measures moved. Desktop only. The playbook session's PR 3 adds its
   two Sizing rows on top.
3. **Models switch** (after the playbook PR and 1): §7.

## 10. Tests (cheapest rung each)

- The merge rule: a pure table, one row per precedence case, including "OpenRouter would change routing" kept
  out of profiles.
- The join: a pure table, including a dated permaslug and an unjoinable id.
- The sync: injected `fetch` and clock; one request per model per hour, the rate kept under 30 a minute, a failed
  read keeping old rows, both kill switches.
- Decision stats and the cost estimate: a real SQLite file with seeded `judge_calls`.
- The routes: real HTTP through the daemon with OpenRouter mocked at `fetch`.
- The Decisions page, the drawer's threshold preview and Recent decisions: rendered components.
- Routing unchanged: one test through `chooseModel` with OpenRouter rows present.

## 11. Left to the builder of the plan

- Exact table and file names, and the migration.
- How the sync spreads its requests.
- The drawer's layout within the shell's drawer conventions.
- Where in Plan's view the measures sit (default: beside the conversation list).
- The decision-model drawer's contents beyond what §7 names.

## 12. Words

- **Source**: where a number came from: AA, AA via OpenRouter, OpenRouter, or your calls.
- **Sure enough**: the confidence a decision's answer needs before 10db acts on it (the judge's floor).
- **Acting / Shadow / Off**: a decision's status (§6.1).
