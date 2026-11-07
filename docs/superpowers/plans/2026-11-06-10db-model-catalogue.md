# Model catalogue implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 10db knows every model an account can run, what each is good for and what it costs, routes work by tier with no
model hard-coded, and shows it all in one list.

**Architecture:** A daemon `catalogue` module fetches models.dev and derives tiers from price. Account lists arrive through
the existing identity probe. `model_profiles` is the one store, and new rows stay disabled until routing moves in Task 9, so Tasks 1 to 8 change nothing about how work runs. A single `chooseModel` applies task, pattern, role and
default settings, then the existing router picks inside that pool. The launcher resolves the choice for the account.

**Tech Stack:** TypeScript, Hono, Drizzle on SQLite, zod, React with Mantine, Vitest, Playwright, Tauri 2.

**Spec:** `docs/superpowers/specs/2026-11-06-10db-model-catalogue-design.md`. Read it first, including its Decisions from review.

**How it is built:** one pull request in one fresh Claude session, outside 10db, with 10db not running. Sub-agents are
allowed. One commit per task. Branch from current `origin/main` in a new worktree:
`git worktree add ../10db-worktrees/model-catalogue-build -b feat/model-catalogue origin/main`.

## Global Constraints

- Read `AGENTS.md`, `.claude/rules/code-style.md`, `.claude/rules/testing.md` and each touched directory's `AGENTS.md`.
- No model ID, alias or price in non-test source, except Claude Code's own alias vocabulary and the one frozen migration.
- No Artificial Analysis number in the repo, fixtures or docs. Slugs and field names only.
- No TypeScript `enum`, no `any`, no `as` outside a validated boundary, no non-null `!`, no versions in names.
- zod at every boundary. A catalogue entry that fails is skipped; a catalogue that fails as a whole is rejected.
- Migrations are forward-only: `pnpm --filter @10db/db generate`, and `--custom` for hand SQL. Generated files are never
  edited by hand.
- Tests and the gate never reach the network.
- Commits are Conventional Commits, single-quoted, naming every path: `git add a b && git commit -m '...'`.
- Run only the changed packages' checks per task. Run `make gate` once, at the end. See Test strategy.
- Tier cuts: Strongest is 30% or more of the top output price; Fast is 10% or less.
- Provider names, copy and the word "pattern" follow the spec.

## Test strategy

From session `10db-66`, which owns the CI and test work on branch `ci/split-gate-into-required-jobs`, on 2026-11-06. These are
its measurements and advice. `.claude/rules/testing.md` is unchanged and still binds this build, including "a real git repo".

- Count isn't the cost. Table rows and pure tests are nearly free, so prefer them. A fake child process is fine.
- The expensive thing is the real pipeline: about 33 git subprocesses per runner step, `createTestEngine`, `createDeliveryHarness`
  and `drizzle-kit` spawns. Don't build one per case for decision logic. Task 9's tables call `chooseModel` directly, and Task 10
  adds at most a few full-pipeline cases.
- Keep new tests in milliseconds each unless they need real git or a process.
- Desktop: use `renderWithDaemon`, not `renderApp`, for one component.
- Add to `tests/repo` only with no process spawn per row, and to e2e only for what jsdom can't show.
- Keep test files focused, because a file can't be split across CI shards. Don't grow `runner.test.ts`, which is due to be split:
  put Task 10's tests in new files.

CI now runs separate required checks instead of one `gate` job, and pre-push runs a pre-check rather than the tests. Read
`CONTRIBUTING.md` for the current flow. `make gate` still prints the final result.

`apps/desktop/e2e/loop.spec.ts:469` fails every time on macOS on clean `main` at 309f610, with a strict-mode error on two `Withdraw…`
dropdowns, and passes on Linux CI. So a local `make gate` fails at e2e whatever you do. If that's the only failure, take Linux CI
as the result, and say so in the PR. Don't fix it here: `10db-66` is likely to.

## Review Focus

1. A model with a price of zero or no output price: it is Unknown, never Fast. Pinned in Task 4.
2. Two accounts offering one model under different IDs, as Bedrock does: one row in the list, two launch IDs. Pinned in
   Task 5.
3. An old workstream whose steps still name `sonnet` after upgrade: it starts normally. Pinned in Tasks 9 and 10.
4. A pattern naming a model the account doesn't offer: the step falls back and says so, and the plan never throws. Pinned
   in Task 9.
