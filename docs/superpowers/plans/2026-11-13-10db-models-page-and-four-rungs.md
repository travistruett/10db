# 10db Models page redesign and four model rungs: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**

- **Four rungs.** 10db's three tiers become the four rungs both makers' lines now have: Efficient, Balanced,
  Capable, Frontier.
  - Efficient is Haiku and Luna, Balanced is Sonnet and Terra, Capable is Opus and Sol, Frontier is Fable and Astra.
  - These are the makers' own words. Anthropic says "lowest latency and price", "best combination of speed and
    intelligence" and "most capable". OpenAI says "most efficient", "balance intelligence and cost" and "most capable,
    flagship".
  - "Fast" goes, because a tier was always a price band, never a speed.
- **The page answers its question first.** Settings › Models and benchmarks opens on "Who each role gets". Then comes
  one chart of Intelligence against cost per task, then a calm table of all models. Detail lives in the drawer.

**Source:**

- The design review is `~/.gstack/projects/10db/designs/design-audit-20261112/design-audit-models-page.md`.
- The mockups are `mockups/direction-a-roles-first.png` and `direction-c-table-and-drawer.png`. The builder chose a
  hybrid: A's page, C's drawer and Used by column, and B's per-model line as the drawer's chart. Every number in the
  mockups is invented.
- The makers' wording comes from Anthropic's models overview and choosing-a-model pages, and OpenAI's models page.

**Tech Stack:** TypeScript, zod 4, Drizzle (SQLite), Hono, React 19, Mantine 9.8.0, mantine-datatable 9.4.0,
`@mantine/charts` 9.8.0.

**Base:** `origin/main` at 818d3644, which includes #585 and #588. One PR.

## Provider parity

The rungs are cut from each maker's own price ladder, so a Claude plan, Bedrock, an API key and a ChatGPT/Codex plan
all rank the same way: the maker's prices are the same on every account. Nothing per account changes.

The page's single Account select lists every live account. Each account kind behaves as #588 already made it:

- A plan says its costs are at the maker's list price.
- Bedrock, an API key or a gateway prices on its own list.
- An account whose list hasn't been read yet says so.

---

## Task 1: four rungs (contracts, catalogue, routing, migration, settings UI)

### Rung rule

`apps/daemon/src/catalogue/tiers.ts`, pure, with a table test. A ranked model's rung comes from its output price as a
share of its maker's top live output price:

| Rung | Rule |
|---|---|
| Frontier | the maker's top model: share 1, ties included |
| Capable | ≥ 0.4 |
| Balanced | ≥ 0.15 |
| Efficient | below 0.15 |

The rules for Superseded, Retired and Unknown stay as they are. Check the cut with an invented catalogue whose prices
follow both lines' published ladders:

- top 40; 20 is Capable, 10 is Balanced, 0.5 is Efficient
- top 40; 20 is Capable, 12 is Balanced, 1.2 is Efficient

### Contracts

- `ModelTier` becomes
  `{ Efficient: 'efficient', Balanced: 'balanced', Capable: 'capable', Frontier: 'frontier' } as const`.
  The old values are no longer valid input.
- This is a protocol change: bump `PROTOCOL_VERSION`, and record the decision.
- The `tierOverrides` keys in `accounts.ts` follow the enum.
- Regenerate `packages/contracts/generated/`.
- The guard that "a tier's name typed in an override field is refused" now checks the four names.

### Routing

- **Order:** `TIERS` lists the rungs weakest first: efficient, balanced, capable, frontier.
- **Role defaults** (`role-defaults.ts`): Plan, Plan review and Review are Capable/high; Implement is Balanced/high;
  QA is Efficient/medium.
  - A floored step's tier was Strongest and becomes **Capable** (`defaultTier`). The effort-up rule for floors is
    unchanged.
  - Why Capable: today Strongest's cheapest model (Opus) is what a default or floored step gets, and Capable keeps
    exactly that. Frontier is reached by score, by a setting, or by escalation.
- **Escalation:** `strongerDefault` climbs through the four rungs.
- **Nearest-tier fallback:** `tierPool` works over four rungs, with ties going to the stronger rung, as today.
- Grep every `ModelTier.Fast`, `.Strongest` and literal `'fast'` or `'strongest'` under `apps/daemon/src`. That covers
  `area-namer.ts` (`NAMING_MODEL`), `environment/launch.ts`, `runner/*`, `team/seed-patterns.ts`, `role-picks.ts`
  and `test-catalogue.ts`.
  - Naming areas uses Efficient where it used Fast.
  - Seeded patterns that named Strongest name Capable.
  - The invented test catalogue gets a Frontier model: `apex` is the maker's top, so it becomes Frontier. Re-check
    every literal expectation in the routing tests and update it where the rung moved, saying why in the commit.

