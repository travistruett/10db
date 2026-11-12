# 10db Models Rightsizing: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Settings › Models and benchmarks shows how 10db sizes a model to a role. The builder sizes models on
Intelligence and cost per task; speed matters little for building. The page gets two views:

- **Table:** a Cost per task column, each row expanding to one line per effort.
- **Chart:** Intelligence against cost per task, with each role's need and the router's own pick for each role.

The page shows which model each role gets, and why.

**Architecture:**

- **Cost on an account** is one module, `apps/daemon/src/routing/cost-on-account.ts` (`costOnAccount`). It holds
  today's private `costOn` rule from `router.ts` unchanged: AA's cost per task, scaled by the account's own output
  price over the maker's. A plan, which has no per-token price, keeps the maker's figure. The router and the model
  rows both call it, and the desktop never prices anything.
- **`GET /models?account=<id>`** (the query is optional and validated by zod). Each row carries `efforts` (one
  `ModelEffortDto` per profile) and `costPerTaskUsd`, the cost of the effort its Intelligence comes from. Without
  `account`, costs are the maker's. With it:
  - the efforts of a model that account offers are its offered profiles (`offeredProfiles`, so an account that
    lists efforts narrows them), priced on that account
  - a model it does not offer keeps every effort at the maker's cost (the desktop's Available on filter hides
    those rows anyway)
  - the row's `intelligence`, `costPerTaskUsd` and speed come from the strongest of the row's efforts, so a row
    never mixes two efforts
- **`GET /models/picks?account=<id>`** (`account` required) returns `RolePicksDto`: for each role,
  `chooseModel`'s choice for that account at the role's default need (`NEED`, exported as `ROLE_NEED`). The choice
  uses the Automatic setting, no persona, no risk tags, no patterns, no role settings and no budget ceiling. The
  account's tier overrides and own list still apply, as they do for any step on it. A pure function
  (`routing/role-picks.ts`) takes the same inputs `routingInputs` gathers, so the chart circles what routing
  chooses for a project on that account with no settings of its own. The panel says what it leaves out: role
  settings, patterns, risk floors and budget ceilings.
- **Desktop:** the models section gets a `SegmentedControl` (Table | Chart) and a Columns menu, both in the toolbar.
  The menu is the Knowledge one, moved to `shell/columns-menu.tsx` and shared, not copied. The chart is
  `@mantine/charts` `ScatterChart`. The Pareto frontier is a pure function (`views/settings/pareto.ts`), and so is
  the build of the chart's series, reference lines, area and dots (`views/settings/rightsizing-series.ts`), so
  jsdom (where recharts draws nothing at zero size) never has to read the SVG.

**Tech Stack:** TypeScript, zod 4, Hono, Vitest, React 19, Mantine 9.8.0, mantine-datatable 9.4.0,
`@mantine/charts` 9.8.0, `recharts` 3.10.1.