5. Every model on an account Unknown: a card, not a crash loop. Pinned in Task 10.
6. A listed model that fails every launch, as Fable does on some Bedrock accounts: the step moves on. Pinned in Task 10.

---

### Task 1: Capture today's routing and run the stop checks

**Files:**

- Create: `apps/daemon/src/routing/routing-regression.test.ts`
- Create: `docs/architecture/research/spike-17-account-model-lists.md`

**Interfaces:**

- Produces: the table every later routing task must keep passing.

- [ ] **Step 1: Write the table test against today's code.** Use `planSteps` with an unconfigured Claude project, real seed
      profiles and `apps/daemon/test/catalogue.ts` measurements. One row per flow step role × risk tag (none, security,
      auth, migration), asserting `model` and `effort`. Add a second table with no measurements, for the role-default path.
- [ ] **Step 2: Run it and prove it can fail.** Run: `pnpm --filter @10db/daemon exec vitest run src/routing/routing-regression.test.ts`. Expected: PASS. Then change one
      value in `NEED`, confirm a row fails, and revert. This is a characterisation test, so this replaces red-first.
- [ ] **Step 3: Recheck the tier rule.** Fetch `https://models.dev/api.json` and confirm by hand that the rule gives Fable and
      Opus Strongest, Sonnet Balanced, Haiku Fast; Astra and Sol Strongest, Terra Balanced, Luna Fast.
- [ ] **Step 4: Run `supportedModels()` live** on the default Claude subscription, using a throwaway script that starts a query
      and calls it before any prompt, and on any Bedrock or gateway account available. Record `value`, `resolvedModel`,
      whether IDs join to models.dev, whether a concrete ID launches, and the `init.model` it reports, because a mismatch is
      `BillingRefused` at `claude-adapter.ts:704`. Write this to the spike file with no secrets.
- [ ] **Step 5: Stop if either check fails,** and bring the result to the builder. A kind with no `resolvedModel` doesn't stop
      the build: it takes the no-list rule.
- [ ] **Step 6: Commit** `test(daemon): pin today's routing before moving it off aliases`.

### Task 2: Contracts for models, settings and patterns

**Files:**

- Create: `packages/contracts/src/catalogue.ts`, `packages/contracts/src/catalogue.test.ts`
- Modify: `packages/contracts/src/steps.ts`, `index.ts`, `json-schema.ts`, `generated/`
- Modify: every step literal: `apps/daemon/src/routing/plan-steps.ts`, `step-flow.ts`, `ship.ts`, and desktop fixtures

**Interfaces:**

- Produces, in `catalogue.ts`:
  - `ModelTier = { Fast: 'fast', Balanced: 'balanced', Strongest: 'strongest' } as const` (moved from `catalogue.ts` in routing).
  - `ModelStatus = { Current: 'current', Superseded: 'superseded', Retired: 'retired', Unknown: 'unknown', NotRunnable: 'not_runnable' } as const`.
  - `ModelSetting`: a discriminated union on `kind`: `{ kind: 'automatic' }`, `{ kind: 'tier', tier: ModelTier }`,
    `{ kind: 'top_of_tier' }`, `{ kind: 'model', model: string }`.
  - `RoleSettingDto`: `{ role: StepRole, projectId: ProjectId | null, setting: ModelSetting }`.
  - `PatternMatch`: `{ roles: StepRole[], riskTags: RiskTag[], areas: string[], retryOnly: boolean }`; empty means any.
  - `PatternDto`: `{ id, projectId: ProjectId | null, name, match: PatternMatch, setting: ModelSetting, position: number }`.
  - `AccountModelDto`: `{ accountId, model, family, launchId, efforts: Effort[], unusable: boolean, lastSeenAt }`.
  - `ModelRowDto`: one row of the list: `{ model, name, maker, family, tier: ModelTier | null, status: ModelStatus, availableOn: AccountId[], providers: string[], inputPrice: number | null, outputPrice: number | null, intelligence: number | null, coding: number | null, outputTokensPerSecond: number | null, stepsRun: number, firstSeenAt }`.
  - `CatalogueStatusDto`: `{ fetchedAt, source: 'fetched' | 'stored' | 'snapshot', models: number }`.
- Modify: `WorkstreamStep` gains `setting: ModelSetting.nullable().default(null)`, so stored steps parse. Step literals set
  `setting: null`.