### Migration

A `--custom` drizzle migration, `0067_four_model_rungs.sql`, written once by hand and never regenerated. It maps
stored values with SQLite's JSON functions, never by text replace on whole documents:

- `fast` becomes `efficient`, and `strongest` becomes `capable`. `balanced` is unchanged.
- **Tables:**
  - `model_profiles.tier`
  - `role_settings.setting` and `patterns.setting`, which are `ModelSetting` JSON: `$.tier` where `$.kind = 'tier'`
  - `tasks.model_setting`, the same shape
  - `workstreams.steps`, a JSON array. Each step's `setting.tier`, and a step whose `model` is a tier name, where
    nothing was offered.
  - `accounts.settings`: `$.tierOverrides.fast` and `$.tierOverrides.strongest` move to `.efficient` and `.capable`
  - `personas` or `shapes` columns that hold a `ModelSetting` or a tier name, if any. Grep `schema.ts` for `tier` and
    `ModelSetting`.
- The migration is checked by a test on a real SQLite file. The test seeds rows in the old shape (inserted by SQL at
  the migration before), runs the migration, and reads every row back.
- `startDaemon` re-derives profile tiers from the catalogue anyway. The migration still maps them, so no read sees an
  old value between the migration and the next reconcile.

### Desktop

- `TIER_LABEL` (`model-labels.ts`) gives Efficient, Balanced, Capable and Frontier.
- The tier filter, `model-setting-options.ts` groups (weakest first), the Plan model picker and `isPickableModel`
  callers all follow the enum.
- **Account overrides** (`accounts/tier-overrides.tsx`, `account-fields.tsx`, `account-form-values.ts`,
  `edit-account-form.tsx`): four fields, labelled `Efficient model`, `Balanced model`, `Capable model` and
  `Frontier model`.
- Fixtures: `test/model-fixtures.ts` and `test/shape-fixtures.ts`.

### Tests (red first)

- the `tiers.test.ts` table (the cut above, ties, a single-model maker is Frontier)
- `role-defaults` and `pools` tables for four rungs
- the migration test above
- the routing tests' updated expectations
- desktop: the overrides form shows four fields and saves `tierOverrides.frontier`; the tier labels table

**Commit:** `feat: models are ranked in four rungs, efficient to frontier, after the makers' own lines`.

---

## Task 2: the Models page redesign (desktop)

### Layout, top to bottom

One page; the Table | Chart switch goes.

1. **Header row.**
   - The title "Models and benchmarks".
   - On the right, one `Select` labelled Account. It lists live accounts and defaults to the default account, then
     the first live account. It replaces both the Available on filter and the chart's own account select.
   - A square `ActionIcon` (Tabler refresh, size 16, `variant="default"`) with a `Tooltip` placed left: "Fetch prices
     from models.dev and re-read every account's model list". It replaces the Refresh Models button and shows its
     loading state on the icon. A refresh error stays beside it.
   - The Columns menu sits beside it.
2. **One dimmed `xs` line under the title:** the catalogue line, then "Scores: Artificial Analysis". The link is the
   same `xs` size (fix `ExternalLink` sizing or pass `size`). The credit appears once on the page, which keeps AA's
   credit beside every view of its scores.
3. **"Who each role gets"** (`Title order={4}`-sized section heading).
   - A small table with columns Role, Needs, Model and effort, Cost per task, and Why.
   - A role whose pick is not drawn on the chart says so in Why.
   - Each row has an orange dot that matches its ring on the chart.
   - Clicking a row selects the role: the chart shows only its need line and ring, the other rows dim, and a second
     click clears it.
   - The footnote stays, shortened: "Automatic choice for a task with no risk tags, on a project with no settings of
     its own. Plan conversations pick by the role's default effort."
4. **"Intelligence and cost":** the chart, about 300 px tall, with the Every effort | Frontier only control on its
   right.
   - Every point is gray. Frontier points and the frontier line are blue. Picks have orange rings.
   - Need lines are dashed and labelled; coinciding needs merge.
   - **No tier colours and no legend.** The "strong enough and cheap" area goes too.
   - The tooltip is an opaque Mantine surface (`bg` body, border) above everything, naming the model, effort,
     Intelligence and cost.
   - The note under the chart: "Blue: the most Intelligence for its cost. Rings: each role's pick on this account. N
     efforts with no score yet are not drawn."