**Base:** `feat/aa-performance-v3` (PR #585): every role routes on Intelligence, speed comes from AA's
`performance_v3`, and the models list is a mantine-datatable. Rebase onto `origin/main` once #585 merges.

## Provider parity

| Account                         | Cost per task                                            | Picks                                 |
| ------------------------------- | -------------------------------------------------------- | ------------------------------------- |
| Claude plan (`claude_subscription`) | maker's figure (no per-token price)                      | `chooseModel` over its offer          |
| Bedrock / Anthropic API key     | scaled by the account's own output price where it lists one | same, with that cost                  |
| ChatGPT/Codex plan (`codex_signin`) | maker's figure (no per-token price)                  | same, over OpenAI profiles            |

Where AA has not measured a model, its cells show a dash, it is not plotted, and its pick (by the tier's default
effort, as routing does then) is listed in the panel with routing's own reason. Nothing is refused per provider.

## Rules that bite

- **No AA numbers** anywhere: tests use the invented models of `routing/test-catalogue.ts` and
  `apps/desktop/src/test/model-fixtures.ts`.
- zod at the boundary: the new query strings and `RolePicksDto` are contracts, registered in `CONTRACT_SCHEMAS`.
  Regenerate with `pnpm --filter @10db/contracts generate`.
- Pin `@mantine/charts` at `9.8.0` and `recharts` at `3.10.1`, exactly.
- One value card per new behaviour in the commit that adds it.

---

## Task 1: cost per task on the rows, the per-effort lines and the Columns menu

One vertical slice: contracts → daemon → desktop, tested through the real backend's route.

**Files:**

- Create: `apps/daemon/src/routing/cost-on-account.ts`, `cost-on-account.test.ts`
- Modify: `apps/daemon/src/routing/router.ts` (import `costOnAccount`; delete the private `costOn`),
  `routing/index.ts` (export `costOnAccount`, `offeredProfiles` is already there)
- Modify: `packages/contracts/src/catalogue.ts`: `ModelEffortDto`
  `{ profileId, effort, intelligence, costPerTaskUsd, outputTokensPerSecond, stepsRun, firstPassSteps }`;
  `ModelRowDto` gains `efforts: ModelEffortDto[]` and `costPerTaskUsd: number | null`; `ModelsQuery`
  `{ account?: AccountId }`. Register `model-effort-dto` and `models-query` in `json-schema.ts`, then regenerate.
- Modify: `apps/daemon/src/catalogue/model-rows.ts`. `ModelRowsInput` gains an optional
  `costAccount: { id; provider; models: AccountModelDto[] }`. Efforts are listed strongest Intelligence first, and
  unscored ones last by effort level. The row's `intelligence`, `costPerTaskUsd` and `outputTokensPerSecond` are
  its first effort's; speed falls back as today.
- Modify: `apps/daemon/src/api/app.ts` (`GET /models` parses `ModelsQuery`; an unknown or archived account is a
  404 through the existing `getAccount` error mapping), `api/services.ts` (`listModels(accountId?)`) and
  `daemon/services.ts`.
- Modify: `apps/desktop/src/daemon/model-queries.ts`: `useModels(accountId: AccountId | null)`, keyed
  `['models', 'list', accountId]` under `modelKeys.all`, so the existing invalidation still covers it.
- Create: `apps/desktop/src/shell/columns-menu.tsx`, the `ColumnsMenu` and its toggle rule moved out of
  `knowledge-table.tsx`, which imports it.
- Modify: `apps/desktop/src/views/settings/models-table.tsx`, `models-section.tsx`, `model-order.ts`
  (`ModelColumn.CostPerTask`), `model-format.ts` (`formatCost`: `$0.42`; under a cent, `<$0.01`; null is the dash).

**Desktop behaviour:**

- Columns, in this order: Model, Tier, Available on, Intelligence, Cost per task, Input, Output, Steps run, Speed.
  The groups go: the AA credit moves to one line above the table (as it will sit under the chart). Input and
  Output read `Input $/1M` and `Output $/1M` in their header titles.
- Speed is `toggleable` with `defaultToggle: false`, so it is hidden until the Columns menu shows it. The Columns
  menu sits in the toolbar beside Refresh Models, and the layout is stored under `models-table`. Hiding and
  showing columns uses the same rule as Knowledge's (`useDataTableColumns`).
- `rowExpansion`: clicking a row's expand chevron (a button named `Show efforts of <name>`) shows one line per
  effort: effort, Intelligence, cost per task, steps run and first pass (`formatFirstPass`). A click elsewhere on
  the row still opens the drawer.
- The section passes `filter.accountId` to `useModels`, so the column shows that account's cost once Available on
  picks one. While the refetch runs, the previous rows stay up (`placeholderData: keepPreviousData`).
- Cost per task sorts like the other numeric columns (no data last, Unknown last).

**Tests (go red first):**

- [ ] `cost-on-account.test.ts`, table-driven and pure, one row per case:
  - the maker's price
  - a 10% dearer Bedrock copy
  - half-price
  - a plan with no price
  - a model the account does not list
  - a profile with no maker price, or a zero maker price
  - no cost per task, which gives null

  `router.test.ts`'s "budget ceiling on an account that pays per token" block stays as the wiring test, unchanged
  and green.
- [ ] `model-rows.test.ts`, extended:
  - (a) a row's efforts are listed strongest first, with `costPerTaskUsd` from that effort
  - (b) with `costAccount` on an account priced 10% above the maker, the row's and every effort's cost are scaled
  - (c) an account whose list names only `low` gives a row with only that effort, and Intelligence follows it
  - (d) a model the account does not offer keeps the maker's costs
- [ ] `apps/daemon/test/models-api.test.ts`: one case, `GET /models?account=<id>`, answers rows with `efforts`.
  A malformed `account` is a 400, and an unknown one a 404.
- [ ] `model-order.test.ts`: add a Cost per task row to the existing sort table.
- [ ] `models-section.test.tsx`, extended:
  - Cost per task shows the strongest effort's cost
  - Speed is hidden until the Columns menu shows it
  - expanding a row lists one line per effort
  - picking an account in Available on asks `/models?account=` and shows that account's cost (fake daemon route)
- [ ] `knowledge-table` tests stay green after the move (no change to them).

**Commit:** `feat: the models list shows cost per task on the account chosen, one line per effort` (with the
value cards).

---

## Task 2: the Chart tab with the router's picks

One vertical slice: contracts → daemon route → desktop chart.

**Files:**

- Modify: `packages/contracts/src/catalogue.ts`: `RolePickDto`
  `{ role, need, profileId | null, model | null, effort | null, reason }`, and `RolePicksDto`
  `{ accountId, picks: RolePickDto[] }`, with one pick per `StepRole` in flow order (plan, plan_review, implement,
  review, qa). Add `ModelPicksQuery { account: AccountId }`, register all three, and regenerate.
- Modify: `apps/daemon/src/routing/catalogue.ts`: export `ROLE_NEED` (today's `NEED`, keyed by `StepRole`), and
  from `routing/index.ts`.
- Create: `apps/daemon/src/routing/role-picks.ts`, `role-picks.test.ts`. The input is
  `Pick<ChooseInput, 'profiles' | 'tierOverrides' | 'accountModels'>`:
  - for each role it calls `chooseModel` with Automatic, `ROLE_NEED[role]`, no persona, an empty task,
    `project: { id: null, budgetCeiling: null }` and `byScore: true`
  - `NoProfileError` becomes a pick with null model, its reason "No model on this account reaches <n>
    intelligence"
  - a choice whose `profile` is null (a tier name, or an override launched as named) keeps its `model` and a null
    `profileId`
- Modify: `apps/daemon/src/api/app.ts` (`GET /models/picks`, query parsed by `ModelPicksQuery`), `api/services.ts`
  (`modelPicks(accountId)`), and `daemon/services.ts`. It uses `routingInputs(db, { accountId, provider })`, with
  `roleSettings` and `patterns` dropped. An archived or unknown account is a 404.
- Modify: `apps/desktop/package.json`: `@mantine/charts` `9.8.0`, `recharts` `3.10.1`. In `src/app.tsx`, import
  `@mantine/charts/styles.css` after the core styles.
- Modify: `apps/desktop/src/daemon/model-queries.ts`: `useModelPicks(accountId | null)` (disabled on null), keyed
  `['models', 'picks', accountId]`.
- Create: `apps/desktop/src/views/settings/pareto.ts` and `pareto.test.ts`. `paretoFrontier(points)` returns the
  points no other point beats: none other costs no more and scores at least as much, with one of the two
  strictly. They come back sorted by cost. Ties on both keep the first by model and effort.
- Create: `apps/desktop/src/views/settings/rightsizing-series.ts` and its test. From the rows (already filtered
  and limited to the chart's account), the picks, the selected role and the dots mode, it builds:
  - the series: one per tier, points `{ cost, intelligence, model, name, effort }`, with no point where either
    value is null or the cost is not above 0 (the log axis has no 0), plus how many were left out
  - the Pareto series, drawn as a line
  - the need lines: one dashed line per role that has a need, labelled `<Role> <need>`; with a role selected,
    only its line
  - the reference dots: a ring on each pick's point, found by `profileId`
  - the "strong enough and cheap" area: Intelligence from the lowest need up, cost up to the dearest pick (with a
    role selected, that role's need and its pick's cost), so the area's right edge is what routing pays
- Create: `apps/desktop/src/views/settings/rightsizing-chart.tsx` (the chart and its controls) and
  `role-picks-panel.tsx` ("Who each role gets": one row per role with its need, the pick's name, effort, cost on
  the account and routing's reason; a row is a button that selects the role, and selecting it again clears it).
- Modify: `models-section.tsx`. The toolbar gets `SegmentedControl` Table | Chart. The Chart view:
  - shows an account select, defaulting to the Available on filter's account, else the default account, else
    the first live account. Its "Any account" choice is not offered; choosing an account sets the shared filter,
    so the Table shows that account too
  - shows only the models the account can run (`availableOn`), with the other header filters applied
  - has the toggle "Every effort | Pareto only"
  - has the AA credit under the chart
  - with no live account says "Add an account to see what each role gets."

**Chart details:** the X axis has `scale: 'log'`, `type: 'number'`, `domain: ['auto', 'auto']` and ticks
formatted by `formatCost`. The Y axis is Intelligence from 0 to 100. The tooltip shows the model name, effort,
Intelligence and cost. With a role selected, the panel's other rows and the other picks' rings are dimmed. The
panel's footnote: "Automatic routing at each role's starting need on this account. Role settings, patterns, risk
floors and budget ceilings can change a task's pick."

**Tests (go red first):**

- [ ] `role-picks.test.ts` (pure, over `testCatalogue()`), table-driven:
  - each role's pick equals `route()`'s cheapest at its need
  - a tier override wins as it does in `chooseModel`
  - an account that offers nothing strong enough yields the null pick with its reason
  - a catalogue with no scores picks by role default with routing's reason
- [ ] `apps/daemon/test/models-api.test.ts`: `GET /models/picks?account=<id>` answers five picks for the
  account's offer through the real daemon. A missing `account` is a 400.
- [ ] `pareto.test.ts`: a table of named cases:
  - one point
  - a dominated point dropped
  - equal cost with the higher score kept
  - equal score with the cheaper kept
  - exact duplicates
  - an unsorted input
- [ ] `rightsizing-series.test.ts`:
  - points with a null or 0 cost are left out and counted
  - the need lines are one per role, or only the selected one
  - the ring sits at the pick's point
  - the area bounds follow the selected role
  - Pareto only keeps the frontier's points
- [ ] `models-section.test.tsx`, extended (fake daemon routes for `/models`, `/models/picks`, `/accounts`):
  - Chart lists "Who each role gets" with each role's pick
  - choosing an account asks `/models/picks?account=`
  - selecting a role marks it pressed (`aria-pressed`)
  - no account gives the add-an-account line
  - the AA credit link is present

**Docs (this task):**

- `docs/architecture/decisions/2026-11-12-the-models-page-shows-the-routers-own-picks.md`, which records:
  - the picks come from `chooseModel` on the daemon, Automatic at `ROLE_NEED`, with role settings, patterns,
    floors and ceilings left out and the panel saying so
  - the Pareto line and the area are presentation, so they are computed in the desktop
  - cost per account is the router's own rule (`costOnAccount`)
- `apps/desktop/AGENTS.md`: rewrite the Settings › Models and benchmarks paragraph for both views.
- `apps/daemon/AGENTS.md`: if it lists the model routes, add `?account=` and `/models/picks`.

**Commit:** `feat: the models page charts intelligence against cost per task with each role's pick` (with value
cards).

---

## After both tasks

- Run `pnpm dev:factory` in `apps/desktop` (UI on `localhost:1420` against the real daemon; ask the builder to
  free 1420 first) and click through the Table (expand a row, the Columns menu, Available on with an account) and
  the Chart (a role selected, Pareto only). Take screenshots for the PR.
- An adversarial code review (the code-reviewer agent; round 1 lists everything, at most two fix rounds).
- `make gate` → `GATE PASS`. Rebase on `origin/main` once #585 has merged (asks first), then open the PR to `main`.

---

## Changes from plan review (these override the tasks above)

1. **The Chart and the picks always price on the same account.** Entering Chart with Available on at Any account
   sets the shared filter to the default account (else the first live supported account), so `useModels` and
   `useModelPicks` both ask with that account. While `useModels` shows placeholder data from another account, no
   rings are drawn. Section test: open Chart with no filter, and it asks `/models?account=<default>`.
2. **A ring only circles a point that is drawn.**
   - Points carry `profileId`.
   - Rings are looked up among the drawn points only.
   - In Pareto only, the picks' own points stay drawn.
   - The area's right edge uses drawn picks only.
   - The panel says "Not on the chart" for a pick with no drawn point: unmeasured, a cost of 0, or hidden by a
     filter.
   - Add `rightsizing-series` rows for each of these cases.
3. **Picks use what a project with no settings of its own gets.** The inputs are:
   - the global role settings and global patterns (`projectId: null`; project ones dropped)
   - the role's default persona, chosen as `planSteps.personaFor` does with no bindings: `DEFAULT_PERSONA_FOR[role]`
     among live personas, else the first live persona of the role
   - `project: { id: null, budgetCeiling: null }`, with no risk tags

   The footnote reads "What a task with no risk tags gets on this account with no project settings: project role
   settings, project patterns, risk floors and budget ceilings can change it." The Plan row's footnote says a Plan
   conversation picks by the role's default effort, not by score.
4. **Invalidation.** Picks live under `modelKeys.all`, and `account`, `role_setting`, `pattern` and `persona` events
   also invalidate `modelKeys.all` (`apps/desktop/src/daemon/events.ts`). Add a row to its table test if one exists.
5. **Archived or unknown account.** Both routes refuse an archived account explicitly with a 404; `getAccount`
   only throws for unknown ids. The account's kind type already limits it to kinds 10db can run, so no kind check is needed. The
   chart's account select lists live, supported accounts only. Test archived and unknown on both routes.
6. **Plan accounts say what the number is.** On an account with no per-token price (Claude subscription,
   ChatGPT/Codex sign-in, a gateway without catalogue prices), the Cost per task header tooltip and the chart's X
   label say "at the maker's API list price; this account has no per-token price". With no account chosen, they
   say "at the maker's API list price". In the parity table, `claude_signin` reads `claude_subscription`. A
   gateway override launched as named has a null `profileId`, and the panel lists it as not on the chart.
7. **Pick DTO.**
   - `RolePickDto` adds `intelligence` and `costPerTaskUsd` (from `costOnAccount`, null when unknown).
   - A `ModelChoice` whose `model` is a tier name (`isModelTier`) becomes `model: null`, with routing's reason.
   - A `NoProfileError` pick keeps routing's message and adds "; a task planned on this account is refused here".
8. **Smaller points.**
   - Efforts tie on Intelligence by the cheaper cost, then the higher effort; unscored efforts go last, highest
     effort first.
   - An offered model whose listed efforts match no profile has `efforts: []`, and its cells show the dash.
   - Rename `costAccount` to `account`.
   - The Columns menu's `useDataTableColumns` state lives in the section, which passes it to the table; the menu
     is hidden in Chart view.
   - `rowExpansion` uses `trigger: 'never'` with controlled `expanded`; the chevron stops propagation.
   - Need lines that coincide merge into one line labelled `Plan review, Review 48`.
   - The Y axis is `auto`, floored at 0.
   - A `ReferenceArea` on the log axis leaves `x1` unset.
   - The `useModels` signature change updates its callers: `views/shape/model-picker.tsx`,
     `views/settings/accounts/tier-overrides.tsx` and `views/settings/model-setting-select.tsx`, which pass `null`.
   - Fixtures gain the new fields: `apps/desktop/src/test/model-fixtures.ts` and
     `packages/contracts/src/catalogue.test.ts`.
   - Task 1 rewrites the table part of the desktop AGENTS.md paragraph. `apps/daemon/AGENTS.md` line 86 lists
     the model routes; update it.
   - `sync.test.ts` needs no change: AA sync is untouched.
9. **Tests.**
   - `role-picks.test.ts` asserts literal picks over `testCatalogue()` (qa→mid@low, implement→mid@high,
     plan→mid@high, plan_review and review→big@high; check these against the catalogue). It also covers a
     disabled or untiered profile, a global role setting, a persona pin and a tier override.
   - The picks API test seeds invented measurements so one case picks by score.
10. **Value cards** (one per behaviour, in the commit):
    - `costOnAccount`: protects=a task's cost on an account is the maker's scaled by the account's own output
      price; fails_when=the scale or a fallback changes; why_new=the router's budget tests reach it only through
      the ceiling; no_claim=AA's figure is right.
    - Rows' efforts and account pricing: protects=each row lists its efforts and its cost on the chosen account;
      fails_when=a row mixes efforts or ignores the account; why_new=model-rows tests cover only the merged row;
      no_claim=the desktop draws it.
    - `rolePicks`: protects=the page circles what routing chooses; fails_when=picks diverge from chooseModel's
      inputs; why_new=nothing exposed picks before; no_claim=floors or ceilings of a real task.
    - `paretoFrontier`: protects=the frontier line; fails_when=a dominated point is kept or a frontier point
      dropped; why_new=new rule; no_claim=drawing.
    - `rightsizing-series`: protects=lines, rings and area match the picks and the drawn points; fails_when=a ring
      lands on an undrawn point; why_new=new rule; no_claim=recharts renders it.
    - Section: protects=table and chart views over the real queries; fails_when=account, columns or expansion
      wiring breaks; why_new=new views; no_claim=pixels (the click-through covers them).

## How it is built

One implementer builds both tasks on this branch, in one or two commits per task, then one code review, at most
one fix round, the click-through, `make gate` and one PR.