- [ ] **Step 1: Write failing tests** for `ModelSetting`, for `PatternMatch` defaults, and that a stored step with no `setting`
      parses to `setting: null`.
- [ ] **Step 2: Run:** `pnpm --filter @10db/contracts exec vitest run src/catalogue.test.ts`. Expected: FAIL at import.
- [ ] **Step 3: Implement the schemas** and run `pnpm --filter @10db/contracts generate`.
- [ ] **Step 4: Run the contracts tests, typecheck and lint.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(contracts): describe models, tiers, settings and patterns`.

### Task 3: Storage

**Files:**

- Modify: `packages/db/src/schema.ts`, `packages/db/src/store/model-profiles.ts`, `packages/db/src/index.ts`,
  `packages/contracts/src/model-profiles.ts`, `apps/daemon/src/routing/test-catalogue.ts`
- Create: `packages/db/src/store/account-models.ts`, `model-settings.ts`, and their tests, plus a generated migration

**Interfaces:**

- Modify: `ModelProfileDto` gains `maker`, `family`, `tier`, `status`, `inputPrice`, `outputPrice`, `releaseDate`, all nullable. Update
  `toDto` (`model-profiles.ts:35`) and fixtures in this task.
- Produces: `replaceAccountModels(ctx, accountId, models)`, `listAccountModels(db, accountId?)`, `markAccountModelUnusable(ctx, accountId, model)`,
  `listRoleSettings(db)`, `setRoleSetting(ctx, input)`, `listPatterns(db)`, `setPatterns(ctx, projectId, patterns)`, `upsertModelProfiles(ctx, rows)`.
  `replaceAccountModels` keeps `unusable` while the row's `launchId` and efforts are unchanged. The fetched catalogue lives in
  `app_settings` under `catalogue.document`.

- [ ] **Step 1: Write failing tests:** a real SQLite file in a temp directory; `replaceAccountModels` replaces rather than appends and keeps
      `unusable` for an unchanged row; role settings unique per role and project; patterns read in `position` order.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Add the columns and tables, and run `pnpm --filter @10db/db generate`.**
- [ ] **Step 4: Run the db tests, then every package's typecheck.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(db): store account models, role settings and patterns`.

### Task 4: Fetch the catalogue and derive tiers

**Files:**

- Create: `apps/daemon/src/catalogue/source.ts`, `tiers.ts`, `sync.ts`, `index.ts`, tests beside each
- Create: `apps/daemon/test/fixtures/catalogue.json`, a small fixture with real IDs and prices and no AA data
- Modify: `apps/daemon/src/daemon/start.ts`

**Interfaces:**

- Produces:
  - `parseCatalogue(raw: unknown): Catalogue`, where `Catalogue = { providers: Record<string, CatalogueProvider>, hash: string }`.
    `hash` covers IDs, prices, statuses and families only.
  - `deriveTiers(models: readonly CatalogueModel[], offered: ReadonlySet<string>): Map<string, { tier: ModelTier | null, status: ModelStatus }>`.
    Only offered models are ranked.
  - `createCatalogueSync({ state, clock, fetch, logger, snapshot, onChanged }): CatalogueSync` with `start`, `stop`, `sync`,
    `status`. `DaemonOptions` gains `catalogueSync: boolean`, false in test harnesses, because unlike AA's sync no key gates it. Modelled on `createBenchmarkSync`, with the same daily interval, backoff and `start` and `stop` shape. Only
    the providers `anthropic`, `openai`, `amazon-bedrock` and `openrouter` are stored.
- Consumes: `ModelTier`, `ModelStatus` (Task 2).

- [ ] **Step 1: Write the failing `deriveTiers` table.** Rows, from output prices: Fable 5.1 $50, Opus 5.5 $20, Sonnet 5.5 $10,
      Haiku 5.5 $0.50 give Strongest, Strongest, Balanced, Fast. Astra $50, Sol $20, Terra $12, Luna $1.20 give Strongest,
      Strongest, Balanced, Fast. Opus 5 at $25 beside Opus 5.5 at $20 is Superseded and doesn't set the top. An unoffered $100
      model doesn't set the top. One model fills every tier. No price, or a price of 0, is Unknown. A `status` of deprecated is Retired.
- [ ] **Step 2: Write failing `parseCatalogue` and sync tests:** a bad entry is skipped and counted; a non-object is rejected and the
      last good document stays; a failed fetch uses the stored copy, then the snapshot; an unchanged hash doesn't call `onChanged`;
      a changed hash does once.