5. **"All models":** the table.
   - Columns:
     - Model: the name on one line, then the status as dimmed `xs` text, with New in blue. No badges, no ID line, no
       wrapping (truncate with a title).
     - Tier: dimmed text.
     - Intelligence.
     - Cost per task.
     - Used by: the roles whose pick is this model, in orange `xs`; empty otherwise.
     - Steps run.
   - Input, Output and Speed are off by default in the Columns menu.
   - Numbers are right-aligned with tabular figures. Model, Intelligence, Cost per task and Steps run sort; Tier keeps
     its header filter and Model its search.
   - **No row expansion.** A row click, or Enter on its name button, opens the drawer.
   - The Available on column and its filter are removed: the page's Account select narrows the list to what that
     account runs (`availableOn`).

### The drawer (`model-drawer.tsx`)

- **Header:** the name, the ID in dimmed monospace, and "· <Rung> tier".
- **"What each effort buys":** a small line chart of the model's efforts (cost on log x, Intelligence on y). The
  account's pick is ringed when a role uses this model.
- **An effort table:** Effort, Intelligence, Cost per task, Steps run, First pass.
- **"Offered by":** each account with its launch ID and own price ("Included in plan" for a plan). This is today's
  content, kept.
- Input and output price per 1M, and speed, as one dimmed line.

### Removed

The Table | Chart `SegmentedControl`, the chart's account select, the rights-area code, tier colours and the legend in
`rightsizing-series.ts`, the row expansion, and the Available on filter. Their tests go with them; the behaviour moves
to the new tests below.

### Tests (red first, `renderWithDaemon`)

Extend `models-section.test.tsx`; the rows below replace the removed views' tests:

- The page opens with "Who each role gets" above the model list.
- One Account select drives the rows and the picks (`/models?account=` and `/models/picks?account=`).
- The refresh icon has its tooltip label and posts `/models/refresh`.
- A row shows its status as text, and Used by names the roles.
- A row click opens the drawer with the effort table.
- Input, Output and Speed are hidden until the Columns menu shows them.
- Selecting a role marks it pressed and dims the others.

`rightsizing-series.test.ts` keeps its rows:

- the frontier
- rings only on drawn points
- the tick ladder
- the merged need lines

It drops the area and tier rows, and adds a row checking that every point is a single gray series plus the frontier.

### Docs

- `apps/desktop/AGENTS.md`: rewrite the Settings › Models and benchmarks paragraph, and the account overrides
  paragraph for four fields.
- `apps/daemon/AGENTS.md`: the tiers line.
- `DESIGN.md`: one line under Tables. A status is dimmed text after the name, never a pill, in a dense list.
- Decision records:
  - `docs/architecture/decisions/2026-11-13-models-are-ranked-in-four-rungs.md`. It records the rung names from the
    makers' words, the price-share cut, `strongest` mapping to `capable`, and Frontier being reached by score,
    setting or escalation, never by a default.
  - `2026-11-13-the-models-page-answers-who-each-role-gets-first.md`. It amends
    `2026-11-12-the-models-page-shows-the-routers-own-picks.md`: the area and the tier colours are gone.

**Commit:** `feat(desktop): the models page shows who each role gets first, then the chart and a calmer list`.

---

## How it is built

- One implementer, Task 1 and then Task 2.
- The coordinator runs a click-through on invented data (port 1421, branch daemon).
- Then one code review that lists everything, the fixes batched in one pass, and a second round only if needed.
- Then `make gate`, one PR, and a squash merge once CI is green (the builder asked for it to land overnight).

---

## Changes from plan review (these override Tasks 1 and 2 where they differ)

The governing rule: **no routing change except the split.** Capable plus Frontier is exactly today's Strongest,
Balanced is today's Balanced, and Efficient is today's Fast. Every default, floor, Top of tier, override, tier setting
and escalation picks the same model as today on every real ladder.

1. **Rung cut** (replaces the cut above). Today's limits stay:
   - Efficient: at most 0.1 of the maker's top live output price.
   - Capable: 0.3 or more.
   - Frontier: within the top band, at least 0.9 of the maker's top price, so two listings of one model at nearby
     prices stay together.
   - Balanced: the rest.

   tiers.test rows for each maker's real-shaped ladder (Claude: 40 top, 20, 10, 0.5; the existing "GPT line on
   models.dev prices" row: Astra 50, Sol 10, Terra 5) state each model's rung. The plan's earlier promise that "Sol
   is Capable" is withdrawn: rungs are price bands, and the page shows what the prices say. A one-model maker is
   Frontier.