- [ ] **Step 3: Run:** `pnpm --filter @10db/daemon exec vitest run src/catalogue`. Expected: FAIL.
- [ ] **Step 4: Implement.** Ranking uses the top price among current models from one maker, with `family` and `release_date`.
- [ ] **Step 5: Run again.** Expected: PASS.
- [ ] **Step 6: Commit** `feat(daemon): fetch a model catalogue and derive tiers from price`.

### Task 5: Account lists and model profiles, added beside today's

**Files:**

- Create: `apps/daemon/src/catalogue/join.ts`, `profiles.ts`, tests
- Modify: `apps/daemon/src/sessions/account-check.ts`, `claude-adapter.ts`, `codex-account-read.ts`, `codex-protocol.ts`,
  `apps/daemon/src/accounts/service.ts`, `preparer.ts`, `apps/daemon/src/daemon/start.ts`

**Interfaces:**

- Modify: `SeenAccount.models` becomes `readonly SeenModel[]`, with `SeenModel = { id: string, resolvedId: string | null, efforts: readonly Effort[] }`.
- Produces: `joinModel(id: string, provider: string, catalogue: Catalogue): CatalogueModel | null`, and
  `reconcileProfiles(ctx, catalogue): void`, which upserts `model_profiles` for every model an account offers, per effort, and
  keeps scores and step counts. `provider` is `providerOf(account.kind)`. Rows are written `enabled: false`, so nothing routes on
  them until Task 9, and seeds stay. Where a list reports no efforts, every `Effort` value is written. `onChanged` calls it, and so does
  a probe whose list changed. `preparer.ts:93` probes at most daily before a session, for the list refresh.
- Consumes: `replaceAccountModels`, `upsertModelProfiles` (Task 3), `deriveTiers` (Task 4).

- [ ] **Step 1: Write the failing `joinModel` table:** exact; normalised dots and hyphens; vendor prefix `anthropic/claude-sonnet`;
      Bedrock `us.anthropic.claude-opus-5-5` to canonical `claude-opus-5-5`; an unmatched name is null, with no fuzzy match.
- [ ] **Step 2: Write failing probe tests:** Codex drops the effort `ultra`; Claude's probe reads `supportedModels()` with the
      fake query; a probe with no list keeps the stored list and its `lastSeenAt`. Bedrock and a subscription offering the same
      model give one profile and two account rows. A non-Anthropic model on a Bedrock or gateway account is Not runnable and gets no
      routable profile. A model Codex marks `hidden` is left out.
- [ ] **Step 3: Run them.** Expected: FAIL.
- [ ] **Step 4: Implement.** An effort outside `Effort` is dropped. A probe that succeeds writes the list. With no list yet,
      `reconcileProfiles` uses the catalogue's models for that account's maker.
- [ ] **Step 5: Run the Task 1 table and the routing tests.** Expected: PASS, unchanged, because routing still reads the seeded rows.
- [ ] **Step 6: Commit** `feat(daemon): build model profiles from account lists and the catalogue`.

### Task 6: Artificial Analysis past Claude

**Files:**

- Modify: `apps/daemon/src/benchmarks/sync.ts`, `apps/daemon/src/daemon/start.ts`
- Create: `apps/daemon/src/benchmarks/slugs.ts`, test

**Interfaces:**

- Produces: `aaSlugFor(model: string, effort: Effort, listed: ReadonlySet<string>): string | null`: the model ID with dots as
  hyphens, then `-<effort>`, with `max` on the bare slug, and only if listed.
- Consumes: `onChanged` (Task 4). It calls `reconcileProfiles` first, then the AA sync. `aaFamily` stays for seeded rows until Task 9.

- [ ] **Step 1: Write the failing table:** `gpt-5.6-sol` at `high` gives `gpt-5-6-sol-high`; `claude-opus-5-5` at `max` gives
      `claude-opus-5-5`; a slug that isn't listed gives null. Use invented scores in sync tests.
- [ ] **Step 2: Add a failing sync test:** a catalogue change triggers one sync; while an offered model has no score, a daily sync
      still runs; with no key nothing is fetched.
- [ ] **Step 3: Run them.** Expected: FAIL.
- [ ] **Step 4: Implement,** and connect `onChanged` in `start.ts`.
- [ ] **Step 5: Run the benchmarks tests.** Expected: PASS.
- [ ] **Step 6: Commit** `feat(daemon): score every offered model and sync when the catalogue changes`.

### Task 7: The Models page

**Files:**

- Create: `apps/desktop/src/views/settings/models-section.tsx`, `models-section.test.tsx`, `model-drawer.tsx`
- Create: `apps/desktop/src/daemon/model-queries.ts`
- Modify: `apps/desktop/src/views/settings/section-body.tsx`, `sections.ts`, `apps/daemon/src/api/app.ts`, `api/services.ts`, `daemon/services.ts`, `apps/daemon/src/screens/render-access.ts`

**Interfaces:**

- Produces: `GET /models` returns `ModelRowDto[]`; `GET /models/status` returns `CatalogueStatusDto`. Both are named in
  `render-access`, as readable or refused, as a test there requires.
- Consumes: `ModelRowDto` (Task 2).

- [ ] **Step 1: Write failing tests:** the segmented control filters All, Fast, Balanced and Strongest; the account filter; sort by each
      column; no AA data shows a dash, never 0; Unknown marked and last; a model first seen in the last 7 days marked New; a row opens the drawer; the page credits Artificial
      Analysis and shows the catalogue's age. Use the Mantine MCP server for component props.
- [ ] **Step 2: Add a failing API test** with `app.request()`: rows join canonical profiles and account models, one row per model, and seeded
      alias rows aren't listed.
- [ ] **Step 3: Run them.** Expected: FAIL.
- [ ] **Step 4: Implement,** and set `planned: null` on `SettingsSectionKey.Models`.
- [ ] **Step 5: Run the desktop and daemon tests for these files.** Expected: PASS. Then look at the page in a browser against a
      dev daemon with real data, and check its tiers before moving on.
- [ ] **Step 6: Commit** `feat(desktop): list every reachable model with its tier, price and scores`.

### Task 8: Role settings, patterns and task overrides

**Files:**

- Create: `apps/desktop/src/views/settings/role-settings.tsx`, `patterns-section.tsx`, tests
- Modify: `apps/desktop/src/views/settings/section-body.tsx`, the task detail form, `apps/daemon/src/api/app.ts`,
  `apps/daemon/src/screens/render-access.ts`, `packages/contracts/src/entities.ts`, `packages/db/src/schema.ts`, the task store in
  `packages/db/src/store/`, `apps/daemon/src/team/seed.ts`, plus a generated migration for the task column

**Interfaces:**

- Produces: `GET` and `PUT /model-settings`, `GET` and `PUT /projects/:projectId/model-settings`; `TaskDto.modelSetting: ModelSetting | null`.
  One seeded pattern: name "High-risk work", match `riskTags: [security, auth, migration]`, setting `top_of_tier`. It's seeded once, under
  the app setting `patterns.seeded`, so a deleted pattern doesn't come back. Nothing reads these settings until Task 9.
- Consumes: `setRoleSetting`, `setPatterns` (Task 3).

- [ ] **Step 1: Write failing tests:** project forms render in `Team` and global forms in `PersonasAndFlows`; a role's dropdown offers
      Automatic, the three tiers and the models offered; a pattern saves and reloads in order; editing the seeded pattern isn't
      undone by a restart; a task's override saves.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** with plain forms: this isn't the agent profiles editor.