2. **Floors and Top of tier keep today's model.**
   - A floored step's default rung is **Frontier** (`defaultTier(role, true)`); today it takes the top of Strongest,
     which is Frontier's model.
   - `top_of_tier`, when the step lands in Capable, takes the top model of Capable and Frontier together. This
     includes the seeded "High-risk work" pattern (`team/seed-patterns.ts`).
   - Correct the rationale and the decision: Frontier is reached by floors, Top of tier, score, setting and
     escalation.
3. **Overrides:** the migration copies `tierOverrides.strongest` into **both** `capable` and `frontier`, and the
   migration test checks both.
4. **Nearest rung:** `tierPool` takes the nearest **stronger** rung that has models, else the nearest weaker one. On
   three tiers this is today's rule, which breaks ties toward the stronger. Example: an account with Frontier and
   Efficient only, asked for Balanced, gets Frontier.
5. **Tests that can catch it** (replaces the tests list in Task 1):
   - Add choose-model and pools rows on real-shaped ladders: one Capable plus one Frontier; Capable empty; Frontier
     plus Efficient only.
   - Cover each case: default, floored, Top of tier, the override on a capable and a frontier landing, a tier
     setting, escalation, and the seeded pattern.
   - Each row asserts the same model today's code picks; check by running the row on `main` first.
   - No existing expectation changes unless the commit says why the old one was wrong.
6. **The column layout** is stored under a new key, `models-list`, so a stored layout from #588 doesn't keep the old
   columns.
7. `workstreams.model` (the column) is migrated too, where it holds `fast` or `strongest`.
8. Task 1 also updates `rightsizing-series.ts` and `model-order.ts` (`TIER_RANK`), which key by `ModelTier`.
   `router.ts`'s `shortfall: 'strongest'` is not a tier and is left alone.
9. **Docs** (Task 1): amend `2026-11-07-models-come-from-a-catalogue.md` (the cut) and
   `2026-10-28-routing-role-defaults.md` (the defaults) with the new decision record, not by editing them. The new
   decision records that stored Strongest settings become Capable. A scored step with a high need on a Capable
   setting no longer reaches Frontier; that is the one behaviour change.
10. **Task 2 details:**
    - The default sort is Intelligence, descending.
    - The page always has an account; with none live, it says "Add an account to see what each role gets" and lists
      no rows. A failed read for the account shows the daemon's message and Try Again (refetch). There is no "Show
      every account".
    - **Picks are violet**, not orange: DESIGN.md keeps orange for paused. That covers the dots, rings and Used by.
      Add the line "violet marks a role's pick in Settings › Models" to DESIGN.md.
    - The refresh `ActionIcon` has `aria-label="Refresh Models"`; its test finds it by role and name.
    - The chart tooltip is a `bg_1` surface with a `bg_2` border, above the plot.
    - Input, Output and Speed live in the drawer only. With nothing left to toggle, this page has no Columns menu.
11. **Value cards** (one per behaviour, in the commit):
    - Rung cut: protects=a model's rung is its price band; fails_when=a limit or the top band moves;
      why_new=tiers.test covers 3 bands; no_claim=the makers rank them so.
    - Routing on four rungs: protects=every default, floor, Top of tier, override and escalation picks today's model;
      fails_when=the split changes a pick; why_new=existing rows use a ladder where the split is invisible;
      no_claim=scored picks above a Capable setting.
    - Migration 0067: protects=stored tier values still parse and mean the same; fails_when=a column or key is
      missed; why_new=new migration; no_claim=values written by older builds after upgrade.
    - Four override fields: protects=each rung's override saves and shows; fails_when=a field is lost;
      why_new=three fields today; no_claim=the gateway text-field path's wording.
    - Page layout: protects=roles first, one account, list, drawer; fails_when=the account, picks, refresh or drawer
      wiring breaks; why_new=the layout is new; no_claim=pixels, which browser QA covers.

## How it is built (replaces the section above)

- One implementer runs Task 1 then Task 2, one commit each.
- The coordinator then runs **full browser QA** on invented data:
  - every state: roles, chart, Frontier only, a selected role, the drawer, account switching, loading, error, no
    account
  - dark and light themes
  - widths 1440, 1100 and 900
- QA findings are fixed in one batch and re-checked in the browser.
- Then a code review that lists everything, with fixes batched (and a second round only if needed), `make gate`, one
  PR, and a squash merge once CI is green.