- [ ] **Step 4: Run the desktop and daemon tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: set a model by role, pattern and task`.

### Task 9: One place that chooses a model

**Files:**

- Create: `apps/daemon/src/routing/choose-model.ts`, `choose-model.test.ts`, `apps/daemon/test/seed-profiles.ts`, and a `--custom` migration
- Create: `packages/db/src/migrations-model-ids.test.ts`, the migration regression
- Modify: `apps/daemon/src/routing/plan-steps.ts`, `router.ts`, `role-defaults.ts`, `offered.ts`, `catalogue.ts`, `index.ts`, `test-catalogue.ts`
- Modify: `apps/daemon/src/team/steps.ts`, `team/seed.ts`, `apps/daemon/src/runner/runner.ts:758-770`, `apps/daemon/src/daemon/start.ts:1020-1040`, `apps/daemon/test/catalogue.ts`

**Interfaces:**

- Produces: `chooseModel(input: ChooseInput): ModelChoice`, with
  `ChooseInput = { def, persona, task, project, profiles, roleSettings, patterns, tierOverrides, stakes: { retry: boolean } }` and
  `ModelChoice = { profile, setting, reason, score, overBudget, pinned }`. Precedence: a persona pin, then task, project pattern, global
  pattern, project role, global role, then the default from `ROLE_DEFAULT`. A tier override swaps the tier's automatic choice only.
- Modify: `route()` and `roleDefault()` lose `provider`: `profiles` is already narrowed to the account by
  `offeredProfiles(profiles, accountModels)`, by model and effort, with `unusable` rows left out. The call sites that pass `provider` change
  with them: `plan-steps.ts:76`, `runner.ts:765`, `start.ts:1023` and `start.ts:1036`. The two `start.ts` calls use `chooseModel` for the Plan role.
- `roleDefault` reads `profile.tier` and takes the tier's cheapest; `top_of_tier` takes its most expensive; `strongerDefault` orders by output price, then
  effort. `escalated()` calls `chooseModel` with `retry: true` first, so a retry pattern fires, and only then `escalateStep`.
- Remove: `SEED_PROFILES`, `FAMILIES`, `MODEL_TIERS`, and `seedTeam`'s profile inserts. `reconcileProfiles` now writes `enabled: true`. Test harnesses
  call `seedProfiles(state)` from the fixture. `test/catalogue.ts` `BASE` is rekeyed to canonical IDs, because it silently skips unknown models.

- [ ] **Step 1: Write the failing precedence table,** one row per level, and a row where each setting names a model the account doesn't offer: the
      step takes the tier's automatic choice and says so, and never throws. Add a tier override row.
- [ ] **Step 2: Add failing rows:** `top_of_tier` picks the most expensive in the pool, Fable beside Opus; a default Strongest step with no scores picks
      Opus; a floor goes to the top of the tier; escalation goes to the top, then one tier up, and stops when none is stronger; a retry-only pattern fires
      on a retry; a ChatGPT account's profiles route with a project whose `provider` is `claude`; an over-budget choice behaves as it does today.
- [ ] **Step 3: Write the failing migration test.** Build a database at the previous migration with `model_profiles`, a `workstreams` row and step named
      `sonnet`, a persona pinned to `opus`, a `shapes.model` of `opus`, a `sessions` row, and `accounts.settings` holding `modelMap` and `aliases`. After
      migrating: the four aliases are `claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5` and `claude-fable-5-1` in `model_profiles.model`,
      `workstreams.model`, each step's `model`, `model_pin` and `shapes.model`. Both settings keys are gone, the other keys stay, a profile's scores and
      step counts survive, and the Fable row is `enabled`. Check every `model` column in `schema.ts` (lines 495, 555, 950, 1074, 1110) and decide each: rows
      that record history stay as written.
- [ ] **Step 4: Run them.** Expected: FAIL.
- [ ] **Step 5: Implement,** with `drizzle-kit generate --custom` for the migration, using `json_remove` and `json_each`. Update Task 1's table to
      canonical IDs without changing what each row chooses, and list the seeded pattern's security, auth and migration rows as the one intended change.
      Its diff must show only those.
- [ ] **Step 6: Run the routing, team and db tests, then every package's typecheck.** Expected: PASS.
- [ ] **Step 7: Commit** `feat(daemon): choose a step's model from settings, patterns and tier`.

### Task 10: Launch, moves, refusal and Plan

**Files:**

- Create: `apps/daemon/src/runner/resolve-step.ts` and tests in new files; don't grow `runner.test.ts`
- Modify: `apps/daemon/src/environment/launch.ts`, `apps/daemon/src/runner/runner.ts:1438`, `apps/daemon/src/daemon/start.ts:1051`, `area-namer.ts`
- Modify: `packages/db/src/store/workstreams.ts:174`, `apps/daemon/test/fixtures.ts:306`, `engine.ts:379`, `apps/daemon/src/sessions/account-check.ts`
- Modify: `packages/contracts/src/shape.ts:303`, `apps/daemon/src/shape/service.ts:940`, `apps/desktop/src/views/shape/model-picker.tsx`, `shape-view.ts:157`

**Interfaces:**

- Modify: `Launcher.session(account, model: string, accountModels: readonly AccountModelDto[]): SessionLaunch`. It launches the row's `launchId`, or the
  canonical ID when there is no row. `ANTHROPIC_DEFAULT_<ALIAS>_MODEL` is generated from the newest offered model in family `claude-<alias>`.
- Produces: `resolveStep(step, account, profiles, accountModels): WorkstreamStep`, called at `runner.ts:1438` for every session start, so a move part way
  through a step is covered. A planned model the account offers is kept; otherwise `step.setting` is re-resolved, the reason says so, and the result is saved.
- Modify: `NAMING_MODEL` becomes `ModelTier.Fast`, resolved per account. `UNPLANNED_MODEL` is removed: `first` is required, and fixtures with empty
  steps pass one. `modelMatches` compares the reported model against `launchId`, using Task 1's `init.model` finding.
- Modify: `ShapeModelAlias` becomes `ShapeModel`, any model ID. `agentModels` stays Claude Code's aliases from `SHAPE_AGENT_MODELS`, so
  `confinement.ts:247` and `policy.ts:192` stay true. The picker lists the account's models, grouped by tier.

- [ ] **Step 1: Write failing tests:** a Bedrock account launches `us.anthropic.claude-opus-5-5` and a subscription its own ID; a ChatGPT account launches a
      real model for every tier with no map; an old step naming a migrated ID starts; a Plan conversation picks a concrete model and its agents still run on aliases.
- [ ] **Step 2: Write the failing move tests:** a project moves between plan and start, and part way through a step; both re-resolve and persist.
- [ ] **Step 3: Write failing refusal tests:** a model refused at launch is marked unusable on that account until its list changes, a card is raised, and the
      step reruns on the tier's next model. An account whose models are all Unknown gets one card and no restart loop. Follow how the runner handles `account_refused`.
- [ ] **Step 4: Run them.** Expected: FAIL.
- [ ] **Step 5: Implement.**
- [ ] **Step 6: Run the daemon, desktop and contracts tests for these areas.** Expected: PASS.
- [ ] **Step 7: Commit** `feat: launch the account's own model and re-resolve after a move`.

### Task 11: Remove the map, ship the snapshot, finish

**Files:**

- Modify: `packages/contracts/src/accounts.ts`, `apps/desktop/src/views/settings/accounts/account-fields.tsx`, `account-form-values.ts`, `edit-account-form.tsx`
- Modify: `scripts/release/build-macos.sh`, `.github/workflows/release-dry-run.yml`, `release.yml`
- Create: `scripts/release/fetch-catalogue.mjs`, and a decision file in `docs/architecture/decisions/`, named by its build date and `models-come-from-a-catalogue`
- Modify: `docs/architecture/04-accounts.md`, `01-factory-loop.md`, `docs/architecture/open-questions.md`, `apps/desktop/src/views/settings/sections.ts`

**Interfaces:**

- Produces: `modelChoice` in account settings holds `tierOverrides: Partial<Record<ModelTier, string>>` and nothing else; `modelMap` and
  `aliases` are gone. The account drawer shows one dropdown per tier, default Automatic, from that account's list. A gateway with no list
  gets a text field per tier.

- [ ] **Step 1: Write failing tests:** a dropdown lists only what the account offers; an override wins over Automatic in `chooseModel`; a
      gateway with no list accepts a typed ID. Confirm `apps/daemon/test/catalogue.ts` no longer needs aliases.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement and delete** `ModelMapRows`, `modelMap` and `aliases`. A grep for `modelMap` in `apps` and `packages/contracts`
      must find nothing outside migrations.
- [ ] **Step 4: Add the snapshot.** `fetch-catalogue.mjs` writes the filtered document into the daemon bundle's resources during
      `build-macos.sh`, and fails the build if the fetch fails. It isn't committed; add its path to `.gitignore`. Local builds with no
      snapshot start from the stored copy.
- [ ] **Step 5: Write the decision file and docs,** and record the OpenAI AA slugs answer in `open-questions.md`. The AA consent row stays.
- [ ] **Step 6: Run `make gate`.** Expected: `GATE PASS`, or only the `loop.spec.ts:469` failure described under Test strategy, with Linux
      CI as the check on it.
- [ ] **Step 7: Live check:** `pnpm dev`, then confirm on the real ChatGPT account that the Models list shows its four models, and start one small
      Ampsio task on it with no fallback. It must run with no Model map.
- [ ] **Step 8: Commit** `feat: remove the model map` and open one PR, Conventional title `feat: 10db picks models from a live catalogue, with no map to maintain`.
