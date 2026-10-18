# 10db M2a Teams and Right-Sizing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A workstream runs its task through a flow of steps (plan, plan review, implement, review, QA). Each step is run by a persona, on the cheapest model profile whose Artificial Analysis score meets the step's need, within the project's budget ceiling. A reviewer's rejection or a failed gate sends the work back one profile stronger, and inbox cards go to the person a routing rule names.

**Architecture:**
- **Data.** New tables hold the team and routing configuration: `personas`, `flows`, `people`, `team_bindings`, `team_members`, `routing_rules` and `model_profiles`, plus `aa_models`, a local copy of Artificial Analysis's model list. Projects gain a default flow and a budget ceiling in dollars per task, and tasks gain risk tags and an optional flow. A workstream stores its resolved step plan (`steps`) and its position in it (`step_index`).
- **Artificial Analysis (AA).** The builder's own free API key, kept in the Keychain, lets a daemon module fetch AA's free model list daily and on demand. It stores the list locally and copies each profile's scores (Intelligence, Coding and Agentic Index), cost per task and speed onto the matching profile by slug. The repo ships profile definitions and slugs only, never AA numbers (AA's Data Platform Terms §2.4).
- **Routing.** A pure `routing` module turns a flow, a task, the project's team and the profile catalogue into a step plan. It holds the floors, the router (each role compares the AA score that fits it) and escalation, and has no I/O.
- **Seeding.** The daemon seeds the catalogue definitions, the default flows, the default personas (read from `packages/harness/plugin/personas/`) and the builder as a person when it starts.
- **Runner.** The runner keeps one lane per workstream and walks the steps:
  - Read-only roles (plan, plan review, review, QA) get no write tools and a read-only shell. They end by calling a new MCP tool, `complete_step`.
  - An implement step ends as today, by ending its turn, and is then gated.
  - After a passing gate, the next step runs. A rejection sends the work back to the step it judged and escalates that step.
- **API and UI.** HTTP routes expose the configuration, the AA data and the step plan. The Factory view shows each workstream's current step. The editing UI and the AA chart are M2b.

**Tech Stack:** As in M1b. No new dependencies; the AA client uses Node's `fetch`.

**Spec:** `docs/superpowers/specs/2026-10-13-10db-factory-loop-design.md`. This plan implements:
- §4: the teams and routing tables, and the planning fields the open items list as missing.
- §5.2 points 3, 5 and 7: router, escalation, concurrency.
- §5.4 "Done means verified", with review steps.
- §7 routing: card owners.
- §11.3: default persona definitions, used for seeding.
- §13 M2: "router and `model_profiles`, personas, flows and teams, routing rules".
- §14: answers the open question "Whether Artificial Analysis data may be imported into `model_profiles`". Yes, as a per-user local import with the user's own key; never committed.

Not in M2a, by plan:
- **M2b** (the next plan, `07-m2b-board-and-batch`):
  - the board with drag and drop, and the derived Ready rule's "no open blocking card";
  - the picker and PM-agent review, which estimates each step's need and picks the flow's optional steps;
  - the batch approval sheet, which edits a step plan before start;
  - the consult step and ⌘K;
  - the Settings view, including the AA key field and the **Intelligence-vs-Cost frontier chart** with its Pareto line, axis picker, AA logo and source link.
- **M2c** (`08-m2c-takeover`): takeover and the PTY.
- **Already built:** the per-provider concurrency cap (§5.2.7) is `caps.perProvider` in the scheduler (`apps/daemon/src/daemon/start.ts`, default 4), so M2a doesn't touch it.

**Plan series:** `00-spikes`, `01-m0-scaffold`, `02-m1a-engine-core`, `03-m1b-sessions-and-ui`, `04-go-public`, `05-release`, **`06-m2a-teams-and-routing` (this file)**, then `07-m2b-board-and-batch` and `08-m2c-takeover`, not yet written. This plan was written against `main` at `e513535` and reviewed against it. Where a file, signature or anchor it names doesn't match the code on `main`, trust the code, adapt the step and say so in the task's report.

**AA research:** the API, free tier, terms and naming facts this plan relies on were gathered on 2026-10-17 from AA's OpenAPI spec (`https://artificialanalysis.ai/api/v2/openapi`), its Data Platform Terms v1.1 and its docs. In summary:
- `GET https://artificialanalysis.ai/api/v2/language/models/free` with header `x-api-key`. It is paginated (`pagination.has_more`), and the free tier allows 100 requests per fixed 24-hour window.
- Each entry has `slug`, `name`, `model_creator.name`, `release_date`, `evaluations.artificial_analysis_{intelligence,coding,agentic}_index` and six capability indexes, `artificial_analysis_intelligence_index_cost.cost_per_task.total_cost` in USD, `pricing.price_1m_{input,output}_tokens` and `performance.median_output_tokens_per_second`. The response's top level has `intelligence_index_version`. A null means "not measured".
- AA benchmarks each Claude effort level as its own entry. The slug is the family slug for `max` and `<family>-<effort>` otherwise; the API's slugs are assumed to match the website's, unverified without a key.
- Terms: local use with the user's own key is Internal Use. Raw data must never be redistributed, so nothing goes in the repo, fixtures, docs or release artifacts. Every chart needs AA's logo and a "Source: Artificial Analysis (artificialanalysis.ai)" link (§5.1). The website must never be scraped.

## New decisions

These are recorded in `docs/architecture/decisions.md` by Task 12, as rows 56 to 65. The code follows them from Task 1.

| # | Decision | Why |
|---|---|---|
| 56 | A model profile is provider, model alias and effort, plus its AA slug. Its scores (Intelligence, Coding and Agentic Index), cost per task (USD) and output speed come from the builder's own AA sync (decision 65); the repo ships profile definitions and slugs only. A profile the builder edits by hand becomes `manual` and the sync leaves it alone until the builder hands it back. | AA is the builder's source of truth, and AA's terms forbid committing its data. Editing by hand stays possible for a model AA hasn't measured. |
| 57 | Each role compares the score that fits it: plan, plan review and review use the Intelligence Index, implement uses the Coding Index, QA uses the Agentic Index. The router takes `minimum = max(step need, rule floor, persona minimum score)` and picks the enabled, measured profile of the project's provider whose score for the role is at least the minimum and whose cost per task is within the project's budget ceiling: cheapest first, then fastest, then lowest score. If none is within the ceiling, it picks the cheapest that meets the minimum and marks the step over budget; starting a task with an over-budget step is refused with the steps named. If no profile is measured at all for that score (no AA key yet), the step runs on the project's model and effort, pinned, and says why. A persona's model pin overrides the router, budget included, and a pinned step never escalates. | Spec §5.2.3 and decision 16; the per-role scores are the builder's choice. Refusing to start is the visible failure: running a step below its need would hide the problem, and silently overspending breaks the ceiling. The unmeasured fallback keeps 10db usable before the builder adds a key. |
| 58 | A flow is an ordered list of steps, each with a role, a need, optional skip rules and an optional persona. The skip rules are `unless_risk` (skip unless the task has one of the tags) and `unless_criteria_over` (skip unless the task has more acceptance criteria than the count). A step's persona overrides the team's binding for its role, so a flow can run two different reviewers. Three flows are seeded: `quick` (implement), `standard` (implement, review) and `full` (plan, plan review, implement, review, QA). A project defaults to `standard`; a task can name its own flow. | Spec §4 "ordered steps by role with skip rules". Declarative rules keep the picker's judgment (M2b) separate from what the flow requires; persona-per-step makes teams scale past one persona per role. |
| 59 | A workstream's step plan is resolved when the task starts and stored on the workstream. Each step holds its role, persona, profile (model and effort), score kind, need, why the profile was chosen, status, attempts, result and when it started. Later edits to flows, bindings or profiles don't change a running workstream; a persona's instructions are read when each session starts, so a fix applies to the next session. A handoff belongs to the step it was written in: a later step never continues from an earlier step's handoff. | The plan is what the builder approved (the M2b approval sheet edits it before start); instructions are guidance and should pick up fixes. A reviewer told to "continue from the handoff" of an implementer would do the wrong job. |
| 60 | Only implement steps write. Plan, plan-review, review and QA sessions get no file-writing tools in their allow list, and the guard denies `Edit`, `Write`, `MultiEdit` and `NotebookEdit`. Their shell is limited to read-only git verbs and a fixed list of read commands with no output redirection; the project's gate command is not in their allow list. `commit` refuses. They end by calling `complete_step` with their result; review roles must give a verdict (`approve` or `reject`). A session that ends its turn without calling it is nudged once; a second turn without it fails the workstream with a flag. | A reviewer that can edit stops being a reviewer, and the shared checkout's claims are the implementer's. A missing verdict must never read as approval. |
| 61 | The gate runs after every implement step. Steps after it run once the gate passes. The workstream is DONE when its last step completes, and the last implement step's gate passed. A read-only last step reaches DONE through VERIFYING without running the gate again, because the workflow has no RUNNING → DONE edge and read-only steps can't change the code. A rejection from plan review returns to the plan step; one from review or QA returns to the implement step, with the reviewer's notes. Every rejection and every failed gate counts against `maxFixAttempts` and escalates the step it returns to. | Spec §5.4 "Flows with review also need the reviewer's approval" and §5.2.5. |
| 62 | Escalation moves a step to the next profile up its own score: the cheapest enabled, measured profile of the same provider with a higher score for the step's role and a cost within the ceiling. When there is none, the step keeps its profile and the reason says so. | Spec §5.2.5 "one profile up the frontier". |
| 63 | Personas are database rows: `key`, `name`, `role`, `tools`, `instructions` (the persona prompt), `skills` (named craft skills the prompt points to), `minimumScore` (a floor for any step it runs), `modelPin` and `archived`. The defaults live in `packages/harness/plugin/personas/<key>.md`; the daemon inserts each one whose key is missing when it starts and never overwrites an existing row. Every save's event carries the previous instructions when they changed. The builder is seeded as the person with handle `me`. | Spec §11.3 and decision 15. The builder's edits win; a harness update reaches new installs; the event log keeps prompt history without a second table. `me` is the assignee every card already carries. |
| 64 | A routing rule maps a question category, optionally narrowed to one area, to a person. A card's assignee is the handle of the most specific matching rule (category and an area the work claims, then category alone), else `me`. Workstreams created before this plan (no stored steps) run as one implement step on their stored model and effort. | Spec §7 routing. The fallback keeps in-flight work running across the upgrade. |
| 65 | 10db reads AA's free model list with the builder's own key, from the macOS Keychain (service `10db`, account `artificial-analysis-api-key`). It syncs at start when the last successful sync is over 24 hours old, then daily, and on demand; a sync that fails, for any reason, records why and never stops the daemon. Every page is stored locally in `aa_models` (for M2b's chart) and matching profiles get their scores. A failed or rate-limited sync keeps the last data and reports why. AA data never leaves the machine: not in the repo, fixtures, docs, logs or release artifacts. Every view that shows it carries AA's logo and a "Source: Artificial Analysis" link. | AA's Data Platform Terms: Internal Use is allowed at every tier with attribution; redistribution and shared keys are not. The daily cadence stays far inside 100 requests a day. |

**Seed catalogue** (Task 5, `apps/daemon/src/routing/catalogue.ts`). Profile definitions only, with no scores. One profile per family and effort (`low`, `medium`, `high`, `xhigh`, `max`):

| Model alias | AA family slug | Enabled |
|---|---|---|
| `haiku` | `claude-haiku-5-5` | yes |
| `sonnet` | `claude-sonnet-5-5` | yes |
| `opus` | `claude-opus-5-5` | yes |
| `fable` | `claude-fable-5-1` | no: enable once Claude Code accepts the `fable` alias |

A profile's slug is the family slug for `max` and `<family>-<effort>` otherwise, so `opus`/`high` is `claude-opus-5-5-high`. AA benchmarked these with Anthropic's "default fallback" setting. Whether Claude Code's aliases run the same configuration is unverified, so Task 12 records it as an open item.

**Score kind per role:** plan, plan review and review use `intelligence`; implement uses `coding`; QA uses `agentic`.

**Default needs** (the seeded flows), in index points: plan 45, plan review 48, implement 40, review 48, QA 35.

**Floors** (Task 5, `routing/floors.ts`):

| Role | Task risk tag | Minimum, in the role's index points |
|---|---|---|
| `review`, `plan_review` | `security` or `auth` | 52 |
| `implement` | `migration` | 45 |

These needs and floors are 10db's starting heuristics, not AA data; the builder tunes them (spec §15).

## Global Constraints

Everything in M0's, M1a's and M1b's Global Constraints still applies. On top of that:
- **Branch:** `feat/m2a-teams-and-routing`, cut from `main`. Open a PR to `main` at the end; its title is a Conventional Commit.
- **Commits:**
  - Each commit is one command that names its paths: `git add <path> … && git commit -m '…'`.
  - The scope is one of `daemon`, `desktop`, `contracts`, `db`, `harness`, `repo`, `ci`, `docs`, `deps`. The subject is lowercase and the header is at most 100 characters.
  - Never `git add -A`, `git add .` or `git commit -a`.
  - Run `pnpm format` first. A failing hook leaves the paths staged: fix the cause and rerun the same line. Never `--no-verify` or `LEFTHOOK=0`.
- **Generated files** are regenerated, never edited: `pnpm --filter @10db/contracts generate` after a contracts change, `pnpm --filter @10db/db generate --name <name>` after a schema change. Commit the output with its source. Never edit or delete a migration (`packages/db/AGENTS.md`); a later fix is a new migration.
- **Contracts are additive** (`packages/contracts/AGENTS.md`). Adding fields to `ProjectDto`, `TaskDto` and `WorkstreamDto` and a `NextAction` kind is additive, so `PROTOCOL_VERSION` stays.
- **IDs** are minted only through `mintId`. New kinds: `Persona` (`per`), `Flow` (`flw`), `Person` (`psn`), `RoutingRule` (`rtr`), `ModelProfile` (`mpf`). `aa_models` is keyed by AA's slug, a natural key like `app_settings`.
- **Every state change writes its row and its event in one transaction** (`store.write`). Every new entity emits an event whose `entityType` the desktop's `INVALIDATIONS` maps (Task 11).
- **The routing module is pure.** `apps/daemon/src/routing/` imports only `@10db/contracts`: no `@10db/db`, no `node:*`, no clock. Its callers pass rows in.
- **AA data stays on the machine.**
  - Tests use synthetic scores and slugs, never AA's numbers.
  - Fixtures, docs, plan text and log lines name slugs and counts, never scores or prices.
  - The AA key is read from the Keychain when a sync starts, never stored, logged or sent anywhere but `artificialanalysis.ai`.
  - The network is the test boundary: the AA client takes an injected `fetch`.
- **No `as` casts, no `!`, no `any`** except at a validated boundary with a comment (`.claude/rules/code-style.md`). Exhaustive switches over `StepRole`, `ScoreKind`, `NextAction['kind']` and `SkipRule['kind']`.
- **Tests:**
  - Red first. Table-driven for the router, floors, skip rules, step moves and the read-only shell.
  - Real SQLite in a temp directory.
  - The fake adapter is the only Claude boundary (`.claude/rules/testing.md`). It picks a script by the prompt's `Task: <title>` line and the session's sequence, so every prompt keeps that line.
- **Tunable defaults** are named constants, never literals inside logic: the default needs, the floors, the score kind per role, `RESULT_NUDGE`, `MAX_STEP_SUMMARY = 8000` characters, `AA_SYNC_INTERVAL_MS = 24 h`, and `AA_FREE_MODELS_URL`.
- **knip:** an `index.ts` re-exports only what another module imports. A type the runner builds inline is not re-exported.
- **Comments never carry decision numbers** (`.claude/rules/code-style.md`). They say the why in words, or cite the spec (`spec §5.2.3`); the decision numbers live in this plan and `decisions.md`.

## Review Focus

These are the seven inputs or conditions most likely to bite a person, each with the task that pins it:
1. **A reviewer never gives a verdict.**
   - Case: the review session ends its turn, or crashes, without calling `complete_step`.
   - It is nudged once per session. A second turn without a verdict fails the workstream with a flag; it never reaches DONE.
   - Tests: Task 9 (`ends a review step that never gives a verdict as FAILED with a flag`).
2. **A reviewer keeps rejecting, or the gate keeps failing.**
   - Each one escalates the step one profile up its role's score and counts against `maxFixAttempts` (3). At the top, or at the ceiling, the step stays on its profile and the reason says so. After the limit the workstream is FAILED with a flag, and retrying it starts the step clean.
   - Tests: Task 5 (escalation table) and Task 9 (`fails after the fix limit…`, `retries a failed review cleanly`).
3. **The budget ceiling is below every profile that meets a step's need.**
   - Starting the task is refused with a 400 that names each over-budget step, its need and the ceiling. Nothing is queued.
   - Tests: Task 5 (router table) and Task 6 (`refuses to start a task whose step plan is over budget`).
4. **A read-only step tries to write.**
   - Case: a reviewer calls `Edit`, `Write` or `commit`, runs `echo x > f`, `sed -i`, `pnpm format` or the gate.
   - The guard denies file tools and any shell command outside the read-only list, `commit` refuses, and the allow list carries no write tool and no gate.
   - Tests: Task 8 (guard tables, allow-list table, `commit` refusal).
5. **The daemon restarts in the middle of a flow.**
   - Case: `kill -9` while a review step runs, or after the implement step handed off and the gate passed.
   - Recovery resumes the same step: `step_index`, the steps and a `revise` action survive in the row. A review that has to start fresh never inherits the implementer's handoff.
   - Tests: Task 9 (`resumes the step it was on after a crash`, `never gives a later step an earlier step's handoff`).
6. **No AA key, a failing sync, a rate limit, or a slug AA doesn't list.**
   - Without a key, 10db still runs: every step falls back to the project's model, the step's reason says why, and the sync status says "no key".
   - A 401, 429, network or database error keeps the last data and records the status; the sync never takes the daemon down. A profile AA doesn't list, or lists without a score or cost, stays unmeasured and is named in the status.
   - Tests: Task 5 (`falls back to the project's model when nothing is measured`) and Task 7 (sync table).
7. **Work that started before the upgrade.**
   - A workstream with no stored steps runs as one implement step on its stored model and effort, and finishes as before.
   - Tests: Task 1 (`currentStep` fallback) and Task 9 (`runs a workstream with no stored steps as one implement step`).

---

## File Structure

```
packages/contracts/src/
  states.ts            (+ StepRole, REVIEW_ROLES, ToolAccess, RiskTag, Verdict, StepStatus, ScoreKind,
                        ROLE_SCORE, ProfileSource)
  ids.ts               (+ Persona, Flow, Person, RoutingRule, ModelProfile)
  team.ts              PersonaDto/Input/Patch, PersonDto/Input, TeamDto/Input, RoutingRuleDto/Input
  flows.ts             SkipRule, FlowStepDef, FlowDto/Input/Patch
  model-profiles.ts    ProfileScores, ModelProfileDto, ModelProfilePatch
  benchmarks.ts        AaModelDto, BenchmarkStatusDto
  steps.ts             StepResult, WorkstreamStep, StepPlanDto, ROLE_LABEL, currentStep
  entities.ts          (+ ProjectDto.flowId/budgetCeiling, ProjectPatch, TaskDto.riskTags/flowId, TaskPatch,
                        WorkstreamDto.steps/stepIndex, NextAction 'revise')
  events.ts            (+ PersonaSaved, FlowSaved, PersonSaved, TeamSaved, RoutingRulesSaved,
                        ModelProfileSaved, BenchmarksSynced, ProjectChanged, StepChanged)
  mcp-tools.ts         (+ complete_step)
packages/db/src/
  schema.ts            (+ 8 tables; projects/tasks/workstreams columns)
  store/team.ts  store/flows.ts  store/model-profiles.ts  store/aa-models.ts  store/routing-rules.ts
  store/projects.ts (+ patchProject)  store/tasks.ts (+ patchTask)  store/handoffs.ts (+ latestHandoffForStep)
  store/workstreams.ts (+ steps, stepIndex)  store/inbox.ts (assignee)
packages/db/drizzle/   0006_teams_and_routing.sql, 0007_planning_fields.sql (generated)
packages/harness/plugin/personas/   planner.md plan-reviewer.md implementer.md reviewer.md qa.md
packages/harness/src/index.ts       (+ PERSONA_KEYS, readDefaultPersonas, PersonaManifestError)
apps/daemon/src/
  routing/             catalogue.ts floors.ts skip-rules.ts router.ts plan-steps.ts index.ts (+ tests)
  team/                seed.ts steps.ts step-flow.ts index.ts (+ tests)
  benchmarks/          aa-client.ts sync.ts index.ts (+ tests)
  environment/         (+ readAaKey from the Keychain)
  briefing/prompts.ts  guard/judge.ts guard/read-only.ts permissions/rules.ts mcp/tools.ts
  runner/runner.ts runner/next-action.ts recovery/recover.ts
  api/app.ts api/services.ts daemon/services.ts daemon/start.ts main.ts
apps/daemon/test/      engine.ts (+ plan option), api-client.ts (+ put, patch, quickFlowId)
apps/desktop/src/      views/factory/step-cell.tsx (+ test), factory-view.tsx, daemon/events.ts, test/fixtures.ts
apps/desktop/e2e/script-book.json   (+ the review session)
docs/architecture/decisions.md (+ 56–65)   docs/open-items.md   docs/architecture/open-questions.md
packages/harness/AGENTS.md   apps/daemon/AGENTS.md   README.md (AA attribution note)
```

---
### Task 1: Contracts for teams, flows, profiles, benchmarks and steps

New vocabularies and schemas, standalone: no existing type changes yet, so nothing downstream breaks.

**Files:**
- Modify: `packages/contracts/src/states.ts`, `packages/contracts/src/ids.ts`, `packages/contracts/src/events.ts`, `packages/contracts/src/index.ts`, `packages/contracts/src/json-schema.ts`
- Create: `packages/contracts/src/team.ts`, `flows.ts`, `model-profiles.ts`, `benchmarks.ts`, `steps.ts`
- Test: `packages/contracts/src/team.test.ts`, `flows.test.ts`, `steps.test.ts`
- Generated: `packages/contracts/generated/*.schema.json`

**Interfaces:**
- Produces (used by every later task):
  - Vocabularies:
    - `StepRole` (`plan | plan_review | implement | review | qa`) and `REVIEW_ROLES` (`plan_review`, `review`, `qa`).
    - `ToolAccess` (`read_only | edit`), `RiskTag` (`security | auth | migration | dependency`), `Verdict` (`approve | reject`) and `StepStatus` (`pending | running | done | failed`).
    - `ScoreKind` (`intelligence | coding | agentic`), `ROLE_SCORE: Readonly<Record<StepRole, ScoreKind>>` and `ProfileSource` (`aa | manual`).
  - IDs: `PersonaId`, `FlowId`, `PersonId`, `RoutingRuleId`, `ModelProfileId`.
  - Team schemas: `PersonaDto`, `PersonaInput`, `PersonaPatch`, `ModelPin`, `PersonDto`, `PersonInput`, `TeamBinding`, `TeamDto`, `TeamInput`, `RoutingRuleDto`, `RoutingRuleInput`, `RoutingRulesInput`.
  - Flow schemas: `SkipRule`, `FlowStepDef`, `FlowDto`, `FlowInput`, `FlowPatch`.
  - Profile and benchmark schemas: `ProfileScores`, `ModelProfileDto`, `ModelProfilePatch`, `AaModelDto`, `BenchmarkStatusDto`.
  - Step schemas and helpers: `MAX_STEP_SUMMARY`, `StepResult`, `WorkstreamStep`, `StepPlanDto`, `ROLE_LABEL`, `currentStep(ws: StepPosition): WorkstreamStep`. `StepPosition` is `{ steps: readonly WorkstreamStep[]; stepIndex: number; model: string; effort: Effort }`.
  - `EventType` additions: `PersonaSaved`, `FlowSaved`, `PersonSaved`, `TeamSaved`, `RoutingRulesSaved`, `ModelProfileSaved`, `BenchmarksSynced`, `ProjectChanged`, `StepChanged`.

- [ ] **Step 1: Write the failing tests**

`packages/contracts/src/flows.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { FlowInput } from './flows';

describe('FlowInput', () => {
  it.each([
    { name: 'a single implement step', input: { name: 'quick', steps: [{ role: 'implement', need: 40 }] }, ok: true },
    {
      name: 'steps with both skip rules and a named persona',
      input: {
        name: 'full',
        steps: [
          { role: 'plan', need: 45, skip: [{ kind: 'unless_criteria_over', count: 3 }] },
          { role: 'plan_review', need: 48, skip: [{ kind: 'unless_risk', tags: ['security'] }] },
          { role: 'implement', need: 40 },
          { role: 'review', need: 48, persona: 'security-reviewer' },
        ],
      },
      ok: true,
    },
    { name: 'no steps', input: { name: 'empty', steps: [] }, ok: false },
    { name: 'no implement step', input: { name: 'talk', steps: [{ role: 'review', need: 48 }] }, ok: false },
    {
      name: 'a review before any implement step',
      input: { name: 'backwards', steps: [{ role: 'review', need: 48 }, { role: 'implement', need: 40 }] },
      ok: false,
    },
    {
      name: 'a skip rule on the implement step',
      input: { name: 'skippy', steps: [{ role: 'implement', need: 40, skip: [{ kind: 'unless_risk', tags: ['auth'] }] }] },
      ok: false,
    },
    { name: 'a need above 100', input: { name: 'big', steps: [{ role: 'implement', need: 101 }] }, ok: false },
    {
      name: 'an unless_risk rule with no tags',
      input: {
        name: 'bare',
        steps: [{ role: 'implement', need: 40 }, { role: 'review', need: 48, skip: [{ kind: 'unless_risk', tags: [] }] }],
      },
      ok: false,
    },
    {
      name: 'a plan after the implement step',
      input: { name: 'late-plan', steps: [{ role: 'implement', need: 40 }, { role: 'plan', need: 45 }] },
      ok: false,
    },
    {
      name: 'a persona key with capitals',
      input: { name: 'caps', steps: [{ role: 'implement', need: 40, persona: 'Implementer' }] },
      ok: false,
    },
  ])('$name', ({ input, ok }) => {
    expect(FlowInput.safeParse(input).success).toBe(ok);
  });
});
```

`packages/contracts/src/team.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { mintId } from './ids';
import { PersonaInput, PersonInput, RoutingRulesInput, TeamInput } from './team';

const persona = {
  key: 'security-reviewer',
  name: 'Security reviewer',
  role: 'review',
  tools: 'read_only',
  instructions: 'Check trust boundaries.',
};

describe('team inputs', () => {
  it.each([
    { name: 'a persona with skills, a minimum score and a pin', parse: () => PersonaInput.safeParse({ ...persona, skills: ['review-checklist'], minimumScore: 52, modelPin: { model: 'opus', effort: 'high' } }), ok: true },
    { name: 'a persona with the defaults', parse: () => PersonaInput.safeParse(persona), ok: true },
    { name: 'a persona key with spaces', parse: () => PersonaInput.safeParse({ ...persona, key: 'Security Reviewer' }), ok: false },
    { name: 'a reviewer persona that can edit', parse: () => PersonaInput.safeParse({ ...persona, tools: 'edit' }), ok: false },
    { name: 'an implementer persona that is read-only', parse: () => PersonaInput.safeParse({ ...persona, role: 'implement' }), ok: false },
    { name: 'a minimum score above 100', parse: () => PersonaInput.safeParse({ ...persona, minimumScore: 101 }), ok: false },
    { name: 'a skill name with a slash', parse: () => PersonaInput.safeParse({ ...persona, skills: ['../etc'] }), ok: false },
    { name: 'a person handle with an at sign', parse: () => PersonInput.safeParse({ handle: '@sam', name: 'Sam' }), ok: false },
    {
      name: 'a team binding two personas to one role',
      parse: () => TeamInput.safeParse({ bindings: [{ role: 'review', personaId: mintId('Persona') }, { role: 'review', personaId: mintId('Persona') }], members: [] }),
      ok: false,
    },
    {
      name: 'routing rules with a duplicate category and area',
      parse: () => RoutingRulesInput.safeParse({ rules: [{ category: 'design', area: 'ui', personId: mintId('Person') }, { category: 'design', area: 'ui', personId: mintId('Person') }] }),
      ok: false,
    },
    {
      name: 'routing rules for one category with and without an area',
      parse: () => RoutingRulesInput.safeParse({ rules: [{ category: 'design', area: 'ui', personId: mintId('Person') }, { category: 'design', area: null, personId: mintId('Person') }] }),
      ok: true,
    },
  ])('$name', ({ parse, ok }) => {
    expect(parse().success).toBe(ok);
  });
});
```

`packages/contracts/src/steps.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { mintId } from './ids';
import { currentStep, WorkstreamStep } from './steps';

const base: WorkstreamStep = {
  role: 'review',
  personaId: mintId('Persona'),
  personaName: 'Reviewer',
  tools: 'read_only',
  score: 'intelligence',
  profileId: mintId('ModelProfile'),
  model: 'sonnet',
  effort: 'high',
  need: 48,
  reason: 'cheapest profile at or above 48',
  overBudget: false,
  pinned: false,
  status: 'pending',
  attempts: 0,
  startedAt: null,
  sessionFloor: 0,
  result: null,
};

describe('WorkstreamStep', () => {
  it.each([
    { name: 'a pending step', step: base, ok: true },
    {
      name: 'a review result with a verdict and the session that gave it',
      step: { ...base, status: 'done', result: { summary: 'Looks right.', verdict: 'approve', sessionId: mintId('Session'), at: '2026-10-17T12:00:00.000Z' } },
      ok: true,
    },
    {
      name: 'a summary over 8000 characters',
      step: { ...base, result: { summary: 'x'.repeat(8001), verdict: null, sessionId: mintId('Session'), at: '2026-10-17T12:00:00.000Z' } },
      ok: false,
    },
    { name: 'a negative attempt count', step: { ...base, attempts: -1 }, ok: false },
  ])('$name', ({ step, ok }) => {
    expect(WorkstreamStep.safeParse(step).success).toBe(ok);
  });
});

describe('currentStep', () => {
  it('runs a workstream with no stored steps as one pinned implement step on its own model', () => {
    expect(currentStep({ steps: [], stepIndex: 0, model: 'opus', effort: 'high' })).toMatchObject({
      role: 'implement',
      tools: 'edit',
      score: 'coding',
      model: 'opus',
      effort: 'high',
      pinned: true,
    });
  });

  it('returns the stored step at the index', () => {
    const implement: WorkstreamStep = { ...base, role: 'implement', tools: 'edit', score: 'coding' };
    expect(currentStep({ steps: [implement, base], stepIndex: 1, model: 'a', effort: 'low' })).toEqual(base);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @10db/contracts exec vitest run src/flows.test.ts src/team.test.ts src/steps.test.ts`
Expected: FAIL, because `./flows`, `./team` and `./steps` don't exist.

- [ ] **Step 3: Add the vocabularies, IDs and events**

In `packages/contracts/src/states.ts`, append:

```ts
/** The roles a flow step can have (spec §4 `flows`). */
export const StepRole = {
  Plan: 'plan',
  PlanReview: 'plan_review',
  Implement: 'implement',
  Review: 'review',
  Qa: 'qa',
} as const;
export type StepRole = ValueOf<typeof StepRole>;

/** Roles that judge work and must give a verdict; every role but implement is read-only. */
export const REVIEW_ROLES: readonly StepRole[] = [StepRole.PlanReview, StepRole.Review, StepRole.Qa];

export const ToolAccess = { ReadOnly: 'read_only', Edit: 'edit' } as const;
export type ToolAccess = ValueOf<typeof ToolAccess>;

/** Risks that raise a step's floor (spec §5.2: trust boundaries, migrations, auth). */
export const RiskTag = { Security: 'security', Auth: 'auth', Migration: 'migration', Dependency: 'dependency' } as const;
export type RiskTag = ValueOf<typeof RiskTag>;

export const Verdict = { Approve: 'approve', Reject: 'reject' } as const;
export type Verdict = ValueOf<typeof Verdict>;

/** A skipped step never enters a plan, so there is no skipped status. */
export const StepStatus = { Pending: 'pending', Running: 'running', Done: 'done', Failed: 'failed' } as const;
export type StepStatus = ValueOf<typeof StepStatus>;

/** The Artificial Analysis indexes a step can be measured against. */
export const ScoreKind = { Intelligence: 'intelligence', Coding: 'coding', Agentic: 'agentic' } as const;
export type ScoreKind = ValueOf<typeof ScoreKind>;

/** The score each role is routed on (the builder's choice): code is measured by coding, QA by agentic work. */
export const ROLE_SCORE: Readonly<Record<StepRole, ScoreKind>> = {
  plan: ScoreKind.Intelligence,
  plan_review: ScoreKind.Intelligence,
  implement: ScoreKind.Coding,
  review: ScoreKind.Intelligence,
  qa: ScoreKind.Agentic,
};

/** Where a profile's scores come from: the AA sync, or the builder's own numbers. */
export const ProfileSource = { Aa: 'aa', Manual: 'manual' } as const;
export type ProfileSource = ValueOf<typeof ProfileSource>;
```

In `packages/contracts/src/ids.ts`, add one entry to `ID_SCHEMAS`, one to `ID_PREFIX` and the exported pair per kind, following the existing pattern exactly:

```ts
// ID_SCHEMAS
  Persona: idSchema('per', 'PersonaId'),
  Flow: idSchema('flw', 'FlowId'),
  Person: idSchema('psn', 'PersonId'),
  RoutingRule: idSchema('rtr', 'RoutingRuleId'),
  ModelProfile: idSchema('mpf', 'ModelProfileId'),
// ID_PREFIX
  Persona: 'per',
  Flow: 'flw',
  Person: 'psn',
  RoutingRule: 'rtr',
  ModelProfile: 'mpf',
// exports, after the existing pairs
export const PersonaId = ID_SCHEMAS.Persona;
export type PersonaId = IdOf<'Persona'>;
export const FlowId = ID_SCHEMAS.Flow;
export type FlowId = IdOf<'Flow'>;
export const PersonId = ID_SCHEMAS.Person;
export type PersonId = IdOf<'Person'>;
export const RoutingRuleId = ID_SCHEMAS.RoutingRule;
export type RoutingRuleId = IdOf<'RoutingRule'>;
export const ModelProfileId = ID_SCHEMAS.ModelProfile;
export type ModelProfileId = IdOf<'ModelProfile'>;
```

In `packages/contracts/src/events.ts`, add to `EventType`, one per line:

```ts
  PersonaSaved: 'persona.saved',
  FlowSaved: 'flow.saved',
  PersonSaved: 'person.saved',
  TeamSaved: 'team.saved',
  RoutingRulesSaved: 'routing_rules.saved',
  ModelProfileSaved: 'model_profile.saved',
  BenchmarksSynced: 'benchmarks.synced',
  ProjectChanged: 'project.changed',
  StepChanged: 'step.changed',
```

- [ ] **Step 4: Write the schemas**

`packages/contracts/src/model-profiles.ts`:

```ts
import { z } from 'zod';
import { ModelProfileId } from './ids';
import { Effort, ProfileSource, Provider } from './states';

/** One Artificial Analysis index per score kind, 0–100; null when nobody has measured it. */
export const ProfileScores = z.object({
  intelligence: z.number().min(0).max(100).nullable(),
  coding: z.number().min(0).max(100).nullable(),
  agentic: z.number().min(0).max(100).nullable(),
});
export type ProfileScores = z.infer<typeof ProfileScores>;

/** One point on the model-and-effort frontier (spec §4 `model_profiles`). */
export const ModelProfileDto = z.object({
  id: ModelProfileId,
  provider: z.enum(Provider),
  model: z.string().min(1),
  effort: z.enum(Effort),
  /** The AA entry this profile is measured by; null for one AA doesn't list. */
  aaSlug: z.string().min(1).nullable(),
  scores: ProfileScores,
  costPerTaskUsd: z.number().nonnegative().nullable(),
  outputTokensPerSecond: z.number().nonnegative().nullable(),
  source: z.enum(ProfileSource),
  /** The AA Intelligence Index version the scores were measured on. */
  indexVersion: z.string().nullable(),
  measuredAt: z.iso.datetime().nullable(),
  enabled: z.boolean(),
  /** Observed: finished steps, steps that passed first time, and escalations away from this profile. */
  stepsRun: z.int().min(0),
  firstPassSteps: z.int().min(0),
  escalations: z.int().min(0),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ModelProfileDto = z.infer<typeof ModelProfileDto>;

/** Editing scores or cost makes the profile `manual` unless the patch names a source. */
export const ModelProfilePatch = z
  .object({
    enabled: z.boolean(),
    aaSlug: z.string().min(1).nullable(),
    scores: ProfileScores,
    costPerTaskUsd: z.number().nonnegative().nullable(),
    source: z.enum(ProfileSource),
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, { message: 'Change at least one field' });
export type ModelProfilePatch = z.infer<typeof ModelProfilePatch>;
```

`packages/contracts/src/benchmarks.ts`:

```ts
import { z } from 'zod';

/**
 * One model from Artificial Analysis's free list, as 10db stores it locally. It is shown
 * only with AA's attribution and never leaves the machine.
 */
export const AaModelDto = z.object({
  slug: z.string().min(1),
  name: z.string(),
  creator: z.string(),
  releaseDate: z.string().nullable(),
  indexVersion: z.string().nullable(),
  /** AA's evaluation indexes by their API name, e.g. `artificial_analysis_intelligence_index`. */
  evaluations: z.record(z.string(), z.number().nullable()),
  costPerTaskUsd: z.number().nullable(),
  pricing: z.record(z.string(), z.number().nullable()),
  performance: z.record(z.string(), z.number().nullable()),
  fetchedAt: z.iso.datetime(),
});
export type AaModelDto = z.infer<typeof AaModelDto>;

export const BenchmarkStatusDto = z.object({
  keyConfigured: z.boolean(),
  /** The last attempt, and the last attempt that stored data; the daily sync runs from the second. */
  lastSyncAt: z.iso.datetime().nullable(),
  lastSuccessAt: z.iso.datetime().nullable(),
  outcome: z.enum(['ok', 'no_key', 'unauthorized', 'rate_limited', 'failed']).nullable(),
  message: z.string().nullable(),
  models: z.int().min(0),
  /** Enabled profiles the last sync could not measure: AA doesn't list the slug, or lists it without a score or cost. */
  unmeasuredProfiles: z.array(z.string()),
});
export type BenchmarkStatusDto = z.infer<typeof BenchmarkStatusDto>;
```

`packages/contracts/src/flows.ts`:

```ts
import { z } from 'zod';
import { FlowId } from './ids';
import { RiskTag, StepRole } from './states';

/** A step is skipped unless its condition holds for the task. */
export const SkipRule = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unless_risk'), tags: z.array(z.enum(RiskTag)).min(1) }),
  z.object({ kind: z.literal('unless_criteria_over'), count: z.int().min(0) }),
]);
export type SkipRule = z.infer<typeof SkipRule>;

export const PersonaKey = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/, 'lowercase letters, digits and hyphens');

export const FlowStepDef = z.object({
  role: z.enum(StepRole),
  /** The score this step needs, in index points, before floors (spec §5.2). */
  need: z.number().min(0).max(100),
  skip: z.array(SkipRule).default([]),
  /** A persona for this step only, over the team's binding for the role. */
  persona: PersonaKey.nullable().default(null),
});
export type FlowStepDef = z.infer<typeof FlowStepDef>;

const FlowName = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/, 'lowercase letters, digits and hyphens');

/** Every flow implements; plans come before the first implement step, review and QA after it; implement is never skipped. */
const FlowSteps = z
  .array(FlowStepDef)
  .min(1)
  .superRefine((steps, ctx) => {
    const firstImplement = steps.findIndex((s) => s.role === StepRole.Implement);
    if (firstImplement === -1) {
      ctx.addIssue({ code: 'custom', message: 'A flow needs an implement step' });
      return;
    }
    steps.forEach((step, i) => {
      if (step.role === StepRole.Implement && step.skip.length > 0)
        ctx.addIssue({ code: 'custom', path: [i, 'skip'], message: 'An implement step is never skipped' });
      if ((step.role === StepRole.Review || step.role === StepRole.Qa) && i < firstImplement)
        ctx.addIssue({ code: 'custom', path: [i, 'role'], message: 'Review and QA come after implement' });
      if ((step.role === StepRole.Plan || step.role === StepRole.PlanReview) && i > firstImplement)
        ctx.addIssue({ code: 'custom', path: [i, 'role'], message: 'Plan and plan review come before implement' });
    });
  });

export const FlowInput = z.object({ name: FlowName, steps: FlowSteps });
export type FlowInput = z.input<typeof FlowInput>;

export const FlowPatch = z.object({ steps: FlowSteps });
export type FlowPatch = z.input<typeof FlowPatch>;

export const FlowDto = z.object({
  id: FlowId,
  name: FlowName,
  steps: z.array(FlowStepDef),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type FlowDto = z.infer<typeof FlowDto>;
```

`packages/contracts/src/team.ts`:

```ts
import { z } from 'zod';
import { PersonaKey } from './flows';
import { PersonaId, PersonId, ProjectId, RoutingRuleId } from './ids';
import { Effort, QuestionCategory, StepRole, ToolAccess } from './states';

export const ModelPin = z.object({ model: z.string().min(1), effort: z.enum(Effort) });
export type ModelPin = z.infer<typeof ModelPin>;

const SkillName = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/, 'a skill name: lowercase letters, digits and hyphens');

/** Implementers edit; every other role is read-only, so a reviewer never changes what it judges. */
const roleMatchesTools = (p: { role: StepRole; tools: ToolAccess }) =>
  (p.role === StepRole.Implement) === (p.tools === ToolAccess.Edit);
const ROLE_TOOLS = { message: 'Only an implement persona edits; every other role is read-only', path: ['tools'] };

export const PersonaInput = z
  .object({
    key: PersonaKey,
    name: z.string().min(1).max(80),
    role: z.enum(StepRole),
    tools: z.enum(ToolAccess),
    /** The persona prompt: how this persona works, sent with every session it runs. */
    instructions: z.string().min(1).max(8000),
    skills: z.array(SkillName).max(10).default([]),
    /** A floor, in its role's index points, for any step this persona runs. */
    minimumScore: z.number().min(0).max(100).nullable().default(null),
    modelPin: ModelPin.nullable().default(null),
  })
  .refine(roleMatchesTools, ROLE_TOOLS);
export type PersonaInput = z.input<typeof PersonaInput>;

export const PersonaPatch = z
  .object({
    name: z.string().min(1).max(80),
    instructions: z.string().min(1).max(8000),
    skills: z.array(SkillName).max(10),
    minimumScore: z.number().min(0).max(100).nullable(),
    modelPin: ModelPin.nullable(),
    archived: z.boolean(),
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, { message: 'Change at least one field' });
export type PersonaPatch = z.infer<typeof PersonaPatch>;

export const PersonaDto = z.object({
  id: PersonaId,
  key: PersonaKey,
  name: z.string(),
  role: z.enum(StepRole),
  tools: z.enum(ToolAccess),
  instructions: z.string(),
  skills: z.array(z.string()),
  minimumScore: z.number().nullable(),
  modelPin: ModelPin.nullable(),
  /** An archived persona stays so workstreams that ran on it still name it; no new plan, binding or flow step uses it. */
  archived: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type PersonaDto = z.infer<typeof PersonaDto>;

const Handle = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/, 'lowercase letters, digits and hyphens');

export const PersonInput = z.object({ handle: Handle, name: z.string().min(1).max(80) });
export type PersonInput = z.infer<typeof PersonInput>;

export const PersonDto = z.object({
  id: PersonId,
  handle: Handle,
  name: z.string(),
  /** The person running this app; cards nobody else owns go to them. */
  isBuilder: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type PersonDto = z.infer<typeof PersonDto>;

export const TeamBinding = z.object({ role: z.enum(StepRole), personaId: PersonaId });
export type TeamBinding = z.infer<typeof TeamBinding>;

export const TeamInput = z.object({
  bindings: z.array(TeamBinding).refine((b) => new Set(b.map((x) => x.role)).size === b.length, 'One persona per role'),
  members: z.array(PersonId).refine((m) => new Set(m).size === m.length, 'A member is listed twice'),
});
export type TeamInput = z.infer<typeof TeamInput>;

export const TeamDto = TeamInput.extend({ projectId: ProjectId });
export type TeamDto = z.infer<typeof TeamDto>;

export const RoutingRuleInput = z.object({
  category: z.enum(QuestionCategory),
  /** Narrows the rule to work that claims this area; null matches any area. */
  area: z.string().min(1).nullable(),
  personId: PersonId,
});
export type RoutingRuleInput = z.infer<typeof RoutingRuleInput>;

/** The project's whole rule list, replaced at once. */
export const RoutingRulesInput = z.object({
  rules: z
    .array(RoutingRuleInput)
    .refine(
      (rules) => new Set(rules.map((r) => `${r.category}\u0000${r.area ?? ''}`)).size === rules.length,
      'Two rules have the same category and area',
    ),
});
export type RoutingRulesInput = z.infer<typeof RoutingRulesInput>;

export const RoutingRuleDto = RoutingRuleInput.extend({
  id: RoutingRuleId,
  projectId: ProjectId,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type RoutingRuleDto = z.infer<typeof RoutingRuleDto>;
```

`packages/contracts/src/steps.ts`:

```ts
import { z } from 'zod';
import { ModelProfileId, PersonaId, SessionId } from './ids';
import { Effort, ROLE_SCORE, ScoreKind, StepRole, StepStatus, ToolAccess, Verdict } from './states';

/** Longest result a step may record: a plan or a review's notes. */
export const MAX_STEP_SUMMARY = 8000;

export const StepResult = z.object({
  summary: z.string().min(1).max(MAX_STEP_SUMMARY),
  verdict: z.enum(Verdict).nullable(),
  /** The session that recorded it, so a nudge knows whether this session has finished its step. */
  sessionId: SessionId,
  at: z.iso.datetime(),
});
export type StepResult = z.infer<typeof StepResult>;

/** One step of a workstream's resolved plan, fixed when the task starts. */
export const WorkstreamStep = z.object({
  role: z.enum(StepRole),
  personaId: PersonaId.nullable(),
  personaName: z.string(),
  tools: z.enum(ToolAccess),
  score: z.enum(ScoreKind),
  profileId: ModelProfileId.nullable(),
  model: z.string().min(1),
  effort: z.enum(Effort),
  need: z.number().min(0).max(100),
  /** Why this profile: the router's reason, a pin, a fallback or an escalation. */
  reason: z.string(),
  overBudget: z.boolean(),
  pinned: z.boolean(),
  status: z.enum(StepStatus),
  /** Times this step was sent back by a reviewer or failed its gate; 0 means it passed first time. */
  attempts: z.int().min(0),
  /** When the step last started, for display. */
  startedAt: z.iso.datetime().nullable(),
  /** Sessions the workstream had run when this step started; a handoff from one of them belongs to an earlier step. */
  sessionFloor: z.int().min(0),
  result: StepResult.nullable(),
});
export type WorkstreamStep = z.infer<typeof WorkstreamStep>;

/** What starting a task would run, before it runs (the M2b approval sheet edits this). */
export const StepPlanDto = z.object({
  flowName: z.string(),
  steps: z.array(WorkstreamStep),
  /** Steps whose need no profile within the budget ceiling meets; starting is refused while any remain. */
  overBudget: z.array(z.int().min(0)),
});
export type StepPlanDto = z.infer<typeof StepPlanDto>;

/** How a step with no persona is named. */
export const ROLE_LABEL: Readonly<Record<StepRole, string>> = {
  plan: 'Planner',
  plan_review: 'Plan reviewer',
  implement: 'Implementer',
  review: 'Reviewer',
  qa: 'QA',
};

export interface StepPosition {
  readonly steps: readonly WorkstreamStep[];
  readonly stepIndex: number;
  readonly model: string;
  readonly effort: Effort;
}

/** The step a workstream is on. One started before flows has none stored: it runs as one implement step. */
export function currentStep(ws: StepPosition): WorkstreamStep {
  const stored = ws.steps[ws.stepIndex];
  if (stored) return stored;
  return {
    role: StepRole.Implement,
    personaId: null,
    personaName: ROLE_LABEL.implement,
    tools: ToolAccess.Edit,
    score: ROLE_SCORE.implement,
    profileId: null,
    model: ws.model,
    effort: ws.effort,
    need: 0,
    reason: 'started before flows: runs on its stored model',
    overBudget: false,
    pinned: true,
    status: StepStatus.Running,
    attempts: 0,
    startedAt: null,
    sessionFloor: 0,
    result: null,
  };
}
```

The pre-flow fallback is `pinned`, so escalation never moves a step that has no profile.

- [ ] **Step 5: Export and register them**

In `packages/contracts/src/index.ts`, add `export * from './benchmarks';`, `export * from './flows';`, `export * from './model-profiles';`, `export * from './steps';` and `export * from './team';`.

In `packages/contracts/src/json-schema.ts`, add to `CONTRACT_SCHEMAS`, importing each from its file:

```ts
  'aa-model-dto': AaModelDto,
  'benchmark-status-dto': BenchmarkStatusDto,
  'flow-dto': FlowDto,
  'flow-input': FlowInput,
  'flow-patch': FlowPatch,
  'model-profile-dto': ModelProfileDto,
  'model-profile-patch': ModelProfilePatch,
  'person-dto': PersonDto,
  'person-input': PersonInput,
  'persona-dto': PersonaDto,
  'persona-input': PersonaInput,
  'persona-patch': PersonaPatch,
  'routing-rule-dto': RoutingRuleDto,
  'routing-rules-input': RoutingRulesInput,
  'step-plan-dto': StepPlanDto,
  'team-dto': TeamDto,
  'team-input': TeamInput,
```

- [ ] **Step 6: Run the tests and regenerate**

Run: `pnpm --filter @10db/contracts exec vitest run && pnpm --filter @10db/contracts generate && pnpm --filter @10db/contracts typecheck`
Expected: all tests pass; `generated/` gains the seventeen new `*.schema.json` files.

- [ ] **Step 7: Commit**

```bash
pnpm format && git add packages/contracts/src packages/contracts/generated && git commit -m 'feat(contracts): add personas, people, teams, routing rules, flows, model profiles and steps'
```

---
### Task 2: Tables and repositories for the team, flows, profiles and AA's model list

**Files:**
- Modify: `packages/db/src/schema.ts`, `packages/db/src/store/index.ts`
- Create: `packages/db/src/store/team.ts`, `flows.ts`, `model-profiles.ts`, `aa-models.ts`, `routing-rules.ts`
- Test: `packages/db/src/store/team.test.ts`, `packages/db/src/store/flows-profiles.test.ts`
- Generated: `packages/db/drizzle/0006_teams_and_routing.sql` and its snapshot

**Interfaces:**
- Consumes: Task 1's schemas and IDs.
- Produces:
  - Personas:
    - `insertPersona(ctx, input: PersonaInput): PersonaDto`, which throws `ConflictError` on a duplicate key.
    - `patchPersona(ctx, id: PersonaId, patch: PersonaPatch): PersonaDto`. Its event carries `previousInstructions` when the instructions change.
    - `getPersona(db, id)`, `findPersonaByKey(db, key)` and `listPersonas(db, opts?: { includeArchived?: boolean })`.
  - People: `BUILDER_HANDLE = 'me'`, `insertPerson(ctx, input: PersonInput & { isBuilder?: boolean }): PersonDto`, `getPerson(db, id)`, `findPersonByHandle(db, handle)` and `listPeople(db)`.
  - Teams:
    - `getTeam(db, projectId): TeamDto`.
    - `setTeam(ctx, projectId, input: TeamInput): TeamDto`. It replaces the bindings and members, and refuses an archived persona or one bound to a role it doesn't have.
  - Flows:
    - `insertFlow(ctx, input: FlowInput): FlowDto` and `patchFlow(ctx, id, patch: FlowPatch): FlowDto`. Both refuse a step persona that doesn't exist or plays another role.
    - `getFlow(db, id)`, `findFlowByName(db, name)` and `listFlows(db)`.
  - Model profiles:
    - `insertModelProfile(ctx, input: NewModelProfile): ModelProfileDto` and `findModelProfile(db, provider, model, effort)`.
    - `patchModelProfile(ctx, id, patch: ModelProfilePatch): ModelProfileDto` and `getModelProfile(db, id)`.
    - `listModelProfiles(db): ModelProfileDto[]`.
    - `applyAaMeasurement(ctx, id, m: AaMeasurement): boolean`, which writes only to an `aa` profile and returns whether it did.
    - `recordProfileOutcome(ctx, id, outcome: { firstPass: boolean; escalated: boolean }): void`.
  - AA models: `replaceAaModels(ctx, models: readonly AaModelDto[]): void` and `listAaModels(db): AaModelDto[]`.
  - Routing rules: `listRoutingRules(db, projectId): RoutingRuleDto[]` and `setRoutingRules(ctx, projectId, input: RoutingRulesInput): RoutingRuleDto[]`.

- [ ] **Step 1: Write the failing tests**

`packages/db/src/store/team.test.ts`:

```ts
import { ConflictError, EventType, InvalidError, type PersonaId } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listEventsAfter } from './events';
import { listRoutingRules, setRoutingRules } from './routing-rules';
import type { Store } from './store';
import {
  findPersonByHandle,
  findPersonaByKey,
  getTeam,
  insertPerson,
  insertPersona,
  listPersonas,
  patchPersona,
  setTeam,
} from './team';
import { createTestStore, seedProject } from './test-support';

let store: Store;
let close: () => void;
beforeEach(() => {
  ({ store, close } = createTestStore());
});
afterEach(() => {
  close();
});

const reviewer = {
  key: 'reviewer',
  name: 'Reviewer',
  role: 'review',
  tools: 'read_only',
  instructions: 'Review the change against the acceptance criteria.',
} as const;

describe('personas', () => {
  it('inserts with defaults, finds by key, patches, and keeps the previous prompt in the event', () => {
    const { value: persona, events } = store.write((ctx) => insertPersona(ctx, reviewer));
    expect(events.map((e) => e.type)).toEqual([EventType.PersonaSaved]);
    expect(persona).toMatchObject({ skills: [], minimumScore: null, modelPin: null, archived: false });
    expect(findPersonaByKey(store.db, 'reviewer')).toEqual(persona);
    const { events: saved } = store.write((ctx) =>
      patchPersona(ctx, persona.id, { instructions: 'Hunt for defects.', skills: ['review-checklist'] }),
    );
    expect(saved[0]?.data).toMatchObject({ previousInstructions: reviewer.instructions });
    expect(findPersonaByKey(store.db, 'reviewer')).toMatchObject({ instructions: 'Hunt for defects.', skills: ['review-checklist'] });
    expect(listEventsAfter(store.db, 0, 10).map((e) => e.type)).toEqual([EventType.PersonaSaved, EventType.PersonaSaved]);
  });

  it('refuses a second persona with the same key', () => {
    store.write((ctx) => insertPersona(ctx, reviewer));
    expect(() => store.write((ctx) => insertPersona(ctx, reviewer))).toThrow(ConflictError);
  });

  it('leaves archived personas out of the list unless asked', () => {
    const persona = store.write((ctx) => insertPersona(ctx, reviewer)).value;
    store.write((ctx) => patchPersona(ctx, persona.id, { archived: true }));
    expect(listPersonas(store.db)).toEqual([]);
    expect(listPersonas(store.db, { includeArchived: true }).map((p) => p.key)).toEqual(['reviewer']);
  });
});

describe('team', () => {
  it('starts empty, then replaces bindings and members as a whole', () => {
    const project = seedProject(store);
    expect(getTeam(store.db, project.id)).toEqual({ projectId: project.id, bindings: [], members: [] });
    const persona = store.write((ctx) => insertPersona(ctx, reviewer)).value;
    const sam = store.write((ctx) => insertPerson(ctx, { handle: 'sam', name: 'Sam' })).value;
    const { events } = store.write((ctx) =>
      setTeam(ctx, project.id, { bindings: [{ role: 'review', personaId: persona.id }], members: [sam.id] }),
    );
    expect(events.map((e) => e.type)).toEqual([EventType.TeamSaved]);
    expect(getTeam(store.db, project.id)).toEqual({
      projectId: project.id,
      bindings: [{ role: 'review', personaId: persona.id }],
      members: [sam.id],
    });
    store.write((ctx) => setTeam(ctx, project.id, { bindings: [], members: [] }));
    expect(getTeam(store.db, project.id).bindings).toEqual([]);
  });

  it.each([
    { name: 'a persona bound to a role it does not have', bind: (id: PersonaId) => ({ role: 'implement' as const, personaId: id }), archive: false },
    { name: 'an archived persona', bind: (id: PersonaId) => ({ role: 'review' as const, personaId: id }), archive: true },
  ])('refuses $name', ({ bind, archive }) => {
    const project = seedProject(store);
    const persona = store.write((ctx) => insertPersona(ctx, reviewer)).value;
    if (archive) store.write((ctx) => patchPersona(ctx, persona.id, { archived: true }));
    expect(() => store.write((ctx) => setTeam(ctx, project.id, { bindings: [bind(persona.id)], members: [] }))).toThrow(InvalidError);
  });
});

describe('people and routing rules', () => {
  it('finds a person by handle and replaces a project rule list', () => {
    const project = seedProject(store);
    const sam = store.write((ctx) => insertPerson(ctx, { handle: 'sam', name: 'Sam' })).value;
    expect(findPersonByHandle(store.db, 'sam')).toEqual(sam);
    const { events } = store.write((ctx) =>
      setRoutingRules(ctx, project.id, { rules: [{ category: 'design', area: 'ui', personId: sam.id }] }),
    );
    expect(events.map((e) => e.type)).toEqual([EventType.RoutingRulesSaved]);
    expect(listRoutingRules(store.db, project.id)).toMatchObject([{ category: 'design', area: 'ui', personId: sam.id }]);
    store.write((ctx) => setRoutingRules(ctx, project.id, { rules: [] }));
    expect(listRoutingRules(store.db, project.id)).toEqual([]);
  });

  it('refuses a rule for an area the project does not have', () => {
    const project = seedProject(store);
    const sam = store.write((ctx) => insertPerson(ctx, { handle: 'sam', name: 'Sam' })).value;
    expect(() =>
      store.write((ctx) => setRoutingRules(ctx, project.id, { rules: [{ category: 'design', area: 'nope', personId: sam.id }] })),
    ).toThrow(InvalidError);
  });
});
```

`packages/db/src/store/flows-profiles.test.ts` (synthetic slugs and numbers only):

```ts
import { ConflictError, EventType, InvalidError } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listAaModels, replaceAaModels } from './aa-models';
import { findFlowByName, insertFlow, listFlows, patchFlow } from './flows';
import {
  applyAaMeasurement,
  findModelProfile,
  insertModelProfile,
  listModelProfiles,
  patchModelProfile,
  recordProfileOutcome,
} from './model-profiles';
import type { Store } from './store';
import { insertPersona } from './team';
import { createTestStore } from './test-support';

let store: Store;
let close: () => void;
beforeEach(() => {
  ({ store, close } = createTestStore());
});
afterEach(() => {
  close();
});

describe('flows', () => {
  it('inserts with defaults filled, finds by name, patches the steps and refuses a duplicate name', () => {
    const { value: flow, events } = store.write((ctx) => insertFlow(ctx, { name: 'quick', steps: [{ role: 'implement', need: 40 }] }));
    expect(events.map((e) => e.type)).toEqual([EventType.FlowSaved]);
    expect(flow.steps).toEqual([{ role: 'implement', need: 40, skip: [], persona: null }]);
    expect(findFlowByName(store.db, 'quick')).toEqual(flow);
    store.write((ctx) => patchFlow(ctx, flow.id, { steps: [{ role: 'implement', need: 42 }, { role: 'review', need: 48 }] }));
    expect(listFlows(store.db)[0]?.steps.map((s) => s.role)).toEqual(['implement', 'review']);
    expect(() => store.write((ctx) => insertFlow(ctx, { name: 'quick', steps: [{ role: 'implement', need: 1 }] }))).toThrow(ConflictError);
  });

  it.each([
    { name: 'a persona that does not exist', persona: 'ghost' },
    { name: 'a persona that plays another role', persona: 'implementer' },
  ])('refuses a step naming $name', ({ persona }) => {
    store.write((ctx) => insertPersona(ctx, { key: 'implementer', name: 'Implementer', role: 'implement', tools: 'edit', instructions: 'Build it.' }));
    expect(() =>
      store.write((ctx) => insertFlow(ctx, { name: 'two-reviews', steps: [{ role: 'implement', need: 40 }, { role: 'review', need: 48, persona }] })),
    ).toThrow(InvalidError);
  });
});

describe('model profiles', () => {
  const definition = { provider: 'claude', model: 'sonnet', effort: 'high', aaSlug: 'test-family-high', enabled: true } as const;
  const measurement = {
    scores: { intelligence: 50, coding: 45, agentic: 40 },
    costPerTaskUsd: 1.5,
    outputTokensPerSecond: 80,
    indexVersion: '9.9',
    measuredAt: '2026-10-17T12:00:00.000Z',
  };

  it('starts unmeasured from AA, takes a measurement, and counts outcomes', () => {
    const profile = store.write((ctx) => insertModelProfile(ctx, definition)).value;
    expect(profile).toMatchObject({ source: 'aa', scores: { intelligence: null, coding: null, agentic: null }, costPerTaskUsd: null });
    expect(findModelProfile(store.db, 'claude', 'sonnet', 'high')).toEqual(profile);
    expect(() => store.write((ctx) => insertModelProfile(ctx, definition))).toThrow(ConflictError);
    expect(store.write((ctx) => applyAaMeasurement(ctx, profile.id, measurement)).value).toBe(true);
    store.write((ctx) => {
      recordProfileOutcome(ctx, profile.id, { firstPass: true, escalated: false });
      recordProfileOutcome(ctx, profile.id, { firstPass: false, escalated: true });
    });
    expect(listModelProfiles(store.db)[0]).toMatchObject({ ...measurement, stepsRun: 2, firstPassSteps: 1, escalations: 1 });
  });

  it('makes a hand-edited profile manual, ignores the sync, and hands back on request', () => {
    const profile = store.write((ctx) => insertModelProfile(ctx, definition)).value;
    const { events } = store.write((ctx) => patchModelProfile(ctx, profile.id, { costPerTaskUsd: 2 }));
    expect(events.map((e) => e.type)).toEqual([EventType.ModelProfileSaved]);
    expect(listModelProfiles(store.db)[0]).toMatchObject({ source: 'manual', costPerTaskUsd: 2 });
    expect(store.write((ctx) => applyAaMeasurement(ctx, profile.id, measurement)).value).toBe(false);
    store.write((ctx) => patchModelProfile(ctx, profile.id, { source: 'aa' }));
    expect(store.write((ctx) => applyAaMeasurement(ctx, profile.id, measurement)).value).toBe(true);
  });
});

describe('AA models', () => {
  const model = (slug: string, intelligence: number) => ({
    slug,
    name: slug,
    creator: 'Test Lab',
    releaseDate: null,
    indexVersion: '9.9',
    evaluations: { artificial_analysis_intelligence_index: intelligence },
    costPerTaskUsd: 0.5,
    pricing: {},
    performance: {},
    fetchedAt: '2026-10-17T12:00:00.000Z',
  });

  it('replaces the whole list, dropping models AA no longer lists, with one event', () => {
    store.write((ctx) => replaceAaModels(ctx, [model('a', 10), model('b', 20)]));
    const { events } = store.write((ctx) => replaceAaModels(ctx, [model('b', 21), model('c', 30)]));
    expect(events.map((e) => e.type)).toEqual([EventType.BenchmarksSynced]);
    expect(listAaModels(store.db).map((m) => [m.slug, m.evaluations['artificial_analysis_intelligence_index']])).toEqual([
      ['b', 21],
      ['c', 30],
    ]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @10db/db exec vitest run src/store/team.test.ts src/store/flows-profiles.test.ts`
Expected: FAIL, because the store modules don't exist.

- [ ] **Step 3: Add the tables**

In `packages/db/src/schema.ts`, import the new ID types and `FlowStepDef`, `ModelPin`, `StepRole`, `ToolAccess`, `QuestionCategory`, `ProfileSource`, `AaModelDto` from `@10db/contracts`, `primaryKey` and `uniqueIndex` from `drizzle-orm/sqlite-core`, and `sql` from `drizzle-orm`. Add these tables (put `flows` above `projects`, since Task 3 references it from there):

```ts
export const flows = sqliteTable('flows', {
  id: text('id').$type<FlowId>().primaryKey(),
  name: text('name').notNull().unique(),
  steps: text('steps', { mode: 'json' }).$type<FlowStepDef[]>().notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const personas = sqliteTable('personas', {
  id: text('id').$type<PersonaId>().primaryKey(),
  key: text('key').notNull().unique(),
  name: text('name').notNull(),
  role: text('role').$type<StepRole>().notNull(),
  tools: text('tools').$type<ToolAccess>().notNull(),
  instructions: text('instructions').notNull(),
  skills: text('skills', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
  minimumScore: real('minimum_score'),
  modelPin: text('model_pin', { mode: 'json' }).$type<ModelPin>(),
  archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const people = sqliteTable('people', {
  id: text('id').$type<PersonId>().primaryKey(),
  handle: text('handle').notNull().unique(),
  name: text('name').notNull(),
  isBuilder: integer('is_builder', { mode: 'boolean' }).notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Per project: which persona plays each role (spec §4 `team_bindings`). */
export const teamBindings = sqliteTable(
  'team_bindings',
  {
    projectId: text('project_id').$type<ProjectId>().notNull().references(() => projects.id),
    role: text('role').$type<StepRole>().notNull(),
    personaId: text('persona_id').$type<PersonaId>().notNull().references(() => personas.id),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.role] })],
);

export const teamMembers = sqliteTable(
  'team_members',
  {
    projectId: text('project_id').$type<ProjectId>().notNull().references(() => projects.id),
    personId: text('person_id').$type<PersonId>().notNull().references(() => people.id),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.personId] })],
);

export const routingRules = sqliteTable(
  'routing_rules',
  {
    id: text('id').$type<RoutingRuleId>().primaryKey(),
    projectId: text('project_id').$type<ProjectId>().notNull().references(() => projects.id),
    category: text('category').$type<QuestionCategory>().notNull(),
    area: text('area'),
    personId: text('person_id').$type<PersonId>().notNull().references(() => people.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('routing_rules_project_idx').on(t.projectId)],
);

export const modelProfiles = sqliteTable(
  'model_profiles',
  {
    id: text('id').$type<ModelProfileId>().primaryKey(),
    provider: text('provider').$type<Provider>().notNull(),
    model: text('model').notNull(),
    effort: text('effort').$type<Effort>().notNull(),
    aaSlug: text('aa_slug'),
    intelligence: real('intelligence'),
    coding: real('coding'),
    agentic: real('agentic'),
    costPerTaskUsd: real('cost_per_task_usd'),
    outputTokensPerSecond: real('output_tokens_per_second'),
    source: text('source').$type<ProfileSource>().notNull(),
    indexVersion: text('index_version'),
    measuredAt: text('measured_at'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    stepsRun: integer('steps_run').notNull().default(0),
    firstPassSteps: integer('first_pass_steps').notNull().default(0),
    escalations: integer('escalations').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('model_profiles_key_idx').on(t.provider, t.model, t.effort)],
);

/** Artificial Analysis's free model list, kept only on this machine (AA's terms forbid sharing it); keyed by AA's slug. */
export const aaModels = sqliteTable('aa_models', {
  slug: text('slug').primaryKey(),
  data: text('data', { mode: 'json' }).$type<AaModelDto>().notNull(),
  updatedAt: text('updated_at').notNull(),
});
```

`aa_models` stores each entry whole, as validated JSON. M2b's chart can then pick any index for an axis without a migration.

- [ ] **Step 4: Write the repositories**

`packages/db/src/store/team.ts`:

```ts
import {
  ConflictError,
  EventType,
  InvalidError,
  mintId,
  NotFoundError,
  PersonaInput,
  PersonaPatch,
  TeamInput,
  type PersonaDto,
  type PersonaId,
  type PersonDto,
  type PersonId,
  type PersonInput,
  type ProjectId,
  type TeamDto,
} from '@10db/contracts';
import { asc, eq, inArray } from 'drizzle-orm';
import * as schema from '../schema';
import type { DbReader, WriteContext } from './store';

/** The person running this app: every card nobody else owns goes to them (spec §7). */
export const BUILDER_HANDLE = 'me';

type PersonaRow = typeof schema.personas.$inferSelect;
const personaDto = (row: PersonaRow): PersonaDto => ({ ...row, modelPin: row.modelPin ?? null });

export function insertPersona(ctx: WriteContext, input: PersonaInput): PersonaDto {
  const config = PersonaInput.parse(input);
  if (findPersonaByKey(ctx.tx, config.key)) throw new ConflictError(`A persona with the key "${config.key}" already exists`);
  const row = { id: mintId('Persona'), ...config, archived: false, createdAt: ctx.now, updatedAt: ctx.now };
  ctx.tx.insert(schema.personas).values(row).run();
  ctx.emit({ type: EventType.PersonaSaved, entityType: 'persona', entityId: row.id });
  return personaDto(row);
}

/** Every save is an event; a changed prompt keeps its previous text there, as the prompt's history. */
export function patchPersona(ctx: WriteContext, id: PersonaId, patch: PersonaPatch): PersonaDto {
  const changes = PersonaPatch.parse(patch);
  const before = getPersona(ctx.tx, id);
  ctx.tx.update(schema.personas).set({ ...changes, updatedAt: ctx.now }).where(eq(schema.personas.id, id)).run();
  const promptChanged = changes.instructions !== undefined && changes.instructions !== before.instructions;
  ctx.emit({
    type: EventType.PersonaSaved,
    entityType: 'persona',
    entityId: id,
    data: promptChanged ? { previousInstructions: before.instructions } : {},
  });
  return getPersona(ctx.tx, id);
}

export function getPersona(db: DbReader, id: PersonaId): PersonaDto {
  const row = db.select().from(schema.personas).where(eq(schema.personas.id, id)).get();
  if (!row) throw new NotFoundError('persona', id);
  return personaDto(row);
}

export function findPersonaByKey(db: DbReader, key: string): PersonaDto | undefined {
  const row = db.select().from(schema.personas).where(eq(schema.personas.key, key)).get();
  return row ? personaDto(row) : undefined;
}

export function listPersonas(db: DbReader, opts: { readonly includeArchived?: boolean } = {}): PersonaDto[] {
  const rows = db.select().from(schema.personas).orderBy(asc(schema.personas.key)).all();
  return rows.filter((r) => opts.includeArchived === true || !r.archived).map(personaDto);
}

export function insertPerson(ctx: WriteContext, input: PersonInput & { readonly isBuilder?: boolean }): PersonDto {
  if (findPersonByHandle(ctx.tx, input.handle)) throw new ConflictError(`Someone already has the handle "${input.handle}"`);
  const row = {
    id: mintId('Person'),
    handle: input.handle,
    name: input.name,
    isBuilder: input.isBuilder ?? false,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
  ctx.tx.insert(schema.people).values(row).run();
  ctx.emit({ type: EventType.PersonSaved, entityType: 'person', entityId: row.id });
  return row;
}

export function getPerson(db: DbReader, id: PersonId): PersonDto {
  const row = db.select().from(schema.people).where(eq(schema.people.id, id)).get();
  if (!row) throw new NotFoundError('person', id);
  return row;
}

export function findPersonByHandle(db: DbReader, handle: string): PersonDto | undefined {
  return db.select().from(schema.people).where(eq(schema.people.handle, handle)).get();
}

export function listPeople(db: DbReader): PersonDto[] {
  return db.select().from(schema.people).orderBy(asc(schema.people.handle)).all();
}

export function getTeam(db: DbReader, projectId: ProjectId): TeamDto {
  const bindings = db
    .select({ role: schema.teamBindings.role, personaId: schema.teamBindings.personaId })
    .from(schema.teamBindings)
    .where(eq(schema.teamBindings.projectId, projectId))
    .orderBy(asc(schema.teamBindings.role))
    .all();
  const members = db
    .select({ personId: schema.teamMembers.personId })
    .from(schema.teamMembers)
    .where(eq(schema.teamMembers.projectId, projectId))
    .orderBy(asc(schema.teamMembers.personId))
    .all()
    .map((m) => m.personId);
  return { projectId, bindings, members };
}

/** Replaces the project's bindings and members; a persona must play its own role and not be archived. */
export function setTeam(ctx: WriteContext, projectId: ProjectId, input: TeamInput): TeamDto {
  const team = TeamInput.parse(input);
  for (const binding of team.bindings) {
    const persona = getPersona(ctx.tx, binding.personaId);
    if (persona.archived) throw new InvalidError(`${persona.name} is archived`);
    if (persona.role !== binding.role) throw new InvalidError(`${persona.name} is a ${persona.role} persona, not ${binding.role}`);
  }
  if (team.members.length > 0) {
    const found = ctx.tx.select({ id: schema.people.id }).from(schema.people).where(inArray(schema.people.id, team.members)).all();
    if (found.length !== team.members.length) throw new InvalidError('A member does not exist');
  }
  ctx.tx.delete(schema.teamBindings).where(eq(schema.teamBindings.projectId, projectId)).run();
  ctx.tx.delete(schema.teamMembers).where(eq(schema.teamMembers.projectId, projectId)).run();
  if (team.bindings.length > 0) ctx.tx.insert(schema.teamBindings).values(team.bindings.map((b) => ({ projectId, ...b }))).run();
  if (team.members.length > 0)
    ctx.tx.insert(schema.teamMembers).values(team.members.map((personId) => ({ projectId, personId }))).run();
  ctx.emit({ type: EventType.TeamSaved, entityType: 'team', entityId: projectId });
  return getTeam(ctx.tx, projectId);
}
```

`packages/db/src/store/flows.ts`:

```ts
import {
  ConflictError,
  EventType,
  FlowInput,
  FlowPatch,
  InvalidError,
  mintId,
  NotFoundError,
  type FlowDto,
  type FlowId,
  type FlowStepDef,
} from '@10db/contracts';
import { asc, eq } from 'drizzle-orm';
import * as schema from '../schema';
import type { DbReader, WriteContext } from './store';
import { findPersonaByKey } from './team';

/** A step's own persona must exist, be live, and play the step's role. */
function checkStepPersonas(db: DbReader, steps: readonly FlowStepDef[]): void {
  for (const step of steps) {
    if (step.persona === null) continue;
    const persona = findPersonaByKey(db, step.persona);
    if (!persona || persona.archived) throw new InvalidError(`No persona "${step.persona}"`);
    if (persona.role !== step.role) throw new InvalidError(`${persona.name} is a ${persona.role} persona, not ${step.role}`);
  }
}

export function insertFlow(ctx: WriteContext, input: FlowInput): FlowDto {
  const config = FlowInput.parse(input);
  if (findFlowByName(ctx.tx, config.name)) throw new ConflictError(`A flow named "${config.name}" already exists`);
  checkStepPersonas(ctx.tx, config.steps);
  const row = { id: mintId('Flow'), ...config, createdAt: ctx.now, updatedAt: ctx.now };
  ctx.tx.insert(schema.flows).values(row).run();
  ctx.emit({ type: EventType.FlowSaved, entityType: 'flow', entityId: row.id });
  return row;
}

export function patchFlow(ctx: WriteContext, id: FlowId, patch: FlowPatch): FlowDto {
  const { steps } = FlowPatch.parse(patch);
  getFlow(ctx.tx, id);
  checkStepPersonas(ctx.tx, steps);
  ctx.tx.update(schema.flows).set({ steps, updatedAt: ctx.now }).where(eq(schema.flows.id, id)).run();
  ctx.emit({ type: EventType.FlowSaved, entityType: 'flow', entityId: id });
  return getFlow(ctx.tx, id);
}

export function getFlow(db: DbReader, id: FlowId): FlowDto {
  const row = db.select().from(schema.flows).where(eq(schema.flows.id, id)).get();
  if (!row) throw new NotFoundError('flow', id);
  return row;
}

export function findFlowByName(db: DbReader, name: string): FlowDto | undefined {
  return db.select().from(schema.flows).where(eq(schema.flows.name, name)).get();
}

export function listFlows(db: DbReader): FlowDto[] {
  return db.select().from(schema.flows).orderBy(asc(schema.flows.name)).all();
}
```

`packages/db/src/store/model-profiles.ts`:

```ts
import {
  ConflictError,
  EventType,
  mintId,
  ModelProfilePatch,
  NotFoundError,
  ProfileSource,
  type Effort,
  type ModelProfileDto,
  type ModelProfileId,
  type ProfileScores,
  type Provider,
} from '@10db/contracts';
import { and, asc, eq, sql } from 'drizzle-orm';
import * as schema from '../schema';
import type { DbReader, WriteContext } from './store';

export interface NewModelProfile {
  readonly provider: Provider;
  readonly model: string;
  readonly effort: Effort;
  readonly aaSlug: string | null;
  readonly enabled: boolean;
}

export interface AaMeasurement {
  readonly scores: ProfileScores;
  readonly costPerTaskUsd: number | null;
  readonly outputTokensPerSecond: number | null;
  readonly indexVersion: string | null;
  readonly measuredAt: string;
}

type Row = typeof schema.modelProfiles.$inferSelect;
const toDto = ({ intelligence, coding, agentic, ...rest }: Row): ModelProfileDto => ({
  ...rest,
  scores: { intelligence, coding, agentic },
});

export function insertModelProfile(ctx: WriteContext, input: NewModelProfile): ModelProfileDto {
  if (findModelProfile(ctx.tx, input.provider, input.model, input.effort))
    throw new ConflictError(`${input.model}@${input.effort} is already in the catalogue`);
  const row: Row = {
    id: mintId('ModelProfile'),
    ...input,
    intelligence: null,
    coding: null,
    agentic: null,
    costPerTaskUsd: null,
    outputTokensPerSecond: null,
    source: ProfileSource.Aa,
    indexVersion: null,
    measuredAt: null,
    stepsRun: 0,
    firstPassSteps: 0,
    escalations: 0,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
  ctx.tx.insert(schema.modelProfiles).values(row).run();
  ctx.emit({ type: EventType.ModelProfileSaved, entityType: 'model_profile', entityId: row.id });
  return toDto(row);
}

export function findModelProfile(db: DbReader, provider: Provider, model: string, effort: Effort): ModelProfileDto | undefined {
  const row = db
    .select()
    .from(schema.modelProfiles)
    .where(and(eq(schema.modelProfiles.provider, provider), eq(schema.modelProfiles.model, model), eq(schema.modelProfiles.effort, effort)))
    .get();
  return row ? toDto(row) : undefined;
}

export function getModelProfile(db: DbReader, id: ModelProfileId): ModelProfileDto {
  const row = db.select().from(schema.modelProfiles).where(eq(schema.modelProfiles.id, id)).get();
  if (!row) throw new NotFoundError('model profile', id);
  return toDto(row);
}

export function listModelProfiles(db: DbReader): ModelProfileDto[] {
  return db
    .select()
    .from(schema.modelProfiles)
    .orderBy(asc(schema.modelProfiles.model), asc(schema.modelProfiles.effort))
    .all()
    .map(toDto);
}

/** Hand-edited scores or cost make the profile `manual`, so the sync leaves it alone, unless the patch names its source. */
export function patchModelProfile(ctx: WriteContext, id: ModelProfileId, patch: ModelProfilePatch): ModelProfileDto {
  const { scores, ...changes } = ModelProfilePatch.parse(patch);
  getModelProfile(ctx.tx, id);
  const handEdited = scores !== undefined || changes.costPerTaskUsd !== undefined;
  ctx.tx
    .update(schema.modelProfiles)
    .set({
      ...changes,
      ...(scores ?? {}),
      ...(handEdited && changes.source === undefined ? { source: ProfileSource.Manual } : {}),
      updatedAt: ctx.now,
    })
    .where(eq(schema.modelProfiles.id, id))
    .run();
  ctx.emit({ type: EventType.ModelProfileSaved, entityType: 'model_profile', entityId: id });
  return getModelProfile(ctx.tx, id);
}

/** Writes an AA measurement onto a profile the sync owns; a manual profile is left alone. */
export function applyAaMeasurement(ctx: WriteContext, id: ModelProfileId, m: AaMeasurement): boolean {
  const result = ctx.tx
    .update(schema.modelProfiles)
    .set({
      ...m.scores,
      costPerTaskUsd: m.costPerTaskUsd,
      outputTokensPerSecond: m.outputTokensPerSecond,
      indexVersion: m.indexVersion,
      measuredAt: m.measuredAt,
      updatedAt: ctx.now,
    })
    .where(and(eq(schema.modelProfiles.id, id), eq(schema.modelProfiles.source, ProfileSource.Aa)))
    .run();
  return result.changes > 0;
}

/** Observed stats for the frontier (spec §4): one call per finished or escalated step. No event: counters only. */
export function recordProfileOutcome(
  ctx: WriteContext,
  id: ModelProfileId,
  outcome: { readonly firstPass: boolean; readonly escalated: boolean },
): void {
  ctx.tx
    .update(schema.modelProfiles)
    .set({
      stepsRun: sql`${schema.modelProfiles.stepsRun} + 1`,
      firstPassSteps: sql`${schema.modelProfiles.firstPassSteps} + ${outcome.firstPass ? 1 : 0}`,
      escalations: sql`${schema.modelProfiles.escalations} + ${outcome.escalated ? 1 : 0}`,
      updatedAt: ctx.now,
    })
    .where(eq(schema.modelProfiles.id, id))
    .run();
}
```

`applyAaMeasurement` emits nothing itself; the sync emits one `BenchmarksSynced` event per run (Task 7).

`packages/db/src/store/aa-models.ts`:

```ts
import { AaModelDto, EventType } from '@10db/contracts';
import { asc, notInArray } from 'drizzle-orm';
import * as schema from '../schema';
import type { DbReader, WriteContext } from './store';

/** Replaces the local copy of AA's list with this sync's, dropping models AA no longer lists. */
export function replaceAaModels(ctx: WriteContext, models: readonly AaModelDto[]): void {
  const slugs = models.map((m) => m.slug);
  ctx.tx.delete(schema.aaModels).where(slugs.length > 0 ? notInArray(schema.aaModels.slug, slugs) : undefined).run();
  for (const model of models)
    ctx.tx
      .insert(schema.aaModels)
      .values({ slug: model.slug, data: model, updatedAt: ctx.now })
      .onConflictDoUpdate({ target: schema.aaModels.slug, set: { data: model, updatedAt: ctx.now } })
      .run();
  ctx.emit({ type: EventType.BenchmarksSynced, entityType: 'benchmarks', entityId: 'aa', data: { models: models.length } });
}

/** Read back through the schema: the column holds JSON a later 10db may have widened. */
export function listAaModels(db: DbReader): AaModelDto[] {
  return db
    .select({ data: schema.aaModels.data })
    .from(schema.aaModels)
    .orderBy(asc(schema.aaModels.slug))
    .all()
    .map((r) => AaModelDto.parse(r.data));
}
```

`packages/db/src/store/routing-rules.ts` (Task 3 adds `assigneeFor`):

```ts
import { EventType, InvalidError, mintId, RoutingRulesInput, type ProjectId, type RoutingRuleDto } from '@10db/contracts';
import { asc, eq } from 'drizzle-orm';
import * as schema from '../schema';
import { getProject } from './projects';
import type { DbReader, WriteContext } from './store';

export function listRoutingRules(db: DbReader, projectId: ProjectId): RoutingRuleDto[] {
  return db
    .select()
    .from(schema.routingRules)
    .where(eq(schema.routingRules.projectId, projectId))
    .orderBy(asc(schema.routingRules.category), asc(schema.routingRules.area))
    .all();
}

/** Replaces the project's rule list; an area must be one of the project's areas. */
export function setRoutingRules(ctx: WriteContext, projectId: ProjectId, input: RoutingRulesInput): RoutingRuleDto[] {
  const { rules } = RoutingRulesInput.parse(input);
  const areas = new Set(getProject(ctx.tx, projectId).areas.map((a) => a.name));
  for (const rule of rules)
    if (rule.area !== null && !areas.has(rule.area)) throw new InvalidError(`The project has no area "${rule.area}"`);
  ctx.tx.delete(schema.routingRules).where(eq(schema.routingRules.projectId, projectId)).run();
  if (rules.length > 0)
    ctx.tx
      .insert(schema.routingRules)
      .values(rules.map((r) => ({ id: mintId('RoutingRule'), projectId, ...r, createdAt: ctx.now, updatedAt: ctx.now })))
      .run();
  ctx.emit({ type: EventType.RoutingRulesSaved, entityType: 'routing_rules', entityId: projectId });
  return listRoutingRules(ctx.tx, projectId);
}
```

In `packages/db/src/store/index.ts`, add `export * from './aa-models';`, `export * from './flows';`, `export * from './model-profiles';`, `export * from './routing-rules';` and `export * from './team';`, one per line.

- [ ] **Step 5: Generate the migration and run the tests**

Run: `pnpm --filter @10db/db generate --name teams_and_routing && pnpm --filter @10db/db exec vitest run && pnpm --filter @10db/db typecheck`
Expected: `drizzle/0006_teams_and_routing.sql` creates the eight tables; every db test passes. Read the SQL: it must only `CREATE TABLE` and `CREATE … INDEX`.

- [ ] **Step 6: Commit**

```bash
pnpm format && git add packages/db/src/schema.ts packages/db/src/store packages/db/drizzle && git commit -m 'feat(db): add personas, people, teams, routing rules, flows, model profiles and aa models'
```

---
### Task 3: Planning fields, step-scoped handoffs and card owners

Projects gain a default flow and a budget ceiling, tasks gain risk tags and an optional flow, and workstreams gain their step plan. A handoff is read only within the step that wrote it, and every new inbox card gets its owner from the routing rules. PATCH inputs for projects and tasks arrive here too, since nothing can set the new fields otherwise.

**Files:**
- Modify: `packages/contracts/src/entities.ts`, `packages/contracts/src/json-schema.ts`, `packages/db/src/schema.ts`, `packages/db/src/store/projects.ts`, `tasks.ts`, `workstreams.ts`, `handoffs.ts`, `routing-rules.ts`, `inbox.ts`, `apps/desktop/src/test/fixtures.ts`
- Test: `packages/db/src/store/planning-fields.test.ts`, `packages/db/src/store/assignee.test.ts`
- Generated: `packages/db/drizzle/0007_planning_fields.sql` and its snapshot, `packages/contracts/generated/*`

**Interfaces:**
- Consumes: Task 1 (`FlowId`, `RiskTag`, `WorkstreamStep`, `currentStep`, `StepPosition`); Task 2 (`flows`, `routingRules` and `people` tables, plus `BUILDER_HANDLE`, `getPerson`, `insertPerson`, `setRoutingRules`).
- Produces:
  - Projects:
    - `ProjectDto.flowId: FlowId | null` and `ProjectDto.budgetCeiling: number | null`, in USD per step.
    - The same two fields on `ProjectInput`, both defaulting to `null`, and `ProjectPatch`.
  - Tasks:
    - `TaskDto.riskTags: RiskTag[]` and `TaskDto.flowId: FlowId | null`.
    - `TaskInput.riskTags` (default `[]`), `TaskInput.flowId` (default `null`) and `TaskPatch`.
  - Workstreams:
    - `WorkstreamDto.steps: WorkstreamStep[]` and `WorkstreamDto.stepIndex: number`.
    - `WorkstreamPatch.steps: WorkstreamStep[]` (mutable, as drizzle's `.set()` needs), plus `.stepIndex`, `.model` and `.effort`.
  - Repository functions:
    - `patchProject(ctx, id: ProjectId, patch: ProjectPatch): ProjectDto` and `patchTask(ctx, id: TaskId, patch: TaskPatch): TaskDto`.
    - `latestHandoffForStep(db, ws: StepPosition & { readonly id: WorkstreamId }): HandoffDto | null`: the latest handoff written by a session after the current step's `sessionFloor`. A workstream with no stored steps has floor 0, so any of its handoffs counts.
    - `assigneeFor(db, projectId, category: QuestionCategory, areas: readonly string[]): string`: a person handle, `me` when no rule matches.

- [ ] **Step 1: Write the failing tests**

`packages/db/src/store/planning-fields.test.ts`:

```ts
import { EventType, InvalidError, mintId, NotFoundError, type ProjectDto, type WorkstreamStep } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { insertFlow } from './flows';
import { insertHandoff, latestHandoffForStep } from './handoffs';
import { getProject, patchProject } from './projects';
import { insertSession } from './sessions';
import type { Store, WriteContext } from './store';
import { getTask, insertTask, patchTask } from './tasks';
import { createTestStore, seedProject } from './test-support';
import { getWorkstream, getWorkstreamRow, insertWorkstream, patchWorkstream } from './workstreams';

let store: Store;
let close: () => void;
let nowMs: number;
beforeEach(() => {
  nowMs = Date.parse('2026-10-17T12:00:00.000Z');
  ({ store, close } = createTestStore(() => new Date(nowMs)));
});
afterEach(() => {
  close();
});

const task = { title: 'T', acceptanceCriteria: ['works'], areas: ['api'] };
const step = (role: WorkstreamStep['role'], sessionFloor = 0): WorkstreamStep => ({
  role,
  personaId: null,
  personaName: role,
  tools: role === 'implement' ? 'edit' : 'read_only',
  score: role === 'implement' ? 'coding' : 'intelligence',
  profileId: null,
  model: 'opus',
  effort: 'high',
  need: 40,
  reason: 'test',
  overBudget: false,
  pinned: false,
  status: 'running',
  attempts: 0,
  startedAt: null,
  sessionFloor,
  result: null,
});

describe('planning fields', () => {
  it('defaults a project to no flow and no ceiling, and patches both with an event', () => {
    const project = seedProject(store);
    expect(project).toMatchObject({ flowId: null, budgetCeiling: null });
    const flow = store.write((ctx) => insertFlow(ctx, { name: 'quick', steps: [{ role: 'implement', need: 40 }] })).value;
    const { events } = store.write((ctx) => patchProject(ctx, project.id, { flowId: flow.id, budgetCeiling: 2.5 }));
    expect(events.map((e) => e.type)).toEqual([EventType.ProjectChanged]);
    expect(getProject(store.db, project.id)).toMatchObject({ flowId: flow.id, budgetCeiling: 2.5 });
  });

  it.each([
    { name: 'a nudge at or below the handoff', patch: { nudgePct: 40 } },
    { name: 'a handoff at or above the nudge', patch: { handoffPct: 50 } },
  ])('refuses $name, checked against the stored values', ({ patch }) => {
    const project = seedProject(store); // handoff 40, nudge 50
    expect(() => store.write((ctx) => patchProject(ctx, project.id, patch))).toThrow(InvalidError);
  });

  it.each([
    { name: 'a project patch', write: (ctx: WriteContext, project: ProjectDto) => patchProject(ctx, project.id, { flowId: mintId('Flow') }) },
    { name: 'a new task', write: (ctx: WriteContext, project: ProjectDto) => insertTask(ctx, project.id, { ...task, flowId: mintId('Flow') }) },
  ])('answers not found for a flow that does not exist, in $name', ({ write }) => {
    const project = seedProject(store);
    expect(() => store.write((ctx) => write(ctx, project))).toThrow(NotFoundError);
  });

  it('stores a task’s risk tags and flow from the input, and patches them', () => {
    const project = seedProject(store);
    const flow = store.write((ctx) => insertFlow(ctx, { name: 'quick', steps: [{ role: 'implement', need: 40 }] })).value;
    const created = store.write((ctx) => insertTask(ctx, project.id, { ...task, riskTags: ['auth'], flowId: flow.id })).value;
    expect(created).toMatchObject({ riskTags: ['auth'], flowId: flow.id });
    const { events } = store.write((ctx) => patchTask(ctx, created.id, { riskTags: ['security'] }));
    expect(events.map((e) => e.type)).toEqual([EventType.TaskChanged]);
    expect(getTask(store.db, created.id).riskTags).toEqual(['security']);
  });

  it('starts a workstream with no steps at index 0, and stores a patched step plan', () => {
    const project = seedProject(store);
    const created = store.write((ctx) => insertTask(ctx, project.id, task)).value;
    const ws = store.write((ctx) => insertWorkstream(ctx, created.id)).value;
    expect(ws).toMatchObject({ steps: [], stepIndex: 0 });
    const plan = [step('implement')];
    store.write((ctx) => {
      patchWorkstream(ctx, ws.id, null, { steps: plan, stepIndex: 0, model: 'opus', effort: 'high' });
    });
    expect(getWorkstream(store.db, ws.id)).toMatchObject({ steps: plan, model: 'opus', effort: 'high' });
  });
});

describe('latestHandoffForStep', () => {
  it('sees only handoffs written by sessions after the current step started', () => {
    const project = seedProject(store);
    const created = store.write((ctx) => insertTask(ctx, project.id, task)).value;
    const ws = store.write((ctx) => insertWorkstream(ctx, created.id)).value;
    const session = (hash: string) =>
      store.write((ctx) =>
        insertSession(ctx, { workstreamId: ws.id, provider: 'claude', model: 'opus', effort: 'high', mode: 'managed', mcpTokenHash: hash }),
      ).value;
    const handoff = (sessionId: ReturnType<typeof session>['id'], nextAction: string) =>
      store.write((ctx) =>
        insertHandoff(ctx, {
          workstreamId: ws.id,
          sessionId,
          content: {
            objective: { task: 'T', acceptanceCriteria: ['works'], nonGoals: [] },
            progress: { done: [], notDone: [], nextAction },
            codeState: { uncommittedSummary: '' },
            reasoning: { decisions: [], tradeOffs: [], rejected: [] },
            validation: { checks: [], environmentProblems: [] },
            continuity: { blockers: [], pendingQuestions: [], backgroundJobs: [], notes: '' },
          },
          gitHead: 'abc1234',
          gitChangedFiles: [],
          gitCommits: [],
        }),
      ).value;
    const early = handoff(session('h1').id, 'implement more'); // session 1
    expect(latestHandoffForStep(store.db, getWorkstreamRow(store.db, ws.id))?.id).toBe(early.id); // no stored steps

    // The review step starts after session 1, at the same instant: time can't tell them apart, sessions can.
    store.write((ctx) => {
      patchWorkstream(ctx, ws.id, null, { steps: [step('implement'), step('review', 1)], stepIndex: 1 });
    });
    expect(latestHandoffForStep(store.db, getWorkstreamRow(store.db, ws.id))).toBeNull();

    const late = handoff(session('h2').id, 'keep reviewing'); // session 2
    expect(latestHandoffForStep(store.db, getWorkstreamRow(store.db, ws.id))?.id).toBe(late.id);
  });
});
```

`packages/db/src/store/assignee.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { insertInboxItem } from './inbox';
import { assigneeFor, setRoutingRules } from './routing-rules';
import type { Store } from './store';
import { insertTask } from './tasks';
import { insertPerson } from './team';
import { createTestStore, seedProject } from './test-support';
import { insertWorkstream } from './workstreams';

let store: Store;
let close: () => void;
beforeEach(() => {
  ({ store, close } = createTestStore());
});
afterEach(() => {
  close();
});

function setup() {
  const project = seedProject(store); // areas api, ui
  const [sam, ana] = store.write((ctx) => [
    insertPerson(ctx, { handle: 'sam', name: 'Sam' }),
    insertPerson(ctx, { handle: 'ana', name: 'Ana' }),
  ]).value;
  store.write((ctx) =>
    setRoutingRules(ctx, project.id, {
      rules: [
        { category: 'design', area: null, personId: sam.id },
        { category: 'design', area: 'ui', personId: ana.id },
      ],
    }),
  );
  return project;
}

describe('assigneeFor', () => {
  it.each([
    { name: 'the area rule over the category rule', category: 'design', areas: ['ui'], who: 'ana' },
    { name: 'the category rule when no area rule matches', category: 'design', areas: ['api'], who: 'sam' },
    { name: 'the category rule when the work claims no area', category: 'design', areas: [], who: 'sam' },
    { name: 'the builder when no rule covers the category', category: 'engineering', areas: ['ui'], who: 'me' },
  ] as const)('picks $name', ({ category, areas, who }) => {
    const project = setup();
    expect(assigneeFor(store.db, project.id, category, areas)).toBe(who);
  });

  it("gives a new card the owner its workstream's areas route to", () => {
    const project = setup();
    const task = store.write((ctx) => insertTask(ctx, project.id, { title: 'T', acceptanceCriteria: ['x'], areas: ['ui'] })).value;
    const ws = store.write((ctx) => insertWorkstream(ctx, task.id)).value;
    const card = store.write((ctx) =>
      insertInboxItem(ctx, {
        projectId: project.id,
        kind: 'question',
        title: 'Which shade?',
        body: '',
        options: [],
        recommendation: null,
        category: 'design',
        urgency: 'normal',
        detail: null,
        foldKey: null,
        targets: [{ workstreamId: ws.id, sessionId: null }],
      }),
    ).value;
    expect(card.assignee).toBe('ana');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @10db/db exec vitest run src/store/planning-fields.test.ts src/store/assignee.test.ts`
Expected: FAIL: `patchProject`, `patchTask`, `latestHandoffForStep` and `assigneeFor` don't exist, and the DTOs have no new fields.

- [ ] **Step 3: Extend the contracts**

In `packages/contracts/src/entities.ts`, import `FlowId` from `./ids`, `RiskTag` from `./states` and `WorkstreamStep` from `./steps`:
- `ProjectInput`: add `flowId: FlowId.nullable().default(null),` and `budgetCeiling: z.number().positive().nullable().default(null),` before the `.refine`.
- `ProjectDto`: add `flowId: FlowId.nullable(),` and `budgetCeiling: z.number().nullable(),` after `humanWaitMinutes`.
- After `ProjectDto`, add:

```ts
/** Fields the builder can change after creation; the nudge/handoff rule is checked against the merged values. */
export const ProjectPatch = z
  .object({
    name: z.string().min(1),
    gateCommand: z.string().min(1),
    maxLanes: z.int().min(1).max(16),
    handoffPct: z.int().min(5).max(95),
    nudgePct: z.int().min(6).max(98),
    humanWaitMinutes: z.int().min(1).max(240),
    flowId: FlowId.nullable(),
    /** The most one step may cost, in USD per AA task; null for no ceiling. */
    budgetCeiling: z.number().positive().nullable(),
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, { message: 'Change at least one field' });
export type ProjectPatch = z.infer<typeof ProjectPatch>;
```

- `TaskInput`: add `riskTags: z.array(z.enum(RiskTag)).default([]),` and `flowId: FlowId.nullable().default(null),`.
- `TaskDto`: add `riskTags: z.array(z.enum(RiskTag)),` and `flowId: FlowId.nullable(),` after `areas`.
- After `TaskDto`, add:

```ts
export const TaskPatch = z
  .object({
    title: z.string().min(1).max(200),
    description: z.string(),
    acceptanceCriteria: z.array(z.string().min(1)).min(1),
    riskTags: z.array(z.enum(RiskTag)),
    flowId: FlowId.nullable(),
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, { message: 'Change at least one field' });
export type TaskPatch = z.infer<typeof TaskPatch>;
```

- `WorkstreamDto`: add `steps: z.array(WorkstreamStep),` and `stepIndex: z.int().min(0),` after `effort`.

Register `'project-patch': ProjectPatch` and `'task-patch': TaskPatch` in `CONTRACT_SCHEMAS`.

- [ ] **Step 4: Add the columns and the repository changes**

In `packages/db/src/schema.ts`:
- `projects`: `flowId: text('flow_id').$type<FlowId>().references(() => flows.id),` and `budgetCeiling: real('budget_ceiling'),`.
- `tasks`: `riskTags: text('risk_tags', { mode: 'json' }).$type<RiskTag[]>().notNull().default(sql\`'[]'\`),` and `flowId: text('flow_id').$type<FlowId>().references(() => flows.id),`.
- `workstreams`: `steps: text('steps', { mode: 'json' }).$type<WorkstreamStep[]>().notNull().default(sql\`'[]'\`),` and `stepIndex: integer('step_index').notNull().default(0),`.

The SQL defaults matter: existing rows get `[]` and `0`, which is how `currentStep` recognizes a workstream started before this plan.

In `packages/db/src/store/projects.ts`, add:

```ts
export function patchProject(ctx: WriteContext, id: ProjectId, patch: ProjectPatch): ProjectDto {
  const changes = ProjectPatch.parse(patch);
  // A stale flow id answers 404, not a foreign-key failure.
  if (changes.flowId) getFlow(ctx.tx, changes.flowId);
  const merged = { ...getProject(ctx.tx, id), ...changes };
  if (merged.nudgePct <= merged.handoffPct) throw new InvalidError('nudgePct must be above handoffPct');
  ctx.tx.update(schema.projects).set({ ...changes, updatedAt: ctx.now }).where(eq(schema.projects.id, id)).run();
  ctx.emit({ type: EventType.ProjectChanged, entityType: 'project', entityId: id });
  return getProject(ctx.tx, id);
}
```

In `packages/db/src/store/projects.ts`'s `insertProject`, after the config is parsed, add `if (config.flowId) getFlow(ctx.tx, config.flowId);` (import `getFlow` from `./flows`).

In `packages/db/src/store/tasks.ts`:
- `insertTask` lists its row fields one by one (it does not spread the config), so add `riskTags: config.riskTags,` and `flowId: config.flowId,` to the `row` literal after `areas`, and check the flow first: `if (config.flowId) getFlow(ctx.tx, config.flowId);`.
- Make the task DTO mapper return `riskTags` and `flowId`.
- Add:

```ts
export function patchTask(ctx: WriteContext, id: TaskId, patch: TaskPatch): TaskDto {
  const changes = TaskPatch.parse(patch);
  getTask(ctx.tx, id);
  if (changes.flowId) getFlow(ctx.tx, changes.flowId);
  ctx.tx.update(schema.tasks).set({ ...changes, updatedAt: ctx.now }).where(eq(schema.tasks.id, id)).run();
  ctx.emit({ type: EventType.TaskChanged, entityType: 'task', entityId: id });
  return getTask(ctx.tx, id);
}
```

In `packages/db/src/store/workstreams.ts`:
- `WorkstreamPatch`: add `readonly steps?: WorkstreamStep[]; readonly stepIndex?: number; readonly model?: string; readonly effort?: Effort;`. The array is mutable because drizzle's `.set()` takes the column's own type.
- `insertWorkstream`: add `steps: [], stepIndex: 0` to the new row.
- `toDto`: add `steps: row.steps, stepIndex: row.stepIndex,` after `effort`.

In `packages/db/src/store/handoffs.ts` (import `currentStep` and `type StepPosition` from `@10db/contracts`, `and` and `gt` from `drizzle-orm`), add:

```ts
/**
 * The latest handoff written in the step the workstream is on: by a session after the
 * step's floor. Sessions, not timestamps, because a step can start in the same instant a handoff lands.
 */
export function latestHandoffForStep(
  db: DbReader,
  ws: StepPosition & { readonly id: WorkstreamId },
): HandoffDto | null {
  const floor = currentStep(ws).sessionFloor;
  const row = db
    .select({ handoff: schema.handoffs })
    .from(schema.handoffs)
    .innerJoin(schema.sessions, eq(schema.sessions.id, schema.handoffs.sessionId))
    .where(and(eq(schema.handoffs.workstreamId, ws.id), gt(schema.sessions.sequence, floor)))
    .orderBy(desc(schema.sessions.sequence), desc(schema.handoffs.id))
    .limit(1)
    .get();
  return row?.handoff ?? null;
}
```

In `packages/db/src/store/routing-rules.ts` (import `getPerson`, `BUILDER_HANDLE` from `./team` and `type QuestionCategory` from `@10db/contracts`), add:

```ts
/** The handle a card goes to: an area rule beats a category rule, and the builder gets the rest (spec §7). */
export function assigneeFor(db: DbReader, projectId: ProjectId, category: QuestionCategory, areas: readonly string[]): string {
  const rules = listRoutingRules(db, projectId).filter((r) => r.category === category);
  const rule = rules.find((r) => r.area !== null && areas.includes(r.area)) ?? rules.find((r) => r.area === null);
  return rule ? getPerson(db, rule.personId).handle : BUILDER_HANDLE;
}
```

In `packages/db/src/store/inbox.ts`, replace `assignee: 'me',` in `insertInboxItem` with `assignee: assigneeFor(ctx.tx, item.projectId, item.category, targetAreas(ctx.tx, item.targets)),` and add:

```ts
/** The areas the targeted workstreams' tasks claim, so a routing rule can narrow by area. */
function targetAreas(db: DbReader, targets: readonly InboxTarget[]): string[] {
  const areas = new Set<string>();
  for (const target of targets) {
    const row = db
      .select({ areas: schema.tasks.areas })
      .from(schema.workstreams)
      .innerJoin(schema.tasks, eq(schema.tasks.id, schema.workstreams.taskId))
      .where(eq(schema.workstreams.id, target.workstreamId))
      .get();
    for (const area of row?.areas ?? []) areas.add(area);
  }
  return [...areas];
}
```

- [ ] **Step 5: Update the DTO fixtures and anything else that builds a DTO literal**

In `apps/desktop/src/test/fixtures.ts`, give the project fixture `flowId: null, budgetCeiling: null`, the task fixture `riskTags: [], flowId: null`, and the workstream fixture `steps: [], stepIndex: 0`. Then run `pnpm -r typecheck` and add the same defaults wherever else a literal `ProjectDto`, `TaskDto` or `WorkstreamDto` is built.

- [ ] **Step 6: Generate and run the tests**

Run: `pnpm --filter @10db/contracts generate && pnpm --filter @10db/db generate --name planning_fields && pnpm --filter @10db/db exec vitest run && pnpm -r typecheck`
Expected: every test passes, and `0007_planning_fields.sql` adds the six columns with `ALTER TABLE … ADD` (`DEFAULT '[]'`, `DEFAULT 0` and inline `REFERENCES` where the schema says so).

If drizzle-kit instead rebuilds a table (`CREATE TABLE __new_…`, `INSERT … SELECT`, `DROP TABLE`), stop. `migrateDatabase` runs every migration in one transaction with foreign keys on, where a rebuild's `PRAGMA foreign_keys=OFF` does nothing and the drop fails. Delete that generated file and author the migration once with `pnpm --filter @10db/db exec drizzle-kit generate --custom --name planning_fields` as plain `ALTER TABLE … ADD COLUMN` statements, like `0002_decisions_fts.sql`.

- [ ] **Step 7: Commit**

```bash
pnpm format && git add packages/contracts/src/entities.ts packages/contracts/src/json-schema.ts packages/contracts/generated packages/db/src/schema.ts packages/db/src/store packages/db/drizzle apps/desktop/src/test/fixtures.ts && git commit -m 'feat(db): add flows, budgets, risk tags and step plans, and route cards to their owner'
```

Add any other file Step 5 touched to that command.

---
### Task 4: Default personas in the harness

**Files:**
- Create: `packages/harness/plugin/personas/planner.md`, `plan-reviewer.md`, `implementer.md`, `reviewer.md`, `qa.md`
- Modify: `packages/harness/src/index.ts`, `packages/harness/AGENTS.md`
- Test: `packages/harness/src/personas.test.ts`

**Interfaces:**
- Produces: `PERSONA_KEYS` (`['implementer', 'plan-reviewer', 'planner', 'qa', 'reviewer']`), `MAX_PERSONA_BYTES = 4096`, `PersonaManifestError`, `readDefaultPersonas(dir?: string): HarnessPersona[]`, where `HarnessPersona = { key: string; name: string; role; tools; skills: string[]; instructions: string }`. `skills` comes from an optional frontmatter line (`skills: test-first, review-checklist`), and each name must be one of `SKILL_NAMES`.
- The harness depends on zod only (`packages/harness/package.json`), so it declares its own `role` and `tools` enums with the same values as `@10db/contracts`. Task 6 parses each result with the contracts' `PersonaInput` before inserting, which catches any drift.

- [ ] **Step 1: Write the failing test**

`packages/harness/src/personas.test.ts`:

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_PERSONA_BYTES, PERSONA_KEYS, PersonaManifestError, readDefaultPersonas, SKILL_NAMES } from './index';

describe('default personas', () => {
  it('ships one persona per role, each small, with instructions', () => {
    const personas = readDefaultPersonas();
    expect(personas.map((p) => p.key)).toEqual([...PERSONA_KEYS]);
    expect(new Set(personas.map((p) => p.role))).toEqual(
      new Set(['plan', 'plan_review', 'implement', 'review', 'qa']),
    );
    for (const p of personas) {
      expect(p.instructions.length, p.key).toBeGreaterThan(200);
      // Plugin text names 10db's tools in full (packages/harness/AGENTS.md).
      expect(p.instructions, p.key).not.toMatch(/`(complete_step|ask_human|commit|write_handoff|report_deviation)`/);
      for (const skill of p.skills) expect(SKILL_NAMES, `${p.key} skill ${skill}`).toContain(skill);
      expect(Buffer.byteLength(p.instructions), p.key).toBeLessThan(MAX_PERSONA_BYTES);
      expect(p.tools, p.key).toBe(p.role === 'implement' ? 'edit' : 'read_only');
    }
  });
});

describe('malformed persona files', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  function pluginWith(file: string, text: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'persona-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'personas'));
    writeFileSync(join(dir, 'personas', file), text);
    return dir;
  }
  const body = `\n${'Read the change carefully. '.repeat(12)}\n`;

  it.each([
    { name: 'no frontmatter', file: 'a.md', text: body },
    { name: 'an unknown role', file: 'a.md', text: `---\nname: A\nrole: boss\ntools: edit\n---${body}` },
    { name: 'a reviewer that edits', file: 'a.md', text: `---\nname: A\nrole: review\ntools: edit\n---${body}` },
    { name: 'a file name that is not a key', file: 'Big Name.md', text: `---\nname: A\nrole: qa\ntools: read_only\n---${body}` },
    { name: 'an empty body', file: 'a.md', text: '---\nname: A\nrole: qa\ntools: read_only\n---\n' },
    { name: 'a body over the cap', file: 'a.md', text: `---\nname: A\nrole: qa\ntools: read_only\n---\n${'x'.repeat(MAX_PERSONA_BYTES)}` },
    { name: 'a skill the harness does not ship', file: 'a.md', text: `---\nname: A\nrole: qa\ntools: read_only\nskills: telepathy\n---${body}` },
  ])('rejects $name', ({ file, text }) => {
    expect(() => readDefaultPersonas(pluginWith(file, text))).toThrow(PersonaManifestError);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @10db/harness exec vitest run src/personas.test.ts`
Expected: FAIL, because `readDefaultPersonas` isn't exported.

- [ ] **Step 3: Write the reader**

In `packages/harness/src/index.ts`, after `listSkills`, reusing `FRONTMATTER`, `PlainValue` and `frontmatterFields`:

```ts
/** The default personas 10db seeds on first start (spec §11.3), one per flow role. */
export const PERSONA_KEYS = ['implementer', 'plan-reviewer', 'planner', 'qa', 'reviewer'] as const;

/** A persona's instructions ride in every session prompt for its step, so they stay short. */
export const MAX_PERSONA_BYTES = 4096;

const PERSONA_KEY = /^[a-z][a-z0-9-]{0,39}$/;

const PersonaFrontmatter = z
  .object({
    name: PlainValue,
    role: z.enum(['plan', 'plan_review', 'implement', 'review', 'qa']),
    tools: z.enum(['read_only', 'edit']),
    skills: z
      .string()
      .optional()
      .transform((list) => (list ? list.split(',').map((s) => s.trim()).filter(Boolean) : []))
      .pipe(z.array(z.enum(SKILL_NAMES))),
  })
  .refine((p) => (p.role === 'implement') === (p.tools === 'edit'), {
    message: 'only the implement role edits',
  });

export interface HarnessPersona {
  readonly key: string;
  readonly name: string;
  readonly role: z.infer<typeof PersonaFrontmatter>['role'];
  readonly tools: z.infer<typeof PersonaFrontmatter>['tools'];
  readonly skills: readonly string[];
  readonly instructions: string;
}

/** A persona file is unreadable, misnamed or has invalid frontmatter or instructions. */
export class PersonaManifestError extends Error {
  override name = 'PersonaManifestError';
  constructor(path: string, reason: string, options?: ErrorOptions) {
    super(`${path}: ${reason}`, options);
  }
}

function readPersona(root: string, file: string): HarnessPersona {
  const path = join(root, file);
  const key = file.slice(0, -'.md'.length);
  if (!PERSONA_KEY.test(key)) throw new PersonaManifestError(path, 'the file name must be a lowercase key');
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new PersonaManifestError(path, 'cannot be read', { cause: error });
  }
  const match = FRONTMATTER.exec(text);
  if (!match?.[1]) throw new PersonaManifestError(path, 'frontmatter is missing');
  const parsed = PersonaFrontmatter.safeParse(frontmatterFields(match[1]));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => i.message).join(', ');
    throw new PersonaManifestError(path, `frontmatter needs a name, a role, tools and known skills (${issues})`);
  }
  const instructions = text.slice(match[0].length).trim();
  if (instructions.length === 0) throw new PersonaManifestError(path, 'the instructions are empty');
  if (Buffer.byteLength(instructions, 'utf8') >= MAX_PERSONA_BYTES)
    throw new PersonaManifestError(path, `the instructions must be under ${String(MAX_PERSONA_BYTES)} bytes`);
  return { key, ...parsed.data, instructions };
}

export function readDefaultPersonas(dir: string = HARNESS_PLUGIN_DIR): HarnessPersona[] {
  const root = join(dir, 'personas');
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => readPersona(root, entry.name))
    .sort((a, b) => a.key.localeCompare(b.key));
}
```

- [ ] **Step 4: Write the five personas**

Each file is frontmatter plus instructions, between 200 and 4096 bytes. They describe how the role works in 10db; the session prompt (Task 7) adds the task, the step and the rules.

`packages/harness/plugin/personas/planner.md`:

```markdown
---
name: Planner
role: plan
tools: read_only
skills: planning
---

You plan one task before anyone writes code. You can read the repository but not change it.

1. Read the task, its acceptance criteria and the code it touches. Find the existing patterns
   the change should follow, and name the files.
2. Write a plan an implementer can follow without asking you anything: the files to change,
   the order, the tests that prove each acceptance criterion (red first), and the risks.
3. Say what is out of scope. If the task is ambiguous, ask with `mcp__10db__ask_human` before
   planning around a guess.
4. When the plan is ready, call `mcp__10db__complete_step` with the plan as the summary, then end
   your turn.
```

`packages/harness/plugin/personas/plan-reviewer.md`:

```markdown
---
name: Plan reviewer
role: plan_review
tools: read_only
skills: review-checklist
---

You review a plan before it is implemented. You can read the repository but not change it.

1. Check the plan against the task's acceptance criteria: every criterion needs a step and a
   test that proves it.
2. Check it against the code: the files it names exist, the patterns it follows are the ones
   the repository uses, and nothing it relies on is missing.
3. Look for risk the plan ignores: trust boundaries, migrations, auth, data loss, concurrency.
4. Call `mcp__10db__complete_step` with a verdict. Approve a plan that is complete and safe.
   Reject one that isn't, and say exactly what to change: the planner sees only your notes.
```

`packages/harness/plugin/personas/implementer.md`:

```markdown
---
name: Implementer
role: implement
tools: edit
skills: test-first, handoff
---

You implement one task in a shared repository. Other sessions work beside you in other areas.

1. If a plan or reviewer notes are in your prompt, follow them; call
   `mcp__10db__report_deviation` if you depart from them, and say why.
2. Work test first: write the failing test, watch it fail for the expected reason, then make
   it pass. Fix the code, not the test.
3. Stay inside your claims. Commit with `mcp__10db__commit`, naming every path.
4. When the acceptance criteria are met and committed, end your turn. 10db runs the gate; if
   it fails, you get its output and another session.
```

`packages/harness/plugin/personas/reviewer.md`:

```markdown
---
name: Reviewer
role: review
tools: read_only
skills: review-checklist
---

You review a change that passed the gate. You can read the repository but not change it.

1. Read the diff for this task (`git log` and `git show` on its commits) and the acceptance
   criteria.
2. Hunt for defects: wrong behavior, missed cases, broken error handling, tests that would pass
   without the change, and anything that weakens a trust boundary.
3. Don't restyle working code. A finding needs a concrete failure: the input, what happens,
   what should happen.
4. Call `mcp__10db__complete_step` with a verdict. Approve when you found nothing that blocks.
   Reject with each finding as a numbered note: the implementer sees only your notes.
```

`packages/harness/plugin/personas/qa.md`:

```markdown
---
name: QA
role: qa
tools: read_only
---

You check a change as its user would, after review. You can read the repository but not
change it.

1. Read the acceptance criteria and work out how a person would exercise each one.
2. Check what you can without writing: read the tests that cover each criterion and look for a
   criterion nothing proves. 10db already ran the gate; your shell can only read.
3. Note anything a user would trip on: confusing errors, missing states, wrong defaults.
4. Call `mcp__10db__complete_step` with a verdict. Reject only for a criterion that isn't met or
   a problem a user would hit, and say how to reproduce it.
```

- [ ] **Step 5: Document the folder**

In `packages/harness/AGENTS.md`, add a bullet: "`plugin/personas/<key>.md` holds the default personas, one per flow role: frontmatter `name`, `role`, `tools` (only `implement` edits) and optional `skills` (names from `SKILL_NAMES`), then the instructions, under 4 KiB, naming 10db's tools in full. The daemon seeds each one whose key is missing on first start and never overwrites a builder's edit. `src/personas.test.ts` enforces the shape."

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @10db/harness exec vitest run && pnpm --filter @10db/harness typecheck`
Expected: PASS, the existing skill tests included (personas live outside `skills/`).

- [ ] **Step 7: Commit**

```bash
pnpm format && git add packages/harness/plugin/personas packages/harness/src/index.ts packages/harness/src/personas.test.ts packages/harness/AGENTS.md && git commit -m 'feat(harness): ship the five default personas and their reader'
```

---
### Task 5: The routing module: catalogue, floors, skip rules, router, escalation and step plans

A pure module: rows in, a step plan out. Everything the spec calls "right-sizing" lives here, so it can be tested by tables. The tests use an invented catalogue (`small`, `mid`, `big`), never AA's numbers.

**Files:**
- Create: `apps/daemon/src/routing/catalogue.ts`, `floors.ts`, `skip-rules.ts`, `router.ts`, `plan-steps.ts`, `index.ts`
- Test: `apps/daemon/src/routing/router.test.ts`, `floors-skip.test.ts`, `plan-steps.test.ts`, `test-catalogue.ts` (shared test data)
- Modify: `apps/daemon/AGENTS.md` (the module list and dependency order)

**Interfaces:**
- Consumes: Task 1's contracts.
- Produces, exported from `routing/index.ts`:
  - `SEED_PROFILES: readonly SeedProfile[]`, `DEFAULT_FLOWS: readonly FlowInput[]`, `DEFAULT_PROJECT_FLOW = 'standard'`.
  - `planSteps(input: PlanInput): StepPlanDto`.
  - `escalateStep(step: WorkstreamStep, input: EscalateInput): { step: WorkstreamStep; escalated: boolean }`.
  - `NoProfileError`.
- Internal to the module, and tested through its files: `stepFloor`, `skipReason`, `route`, `UnmeasuredError` and `DEFAULT_PERSONA_FOR`.

- [ ] **Step 1: Write the failing tests**

`apps/daemon/src/routing/test-catalogue.ts` (test data only; it is imported by the three test files and by nothing else):

```ts
import { mintId, type ModelProfileDto } from '@10db/contracts';

const NOW = '2026-10-17T12:00:00.000Z';

/** An invented frontier: three model sizes at two efforts, scored and priced to make the tables readable. */
const ROWS = [
  ['small', 'low', 20, 18, 15, 0.05, 200],
  ['small', 'high', 30, 28, 25, 0.1, 180],
  ['mid', 'low', 38, 36, 30, 0.4, 90],
  ['mid', 'high', 46, 44, 40, 1, 70],
  ['big', 'high', 50, 50, 45, 2, 50],
  ['big', 'max', 56, 54, 50, 6, 30],
] as const;

export function testCatalogue(overrides: Readonly<Record<string, Partial<ModelProfileDto>>> = {}): ModelProfileDto[] {
  return ROWS.map(([model, effort, intelligence, coding, agentic, cost, tps]) => ({
    id: mintId('ModelProfile'),
    provider: 'claude',
    model,
    effort,
    aaSlug: `test-${model}-${effort}`,
    scores: { intelligence, coding, agentic },
    costPerTaskUsd: cost,
    outputTokensPerSecond: tps,
    source: 'aa',
    indexVersion: 'test',
    measuredAt: NOW,
    enabled: true,
    stepsRun: 0,
    firstPassSteps: 0,
    escalations: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides[`${model}@${effort}`],
  }));
}

export const label = (p: Pick<ModelProfileDto, 'model' | 'effort'>) => `${p.model}@${p.effort}`;
```

`apps/daemon/src/routing/router.test.ts`:

```ts
import type { StepRole, WorkstreamStep } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { escalateStep, NoProfileError, route, UnmeasuredError } from './router';
import { label, testCatalogue } from './test-catalogue';

const none = { minimum: 0, why: null };
const at = (role: StepRole, need: number, opts: { floor?: { minimum: number; why: string }; ceiling?: number | null } = {}) => ({
  provider: 'claude' as const,
  role,
  need,
  floor: opts.floor ?? none,
  budgetCeiling: opts.ceiling ?? null,
  profiles: testCatalogue(),
});

describe('route', () => {
  it.each([
    { name: 'implement on its coding score', input: at('implement', 40), want: 'mid@high', over: false },
    { name: 'review on its intelligence score', input: at('review', 48), want: 'big@high', over: false },
    { name: 'QA on its agentic score', input: at('qa', 35), want: 'mid@high', over: false },
    { name: 'the floor over a lower need', input: at('review', 48, { floor: { minimum: 52, why: 'security-sensitive review' } }), want: 'big@max', over: false },
    { name: 'the cheapest of all for a small need', input: at('implement', 15), want: 'small@low', over: false },
    { name: 'the cheapest that meets the need, over budget, when nothing within the ceiling does', input: at('implement', 40, { ceiling: 0.5 }), want: 'mid@high', over: true },
    { name: 'a profile exactly at the ceiling', input: at('implement', 40, { ceiling: 1 }), want: 'mid@high', over: false },
  ])('routes $name', ({ input, want, over }) => {
    const choice = route(input);
    expect(label(choice.profile)).toBe(want);
    expect(choice.overBudget).toBe(over);
  });

  it.each([
    { name: 'skips a disabled profile', overrides: { 'mid@high': { enabled: false } }, want: 'big@high' },
    { name: 'breaks a cost tie on speed', overrides: { 'big@high': { costPerTaskUsd: 1, outputTokensPerSecond: 80 } }, want: 'big@high' },
    { name: 'breaks a cost and speed tie on the lower score', overrides: { 'big@high': { costPerTaskUsd: 1, outputTokensPerSecond: 70 } }, want: 'mid@high' },
    { name: 'skips a profile with no cost', overrides: { 'mid@high': { costPerTaskUsd: null } }, want: 'big@high' },
  ])('$name', ({ overrides, want }) => {
    expect(label(route({ ...at('implement', 40), profiles: testCatalogue(overrides) }).profile)).toBe(want);
  });

  it('explains its choice', () => {
    const choice = route(at('review', 48, { floor: { minimum: 52, why: 'security-sensitive review' }, ceiling: 3 }));
    expect(choice.reason).toBe(
      'cheapest profile at or above 52 intelligence (floor: security-sensitive review); over the budget ceiling of $3',
    );
  });

  it('throws NoProfileError when measured profiles exist but none reaches the minimum', () => {
    expect(() => route(at('implement', 99))).toThrow(NoProfileError);
  });

  it('throws UnmeasuredError when no profile has the role’s score yet', () => {
    const unmeasured = testCatalogue(
      Object.fromEntries(
        ['small@low', 'small@high', 'mid@low', 'mid@high', 'big@high', 'big@max'].map((k) => [
          k,
          { scores: { intelligence: 1, coding: null, agentic: 1 } },
        ]),
      ),
    );
    expect(() => route({ ...at('implement', 40), profiles: unmeasured })).toThrow(UnmeasuredError);
    expect(label(route({ ...at('review', 1), profiles: unmeasured }).profile)).toBe('small@low');
  });
});

describe('escalateStep', () => {
  const profiles = testCatalogue();
  const stepOn = (name: string, extra: Partial<WorkstreamStep> = {}): WorkstreamStep => {
    const p = profiles.find((x) => label(x) === name);
    if (!p) throw new Error(name);
    return {
      role: 'implement',
      personaId: null,
      personaName: 'Implementer',
      tools: 'edit',
      score: 'coding',
      profileId: p.id,
      model: p.model,
      effort: p.effort,
      need: 40,
      reason: 'cheapest profile at or above 40 coding',
      overBudget: false,
      pinned: false,
      status: 'running',
      attempts: 1,
      startedAt: null,
      sessionFloor: 0,
      result: null,
      ...extra,
    };
  };
  const input = (ceiling: number | null = null) => ({ provider: 'claude' as const, budgetCeiling: ceiling, profiles, why: 'the gate failed' });

  it.each([
    { name: 'one profile up its own score', from: stepOn('mid@high'), ceiling: null, want: 'big@high', escalated: true },
    { name: 'nothing above the top', from: stepOn('big@max'), ceiling: null, want: 'big@max', escalated: false },
    { name: 'nothing within the ceiling', from: stepOn('mid@high'), ceiling: 1.5, want: 'mid@high', escalated: false },
    { name: 'nothing for a pinned step', from: stepOn('mid@high', { pinned: true }), ceiling: null, want: 'mid@high', escalated: false },
  ])('moves $name', ({ from, ceiling, want, escalated }) => {
    const result = escalateStep(from, input(ceiling));
    expect(`${result.step.model}@${result.step.effort}`).toBe(want);
    expect(result.escalated).toBe(escalated);
  });

  it('says why it moved, or why it could not', () => {
    expect(escalateStep(stepOn('mid@low'), input(1.5)).step.reason).toBe('escalated from mid@low after the gate failed');
    expect(escalateStep(stepOn('mid@high'), input(1.5)).step.reason).toBe(
      'kept mid@high after the gate failed: no stronger profile within the budget ceiling of $1.5',
    );
  });
});
```

`apps/daemon/src/routing/floors-skip.test.ts`:

```ts
import type { SkipRule } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { stepFloor } from './floors';
import { skipReason, type TaskShape } from './skip-rules';

describe('stepFloor', () => {
  it.each([
    { role: 'review', tags: ['security'], minimum: 52 },
    { role: 'plan_review', tags: ['auth'], minimum: 52 },
    { role: 'review', tags: ['dependency'], minimum: 0 },
    { role: 'implement', tags: ['migration'], minimum: 45 },
    { role: 'implement', tags: ['security'], minimum: 0 },
    { role: 'qa', tags: ['security', 'migration'], minimum: 0 },
    { role: 'review', tags: [], minimum: 0 },
  ] as const)('$role with $tags needs at least $minimum', ({ role, tags, minimum }) => {
    expect(stepFloor(role, tags).minimum).toBe(minimum);
  });
});

describe('skipReason', () => {
  const task = (riskTags: ('security' | 'auth')[], criteria: number) => ({
    riskTags,
    acceptanceCriteria: Array.from({ length: criteria }, (_, i) => `criterion ${String(i)}`),
  });
  const rows: { name: string; skip: SkipRule[]; t: TaskShape; skipped: boolean }[] = [
    { name: 'a step with no rules runs', skip: [], t: task([], 1), skipped: false },
    { name: 'unless_risk runs when a tag matches', skip: [{ kind: 'unless_risk', tags: ['security'] }], t: task(['security'], 1), skipped: false },
    { name: 'unless_risk skips when none matches', skip: [{ kind: 'unless_risk', tags: ['security'] }], t: task(['auth'], 1), skipped: true },
    { name: 'unless_criteria_over runs above the count', skip: [{ kind: 'unless_criteria_over', count: 3 }], t: task([], 4), skipped: false },
    { name: 'unless_criteria_over skips at the count', skip: [{ kind: 'unless_criteria_over', count: 3 }], t: task([], 3), skipped: true },
    { name: 'two rules run when either holds', skip: [{ kind: 'unless_risk', tags: ['auth'] }, { kind: 'unless_criteria_over', count: 3 }], t: task(['auth'], 1), skipped: false },
  ];
  it.each(rows)('$name', ({ skip, t, skipped }) => {
    expect(skipReason({ role: 'review', need: 48, skip, persona: null }, t) !== null).toBe(skipped);
  });
});
```

`apps/daemon/src/routing/plan-steps.test.ts`:

```ts
import { mintId, type FlowDto, type PersonaDto } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { DEFAULT_FLOWS } from './catalogue';
import { planSteps, type PlanInput } from './plan-steps';
import { testCatalogue } from './test-catalogue';

const NOW = '2026-10-17T12:00:00.000Z';
const flow = (name: string, steps?: FlowDto['steps']): FlowDto => {
  const def = DEFAULT_FLOWS.find((f) => f.name === name);
  return {
    id: mintId('Flow'),
    name,
    steps: steps ?? (def?.steps ?? []).map((s) => ({ ...s, skip: s.skip ?? [], persona: s.persona ?? null })),
    createdAt: NOW,
    updatedAt: NOW,
  };
};
const persona = (key: string, role: PersonaDto['role'], extra: Partial<PersonaDto> = {}): PersonaDto => ({
  id: mintId('Persona'),
  key,
  name: key,
  role,
  tools: role === 'implement' ? 'edit' : 'read_only',
  instructions: `${key} instructions`,
  skills: [],
  minimumScore: null,
  modelPin: null,
  archived: false,
  createdAt: NOW,
  updatedAt: NOW,
  ...extra,
});
const defaults = [
  persona('planner', 'plan'),
  persona('plan-reviewer', 'plan_review'),
  persona('implementer', 'implement'),
  persona('reviewer', 'review'),
  persona('qa', 'qa'),
];
const project = { provider: 'claude', budgetCeiling: null, model: 'sonnet', effort: 'medium' } as const;
const task = (riskTags: ('security' | 'migration')[] = [], criteria = 1) => ({
  riskTags,
  acceptanceCriteria: Array.from({ length: criteria }, (_, i) => `c${String(i)}`),
});
const input = (over: Partial<PlanInput> = {}): PlanInput => ({
  flow: flow('standard'),
  task: task(),
  project,
  personas: defaults,
  bindings: [],
  profiles: testCatalogue(),
  ...over,
});
const summary = (plan: ReturnType<typeof planSteps>) => plan.steps.map((s) => `${s.role}:${s.personaName}:${s.model}@${s.effort}`);

describe('planSteps', () => {
  it.each([
    { name: 'standard: implement then review', over: {}, want: ['implement:implementer:mid@high', 'review:reviewer:big@high'] },
    { name: 'full on a small, safe task skips the plan, the plan review and QA', over: { flow: flow('full') }, want: ['implement:implementer:mid@high', 'review:reviewer:big@high'] },
    {
      name: 'full on a large security task keeps every step and raises the reviews',
      over: { flow: flow('full'), task: task(['security'], 4) },
      want: ['plan:planner:mid@high', 'plan_review:plan-reviewer:big@max', 'implement:implementer:mid@high', 'review:reviewer:big@max', 'qa:qa:mid@high'],
    },
    { name: 'full drops a plan review when the plan step was skipped', over: { flow: flow('full'), task: task(['security']) }, want: ['implement:implementer:mid@high', 'review:reviewer:big@max'] },
    { name: 'a migration raises the implement step', over: { flow: flow('quick'), task: task(['migration']) }, want: ['implement:implementer:big@high'] },
  ])('$name', ({ over, want }) => {
    expect(summary(planSteps(input(over)))).toEqual(want);
  });

  it('records each step’s score kind and starts it pending', () => {
    const plan = planSteps(input());
    expect(plan.steps.map((s) => [s.score, s.status, s.attempts, s.startedAt, s.result])).toEqual([
      ['coding', 'pending', 0, null, null],
      ['intelligence', 'pending', 0, null, null],
    ]);
  });

  it('uses a step’s own persona over the team’s binding', () => {
    const sec = persona('security-reviewer', 'review');
    const plan = planSteps(
      input({
        flow: flow('two-reviews', [
          { role: 'implement', need: 40, skip: [], persona: null },
          { role: 'review', need: 48, skip: [], persona: null },
          { role: 'review', need: 48, skip: [], persona: 'security-reviewer' },
        ]),
        personas: [...defaults, sec],
      }),
    );
    expect(plan.steps.map((s) => s.personaName)).toEqual(['implementer', 'reviewer', 'security-reviewer']);
  });

  it('uses the persona the team binds to a role, and its pin over the router', () => {
    const pinned = persona('opus-reviewer', 'review', { modelPin: { model: 'big', effort: 'max' } });
    const plan = planSteps(input({ personas: [...defaults, pinned], bindings: [{ role: 'review', personaId: pinned.id }] }));
    expect(plan.steps[1]).toMatchObject({ personaId: pinned.id, model: 'big', effort: 'max', pinned: true, reason: 'pinned by opus-reviewer' });
  });

  it('raises a step to the persona’s minimum score', () => {
    const strict = persona('reviewer', 'review', { minimumScore: 52 });
    const plan = planSteps(input({ personas: [...defaults.filter((p) => p.key !== 'reviewer'), strict] }));
    expect(plan.steps[1]).toMatchObject({ model: 'big', effort: 'max' });
    expect(plan.steps[1]?.reason).toContain('floor: reviewer minimum');
  });

  it('runs the role’s default when a step names a persona that is gone or archived', () => {
    const plan = planSteps(
      input({
        flow: flow('ghost', [
          { role: 'implement', need: 40, skip: [], persona: null },
          { role: 'review', need: 48, skip: [], persona: 'old-reviewer' },
        ]),
      }),
    );
    expect(plan.steps[1]?.personaName).toBe('reviewer');
  });

  it('runs a role with no persona as a bare step', () => {
    const plan = planSteps(input({ flow: flow('quick'), personas: [] }));
    expect(plan.steps[0]).toMatchObject({ personaId: null, personaName: 'Implementer', tools: 'edit' });
  });

  it('falls back to the project’s model when nothing is measured', () => {
    const unmeasured = testCatalogue(
      Object.fromEntries(
        ['small@low', 'small@high', 'mid@low', 'mid@high', 'big@high', 'big@max'].map((k) => [
          k,
          { scores: { intelligence: null, coding: null, agentic: null }, costPerTaskUsd: null },
        ]),
      ),
    );
    const plan = planSteps(input({ profiles: unmeasured }));
    expect(plan.steps.map((s) => [s.model, s.effort, s.pinned, s.profileId])).toEqual([
      ['sonnet', 'medium', true, null],
      ['sonnet', 'medium', true, null],
    ]);
    expect(plan.steps[0]?.reason).toBe(
      "no profile has a coding score yet: runs on the project's model (sync Artificial Analysis to route by score)",
    );
    expect(plan.overBudget).toEqual([]);
  });

  it('lists the steps no profile within the ceiling can run', () => {
    const plan = planSteps(input({ project: { ...project, budgetCeiling: 1.5 } }));
    expect(plan.overBudget).toEqual([1]);
    expect(plan.steps.map((s) => s.overBudget)).toEqual([false, true]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @10db/daemon exec vitest run src/routing`
Expected: FAIL, because the module doesn't exist.

- [ ] **Step 3: Write the catalogue, floors and skip rules**

`apps/daemon/src/routing/catalogue.ts`:

```ts
import { Effort, StepRole, type FlowInput, type Provider } from '@10db/contracts';

export interface SeedProfile {
  readonly provider: Provider;
  readonly model: string;
  readonly effort: Effort;
  readonly aaSlug: string;
  readonly enabled: boolean;
}

/** Claude Code's model aliases and the AA family each maps to; the slugs only, never AA's data. */
const FAMILIES = [
  { model: 'haiku', aaFamily: 'claude-haiku-5-5', enabled: true },
  { model: 'sonnet', aaFamily: 'claude-sonnet-5-5', enabled: true },
  { model: 'opus', aaFamily: 'claude-opus-5-5', enabled: true },
  // Off until Claude Code accepts the alias.
  { model: 'fable', aaFamily: 'claude-fable-5-1', enabled: false },
] as const;

/** AA lists `max` under the family slug and every other effort as `<family>-<effort>`. */
export const SEED_PROFILES: readonly SeedProfile[] = FAMILIES.flatMap((family) =>
  Object.values(Effort).map((effort) => ({
    provider: 'claude' as const,
    model: family.model,
    effort,
    aaSlug: effort === Effort.Max ? family.aaFamily : `${family.aaFamily}-${effort}`,
    enabled: family.enabled,
  })),
);

/** Starting needs, in the role's index points (spec §15): heuristics to tune, not AA data. */
const NEED = { plan: 45, planReview: 48, implement: 40, review: 48, qa: 35 } as const;

export const DEFAULT_FLOWS: readonly FlowInput[] = [
  { name: 'quick', steps: [{ role: StepRole.Implement, need: NEED.implement }] },
  {
    name: 'standard',
    steps: [
      { role: StepRole.Implement, need: NEED.implement },
      { role: StepRole.Review, need: NEED.review },
    ],
  },
  {
    name: 'full',
    steps: [
      { role: StepRole.Plan, need: NEED.plan, skip: [{ kind: 'unless_criteria_over', count: 3 }] },
      { role: StepRole.PlanReview, need: NEED.planReview, skip: [{ kind: 'unless_risk', tags: ['security', 'auth', 'migration'] }] },
      { role: StepRole.Implement, need: NEED.implement },
      { role: StepRole.Review, need: NEED.review },
      { role: StepRole.Qa, need: NEED.qa, skip: [{ kind: 'unless_criteria_over', count: 3 }] },
    ],
  },
];

/** A project with no flow of its own runs this one. */
export const DEFAULT_PROJECT_FLOW = 'standard';

/** The seeded persona each role falls back to when neither the step nor the team names one. */
export const DEFAULT_PERSONA_FOR: Readonly<Record<StepRole, string>> = {
  plan: 'planner',
  plan_review: 'plan-reviewer',
  implement: 'implementer',
  review: 'reviewer',
  qa: 'qa',
};
```

`Object.values(Effort)` follows the order `Effort` declares (`low`, `medium`, `high`, `xhigh`, `max`).

`apps/daemon/src/routing/floors.ts`:

```ts
import { RiskTag, StepRole } from '@10db/contracts';

export interface Floor {
  readonly minimum: number;
  readonly why: string | null;
}

interface FloorRule {
  readonly roles: readonly StepRole[];
  readonly tags: readonly RiskTag[];
  readonly minimum: number;
  readonly why: string;
}

/** Rule floors (spec §5.2.3), in the role's index points: a matching role and risk tag needs at least this. */
const FLOOR_RULES: readonly FloorRule[] = [
  { roles: [StepRole.Review, StepRole.PlanReview], tags: [RiskTag.Security, RiskTag.Auth], minimum: 52, why: 'security-sensitive review' },
  { roles: [StepRole.Implement], tags: [RiskTag.Migration], minimum: 45, why: 'migration' },
];

export function stepFloor(role: StepRole, riskTags: readonly RiskTag[]): Floor {
  let floor: Floor = { minimum: 0, why: null };
  for (const rule of FLOOR_RULES) {
    if (!rule.roles.includes(role) || !rule.tags.some((t) => riskTags.includes(t))) continue;
    if (rule.minimum > floor.minimum) floor = { minimum: rule.minimum, why: rule.why };
  }
  return floor;
}

/** The higher of two floors; a persona's minimum score is one. */
export function higherFloor(a: Floor, b: Floor): Floor {
  return b.minimum > a.minimum ? b : a;
}
```

`apps/daemon/src/routing/skip-rules.ts`:

```ts
import type { FlowStepDef, SkipRule, TaskDto } from '@10db/contracts';

export type TaskShape = Pick<TaskDto, 'riskTags' | 'acceptanceCriteria'>;

function holds(rule: SkipRule, task: TaskShape): boolean {
  switch (rule.kind) {
    case 'unless_risk':
      return rule.tags.some((t) => task.riskTags.includes(t));
    case 'unless_criteria_over':
      return task.acceptanceCriteria.length > rule.count;
  }
}

function describeRule(rule: SkipRule): string {
  switch (rule.kind) {
    case 'unless_risk':
      return `no ${rule.tags.join(' or ')} risk`;
    case 'unless_criteria_over':
      return `${String(rule.count)} or fewer acceptance criteria`;
  }
}

/** Why a step is skipped for this task, or null when it runs. A step runs when any of its rules holds. */
export function skipReason(step: FlowStepDef, task: TaskShape): string | null {
  if (step.skip.length === 0 || step.skip.some((rule) => holds(rule, task))) return null;
  return step.skip.map(describeRule).join(' and ');
}
```

- [ ] **Step 4: Write the router and escalation**

`apps/daemon/src/routing/router.ts`:

```ts
import { ROLE_SCORE, type ModelProfileDto, type Provider, type ScoreKind, type StepRole, type WorkstreamStep } from '@10db/contracts';
import type { Floor } from './floors';

export interface RouteInput {
  readonly provider: Provider;
  readonly role: StepRole;
  readonly need: number;
  readonly floor: Floor;
  readonly budgetCeiling: number | null;
  readonly profiles: readonly ModelProfileDto[];
}

export interface RouteChoice {
  readonly profile: ModelProfileDto;
  readonly reason: string;
  readonly overBudget: boolean;
}

/** Profiles are measured, but none of the provider's reaches a step's minimum score. */
export class NoProfileError extends Error {
  override name = 'NoProfileError';
}

/** No enabled profile of the provider has the role's score and a cost yet: there is nothing to route on. */
export class UnmeasuredError extends Error {
  override name = 'UnmeasuredError';
}

const score = (p: ModelProfileDto, kind: ScoreKind): number | null => p.scores[kind];

function measured(profiles: readonly ModelProfileDto[], provider: Provider, kind: ScoreKind): ModelProfileDto[] {
  return profiles.filter((p) => p.enabled && p.provider === provider && score(p, kind) !== null && p.costPerTaskUsd !== null);
}

const preference = (kind: ScoreKind) => (a: ModelProfileDto, b: ModelProfileDto) =>
  (a.costPerTaskUsd ?? 0) - (b.costPerTaskUsd ?? 0) ||
  (b.outputTokensPerSecond ?? 0) - (a.outputTokensPerSecond ?? 0) ||
  (score(a, kind) ?? 0) - (score(b, kind) ?? 0);

const withinCeiling = (p: ModelProfileDto, ceiling: number | null) => ceiling === null || (p.costPerTaskUsd ?? 0) <= ceiling;
const dollars = (n: number) => `$${String(n)}`;

/** The cheapest measured profile at or above the step's need and floor, within the ceiling (spec §5.2.3). */
export function route(input: RouteInput): RouteChoice {
  const kind = ROLE_SCORE[input.role];
  const candidates = measured(input.profiles, input.provider, kind);
  if (candidates.length === 0) throw new UnmeasuredError(`No ${input.provider} profile has a ${kind} score yet`);
  const minimum = Math.max(input.need, input.floor.minimum);
  const able = candidates.filter((p) => (score(p, kind) ?? 0) >= minimum).sort(preference(kind));
  const best = able.find((p) => withinCeiling(p, input.budgetCeiling)) ?? able[0];
  if (!best) throw new NoProfileError(`No enabled ${input.provider} profile reaches ${String(minimum)} ${kind}`);
  const overBudget = !withinCeiling(best, input.budgetCeiling);
  const floor = input.floor.why && input.floor.minimum > input.need ? ` (floor: ${input.floor.why})` : '';
  const budget = overBudget && input.budgetCeiling !== null ? `; over the budget ceiling of ${dollars(input.budgetCeiling)}` : '';
  return { profile: best, overBudget, reason: `cheapest profile at or above ${String(minimum)} ${kind}${floor}${budget}` };
}

export interface EscalateInput {
  readonly provider: Provider;
  readonly budgetCeiling: number | null;
  readonly profiles: readonly ModelProfileDto[];
  /** Why the step is being retried, as a phrase: "the gate failed". */
  readonly why: string;
}

/** One profile up the step's own score (spec §5.2.5); a pinned step, the top, or the ceiling keeps it. */
export function escalateStep(step: WorkstreamStep, input: EscalateInput): { readonly step: WorkstreamStep; readonly escalated: boolean } {
  const current = `${step.model}@${step.effort}`;
  if (step.pinned) return { step: { ...step, reason: `kept ${current} after ${input.why}: pinned` }, escalated: false };
  const here = input.profiles.find((p) => p.id === step.profileId);
  const level = (here && score(here, step.score)) ?? step.need;
  const next = measured(input.profiles, input.provider, step.score)
    .filter((p) => (score(p, step.score) ?? 0) > level && withinCeiling(p, input.budgetCeiling))
    .sort(preference(step.score))[0];
  if (!next) {
    const limit =
      input.budgetCeiling === null
        ? 'no stronger profile'
        : `no stronger profile within the budget ceiling of ${dollars(input.budgetCeiling)}`;
    return { step: { ...step, reason: `kept ${current} after ${input.why}: ${limit}` }, escalated: false };
  }
  return {
    escalated: true,
    step: { ...step, profileId: next.id, model: next.model, effort: next.effort, overBudget: false, reason: `escalated from ${current} after ${input.why}` },
  };
}
```

- [ ] **Step 5: Write the step planner**

`apps/daemon/src/routing/plan-steps.ts`:

```ts
import {
  ROLE_LABEL,
  ROLE_SCORE,
  StepRole,
  ToolAccess,
  type FlowDto,
  type FlowStepDef,
  type ModelProfileDto,
  type PersonaDto,
  type ProjectDto,
  type StepPlanDto,
  type TeamBinding,
  type WorkstreamStep,
} from '@10db/contracts';
import { DEFAULT_PERSONA_FOR } from './catalogue';
import { higherFloor, stepFloor } from './floors';
import { route, UnmeasuredError } from './router';
import { skipReason, type TaskShape } from './skip-rules';

export interface PlanInput {
  readonly flow: FlowDto;
  readonly task: TaskShape;
  /** The project's model and effort run a step nothing is measured for. */
  readonly project: Pick<ProjectDto, 'provider' | 'budgetCeiling' | 'model' | 'effort'>;
  /** Personas that may play a role: archived ones are left out by the caller. */
  readonly personas: readonly PersonaDto[];
  readonly bindings: readonly TeamBinding[];
  readonly profiles: readonly ModelProfileDto[];
}

/**
 * A step's own persona, then the team's binding for its role, then the seeded default, then any of the role.
 * The caller passes live personas only, so a step naming an archived one runs the role's default.
 */
function personaFor(def: FlowStepDef, input: PlanInput): PersonaDto | undefined {
  const own = def.persona === null ? undefined : input.personas.find((p) => p.key === def.persona && p.role === def.role);
  const bound = input.bindings.find((b) => b.role === def.role);
  return (
    own ??
    (bound ? input.personas.find((p) => p.id === bound.personaId) : undefined) ??
    input.personas.find((p) => p.key === DEFAULT_PERSONA_FOR[def.role]) ??
    input.personas.find((p) => p.role === def.role)
  );
}

function routedStep(def: FlowStepDef, persona: PersonaDto | undefined, input: PlanInput): WorkstreamStep {
  const kind = ROLE_SCORE[def.role];
  const base = {
    role: def.role,
    personaId: persona?.id ?? null,
    personaName: persona?.name ?? ROLE_LABEL[def.role],
    tools: def.role === StepRole.Implement ? ToolAccess.Edit : ToolAccess.ReadOnly,
    score: kind,
    need: def.need,
    status: 'pending',
    attempts: 0,
    startedAt: null,
    sessionFloor: 0,
    result: null,
  } as const;
  const pin = persona?.modelPin ?? null;
  if (pin && persona) {
    const pinned = input.profiles.find((p) => p.provider === input.project.provider && p.model === pin.model && p.effort === pin.effort);
    return { ...base, profileId: pinned?.id ?? null, model: pin.model, effort: pin.effort, reason: `pinned by ${persona.key}`, overBudget: false, pinned: true };
  }
  const personaFloor =
    persona && persona.minimumScore !== null
      ? { minimum: persona.minimumScore, why: `${persona.key} minimum` }
      : { minimum: 0, why: null };
  try {
    const choice = route({
      provider: input.project.provider,
      role: def.role,
      need: def.need,
      floor: higherFloor(stepFloor(def.role, input.task.riskTags), personaFloor),
      budgetCeiling: input.project.budgetCeiling,
      profiles: input.profiles,
    });
    return {
      ...base,
      profileId: choice.profile.id,
      model: choice.profile.model,
      effort: choice.profile.effort,
      reason: choice.reason,
      overBudget: choice.overBudget,
      pinned: false,
    };
  } catch (error) {
    if (!(error instanceof UnmeasuredError)) throw error;
    return {
      ...base,
      profileId: null,
      model: input.project.model,
      effort: input.project.effort,
      reason: `no profile has a ${kind} score yet: runs on the project's model (sync Artificial Analysis to route by score)`,
      overBudget: false,
      pinned: true,
    };
  }
}

/** Resolves a flow into the steps a workstream runs. Skipped steps are left out. */
export function planSteps(input: PlanInput): StepPlanDto {
  const steps: WorkstreamStep[] = [];
  for (const def of input.flow.steps) {
    if (skipReason(def, input.task) !== null) continue;
    // A plan review with no plan before it has nothing to judge and nowhere to send a rejection.
    if (def.role === StepRole.PlanReview && !steps.some((s) => s.role === StepRole.Plan)) continue;
    steps.push(routedStep(def, personaFor(def, input), input));
  }
  return { flowName: input.flow.name, steps, overBudget: steps.flatMap((s, i) => (s.overBudget ? [i] : [])) };
}
```

`apps/daemon/src/routing/index.ts`:

```ts
export { DEFAULT_FLOWS, DEFAULT_PROJECT_FLOW, SEED_PROFILES } from './catalogue';
export { planSteps } from './plan-steps';
export { escalateStep, NoProfileError } from './router';
```

These are the names Tasks 6 and 9 import; the module's own tests import from its files. Until those tasks land, knip may flag the entry point; that resolves by Task 9, and the gate runs at the end (Task 12).

- [ ] **Step 6: Document the module**

In `apps/daemon/AGENTS.md`:
- Add `routing` to the first dependency group: `clock`, `log`, `events`, `guard`, `permissions`, `git`, `verify`, `routing` → …
- Add a bullet: "`routing/` is pure: flows, floors, the per-role AA score, the router, escalation and step plans over rows its caller passes in. It imports `@10db/contracts` only. Its tests use the invented catalogue in `test-catalogue.ts`, never AA's numbers."

- [ ] **Step 7: Run the tests**

Run: `pnpm --filter @10db/daemon exec vitest run src/routing && pnpm --filter @10db/daemon typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
pnpm format && git add apps/daemon/src/routing apps/daemon/AGENTS.md && git commit -m 'feat(daemon): route steps by their role’s aa score, with floors, skip rules and escalation'
```

---
### Task 6: Seeding, step plans at start, and the tests that start tasks

The daemon seeds the catalogue definitions, the default flows, the default personas and the builder when it starts. Starting a task resolves and stores its step plan, refusing an over-budget plan. Tests that start tasks through the API and script only an implement session pin the `quick` flow; the e2e loop gains a review session, so the standard flow runs end to end through the UI.

**Files:**
- Create: `apps/daemon/src/team/seed.ts`, `apps/daemon/src/team/steps.ts`, `apps/daemon/src/team/index.ts`, `apps/daemon/test/catalogue.ts`
- Modify: `apps/daemon/src/daemon/start.ts`, `apps/daemon/src/daemon/services.ts`, `apps/daemon/src/api/services.ts`, `apps/daemon/src/api/app.ts`, `apps/daemon/src/api/app.test.ts`, `apps/daemon/src/main.ts`, `apps/daemon/test/engine.ts`, `apps/daemon/test/api-client.ts`, `apps/daemon/test/acceptance.test.ts`, `apps/daemon/test/crash-recovery.test.ts`, `apps/daemon/test/acceptance-checks.test.ts`, `apps/daemon/src/daemon/start.test.ts`, `apps/desktop/e2e/script-book.json`, `apps/daemon/AGENTS.md`
- Test: `apps/daemon/src/team/seed.test.ts`, `apps/daemon/src/team/steps.test.ts`

**Interfaces:**
- Consumes:
  - Tasks 2 and 3: the repositories.
  - Task 4: `readDefaultPersonas` and `HarnessPersona`.
  - Task 5: `planSteps`, `SEED_PROFILES`, `DEFAULT_FLOWS`, `DEFAULT_PROJECT_FLOW` and `NoProfileError`.
- Produces:
  - `seedTeam(state: StateStore, personas: readonly HarnessPersona[]): void`.
  - `resolveStepPlan(db: DbReader, taskId: TaskId): StepPlanDto`, which throws `InvalidError` when no flow fits or no measured profile reaches a need.
  - `startTaskWithPlan(state: StateStore, taskId: TaskId): WorkstreamDto`, which throws `InvalidError` naming the over-budget steps.
  - `DaemonOptions.harnessDir?: string`.
  - `GET /flows` (`ApiServices.listFlows(): FlowDto[]`); Task 10 adds the other routes.
  - `quickFlowId(api): Promise<FlowId>` in `apps/daemon/test/api-client.ts`.
  - `measureForTests(state: StateStore): void` in `apps/daemon/test/catalogue.ts`. It gives every seeded profile an invented measurement, so runner tests route deterministically.
  - `TestEngine.addTask(title, areas?, dependsOn?, plan?: { flow: string; riskTags?: RiskTag[]; criteria?: number })`. With `plan`, the task starts through `startTaskWithPlan`; without it, it starts as before, with no stored steps.

**Invented test catalogue** (`measureForTests`). Every score kind gets the same number: base by model plus a bonus by effort.

| | base | cost (USD) | speed |
|---|---|---|---|
| `haiku` | 20 | 0.05 | 200 |
| `sonnet` | 35 | 0.3 | 100 |
| `opus` | 45 | 1.0 | 50 |

- Effort bonus: `low` +0, `medium` +3, `high` +6, `xhigh` +8, `max` +10.
- Cost multiplier: `low` ×1, `medium` ×1.5, `high` ×2.5, `xhigh` ×4, `max` ×6.

With it, the default needs route to:

| Role | Need | Profile |
|---|---|---|
| implement | coding 40 | `sonnet@high` (41, $0.75) |
| review | intelligence 48 | `opus@medium` (48, $1.50) |
| plan | intelligence 45 | `opus@low` (45, $1.00) |
| QA | agentic 35 | `sonnet@low` (35, $0.30) |

Escalating implement from `sonnet@high` moves to `opus@low`, the cheapest profile with a higher score ($1.00, cheaper than `sonnet@xhigh` at $1.20).

- [ ] **Step 1: Write the failing tests**

`apps/daemon/test/catalogue.ts`:

```ts
import type { Effort } from '@10db/contracts';
import { applyAaMeasurement, listModelProfiles } from '@10db/db';
import type { StateStore } from '../src/events';

/** Score base, cost per task and speed by model alias. */
const BASE: Readonly<Record<string, readonly [number, number, number]>> = {
  haiku: [20, 0.05, 200],
  sonnet: [35, 0.3, 100],
  opus: [45, 1, 50],
  fable: [50, 2, 40],
};
/** Score bonus and cost multiplier by effort. */
const EFFORT: Readonly<Record<Effort, readonly [number, number]>> = {
  low: [0, 1],
  medium: [3, 1.5],
  high: [6, 2.5],
  xhigh: [8, 4],
  max: [10, 6],
};

/** Invented measurements for the seeded catalogue: deterministic routing in tests, and never AA's numbers. */
export function measureForTests(state: StateStore): void {
  state.write((ctx) => {
    for (const p of listModelProfiles(ctx.tx)) {
      const model = BASE[p.model];
      if (!model) continue;
      const [base, cost, tps] = model;
      const [bonus, mult] = EFFORT[p.effort];
      const score = base + bonus;
      applyAaMeasurement(ctx, p.id, {
        scores: { intelligence: score, coding: score, agentic: score },
        costPerTaskUsd: cost * mult,
        outputTokensPerSecond: tps,
        indexVersion: 'test',
        measuredAt: ctx.now,
      });
    }
  });
}
```

`apps/daemon/src/team/seed.test.ts`:

```ts
import { createTestStore, findPersonByHandle, findPersonaByKey, listFlows, listModelProfiles, listPersonas, patchPersona } from '@10db/db';
import { readDefaultPersonas } from '@10db/harness';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { DEFAULT_FLOWS, SEED_PROFILES } from '../routing';
import { seedTeam } from './seed';

let state: StateStore;
let close: () => void;
beforeEach(() => {
  const test = createTestStore();
  close = test.close;
  state = createStateStore(test.store, createEventBus());
});
afterEach(() => {
  close();
});

describe('seedTeam', () => {
  it('seeds unmeasured profiles, the flows, the personas and the builder', () => {
    seedTeam(state, readDefaultPersonas());
    const profiles = listModelProfiles(state.db);
    expect(profiles).toHaveLength(SEED_PROFILES.length);
    expect(profiles.every((p) => p.scores.coding === null && p.costPerTaskUsd === null && p.source === 'aa')).toBe(true);
    expect(profiles.find((p) => p.model === 'opus' && p.effort === 'high')?.aaSlug).toBe('claude-opus-5-5-high');
    expect(profiles.find((p) => p.model === 'opus' && p.effort === 'max')?.aaSlug).toBe('claude-opus-5-5');
    expect(profiles.filter((p) => p.model === 'fable').every((p) => !p.enabled)).toBe(true);
    expect(listFlows(state.db).map((f) => f.name).sort()).toEqual(DEFAULT_FLOWS.map((f) => f.name).sort());
    expect(listPersonas(state.db).map((p) => p.key)).toEqual(['implementer', 'plan-reviewer', 'planner', 'qa', 'reviewer']);
    expect(findPersonByHandle(state.db, 'me')).toMatchObject({ isBuilder: true });
  });

  it('adds nothing the second time and keeps the builder’s edits', () => {
    seedTeam(state, readDefaultPersonas());
    const reviewer = findPersonaByKey(state.db, 'reviewer');
    if (!reviewer) throw new Error('reviewer was not seeded');
    state.write((ctx) => patchPersona(ctx, reviewer.id, { instructions: 'Mine now.', archived: true }));
    seedTeam(state, readDefaultPersonas());
    expect(listModelProfiles(state.db)).toHaveLength(SEED_PROFILES.length);
    expect(listPersonas(state.db, { includeArchived: true })).toHaveLength(5);
    expect(findPersonaByKey(state.db, 'reviewer')).toMatchObject({ instructions: 'Mine now.', archived: true });
  });
});
```

`apps/daemon/src/team/steps.test.ts`:

```ts
import { InvalidError } from '@10db/contracts';
import { createTestStore, findFlowByName, getWorkstream, insertTask, patchProject, patchTask, seedProject } from '@10db/db';
import { readDefaultPersonas } from '@10db/harness';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { measureForTests } from '../../test/catalogue';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { seedTeam } from './seed';
import { resolveStepPlan, startTaskWithPlan } from './steps';

let state: StateStore;
let close: () => void;
let project: ReturnType<typeof seedProject>;
beforeEach(() => {
  const test = createTestStore();
  close = test.close;
  state = createStateStore(test.store, createEventBus());
  seedTeam(state, readDefaultPersonas());
  project = seedProject(test.store); // model sonnet, effort medium
});
afterEach(() => {
  close();
});

const addTask = () => state.write((ctx) => insertTask(ctx, project.id, { title: 'T', acceptanceCriteria: ['x'], areas: ['api'] }));
const flowId = (name: string) => {
  const flow = findFlowByName(state.db, name);
  if (!flow) throw new Error(name);
  return flow.id;
};

describe('resolveStepPlan', () => {
  it.each([
    { name: 'the standard flow by default', projectFlow: null, taskFlow: null, roles: ['implement', 'review'] },
    { name: "the project's flow over the default", projectFlow: 'quick', taskFlow: null, roles: ['implement'] },
    { name: "the task's flow over the project's", projectFlow: 'quick', taskFlow: 'standard', roles: ['implement', 'review'] },
  ])('uses $name', ({ projectFlow, taskFlow, roles }) => {
    const task = addTask();
    if (projectFlow) state.write((ctx) => patchProject(ctx, project.id, { flowId: flowId(projectFlow) }));
    if (taskFlow) state.write((ctx) => patchTask(ctx, task.id, { flowId: flowId(taskFlow) }));
    expect(resolveStepPlan(state.db, task.id).steps.map((s) => s.role)).toEqual(roles);
  });

  it('routes on the measured catalogue once there is one', () => {
    measureForTests(state);
    const plan = resolveStepPlan(state.db, addTask().id);
    expect(plan.steps.map((s) => `${s.model}@${s.effort}`)).toEqual(['sonnet@high', 'opus@medium']);
  });
});

describe('startTaskWithPlan', () => {
  it('stores the plan, starts its first step, and runs on the project’s model before anything is measured', () => {
    const ws = startTaskWithPlan(state, addTask().id);
    expect(ws.steps.map((s) => [s.role, s.status])).toEqual([
      ['implement', 'running'],
      ['review', 'pending'],
    ]);
    expect(ws.steps[0]?.startedAt).not.toBeNull();
    expect(getWorkstream(state.db, ws.id)).toMatchObject({ stepIndex: 0, model: 'sonnet', effort: 'medium' });
  });

  it('refuses to start a task whose step plan is over budget, naming the step', () => {
    measureForTests(state);
    const task = addTask();
    state.write((ctx) => patchProject(ctx, project.id, { budgetCeiling: 1 }));
    expect(() => startTaskWithPlan(state, task.id)).toThrow(InvalidError);
    expect(() => startTaskWithPlan(state, task.id)).toThrow(
      'Step 2 (review, need 48 intelligence) has no profile within the budget ceiling of $1',
    );
  });
});
```

The over-budget case: implement routes to `sonnet@high` ($0.75, within $1); review needs 48, and the cheapest profile reaching it is `opus@medium` at $1.50.

In `apps/daemon/src/api/app.test.ts`, add `listFlows: () => []` to `stubServices`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @10db/daemon exec vitest run src/team`
Expected: FAIL, because the module doesn't exist.

- [ ] **Step 3: Write the seeding**

`apps/daemon/src/team/seed.ts`:

```ts
import { PersonaInput } from '@10db/contracts';
import {
  BUILDER_HANDLE,
  findFlowByName,
  findModelProfile,
  findPersonByHandle,
  findPersonaByKey,
  insertFlow,
  insertModelProfile,
  insertPerson,
  insertPersona,
} from '@10db/db';
import type { HarnessPersona } from '@10db/harness';
import type { StateStore } from '../events';
import { DEFAULT_FLOWS, SEED_PROFILES } from '../routing';

/** Adds whatever is missing, in one transaction; never changes a row that exists, so the builder's edits win. */
export function seedTeam(state: StateStore, personas: readonly HarnessPersona[]): void {
  state.write((ctx) => {
    for (const profile of SEED_PROFILES)
      if (!findModelProfile(ctx.tx, profile.provider, profile.model, profile.effort)) insertModelProfile(ctx, profile);
    for (const persona of personas)
      if (!findPersonaByKey(ctx.tx, persona.key)) insertPersona(ctx, PersonaInput.parse(persona));
    for (const flow of DEFAULT_FLOWS) if (!findFlowByName(ctx.tx, flow.name)) insertFlow(ctx, flow);
    if (!findPersonByHandle(ctx.tx, BUILDER_HANDLE)) insertPerson(ctx, { handle: BUILDER_HANDLE, name: 'You', isBuilder: true });
  });
}
```

Personas are seeded before flows, because a flow may name a persona. `PersonaInput.parse(persona)` is the boundary between the harness's own enums and the contracts'.

- [ ] **Step 4: Write the step plan service**

`apps/daemon/src/team/steps.ts`:

```ts
import { InvalidError, type StepPlanDto, type TaskId, type WorkstreamDto } from '@10db/contracts';
import {
  findFlowByName,
  getFlow,
  getProject,
  getTask,
  getTeam,
  getWorkstream,
  insertWorkstream,
  listModelProfiles,
  listPersonas,
  patchWorkstream,
  type DbReader,
} from '@10db/db';
import type { StateStore } from '../events';
import { DEFAULT_PROJECT_FLOW, NoProfileError, planSteps } from '../routing';

/** What starting this task would run: its flow resolved against the project's team and the catalogue. */
export function resolveStepPlan(db: DbReader, taskId: TaskId): StepPlanDto {
  const task = getTask(db, taskId);
  const project = getProject(db, task.projectId);
  const flowId = task.flowId ?? project.flowId;
  const flow = flowId ? getFlow(db, flowId) : findFlowByName(db, DEFAULT_PROJECT_FLOW);
  if (!flow) throw new InvalidError(`The ${DEFAULT_PROJECT_FLOW} flow is missing; restart 10db to seed it`);
  try {
    return planSteps({
      flow,
      task,
      project,
      personas: listPersonas(db),
      bindings: getTeam(db, project.id).bindings,
      profiles: listModelProfiles(db),
    });
  } catch (error) {
    if (error instanceof NoProfileError) throw new InvalidError(error.message);
    throw error;
  }
}

/** Starts a task on its resolved plan, refusing one that no profile within the budget ceiling can run. */
export function startTaskWithPlan(state: StateStore, taskId: TaskId): WorkstreamDto {
  const plan = resolveStepPlan(state.db, taskId);
  if (plan.overBudget.length > 0) {
    const ceiling = getProject(state.db, getTask(state.db, taskId).projectId).budgetCeiling;
    const named = plan.overBudget.map((i) => {
      const step = plan.steps[i];
      const need = step ? `${String(step.need)} ${step.score}` : '?';
      return `Step ${String(i + 1)} (${step?.role ?? '?'}, need ${need}) has no profile within the budget ceiling of $${String(ceiling)}`;
    });
    throw new InvalidError(`${named.join('. ')}. Raise the ceiling, lower the need or pin a persona.`);
  }
  const first = plan.steps[0];
  if (!first) throw new InvalidError('The flow resolved to no steps');
  return state.write((ctx) => {
    const ws = insertWorkstream(ctx, taskId);
    patchWorkstream(ctx, ws.id, null, {
      steps: plan.steps.map((s, i) => (i === 0 ? { ...s, status: 'running', startedAt: ctx.now } : s)),
      stepIndex: 0,
      model: first.model,
      effort: first.effort,
    });
    return getWorkstream(ctx.tx, ws.id);
  });
}
```

`apps/daemon/src/team/index.ts`:

```ts
export { seedTeam } from './seed';
export { resolveStepPlan, startTaskWithPlan } from './steps';
```

- [ ] **Step 5: Wire it into the daemon, the API and the test engine**

In `apps/daemon/src/daemon/start.ts`:
- Add `/** The harness plugin folder the default personas are read from. */ readonly harnessDir?: string;` to `DaemonOptions`.
- Right after `const state = createStateStore(…)`, add `seedTeam(state, readDefaultPersonas(opts.harnessDir ?? HARNESS_PLUGIN_DIR));`. A malformed persona file throws `PersonaManifestError` and the daemon doesn't start, which is the same policy as a failed migration.

In `apps/daemon/src/main.ts`, pass `harnessDir: resolveHarnessDir()` next to `migrationsDir`.

In `apps/daemon/src/daemon/services.ts`, replace the body of `startTask`, and add `listFlows`:

```ts
    startTask(taskId) {
      const ws = startTaskWithPlan(deps.state, taskId);
      deps.scheduler.requestTick();
      return ws;
    },
    listFlows: () => listFlows(db),
```

In `apps/daemon/src/api/services.ts`, add `listFlows(): FlowDto[];`. In `apps/daemon/src/api/app.ts`, chain `.get('/flows', (c) => c.json(deps.services.listFlows()))` onto the routes.

In `apps/daemon/test/api-client.ts`, add `put` and `patch` beside `post`, with the same shape, and:

```ts
/** The seeded `quick` flow (implement only), for tests whose scripts run one implement session per task. */
export async function quickFlowId(api: ReturnType<typeof apiClient>): Promise<FlowId> {
  const quick = (await api.get('/flows', z.array(FlowDto))).find((f) => f.name === 'quick');
  if (!quick) throw new Error('the quick flow was not seeded');
  return quick.id;
}
```

Change its `import type { z } from 'zod'` to a value import, since `z.array` is now called.

In `apps/daemon/test/engine.ts`:
- After the state store is created, call `seedTeam(state, readDefaultPersonas());` and then `measureForTests(state);`.
- Extend `addTask` with the optional `plan` argument from the Interfaces block:

```ts
    addTask(title, areas = ['api'], dependsOn = [], plan) {
      const criteria = Array.from({ length: plan?.criteria ?? 1 }, (_, i) => (i === 0 ? 'it works' : `criterion ${String(i + 1)}`));
      const flowId = plan ? (findFlowByName(store.db, plan.flow)?.id ?? null) : null;
      const task = state.write((ctx) =>
        insertTask(ctx, seeded.id, { title, acceptanceCriteria: criteria, areas, dependsOn, riskTags: plan?.riskTags ?? [], flowId }),
      );
      const workstream = plan ? startTaskWithPlan(state, task.id) : state.write((ctx) => insertWorkstream(ctx, task.id));
      return { task, workstream };
    },
```

Update the `TestEngine` interface to match. Existing tests call `addTask` without a plan, so they keep running pre-flow workstreams: one implement step on the project's model, exactly as before.

- [ ] **Step 6: Pin `quick` where a test scripts one implement session**

These tests start tasks through `POST /tasks/:id/start`, which now runs the `standard` flow, but their fake scripts end after the implement session. Pin `quick` in each project they create, by adding `flowId: await quickFlowId(api)` to the `POST /projects` body:
- `apps/daemon/test/acceptance.test.ts`: the project at its `api.post('/projects', …)` (Alpha, Beta and Gamma).
- `apps/daemon/test/crash-recovery.test.ts`: the project at its `api.post('/projects', …)`.
- `apps/daemon/test/acceptance-checks.test.ts`: the project at its `api.post('/projects', …)` in `beforeAll` (its tasks start through the API and it waits for every workstream to be DONE).
- `apps/daemon/src/daemon/start.test.ts`:
  - "does not count a clean stop against the recovery limit". It posts with a raw `call`; create an `apiClient(daemon.url, daemon.token)` there to look the flow up.
  - "holds keep-awake and watches the repo while a lane runs, and lets go when it is cancelled".

Then run the whole daemon suite. Any other test that starts a task through the API and expects DONE after one session gets the same one-line change.

The e2e loop keeps the default `standard` flow, and its script book gains the review session. In `apps/desktop/e2e/script-book.json`, append a second session to `"Write the greeting"`:

```json
    [
      {
        "do": "mcp",
        "tool": "complete_step",
        "args": { "opId": "op-e2e-review1", "summary": "The greeting is written and committed.", "verdict": "approve" }
      },
      { "do": "turn_complete" }
    ]
```

`loop.spec.ts`'s assertions (Done in the Factory and Tasks views, the review card "Gate passed with 1 commit(s).") still hold. The gate passed before the review, and the review commits nothing.

In `apps/daemon/AGENTS.md`:
- Add `team` to the second dependency group: `sessions`, `inbox`, `briefing`, `team` → `mcp` → …
- Add a bullet: "`team/` seeds the team configuration at start and turns a task into its stored step plan. Read the step a workstream is on with `currentStep` from `@10db/contracts`. Daemon tests get an invented measured catalogue from `test/catalogue.ts`."

- [ ] **Step 7: Run the tests**

Run: `pnpm --filter @10db/daemon exec vitest run && pnpm --filter @10db/daemon typecheck && pnpm --filter @10db/desktop e2e`
Expected: the new tests pass, every existing daemon test still passes, and the e2e loop still reaches Done. The runner doesn't walk steps until Task 9, so the script book's review session first runs there.

- [ ] **Step 8: Commit**

```bash
pnpm format && git add apps/daemon/src/team apps/daemon/src/daemon apps/daemon/src/api apps/daemon/src/main.ts apps/daemon/test apps/desktop/e2e/script-book.json apps/daemon/AGENTS.md && git commit -m 'feat(daemon): seed the team at start and start tasks on their resolved step plan'
```

---
### Task 7: The Artificial Analysis sync

10db fetches AA's free model list with the builder's own key, stores it locally and measures the catalogue by slug. Without a key it does nothing and says so; a failure keeps the last good data.

**Files:**
- Create: `apps/daemon/src/benchmarks/aa-client.ts`, `apps/daemon/src/benchmarks/sync.ts`, `apps/daemon/src/benchmarks/index.ts`
- Modify: `apps/daemon/src/environment/session-env.ts`, `apps/daemon/src/environment/index.ts`, `apps/daemon/src/daemon/start.ts`, `apps/daemon/src/main.ts`, `apps/daemon/AGENTS.md`, `README.md`
- Test: `apps/daemon/src/benchmarks/sync.test.ts`, `apps/daemon/src/environment/session-env.test.ts`

**Interfaces:**
- Consumes: Task 1 `AaModelDto`, `BenchmarkStatusDto`; Task 2 `replaceAaModels`, `listAaModels`, `listModelProfiles`, `applyAaMeasurement`, `getAppSetting`, `setAppSetting`; Task 6 seeding (the catalogue's slugs).
- Produces:
  - `AA_FREE_MODELS_URL`, `AA_SYNC_INTERVAL_MS`.
  - `fetchAaModels(deps: { fetch: typeof fetch; key: string; now: string }): Promise<AaFetchOutcome>`.
  - `createBenchmarkSync(deps: BenchmarkSyncDeps): BenchmarkSync`, where `BenchmarkSync = { status(): BenchmarkStatusDto; sync(): Promise<BenchmarkStatusDto>; start(): void; stop(): void }`.
  - `SecretSource.artificialAnalysisKey(): string | null`, read from Keychain service `10db`, account `artificial-analysis-api-key`.
  - `DaemonOptions.aaKey?: () => string | null` and `DaemonOptions.fetch?: typeof fetch`. Both are absent in tests, so the sync reports `no_key` and never touches the network.
  - `RunningDaemon.benchmarks: BenchmarkSync`, which Task 10's routes use.

- [ ] **Step 1: Write the failing tests**

In `apps/daemon/src/environment/session-env.test.ts`, inside `describe('keychainSecrets', …)`, add:

```ts
  it('reads the Artificial Analysis key from its own Keychain account', () => {
    const calls: (readonly string[])[] = [];
    const secrets = keychainSecretsWith((_cmd, args) => {
      calls.push(args);
      return 'aa-key\n';
    });
    expect(secrets.artificialAnalysisKey()).toBe('aa-key');
    expect(calls[0]).toEqual(['find-generic-password', '-s', '10db', '-a', 'artificial-analysis-api-key', '-w']);
  });
```

`apps/daemon/src/benchmarks/sync.test.ts`. The slugs are the catalogue's; every number is invented:

```ts
import { createTestStore, findModelProfile, listAaModels, patchModelProfile } from '@10db/db';
import { readDefaultPersonas } from '@10db/harness';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../clock';
import { createEventBus, createStateStore, type StateStore } from '../events';
import type { Logger } from '../log';
import { seedTeam } from '../team';
import { AA_FREE_MODELS_URL } from './aa-client';
import { AA_SYNC_INTERVAL_MS, createBenchmarkSync } from './index';
import type { BenchmarkSyncDeps } from './sync';

const KEY = 'aa-test-key-123';
const quiet: Logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined, child: () => quiet };

const entry = (slug: string, score: number) => ({
  id: `id-${slug}`,
  name: slug,
  slug,
  release_date: null,
  model_creator: { id: 'c', name: 'Test Lab' },
  evaluations: {
    artificial_analysis_intelligence_index: score,
    artificial_analysis_coding_index: score - 1,
    artificial_analysis_agentic_index: score - 2,
  },
  artificial_analysis_intelligence_index_cost: { total_cost: 1, cost_per_task: { total_cost: score / 100 } },
  pricing: { price_1m_input_tokens: 1, price_1m_output_tokens: 2 },
  performance: { median_output_tokens_per_second: 50 },
});
const page = (data: object[], hasMore: boolean, pageNo = 1) => ({
  tier: 'free',
  intelligence_index_version: '9.9',
  pagination: { page: pageNo, page_size: 200, total_pages: 2, has_more: hasMore },
  data,
});

let state: StateStore;
let close: () => void;
let clock: ManualClock;
let requests: { url: string; key: string | null }[];
beforeEach(() => {
  clock = new ManualClock(new Date('2026-10-17T12:00:00.000Z'));
  const test = createTestStore(() => clock.now());
  close = test.close;
  state = createStateStore(test.store, createEventBus());
  seedTeam(state, readDefaultPersonas());
  requests = [];
});
afterEach(() => {
  close();
});

type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | 'network-error';
function fakeFetch(...replies: Reply[]): typeof fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    requests.push({ url: String(input), key: headers.get('x-api-key') });
    const reply = replies.shift() ?? { status: 500 };
    if (reply === 'network-error') return Promise.reject(new TypeError('fetch failed'));
    return Promise.resolve(new Response(JSON.stringify(reply.body ?? {}), { status: reply.status, headers: reply.headers }));
  };
}
const sync = (fetchImpl: BenchmarkSyncDeps['fetch'], key: string | null = KEY, store: StateStore = state) =>
  createBenchmarkSync({ state: store, clock, fetch: fetchImpl, readKey: () => key, logger: quiet });
const opusHigh = () => findModelProfile(state.db, 'claude', 'opus', 'high');

describe('benchmark sync', () => {
  it('stores every page and measures the profiles whose slug AA lists', async () => {
    const status = await sync(
      fakeFetch(
        { status: 200, body: page([entry('claude-opus-5-5-high', 50), entry('other-lab-model', 30)], true) },
        { status: 200, body: page([entry('claude-sonnet-5-5', 45)], false, 2) },
      ),
    ).sync();
    expect(requests).toEqual([
      { url: `${AA_FREE_MODELS_URL}?page=1`, key: KEY },
      { url: `${AA_FREE_MODELS_URL}?page=2`, key: KEY },
    ]);
    expect(listAaModels(state.db).map((m) => m.slug)).toEqual(['claude-opus-5-5-high', 'claude-sonnet-5-5', 'other-lab-model']);
    expect(opusHigh()).toMatchObject({ scores: { intelligence: 50, coding: 49, agentic: 48 }, costPerTaskUsd: 0.5, outputTokensPerSecond: 50, indexVersion: '9.9' });
    expect(status).toMatchObject({ outcome: 'ok', models: 3, keyConfigured: true });
    expect(status.unmeasuredProfiles).toContain('opus@medium');
    expect(status.unmeasuredProfiles).not.toContain('opus@high');
    expect(status.unmeasuredProfiles).not.toContain('fable@max'); // disabled profiles are not reported
  });

  it.each([
    { name: 'no key', key: null, replies: [], outcome: 'no_key', requests: 0 },
    { name: 'a rejected key', key: KEY, replies: [{ status: 401 }], outcome: 'unauthorized', requests: 1 },
    { name: 'the rate limit', key: KEY, replies: [{ status: 429, headers: { 'Retry-After': '3600' } }], outcome: 'rate_limited', requests: 1 },
    { name: 'a server error', key: KEY, replies: [{ status: 503 }], outcome: 'failed', requests: 1 },
    { name: 'a network error', key: KEY, replies: ['network-error' as const], outcome: 'failed', requests: 1 },
    { name: 'a response of the wrong shape', key: KEY, replies: [{ status: 200, body: { data: 'nope' } }], outcome: 'failed', requests: 1 },
    { name: 'an empty list', key: KEY, replies: [{ status: 200, body: page([], false) }], outcome: 'failed', requests: 1 },
  ])('keeps the last good data after $name', async ({ key, replies, outcome, requests: count }) => {
    await sync(fakeFetch({ status: 200, body: page([entry('claude-opus-5-5-high', 50)], false) })).sync();
    requests = [];
    const status = await sync(fakeFetch(...replies), key).sync();
    expect(status.outcome).toBe(outcome);
    expect(requests).toHaveLength(count);
    expect(listAaModels(state.db).map((m) => m.slug)).toEqual(['claude-opus-5-5-high']);
    expect(opusHigh()?.scores.intelligence).toBe(50);
    expect(JSON.stringify(status)).not.toContain(KEY);
  });

  it('reports a listed profile AA gives no cost as unmeasured', async () => {
    const unpriced = { ...entry('claude-opus-5-5-high', 50), artificial_analysis_intelligence_index_cost: null };
    const status = await sync(fakeFetch({ status: 200, body: page([unpriced], false) })).sync();
    expect(status.outcome).toBe('ok');
    expect(status.unmeasuredProfiles).toContain('opus@high');
  });

  it('records a database failure as a failed sync instead of rejecting', async () => {
    const failing: StateStore = {
      ...state,
      write: () => {
        throw new Error('disk I/O error');
      },
    };
    const status = await sync(fakeFetch({ status: 200, body: page([entry('claude-opus-5-5-high', 50)], false) }), KEY, failing).sync();
    expect(status.outcome).toBe('failed');
    expect(status.message).toContain('Error');
    expect(listAaModels(state.db)).toEqual([]);
  });

  it('leaves a profile the builder edited alone', async () => {
    const profile = opusHigh();
    if (!profile) throw new Error('not seeded');
    state.write((ctx) => patchModelProfile(ctx, profile.id, { costPerTaskUsd: 9 }));
    await sync(fakeFetch({ status: 200, body: page([entry('claude-opus-5-5-high', 50)], false) })).sync();
    expect(opusHigh()).toMatchObject({ source: 'manual', costPerTaskUsd: 9, scores: { intelligence: null } });
  });

  it('syncs at start when the last success is stale, then once a day', async () => {
    const replies = () => ({ status: 200, body: page([entry('claude-opus-5-5-high', 50)], false) });
    const s = sync(fakeFetch(replies(), replies(), replies()));
    s.start();
    await vi.waitFor(() => expect(s.status().lastSuccessAt).not.toBeNull());
    expect(requests).toHaveLength(1);
    clock.advance(AA_SYNC_INTERVAL_MS - 1);
    expect(requests).toHaveLength(1);
    clock.advance(1);
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    s.stop();
    clock.advance(AA_SYNC_INTERVAL_MS * 2);
    expect(requests).toHaveLength(2); // stopped: no timer re-arms
  });

  it('does not sync at start when the last success is recent', async () => {
    await sync(fakeFetch({ status: 200, body: page([entry('claude-opus-5-5-high', 50)], false) })).sync();
    requests = [];
    const s = sync(fakeFetch());
    s.start();
    expect(requests).toHaveLength(0);
    s.stop();
  });
});
```

Import `vi` from `vitest` with the other test functions.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @10db/daemon exec vitest run src/benchmarks src/environment`
Expected: FAIL, because `benchmarks` doesn't exist and `artificialAnalysisKey` isn't on `SecretSource`.

- [ ] **Step 3: Read the key from the Keychain**

In `apps/daemon/src/environment/session-env.ts`:
- Make `KEYCHAIN` `{ service: '10db', apiKeyAccount: 'anthropic-api-key', aaKeyAccount: 'artificial-analysis-api-key' } as const`.
- Add `artificialAnalysisKey(): string | null;` to `SecretSource`.
- Move the body of `anthropicApiKey()` into a local `read(account: string, what: string): string | null`. Its messages name `what` ("the API key" or "the Artificial Analysis key") and still carry the status, never the output.
- Then:

```ts
  return {
    anthropicApiKey: () => read(KEYCHAIN.apiKeyAccount, 'the API key'),
    artificialAnalysisKey: () => read(KEYCHAIN.aaKeyAccount, 'the Artificial Analysis key'),
  };
```

The existing tests keep passing, because the Anthropic path's messages are unchanged. Every literal `SecretSource` must gain the new method, or the typecheck fails. The helper in `session-env.test.ts` (`const keychain = (key: string | null): SecretSource => ({ anthropicApiKey: () => key })`) gets `artificialAnalysisKey: () => null`, and `pnpm --filter @10db/daemon typecheck` names any other.

- [ ] **Step 4: Write the client**

`apps/daemon/src/benchmarks/aa-client.ts`:

```ts
import type { AaModelDto } from '@10db/contracts';
import { z } from 'zod';

/** AA's free model list; every request carries the builder's own key, never a shared one. */
export const AA_FREE_MODELS_URL = 'https://artificialanalysis.ai/api/v2/language/models/free';

/** Pages fetched in one sync at most, so a bad response can't burn the daily quota. */
const MAX_PAGES = 10;

const Numbers = z
  .record(z.string(), z.unknown())
  .transform((rec) =>
    Object.fromEntries(Object.entries(rec).filter((e): e is [string, number | null] => typeof e[1] === 'number' || e[1] === null)),
  );

/** Only the fields 10db uses; everything else AA sends is ignored. */
const AaEntry = z.looseObject({
  slug: z.string().min(1),
  name: z.string(),
  release_date: z.string().nullable().optional(),
  model_creator: z.looseObject({ name: z.string() }),
  evaluations: Numbers.optional(),
  artificial_analysis_intelligence_index_cost: z
    .looseObject({ cost_per_task: z.looseObject({ total_cost: z.number().nullable() }).nullable().optional() })
    .nullable()
    .optional(),
  pricing: Numbers.optional(),
  performance: Numbers.optional(),
});

const AaPage = z.looseObject({
  intelligence_index_version: z.union([z.string(), z.number()]).nullable().optional(),
  pagination: z.looseObject({ has_more: z.boolean() }),
  data: z.array(AaEntry),
});

export type AaFetchOutcome =
  | { readonly kind: 'ok'; readonly models: AaModelDto[] }
  | { readonly kind: 'unauthorized' | 'rate_limited' | 'failed'; readonly message: string };

function toModel(entry: z.infer<typeof AaEntry>, version: string | null, now: string): AaModelDto {
  return {
    slug: entry.slug,
    name: entry.name,
    creator: entry.model_creator.name,
    releaseDate: entry.release_date ?? null,
    indexVersion: version,
    evaluations: entry.evaluations ?? {},
    costPerTaskUsd: entry.artificial_analysis_intelligence_index_cost?.cost_per_task?.total_cost ?? null,
    pricing: entry.pricing ?? {},
    performance: entry.performance ?? {},
    fetchedAt: now,
  };
}

/** Fetches every page; any failure returns an outcome, never throws, and never repeats the key. */
export async function fetchAaModels(deps: {
  readonly fetch: typeof fetch;
  readonly key: string;
  readonly now: string;
}): Promise<AaFetchOutcome> {
  const models: AaModelDto[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    let res: Response;
    try {
      res = await deps.fetch(`${AA_FREE_MODELS_URL}?page=${String(page)}`, {
        headers: { 'x-api-key': deps.key, accept: 'application/json' },
      });
    } catch (error) {
      return { kind: 'failed', message: `Artificial Analysis could not be reached (${error instanceof Error ? error.name : 'error'})` };
    }
    if (res.status === 401 || res.status === 403) return { kind: 'unauthorized', message: 'Artificial Analysis refused the key' };
    if (res.status === 429) {
      const retry = res.headers.get('Retry-After');
      return { kind: 'rate_limited', message: `The daily Artificial Analysis limit is used up${retry ? `; retry in ${retry} s` : ''}` };
    }
    if (!res.ok) return { kind: 'failed', message: `Artificial Analysis answered ${String(res.status)}` };
    const parsed = AaPage.safeParse(await res.json().catch(() => null));
    if (!parsed.success) return { kind: 'failed', message: 'Artificial Analysis sent a response 10db does not understand' };
    const raw = parsed.data.intelligence_index_version;
    const version = raw === null || raw === undefined ? null : String(raw);
    models.push(...parsed.data.data.map((entry) => toModel(entry, version, deps.now)));
    if (!parsed.data.pagination.has_more) return { kind: 'ok', models };
  }
  return { kind: 'ok', models };
}
```

- [ ] **Step 5: Write the sync**

`apps/daemon/src/benchmarks/sync.ts`:

```ts
import { BenchmarkStatusDto, type AaModelDto, type ModelProfileDto } from '@10db/contracts';
import { applyAaMeasurement, getAppSetting, listAaModels, listModelProfiles, replaceAaModels, setAppSetting } from '@10db/db';
import type { z } from 'zod';
import type { Clock, Timer } from '../clock';
import type { StateStore } from '../events';
import type { Logger } from '../log';
import { fetchAaModels } from './aa-client';

/** A daily sync stays far inside the free tier's 100 requests a day. */
export const AA_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

const STATUS_KEY = 'benchmarks.status';
/** Everything but the model count is recorded at sync time, so reading the status never touches the Keychain. */
const StoredStatus = BenchmarkStatusDto.omit({ models: true });
type StoredStatus = z.infer<typeof StoredStatus>;
const NEVER: StoredStatus = {
  keyConfigured: false,
  lastSyncAt: null,
  lastSuccessAt: null,
  outcome: null,
  message: null,
  unmeasuredProfiles: [],
};

export interface BenchmarkSyncDeps {
  readonly state: StateStore;
  readonly clock: Clock;
  readonly fetch: typeof fetch;
  /** The builder's AA key, read fresh for every sync; null when there is none. */
  readonly readKey: () => string | null;
  readonly logger: Logger;
}

export interface BenchmarkSync {
  status(): BenchmarkStatusDto;
  /** One sync; a sync already running is joined, not repeated. It never rejects. */
  sync(): Promise<BenchmarkStatusDto>;
  /** Syncs now if the last success is a day old, then once a day. */
  start(): void;
  stop(): void;
}

function measurement(model: AaModelDto) {
  const e = model.evaluations;
  return {
    scores: {
      intelligence: e['artificial_analysis_intelligence_index'] ?? null,
      coding: e['artificial_analysis_coding_index'] ?? null,
      agentic: e['artificial_analysis_agentic_index'] ?? null,
    },
    costPerTaskUsd: model.costPerTaskUsd,
    outputTokensPerSecond: model.performance['median_output_tokens_per_second'] ?? null,
    indexVersion: model.indexVersion,
    measuredAt: model.fetchedAt,
  };
}

/** A profile the router can use for at least one role: a cost and some score. */
const measured = (p: ModelProfileDto) =>
  p.costPerTaskUsd !== null && (p.scores.intelligence !== null || p.scores.coding !== null || p.scores.agentic !== null);

export function createBenchmarkSync(deps: BenchmarkSyncDeps): BenchmarkSync {
  const { state } = deps;
  let running: Promise<BenchmarkStatusDto> | null = null;
  let timer: Timer | null = null;
  let stopped = false;

  const stored = (): StoredStatus => {
    const parsed = StoredStatus.safeParse(getAppSetting(state.db, STATUS_KEY));
    return parsed.success ? parsed.data : NEVER;
  };
  const status = (): BenchmarkStatusDto => ({ ...stored(), models: listAaModels(state.db).length });
  /** Records the outcome; if even that write fails, the status is returned unrecorded. */
  const record = (next: Partial<StoredStatus>): BenchmarkStatusDto => {
    const merged = { ...stored(), ...next };
    try {
      state.write((ctx) => {
        setAppSetting(ctx, STATUS_KEY, merged);
      });
    } catch (error) {
      deps.logger.error({ err: error instanceof Error ? error.name : 'error' }, 'could not record the benchmark status');
    }
    return { ...merged, models: listAaModels(state.db).length };
  };

  async function attempt(now: string): Promise<BenchmarkStatusDto> {
    const key = deps.readKey();
    if (key === null)
      return record({ keyConfigured: false, lastSyncAt: now, outcome: 'no_key', message: 'Add an Artificial Analysis key to route by score' });
    const outcome = await fetchAaModels({ fetch: deps.fetch, key, now });
    if (outcome.kind !== 'ok') {
      deps.logger.warn({ outcome: outcome.kind }, 'artificial analysis sync failed');
      return record({ keyConfigured: true, lastSyncAt: now, outcome: outcome.kind, message: outcome.message });
    }
    if (outcome.models.length === 0)
      return record({
        keyConfigured: true,
        lastSyncAt: now,
        outcome: 'failed',
        message: 'Artificial Analysis returned no models; keeping the last list',
      });
    const bySlug = new Map(outcome.models.map((m) => [m.slug, m]));
    state.write((ctx) => {
      replaceAaModels(ctx, outcome.models);
      for (const profile of listModelProfiles(ctx.tx)) {
        const model = profile.aaSlug ? bySlug.get(profile.aaSlug) : undefined;
        if (model) applyAaMeasurement(ctx, profile.id, measurement(model));
      }
    });
    const unmeasuredProfiles = listModelProfiles(state.db)
      .filter((p) => p.enabled && !measured(p))
      .map((p) => `${p.model}@${p.effort}`);
    deps.logger.info({ models: outcome.models.length, unmeasured: unmeasuredProfiles.length }, 'artificial analysis synced');
    return record({
      keyConfigured: true,
      lastSyncAt: now,
      lastSuccessAt: now,
      outcome: 'ok',
      message: `${String(outcome.models.length)} models`,
      unmeasuredProfiles,
    });
  }

  /** A failure anywhere (the Keychain, the network, the database) becomes a status, never a rejection. */
  async function run(): Promise<BenchmarkStatusDto> {
    const now = deps.clock.now().toISOString();
    try {
      return await attempt(now);
    } catch (error) {
      const name = error instanceof Error ? error.name : 'error';
      deps.logger.error({ err: name }, 'artificial analysis sync failed');
      return record({ lastSyncAt: now, outcome: 'failed', message: `The sync failed (${name}); keeping the last data` });
    }
  }

  const sync = (): Promise<BenchmarkStatusDto> => {
    running ??= run().finally(() => {
      running = null;
    });
    return running;
  };

  const schedule = (ms: number): void => {
    if (stopped) return;
    timer = deps.clock.setTimeout(() => {
      void sync().then(() => {
        schedule(AA_SYNC_INTERVAL_MS);
      });
    }, ms);
  };

  return {
    status,
    sync,
    start() {
      stopped = false;
      const last = stored().lastSuccessAt;
      const age = last === null ? Infinity : deps.clock.now().getTime() - Date.parse(last);
      if (age >= AA_SYNC_INTERVAL_MS) {
        void sync();
        schedule(AA_SYNC_INTERVAL_MS);
      } else {
        schedule(AA_SYNC_INTERVAL_MS - age);
      }
    },
    stop() {
      stopped = true;
      timer?.cancel();
      timer = null;
    },
  };
}
```

Log lines carry outcome kinds and counts only, never a key, a score or a price. `Timer` and its `cancel()` come from `apps/daemon/src/clock/index.ts`.

`apps/daemon/src/benchmarks/index.ts`:

```ts
export { AA_SYNC_INTERVAL_MS, createBenchmarkSync, type BenchmarkSync } from './sync';
```

- [ ] **Step 6: Wire it into the daemon**

In `apps/daemon/src/daemon/start.ts`:
- Add to `DaemonOptions`:

```ts
  /** The builder's Artificial Analysis key (the Keychain in production); absent means no sync. */
  readonly aaKey?: () => string | null;
  readonly fetch?: typeof fetch;
```

- After seeding, create the sync and start it:

```ts
  const benchmarks = createBenchmarkSync({
    state,
    clock,
    fetch: opts.fetch ?? fetch,
    readKey: opts.aaKey ?? (() => null),
    logger: logger.child({ component: 'benchmarks' }),
  });
  benchmarks.start();
```

- Call `benchmarks.stop()` in the shutdown path beside the scheduler's stop, and add `readonly benchmarks: BenchmarkSync` to `RunningDaemon`.

Without `aaKey`, every sync records `no_key` and makes no request, so the test suites never reach the network.

In `apps/daemon/src/main.ts`, pass `aaKey: () => keychainSecrets.artificialAnalysisKey()`.

In `apps/daemon/AGENTS.md`:
- Add `benchmarks` to the group after `mcp` → `runner` (`watcher`, `scheduler`, `recovery`, `backups`, `benchmarks`).
- Add a bullet: "`benchmarks/` syncs Artificial Analysis's free model list with the builder's own key, read from the Keychain (service `10db`, account `artificial-analysis-api-key`). AA data stays on the machine: never in logs, fixtures, docs or the repo, and every view of it shows AA's attribution. Tests use invented numbers and an injected `fetch`."

In `README.md`, under the section that lists features or setup, add:

> **Model data from Artificial Analysis.** 10db can route each step on [Artificial Analysis](https://artificialanalysis.ai) benchmark scores, using your own free API key. Add it with `security add-generic-password -s 10db -a artificial-analysis-api-key -w`, which prompts for the key. The data is fetched to your machine only, and is not covered by this repository's license. Source: Artificial Analysis (artificialanalysis.ai).

- [ ] **Step 7: Run the tests**

Run: `pnpm --filter @10db/daemon exec vitest run && pnpm --filter @10db/daemon typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
pnpm format && git add apps/daemon/src/benchmarks apps/daemon/src/environment apps/daemon/src/daemon/start.ts apps/daemon/src/main.ts apps/daemon/AGENTS.md README.md && git commit -m 'feat(daemon): sync artificial analysis scores into the model catalogue with the builder’s key'
```

---
### Task 8: Role-aware sessions: the prompt, read-only steps and `complete_step`

Each session now knows which step it is on:
- The prompt names the step and carries the persona's instructions and skills, plus earlier steps' results with their verdicts.
- A read-only step loses its write tools and gets a read-only shell, and `commit` refuses it.
- A new MCP tool, `complete_step`, records a step's result.

**Files:**
- Create: `apps/daemon/src/guard/read-only.ts`
- Modify: `apps/daemon/src/briefing/prompts.ts`, `apps/daemon/src/briefing/index.ts`, `apps/daemon/src/guard/judge.ts`, `apps/daemon/src/guard/index.ts`, `apps/daemon/src/permissions/rules.ts`, `apps/daemon/src/permissions/index.ts`, `packages/contracts/src/mcp-tools.ts`, `apps/daemon/src/mcp/tools.ts`, `apps/daemon/src/runner/runner.ts`
- Test: `apps/daemon/src/briefing/briefing.test.ts`, `apps/daemon/src/permissions/rules.test.ts`, `apps/daemon/src/guard/judge.test.ts`, `apps/daemon/src/mcp/mcp.test.ts`
- Generated: `packages/contracts/generated/mcp-complete_step-input.schema.json` and `…-output.schema.json`

**Interfaces:**
- Consumes: Task 1 `currentStep`, `StepResult`, `REVIEW_ROLES`, `MAX_STEP_SUMMARY` and `Verdict`; Task 2 `getPersona`.
- Produces:
  - `PromptInput.step` (a `StepBrief`) and `PromptInput.priorResults` (a `readonly PriorResult[]`). The runner builds both inline, so the types are not re-exported.
    - `StepBrief = { index: number; count: number; role: StepRole; personaName: string; instructions: string | null; skills: readonly string[]; tools: ToolAccess }`
    - `PriorResult = { role: StepRole; personaName: string; result: StepResult }`
  - `RESULT_NUDGE: string`, exported from `briefing` and sent by Task 9.
  - `READ_COMMANDS: ReadonlySet<string>` and `readOnlyShellRefusal(command: string): string | null`, from `guard`.
  - `GuardInput.readOnly: boolean`.
  - `allowedToolsFor(project: Pick<ProjectDto, 'gateCommand'>, tools: ToolAccess): string[]`, from `permissions`.
  - MCP tool `complete_step`: input `{ opId, summary, verdict: 'approve' | 'reject' | null }`, output `{ instruction: string }`. It writes `{ summary, verdict, sessionId, at }` into the current step and emits `StepChanged`.

- [ ] **Step 1: Write the failing tests**

In `apps/daemon/src/briefing/briefing.test.ts`, add `step` and `priorResults` to `base` so the existing tests compile, then add the new cases:

```ts
const implementStep = { index: 0, count: 1, role: 'implement', personaName: 'Implementer', instructions: null, skills: [], tools: 'edit' } as const;
// in `base`: step: implementStep, priorResults: [],

describe('buildSessionPrompt for flow steps', () => {
  const reviewStep = {
    index: 1,
    count: 2,
    role: 'review',
    personaName: 'Reviewer',
    instructions: 'Hunt for defects.',
    skills: ['review-checklist'],
    tools: 'read_only',
  } as const;
  const result = (summary: string, verdict: 'approve' | 'reject' | null) => ({
    summary,
    verdict,
    sessionId: mintId('Session'),
    at: '2026-10-17T12:00:00.000Z',
  });

  it('names the step, its persona and its skills, keeps the task line, and carries the instructions', () => {
    const prompt = buildSessionPrompt({ ...base, step: reviewStep, action: { kind: 'start' } });
    expect(prompt).toContain('Task: Add the badge\n');
    expect(prompt).toContain('Your step: 2 of 2, review, as Reviewer.');
    expect(prompt).toContain('Skills to use: review-checklist.');
    expect(prompt).toContain('How you work:\nHunt for defects.');
  });

  it('tells a read-only step it cannot write and must finish with complete_step and a verdict', () => {
    const prompt = buildSessionPrompt({ ...base, step: reviewStep, action: { kind: 'start' } });
    expect(prompt).toContain('This step is read-only');
    expect(prompt).toContain('call mcp__10db__complete_step with your findings and a verdict');
    expect(prompt).not.toContain('When the acceptance criteria are met and committed, end your turn.');
  });

  it('gives read-only steps a handoff nudge that asks for no commit', () => {
    expect(HANDOFF_NUDGE_READ_ONLY).toContain('mcp__10db__write_handoff');
    expect(HANDOFF_NUDGE_READ_ONLY).not.toContain('commit');
  });

  it('keeps the implement rules for an implement step', () => {
    const prompt = buildSessionPrompt({ ...base, action: { kind: 'start' } });
    expect(prompt).toContain('When the acceptance criteria are met and committed, end your turn.');
    expect(prompt).not.toContain('complete_step');
  });

  it('carries earlier steps’ results as data, with their verdicts', () => {
    const prompt = buildSessionPrompt({
      ...base,
      action: { kind: 'start' },
      priorResults: [
        { role: 'plan', personaName: 'Planner', result: result('1. Add <Badge/> to header.tsx', null) },
        { role: 'review', personaName: 'Reviewer', result: result('1. No empty-state test.', 'reject') },
      ],
    });
    expect(prompt).toContain('Earlier steps:\n--- plan (Planner)\n1. Add <Badge/> to header.tsx\n---');
    expect(prompt).toContain('--- review (Reviewer): rejected\n1. No empty-state test.\n---');
  });
});
```

Import `mintId` from `@10db/contracts`, and `HANDOFF_NUDGE_READ_ONLY` with the other `briefing` imports, in that file.

In `apps/daemon/src/permissions/rules.test.ts`:

```ts
describe('allowedToolsFor', () => {
  const project = { gateCommand: 'make gate' };
  it.each([
    { tools: 'edit', has: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Read', 'Bash(make gate)'], lacks: ['Bash(cat:*)'] },
    {
      tools: 'read_only',
      has: ['Read', 'Grep', 'mcp__10db__*', 'Bash(git diff:*)', 'Bash(cat:*)', 'Bash(grep:*)'],
      lacks: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash(make gate)'],
    },
  ] as const)('gives a $tools step the right tools', ({ tools, has, lacks }) => {
    const allowed = allowedToolsFor(project, tools);
    for (const t of has) expect(allowed, t).toContain(t);
    for (const t of lacks) expect(allowed, t).not.toContain(t);
  });

  it('gives an edit step exactly the base list', () => {
    expect(allowedToolsFor(project, 'edit')).toEqual(baseAllowedTools(project));
  });
});
```

In `apps/daemon/src/guard/judge.test.ts`, give the existing `judge(toolName, toolInput, claims)` helper a fourth parameter `readOnly = false` and pass it through as `readOnly` to `judgeToolUse`, so every existing case compiles unchanged. Then add:

```ts
describe('read-only steps', () => {
  const ro = (tool: string, input: object) => judge(tool, input, [{ kind: 'area', name: 'api' }], true);
  it.each([
    { tool: 'Write', input: { file_path: 'src/api/a.ts' }, decision: 'deny' },
    { tool: 'Edit', input: { file_path: 'src/api/a.ts' }, decision: 'deny' },
    { tool: 'MultiEdit', input: { file_path: 'src/api/a.ts' }, decision: 'deny' },
    { tool: 'NotebookEdit', input: { notebook_path: 'src/api/n.ipynb' }, decision: 'deny' },
    { tool: 'Read', input: { file_path: 'src/api/a.ts' }, decision: 'allow' },
  ])('$decision $tool inside the claims', ({ tool, input, decision }) => {
    expect(ro(tool, input).decision).toBe(decision);
  });

  it.each([
    { name: 'read-only git', command: 'git diff HEAD~1 -- src/api', decision: 'allow' },
    { name: 'git log piped to head', command: 'git log --oneline | head -5', decision: 'allow' },
    { name: 'a grep with stderr discarded', command: 'grep -rn TODO src 2>/dev/null', decision: 'allow' },
    { name: 'find that only lists', command: "find src -name '*.ts'", decision: 'allow' },
    { name: 'a redirect into a file', command: 'echo x > src/api/a.ts', decision: 'deny' },
    { name: 'an append', command: 'cat a >> b', decision: 'deny' },
    { name: 'sed in place', command: "sed -i 's/a/b/' src/api/a.ts", decision: 'deny' },
    { name: 'a formatter', command: 'pnpm format', decision: 'deny' },
    { name: 'the gate', command: 'make gate', decision: 'deny' },
    { name: 'find -delete', command: 'find . -name x -delete', decision: 'deny' },
    { name: 'find -exec', command: 'find . -exec rm {} ;', decision: 'deny' },
    { name: 'tee', command: 'git diff | tee out.txt', decision: 'deny' },
    { name: 'git push', command: 'git push origin HEAD', decision: 'deny' },
    { name: 'git with a leading option', command: 'git -C /tmp status', decision: 'deny' },
    { name: 'sort writing a file', command: 'sort -o src/api/a.ts src/api/a.ts', decision: 'deny' },
    { name: 'sort writing a file, long form', command: 'sort --output=out.txt a.txt', decision: 'deny' },
    { name: 'uniq, which writes its second operand', command: 'uniq a.txt b.txt', decision: 'deny' },
    { name: 'tree writing a file', command: 'tree -o out.txt src', decision: 'deny' },
    { name: 'rg running a preprocessor', command: 'rg --pre ./scripts/x.sh TODO', decision: 'deny' },
    { name: 'a plain sort', command: 'sort a.txt', decision: 'allow' },
    { name: 'a plain rg', command: 'rg -n TODO src', decision: 'allow' },
    { name: 'a read hiding a write in a substitution', command: 'echo $(touch x)', decision: 'deny' },
  ])('$decision $name', ({ command, decision }) => {
    expect(ro('Bash', { command }).decision).toBe(decision);
  });
});
```

In `apps/daemon/src/mcp/mcp.test.ts`:
- Change `'lists exactly the ten tools'` to eleven, and add `'complete_step'` to its expected list.
- Add a helper and the cases:

```ts
const stepAt = (role: 'implement' | 'review' | 'plan'): WorkstreamStep => ({
  role,
  personaId: null,
  personaName: role,
  tools: role === 'implement' ? 'edit' : 'read_only',
  score: role === 'implement' ? 'coding' : 'intelligence',
  profileId: null,
  model: 'sonnet',
  effort: 'medium',
  need: 40,
  reason: 'test',
  overBudget: false,
  pinned: false,
  status: 'running',
  attempts: 0,
  startedAt: null,
  sessionFloor: 0,
  result: null,
});

async function onStep(role: 'implement' | 'review' | 'plan') {
  const s = await seedSession();
  state.write((ctx) => {
    patchWorkstream(ctx, s.workstream.id, null, { steps: [stepAt('implement'), stepAt(role)], stepIndex: 1 });
  });
  return s;
}

describe('complete_step', () => {
  it('records a review verdict, and the session that gave it, on the current step once per opId', async () => {
    const s = await onStep('review');
    const first = await s.call('complete_step', { opId: 'op-step-0001', summary: 'Looks right.', verdict: 'approve' });
    const retry = await s.call('complete_step', { opId: 'op-step-0001', summary: 'Looks right.', verdict: 'approve' });
    expect(first.isError).toBe(false);
    expect(retry.json).toEqual(first.json);
    expect(getWorkstream(base.db, s.workstream.id).steps[1]?.result).toMatchObject({
      summary: 'Looks right.',
      verdict: 'approve',
      sessionId: s.session.id,
    });
  });

  it.each([
    { name: 'an implement step', role: 'implement', args: { summary: 'Done.', verdict: null }, says: 'ends by ending your turn' },
    { name: 'a review with no verdict', role: 'review', args: { summary: 'Hmm.', verdict: null }, says: 'needs a verdict' },
  ] as const)('refuses $name', async ({ role, args, says }) => {
    const s = await onStep(role);
    const result = await s.call('complete_step', { opId: 'op-step-0002', ...args });
    expect(result.isError).toBe(true);
    expect(result.text).toContain(says);
  });

  it('accepts a plan with no verdict', async () => {
    const s = await onStep('plan');
    expect((await s.call('complete_step', { opId: 'op-step-0003', summary: '1. Do it.', verdict: null })).isError).toBe(false);
  });
});

it('refuses to commit from a read-only step', async () => {
  const s = await onStep('review');
  writeRepoFile('src/api/a.ts', 'export {}\n');
  const result = await s.call('commit', { opId: 'op-commit-ro1', paths: ['src/api/a.ts'], message: 'Sneak' });
  expect(result.isError).toBe(true);
  expect(result.text).toContain('read-only');
  expect(commitCount()).toBe(1);
});
```

Import `getWorkstream` from `@10db/db` and `type WorkstreamStep` from `@10db/contracts` in that file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @10db/daemon exec vitest run src/briefing src/permissions src/guard src/mcp`
Expected: FAIL. The new `PromptInput` fields, `allowedToolsFor`, `readOnly`, the read-only shell and `complete_step` don't exist yet.

- [ ] **Step 3: Add the `complete_step` contract**

In `packages/contracts/src/mcp-tools.ts` (import `MAX_STEP_SUMMARY` from `./steps` and `Verdict` from `./states`):
- `McpToolName`: add `CompleteStep: 'complete_step',`.
- `McpToolInputs`:

```ts
  complete_step: z.object({
    opId: OpId,
    summary: z.string().min(1).max(MAX_STEP_SUMMARY).describe('Your plan, or your findings as numbered notes.'),
    verdict: z
      .enum(Verdict)
      .nullable()
      .default(null)
      .describe('Required for plan_review, review and QA steps; null for a plan step.'),
  }),
```

- `McpToolOutputs`: add `complete_step: z.object({ instruction: z.string() }),`.

Run `pnpm --filter @10db/contracts generate`; the existing `mcp-<tool>-input/output` loop writes the two schemas.

- [ ] **Step 4: Teach the prompt about steps**

In `apps/daemon/src/briefing/prompts.ts` (import `REVIEW_ROLES`, `ToolAccess`, `type StepRole`, `type StepResult` from `@10db/contracts`):

```ts
interface StepBrief {
  readonly index: number;
  readonly count: number;
  readonly role: StepRole;
  readonly personaName: string;
  readonly instructions: string | null;
  readonly skills: readonly string[];
  readonly tools: ToolAccess;
}

interface PriorResult {
  readonly role: StepRole;
  readonly personaName: string;
  readonly result: StepResult;
}

/** The handoff nudge for a read-only step, which has nothing to commit. */
export const HANDOFF_NUDGE_READ_ONLY =
  '10db: your context is filling up. Call mcp__10db__write_handoff with what you have found so far and end your turn. Do not start new checks.';

/** Sent when a read-only step ends its turn without recording its result in this session. */
export const RESULT_NUDGE =
  '10db: this step is not finished until you call mcp__10db__complete_step with your result (and, for a review, a verdict). Call it now, then end your turn.';

function readOnlyRules(role: StepRole): string[] {
  return [
    'This step is read-only: 10db refuses file edits, commits and any shell command that writes. Report what should change; the implement step changes it.',
    'When a decision is not yours to make, ask with mcp__10db__ask_human (or your question tool). Record routine engineering decisions with mcp__10db__record_decision.',
    REVIEW_ROLES.includes(role)
      ? 'When you are done, call mcp__10db__complete_step with your findings and a verdict (approve or reject), then end your turn.'
      : 'When you are done, call mcp__10db__complete_step with your plan, then end your turn.',
    'If 10db asks you to hand off, call mcp__10db__write_handoff, and end your turn.',
  ];
}

const VERDICT_LABEL = { approve: 'approved', reject: 'rejected' } as const;

function stepSection(input: PromptInput): string[] {
  const { step } = input;
  const lines = [`Your step: ${String(step.index + 1)} of ${String(step.count)}, ${step.role}, as ${step.personaName}.`];
  if (step.skills.length > 0) lines.push(`Skills to use: ${step.skills.join(', ')}.`);
  if (step.instructions) lines.push('', `How you work:\n${step.instructions}`);
  if (input.priorResults.length > 0) {
    lines.push('', 'Earlier steps:');
    for (const prior of input.priorResults) {
      const verdict = prior.result.verdict ? `: ${VERDICT_LABEL[prior.result.verdict]}` : '';
      lines.push(`--- ${prior.role} (${prior.personaName})${verdict}`, prior.result.summary, '---');
    }
  }
  return lines;
}
```

Then:
- Add `readonly step: StepBrief;` and `readonly priorResults: readonly PriorResult[];` to `PromptInput`.
- In `buildSessionPrompt`, insert `...stepSection(input), ''` after the opening line and its blank line, before `Task: …`.
- Use `input.step.tools === ToolAccess.ReadOnly ? readOnlyRules(input.step.role) : RULES` where the rules are listed.
- Export `RESULT_NUDGE` and `HANDOFF_NUDGE_READ_ONLY` from `briefing/index.ts`.

The `Task: <title>\n` line keeps its own line, so every fake script book keeps matching.

- [ ] **Step 5: Restrict the tools and the shell**

`apps/daemon/src/guard/read-only.ts`:

```ts
import { splitCommand, stripCommandPrefixes } from './shell-words';

/** Commands a read-only step may run: they read or print, and change nothing. */
export const READ_COMMANDS: ReadonlySet<string> = new Set([
  'basename', 'cat', 'diff', 'dirname', 'echo', 'file', 'find', 'grep', 'head', 'jq', 'ls', 'pwd',
  'realpath', 'rg', 'sort', 'stat', 'tail', 'test', 'tree', 'true', 'wc', 'which',
]);

const READ_GIT: ReadonlySet<string> = new Set(['blame', 'describe', 'diff', 'grep', 'log', 'ls-files', 'rev-parse', 'shortlog', 'show', 'status']);

/** Options that make an otherwise reading command delete, write a file or run a program. */
const WRITING_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  find: ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprint0', '-fprintf', '-fls'],
  sort: ['-o', '--output'],
  tree: ['-o'],
  rg: ['--pre', '--pre-glob'],
};

/** `--output=x` and `-ox` are the option too, not only `--output x`. */
function usesOption(arg: string, option: string): boolean {
  if (arg === option || arg.startsWith(`${option}=`)) return true;
  return !option.startsWith('--') && option.length === 2 && arg.startsWith(option);
}

/** Redirections that only discard or merge output. */
const HARMLESS_REDIRECTS = /(?:\d?>\s*\/dev\/null|2>&1)/g;

const REFUSAL =
  'This step is read-only: the shell may only read (read-only git, cat, grep, ls, find and similar, no redirection). Describe the change in mcp__10db__complete_step.';

/** Why a read-only step may not run this command, or null when every segment only reads. */
export function readOnlyShellRefusal(command: string): string | null {
  for (const segment of splitCommand(command)) {
    const words = stripCommandPrefixes(segment.words);
    const [cmd = '', ...args] = words;
    if (cmd === '') continue;
    if (segment.raw.replace(HARMLESS_REDIRECTS, '').includes('>')) return REFUSAL;
    if (cmd === 'git') {
      if (!READ_GIT.has(args[0] ?? '')) return REFUSAL;
      continue;
    }
    if (!READ_COMMANDS.has(cmd)) return REFUSAL;
    const writing = WRITING_OPTIONS[cmd] ?? [];
    if (args.some((a) => writing.some((o) => usesOption(a, o)))) return REFUSAL;
  }
  return null;
}
```

`git` must name its verb first, so `git -C elsewhere status` is refused. `uniq` is left out, because its second operand is an output file; `sort -o`, `tree -o` and `rg --pre` are refused by option. `splitCommand` splits out `$(…)` bodies as segments of their own, so `echo $(touch x)` is judged on `touch`. Export `READ_COMMANDS` and `readOnlyShellRefusal` from `guard/index.ts`.

In `apps/daemon/src/guard/judge.ts`, add `/** A read-only step: file writes and writing shell commands are refused, claims or not. */ readonly readOnly: boolean;` to `GuardInput`, and make the start of `judgeToolUse`:

```ts
  if (FILE_TOOLS.has(input.toolName)) {
    if (input.readOnly)
      return deny('This step is read-only. Describe the change in mcp__10db__complete_step; the implement step makes it.');
    const filePath = stringField(input.toolInput, 'file_path') ?? stringField(input.toolInput, 'notebook_path');
    return filePath === null ? ALLOW : judgeFile(input, filePath);
  }
  if (input.toolName === 'Bash') {
    const command = stringField(input.toolInput, 'command');
    if (command === null) return ALLOW;
    if (input.readOnly) {
      const refusal = readOnlyShellRefusal(command);
      if (refusal) return deny(refusal);
    }
    return judgeShell(input, command);
  }
```

A read-only command still goes through `judgeShell` afterwards, so the hard denials and the git rules apply to it too.

In `apps/daemon/src/permissions/rules.ts` (import `READ_COMMANDS` from `../guard`):

```ts
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/**
 * A read-only step drops the file-writing tools and the gate, and may run the read
 * commands without a card; the guard has already refused anything that writes.
 */
export function allowedToolsFor(project: Pick<ProjectDto, 'gateCommand'>, tools: ToolAccess): string[] {
  const base = baseAllowedTools(project);
  if (tools === ToolAccess.Edit) return base;
  const gate = `Bash(${project.gateCommand})`;
  return [...base.filter((t) => !WRITE_TOOLS.has(t) && t !== gate), ...[...READ_COMMANDS].map((c) => `Bash(${c}:*)`)];
}
```

Export `allowedToolsFor` from `permissions/index.ts`.

- [ ] **Step 6: Add the tool handler and the commit refusal**

In `apps/daemon/src/mcp/tools.ts` (import `currentStep`, `REVIEW_ROLES`, `StepRole`, `ToolAccess`, `EventType` from `@10db/contracts`, and `getWorkstreamRow`, `patchWorkstream` from `@10db/db`):
- Add to `TOOL_DESCRIPTIONS`: `complete_step: 'Finish a plan, plan-review, review or QA step: your plan or findings as the summary and, for a review, a verdict. Implement steps never call this; they end by ending the turn.',`.
- At the top of the `commit` handler:

```ts
      if (currentStep(getWorkstreamRow(db, workstreamId)).tools === ToolAccess.ReadOnly)
        throw new InvalidError('This step is read-only; only an implement step commits.');
```

- The `commit` handler's own `judgeToolUse` call (where it checks the paths against the claims) builds a `GuardInput`: add `readOnly: false` to it, since the read-only refusal has already run.
- Add the handler:

```ts
    complete_step: (input) => {
      const done = prior(input.opId, McpToolName.CompleteStep);
      if (done !== undefined) return Promise.resolve(McpToolOutputs.complete_step.parse(done));
      return Promise.resolve(
        deps.state.write((ctx) => {
          const row = getWorkstreamRow(ctx.tx, workstreamId);
          const step = currentStep(row);
          if (step.role === StepRole.Implement)
            throw new InvalidError('An implement step ends by ending your turn; 10db runs the gate.');
          if (REVIEW_ROLES.includes(step.role) && input.verdict === null)
            throw new InvalidError('This review step needs a verdict: approve or reject.');
          const result = { summary: input.summary, verdict: input.verdict, sessionId, at: ctx.now };
          patchWorkstream(ctx, workstreamId, null, {
            steps: row.steps.map((s, i) => (i === row.stepIndex ? { ...s, result } : s)),
          });
          ctx.emit({
            type: EventType.StepChanged,
            entityType: 'workstream',
            entityId: workstreamId,
            data: { stepIndex: row.stepIndex, role: step.role, verdict: input.verdict },
          });
          return record('complete_step', input.opId, { instruction: 'Recorded. End your turn now.' }, ctx);
        }),
      );
    },
```

`entityType: 'workstream'` lets the UI's existing workstream invalidation pick the change up. A read-only step always has a stored step (the pre-flow fallback is an implement step), so `row.steps[row.stepIndex]` exists whenever this writes.

- [ ] **Step 7: Use the step in the runner's session start**

In `apps/daemon/src/runner/runner.ts`, in `runSession`, after `const action = row.nextAction;`:

```ts
    const step = currentStep(row);
    const persona = step.personaId ? getPersona(db, step.personaId) : null;
    const priorResults = row.steps.flatMap((s, i) =>
      i !== row.stepIndex && s.result ? [{ role: s.role, personaName: s.personaName, result: s.result }] : [],
    );
```

Then:
- Pass `step: { index: row.stepIndex, count: Math.max(row.steps.length, 1), role: step.role, personaName: step.personaName, instructions: persona?.instructions ?? null, skills: persona?.skills ?? [], tools: step.tools }` and `priorResults` to `buildSessionPrompt`.
- Replace `allowedTools: baseAllowedTools(project)` with `allowedTools: allowedToolsFor(project, step.tools)`.
- Add `readOnly: step.tools === ToolAccess.ReadOnly` to the `judgeToolUse` input.
- Where the `context` case sends `handle.send(HANDOFF_NUDGE)` at the threshold, send `step.tools === ToolAccess.ReadOnly ? HANDOFF_NUDGE_READ_ONLY : HANDOFF_NUDGE`. The plain nudge says "commit it", and a read-only step would be refused.

Import `currentStep` and `ToolAccess` from `@10db/contracts`, and `getPersona` from `@10db/db`.

- [ ] **Step 8: Run the tests**

Run: `pnpm --filter @10db/contracts generate && pnpm --filter @10db/daemon exec vitest run && pnpm -r typecheck`
Expected: PASS, the existing runner tests included (a pre-flow workstream is an implement step with the old rules).

- [ ] **Step 9: Commit**

```bash
pnpm format && git add packages/contracts/src/mcp-tools.ts packages/contracts/generated apps/daemon/src/briefing apps/daemon/src/permissions apps/daemon/src/guard apps/daemon/src/mcp apps/daemon/src/runner/runner.ts && git commit -m 'feat(daemon): run each step as its persona, keep read-only steps read-only, add complete_step'
```

---
### Task 9: Step transitions, verdicts, escalation and step-scoped recovery

The runner walks the plan:
- After an implement step's gate passes, the next step is queued.
- After a read-only step records its result, the next step runs in the same lane.
- A rejection sends the work back to the step it judged, one profile stronger.
- A failed gate escalates the implement step.
- A read-only step that never records a result fails the workstream, and the failed step is marked.
- Every "latest handoff" read becomes step-scoped. A retry starts the current step clean.

**Files:**
- Create: `apps/daemon/src/team/step-flow.ts`, `apps/daemon/src/team/step-flow.test.ts`
- Modify:
  - `packages/contracts/src/entities.ts` (`NextAction`), `packages/contracts/generated/*`
  - `apps/daemon/src/team/index.ts`, `apps/daemon/src/briefing/prompts.ts`, `apps/daemon/src/briefing/context-pack.ts`
  - `apps/daemon/src/runner/next-action.ts`, `apps/daemon/src/runner/next-action.test.ts`, `apps/daemon/src/runner/runner.ts`
  - `apps/daemon/src/recovery/recover.ts`, `apps/daemon/src/daemon/services.ts`
- Test: `apps/daemon/src/runner/runner.test.ts`

**Interfaces:**
- Consumes:
  - Task 3: `latestHandoffForStep`.
  - Task 5: `escalateStep`.
  - Task 6: `TestEngine.addTask(…, plan)` and the measured test catalogue.
  - Task 7: `RESULT_NUDGE` and the `complete_step` tool, including `result.sessionId`.
  - Task 2: `listModelProfiles` and `recordProfileOutcome`.
- Produces:
  - `NextAction` kind `revise`: `{ kind: 'revise'; reviewStep: number }`.
  - `moveAfter(steps: readonly WorkstreamStep[], index: number): StepMove`, where `StepMove = { kind: 'advance'; to: number } | { kind: 'done' } | { kind: 'send_back'; to: number } | { kind: 'no_result' }`.
  - `StepEntry = { now: string; sessions: number }`: the time a step is entered and the workstream's session count at that moment.
  - `advanceSteps(steps, from, to, entry: StepEntry): WorkstreamStep[]` and `sendBackSteps(steps, from, to, target: WorkstreamStep, entry: StepEntry): WorkstreamStep[]`. They set the entered step's `startedAt` and `sessionFloor`.
  - `restartStep(steps, index, now: string): WorkstreamStep[]`, used by retry. It keeps the step's `sessionFloor`, so a retried step still sees its own handoffs and never an earlier step's.
  - `failStep(steps, index): WorkstreamStep[]`.
  - `retryWorkstream(state, id): WorkstreamDto`, which moves out of `daemon/services.ts`.
  - `PromptInput.revisedBy: { role: StepRole; personaName: string } | null`.

With the test engine's measured catalogue (Task 6), the expected profiles are: implement `sonnet@high`, review `opus@medium`, plan `opus@low`, QA `sonnet@low`. Implement escalates from `sonnet@high` to `opus@low`.

- [ ] **Step 1: Write the failing tests**

`apps/daemon/src/team/step-flow.test.ts`:

```ts
import { mintId, type StepRole, type Verdict, type WorkstreamStep } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { advanceSteps, moveAfter, restartStep, sendBackSteps } from './step-flow';

const NOW = '2026-10-17T12:00:00.000Z';
const ENTRY = { now: NOW, sessions: 2 };
const step = (role: StepRole, verdict: Verdict | null | 'none' = 'none'): WorkstreamStep => ({
  role,
  personaId: null,
  personaName: role,
  tools: role === 'implement' ? 'edit' : 'read_only',
  score: role === 'implement' ? 'coding' : 'intelligence',
  profileId: null,
  model: 'sonnet',
  effort: 'medium',
  need: 40,
  reason: 'test',
  overBudget: false,
  pinned: false,
  status: 'running',
  attempts: 0,
  startedAt: null,
  sessionFloor: 0,
  result: verdict === 'none' ? null : { summary: 'notes', verdict, sessionId: mintId('Session'), at: NOW },
});

describe('moveAfter', () => {
  it.each([
    { name: 'an implement step with a step after it advances', steps: [step('implement'), step('review')], at: 0, move: { kind: 'advance', to: 1 } },
    { name: 'the last implement step is done', steps: [step('implement')], at: 0, move: { kind: 'done' } },
    { name: 'a plan with a result advances', steps: [step('plan', null), step('implement')], at: 0, move: { kind: 'advance', to: 1 } },
    { name: 'an approval on the last step is done', steps: [step('implement'), step('review', 'approve')], at: 1, move: { kind: 'done' } },
    { name: 'a review rejection goes back to the implement step', steps: [step('implement'), step('review', 'reject'), step('qa')], at: 1, move: { kind: 'send_back', to: 0 } },
    { name: 'a QA rejection goes back to the nearest implement step', steps: [step('plan', null), step('implement'), step('review', 'approve'), step('qa', 'reject')], at: 3, move: { kind: 'send_back', to: 1 } },
    { name: 'a plan-review rejection goes back to the plan', steps: [step('plan', null), step('plan_review', 'reject'), step('implement')], at: 1, move: { kind: 'send_back', to: 0 } },
    { name: 'a review with no result has none', steps: [step('implement'), step('review')], at: 1, move: { kind: 'no_result' } },
    { name: 'a workstream with no stored steps is done', steps: [], at: 0, move: { kind: 'done' } },
  ] as const)('$name', ({ steps, at, move }) => {
    expect(moveAfter(steps, at)).toEqual(move);
  });
});

describe('advanceSteps, sendBackSteps and restartStep', () => {
  it('marks the step done and starts the next with no result, stamped with its entry', () => {
    const steps = [step('implement'), { ...step('review', 'approve'), status: 'pending' as const }];
    expect(advanceSteps(steps, 0, 1, ENTRY).map((s) => [s.status, s.result, s.startedAt, s.sessionFloor])).toEqual([
      ['done', null, null, 0],
      ['running', null, NOW, 2],
    ]);
  });

  it('keeps the rejecting step’s notes and restarts the target, counting the retry', () => {
    const first = step('implement');
    const steps = [first, step('review', 'reject')];
    const target: WorkstreamStep = { ...first, model: 'opus' };
    const moved = sendBackSteps(steps, 1, 0, target, ENTRY);
    expect(moved[0]).toMatchObject({ model: 'opus', status: 'running', attempts: 1, result: null, startedAt: NOW, sessionFloor: 2 });
    expect(moved[1]).toMatchObject({ status: 'pending', result: { verdict: 'reject' } });
  });

  it('restarts a failed step clean for a retry, keeping its session floor', () => {
    const steps = [step('implement'), { ...step('review', 'reject'), status: 'failed' as const, attempts: 3, sessionFloor: 5 }];
    expect(restartStep(steps, 1, NOW)[1]).toMatchObject({ status: 'running', attempts: 0, result: null, startedAt: NOW, sessionFloor: 5 });
  });
});
```

In `apps/daemon/src/runner/runner.test.ts`, add a `describe('flows', …)` block:

```ts
describe('flows', () => {
  const approve = (opId: string) => ({ do: 'mcp' as const, tool: 'complete_step', args: { opId, summary: 'Looks right.', verdict: 'approve' } });
  const reject = (opId: string, notes = '1. The empty state has no test.') => ({
    do: 'mcp' as const,
    tool: 'complete_step',
    args: { opId, summary: notes, verdict: 'reject' },
  });
  const implement = (opId: string) => [write('src/api/a.txt', opId), commit(opId, ['src/api/a.txt']), turn];
  const step = (id: Parameters<typeof ws>[0], i: number) => ws(id).steps[i];
  const until = async (id: Parameters<typeof ws>[0], done: (state: string) => boolean, max = 10) => {
    for (let i = 0; i < max && !done(ws(id).state); i += 1) {
      engine.launch(id);
      await engine.runner.idle();
    }
  };

  it('runs implement then review to DONE when the reviewer approves', async () => {
    engine = await createTestEngine({ Alpha: [implement('op-flow-0001'), [approve('op-flow-0002'), turn]] });
    const { workstream } = engine.addTask('Alpha', ['api'], [], { flow: 'standard' });
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id)).toMatchObject({ state: 'QUEUED', stepIndex: 1, model: 'opus', effort: 'medium' });
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id).state).toBe('DONE');
    expect(ws(workstream.id).steps.map((s) => s.status)).toEqual(['done', 'done']);
    expect(engine.adapter.prompts[1]?.prompt).toContain('Your step: 2 of 2, review, as Reviewer.');
    expect(listEvidence(engine.store.db, workstream.id).filter((e) => e.kind === 'gate')).toHaveLength(1);
  });

  it('sends a rejection back to the implement step, one profile up, with the notes', async () => {
    engine = await createTestEngine({
      Alpha: [implement('op-flow-0011'), [reject('op-flow-0012'), turn], implement('op-flow-0013'), [approve('op-flow-0014'), turn]],
    });
    const { workstream } = engine.addTask('Alpha', ['api'], [], { flow: 'standard' });
    engine.launch(workstream.id);
    await engine.runner.idle();
    engine.launch(workstream.id); // review rejects; the implement step reruns in the same lane
    await engine.runner.idle();
    expect(engine.adapter.prompts[2]?.prompt).toContain('1. The empty state has no test.');
    expect(engine.adapter.prompts[2]?.prompt).toContain('The review step (Reviewer) rejected the work');
    expect(step(workstream.id, 0)).toMatchObject({
      model: 'opus',
      effort: 'low',
      attempts: 1,
      reason: 'escalated from sonnet@high after the review step rejected it',
    });
    expect(ws(workstream.id).attempt).toBe(1);
    engine.launch(workstream.id); // the second gate passed; review again
    await engine.runner.idle();
    expect(ws(workstream.id).state).toBe('DONE');
  });

  it('ends a review step that never gives a verdict as FAILED with a flag, and marks the step failed', async () => {
    engine = await createTestEngine({ Alpha: [implement('op-flow-0021'), [turn, { do: 'await_message', contains: 'complete_step' }, turn]] });
    const { workstream } = engine.addTask('Alpha', ['api'], [], { flow: 'standard' });
    await until(workstream.id, (s) => s === 'FAILED');
    expect(ws(workstream.id)).toMatchObject({ state: 'FAILED', failureReason: 'The review step ended without calling complete_step' });
    expect(step(workstream.id, 1)?.status).toBe('failed');
    expect(listInbox(engine.store.db, { states: ['OPEN'] }).map((i) => i.kind)).toContain('flag');
  });

  it('accepts a verdict given after the nudge', async () => {
    engine = await createTestEngine({
      Alpha: [implement('op-flow-0031'), [turn, { do: 'await_message', contains: 'complete_step' }, approve('op-flow-0032'), turn]],
    });
    const { workstream } = engine.addTask('Alpha', ['api'], [], { flow: 'standard' });
    await until(workstream.id, (s) => s === 'DONE');
    expect(ws(workstream.id).state).toBe('DONE');
  });

  it('fails after the fix limit when the reviewer keeps rejecting, then retries the review cleanly', async () => {
    const round = (n: number) => [[turn], [reject(`op-flow-04${String(n)}0`), turn]];
    engine = await createTestEngine({ Alpha: [...[1, 2, 3, 4].flatMap(round), [approve('op-flow-0499'), turn]] });
    const { workstream } = engine.addTask('Alpha', ['api'], [], { flow: 'standard' });
    await until(workstream.id, (s) => s === 'FAILED');
    expect(ws(workstream.id)).toMatchObject({ state: 'FAILED', failureReason: 'The review step rejected the work and the retry limit (3) is used up' });
    // The builder retries: the review starts clean (no stale verdict) and approves.
    engine.retry(workstream.id);
    expect(step(workstream.id, 1)).toMatchObject({ status: 'running', result: null, attempts: 0 });
    await until(workstream.id, (s) => s === 'DONE');
    expect(ws(workstream.id).state).toBe('DONE');
  });

  it('escalates the implement step when the gate fails', async () => {
    engine = await createTestEngine(
      { Alpha: [[turn], implement('op-flow-0051'), [approve('op-flow-0052'), turn]] },
      { gateCommand: 'test -f src/api/a.txt' },
    );
    const { workstream } = engine.addTask('Alpha', ['api'], [], { flow: 'standard' });
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id)).toMatchObject({ state: 'QUEUED', nextAction: { kind: 'fix' }, model: 'opus', effort: 'low' });
    expect(step(workstream.id, 0)?.reason).toBe('escalated from sonnet@high after the gate failed');
    await until(workstream.id, (s) => s === 'DONE');
    expect(ws(workstream.id).state).toBe('DONE');
  });

  it('gives the implementer the plan', async () => {
    engine = await createTestEngine({
      Alpha: [
        [{ do: 'mcp', tool: 'complete_step', args: { opId: 'op-flow-0061', summary: '1. Put it in src/api/a.txt.', verdict: null } }, turn],
        implement('op-flow-0062'),
        [approve('op-flow-0063'), turn],
        [approve('op-flow-0064'), turn],
      ],
    });
    // Four criteria run the full flow's plan and QA steps; with no risk tag the plan review is skipped.
    const { workstream } = engine.addTask('Alpha', ['api'], [], { flow: 'full', criteria: 4 });
    expect(ws(workstream.id).steps.map((s) => s.role)).toEqual(['plan', 'implement', 'review', 'qa']);
    await until(workstream.id, (s) => s === 'DONE');
    expect(engine.adapter.prompts[1]?.prompt).toContain('1. Put it in src/api/a.txt.');
    expect(ws(workstream.id).state).toBe('DONE');
  });

  it('resumes the step it was on after a crash', async () => {
    engine = await createTestEngine({ Alpha: [implement('op-flow-0071'), [{ do: 'crash', message: 'boom' }], [approve('op-flow-0072'), turn]] });
    const { workstream } = engine.addTask('Alpha', ['api'], [], { flow: 'standard' });
    engine.launch(workstream.id);
    await engine.runner.idle();
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id)).toMatchObject({ state: 'QUEUED', stepIndex: 1, nextAction: { kind: 'resume' } });
    await until(workstream.id, (s) => s === 'DONE');
    const sessions = listSessions(engine.store.db, workstream.id);
    expect(engine.adapter.prompts[2]).toMatchObject({ resume: sessions[1]?.providerSessionId });
  });

  it('never gives a later step an earlier step’s handoff', async () => {
    engine = await createTestEngine({
      Alpha: [
        [{ do: 'context', percentage: 75 }, { do: 'await_message', contains: 'write_handoff' }, { do: 'mcp', tool: 'write_handoff', args: handoffArgs('op-flow-0081', 'Commit the file') }, turn],
        implement('op-flow-0082'),
        [{ do: 'crash', message: 'boom' }],
        [{ do: 'crash', message: 'boom again' }],
        [approve('op-flow-0083'), turn],
      ],
    });
    const { workstream } = engine.addTask('Alpha', ['api'], [], { flow: 'standard' });
    await until(workstream.id, (s) => s === 'DONE');
    // The review crashed twice: once resumed, then started fresh. A fresh review starts, not continues.
    expect(engine.adapter.prompts[4]?.prompt).not.toContain('Continue from the handoff');
    expect(engine.adapter.prompts[4]?.prompt).toContain('Your step: 2 of 2, review');
  });

  it('runs a workstream with no stored steps as one implement step', async () => {
    engine = await createTestEngine({ Alpha: [implement('op-flow-0091')] });
    const { workstream } = engine.addTask('Alpha');
    expect(ws(workstream.id).steps).toEqual([]);
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id).state).toBe('DONE');
  });
});
```

`engine.retry(id)` doesn't exist yet. Add it to `TestEngine` in `apps/daemon/test/engine.ts` as a thin call to the same retry the API uses (Step 6 moves that logic into `team/steps.ts` as `retryWorkstream(state, id)`, so the engine and `daemon/services.ts` share it).

In `apps/daemon/src/runner/next-action.test.ts`, add a row: a crash during a `revise` keeps the `revise` action, the same as `fix`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @10db/daemon exec vitest run src/team/step-flow.test.ts src/runner`
Expected: FAIL. `step-flow` and the `revise` kind don't exist yet. Every `flows` case either reaches DONE after the implement step, with no review, or times out on a missing nudge.

- [ ] **Step 3: Add the `revise` action**

In `packages/contracts/src/entities.ts`, add to the `NextAction` union:

```ts
  /** Rerun a step a reviewer rejected; the rejecting step's notes are in its result. */
  z.object({ kind: z.literal('revise'), reviewStep: z.int().min(0) }),
```

Run `pnpm --filter @10db/contracts generate`, then `pnpm -r typecheck`. Every exhaustive switch the compiler now flags gets a `revise` case:
- `apps/daemon/src/runner/next-action.ts`: `case 'revise':` joins `case 'verify': case 'fix': return previous;`.
- `apps/daemon/src/briefing/prompts.ts`: add `readonly revisedBy: { readonly role: StepRole; readonly personaName: string } | null;` to `PromptInput` (and `revisedBy: null` to the test file's `base`), and in `actionSection`:

```ts
    case 'revise': {
      const by = input.revisedBy ? `The ${input.revisedBy.role} step (${input.revisedBy.personaName})` : 'A reviewer';
      return input.step.tools === ToolAccess.Edit
        ? `${by} rejected the work. Its notes are under Earlier steps. Address each one, commit, and end your turn.`
        : `${by} rejected your result. Its notes are under Earlier steps. Address each one, then call mcp__10db__complete_step again.`;
    }
```

- Any other switch the compiler names. The desktop has none on `NextAction` today; if one appears, show `revise` as "Revising".

- [ ] **Step 4: Write the step flow**

`apps/daemon/src/team/step-flow.ts`:

```ts
import { StepRole, StepStatus, Verdict, type WorkstreamStep } from '@10db/contracts';

export type StepMove =
  | { readonly kind: 'advance'; readonly to: number }
  | { readonly kind: 'done' }
  | { readonly kind: 'send_back'; readonly to: number }
  | { readonly kind: 'no_result' };

/** Where a rejection goes: a plan review back to the plan, review and QA back to the implement step. */
function sendBackTarget(steps: readonly WorkstreamStep[], index: number): number {
  const want = steps[index]?.role === StepRole.PlanReview ? StepRole.Plan : StepRole.Implement;
  for (let i = index - 1; i >= 0; i -= 1) if (steps[i]?.role === want) return i;
  return index;
}

/** What follows a finished step (spec §5.4). An implement step is finished once its gate passed. */
export function moveAfter(steps: readonly WorkstreamStep[], index: number): StepMove {
  const step = steps[index];
  if (!step) return { kind: 'done' };
  if (step.role !== StepRole.Implement) {
    if (!step.result) return { kind: 'no_result' };
    if (step.result.verdict === Verdict.Reject) return { kind: 'send_back', to: sendBackTarget(steps, index) };
  }
  return index + 1 < steps.length ? { kind: 'advance', to: index + 1 } : { kind: 'done' };
}

/** When a step is entered, and how many sessions the workstream had run by then. */
export interface StepEntry {
  readonly now: string;
  readonly sessions: number;
}

const entered = (s: WorkstreamStep, entry: StepEntry): WorkstreamStep => ({
  ...s,
  status: StepStatus.Running,
  result: null,
  startedAt: entry.now,
  sessionFloor: entry.sessions,
});

/** `to` of -1 finishes the last step without starting another. */
export function advanceSteps(steps: readonly WorkstreamStep[], from: number, to: number, entry: StepEntry): WorkstreamStep[] {
  return steps.map((s, i) => {
    if (i === from) return { ...s, status: StepStatus.Done };
    if (i === to) return entered(s, entry);
    return s;
  });
}

/** The rejecting step keeps its notes for the rework; the target restarts with one more attempt. */
export function sendBackSteps(
  steps: readonly WorkstreamStep[],
  from: number,
  to: number,
  target: WorkstreamStep,
  entry: StepEntry,
): WorkstreamStep[] {
  return steps.map((s, i) => {
    if (i === from) return { ...s, status: StepStatus.Pending };
    if (i === to) return { ...entered(target, entry), attempts: s.attempts + 1 };
    return s;
  });
}

/** A retried workstream restarts its current step clean (no stale verdict, no counted attempts) in the same step. */
export function restartStep(steps: readonly WorkstreamStep[], index: number, now: string): WorkstreamStep[] {
  return steps.map((s, i) =>
    i === index ? { ...s, status: StepStatus.Running, attempts: 0, result: null, startedAt: now } : s,
  );
}

/** Marks the current step failed when its workstream fails. */
export function failStep(steps: readonly WorkstreamStep[], index: number): WorkstreamStep[] {
  return steps.map((s, i) => (i === index ? { ...s, status: StepStatus.Failed } : s));
}
```

Export `moveAfter`, `advanceSteps`, `sendBackSteps`, `restartStep`, `failStep` and `type StepEntry` from `team/index.ts`. Don't export the `StepMove` type, since nothing outside `team` imports it.

- [ ] **Step 5: Scope every handoff read to the step**

Replace each `latestHandoff(db, id)` with `latestHandoffForStep(db, getWorkstreamRow(db, id))`, or pass the row already in hand:
- `apps/daemon/src/runner/runner.ts`:
  - `freshAction` (it serves the `paused` branch of `settle` and the session-start rewrite).
  - The crash branch of `settle`, which passes the latest handoff to `nextActionAfterCrash`.
- `apps/daemon/src/recovery/recover.ts`: the `nextActionAfterCrash(…, latestHandoff(db, ws.id))` call. In the same file, the recovery-limit failure (`transitionWorkstream(ctx, ws.id, { to: S.Failed, … patch: { recoveryAttempts, failureReason } })`) also marks the current step: add `...(row.steps.length > 0 ? { steps: failStep(row.steps, row.stepIndex) } : {})` to that patch, importing `failStep` from `../team`.
- `apps/daemon/src/briefing/context-pack.ts`: the fallback for non-`continue_from_handoff` actions. It has the `WorkstreamDto`, so pass `workstream`.
- `apps/daemon/src/daemon/services.ts`: `retryWorkstream`. Step 6 moves it into `team`.

If nothing else imports `latestHandoff` afterwards, knip names it; remove it from the db's exports and keep it as a private helper, or delete it.

- [ ] **Step 6: Walk the steps in the runner, and retry cleanly**

In `apps/daemon/src/runner/runner.ts`, import:
- `advanceSteps`, `failStep`, `moveAfter`, `sendBackSteps` and `type StepEntry` from `../team`;
- `escalateStep` from `../routing`, and `RESULT_NUDGE` from `../briefing`;
- `latestHandoffForStep`, `listModelProfiles`, `recordProfileOutcome`, `type WorkstreamRow` and `type WriteContext` from `@10db/db`;
- `StepRole`, `EventType` and `type WorkstreamStep` from `@10db/contracts`.

6a. Pass `revisedBy` to `buildSessionPrompt`:

```ts
    const reviser = action.kind === 'revise' ? row.steps[action.reviewStep] : undefined;
    // … in the prompt input:
      revisedBy: reviser ? { role: reviser.role, personaName: reviser.personaName } : null,
```

6b. Add `resultNudged: boolean` to `SessionState` (initialised `false`), and keep `const readOnly = step.tools === ToolAccess.ReadOnly;` beside Task 8's `step`. In the `turn_complete` case, add this branch between the firm-nudge branch and the final `else`:

```ts
            } else if (readOnly && currentStep(getWorkstreamRow(db, id)).result?.sessionId !== session.id && !st.resultNudged) {
              st.resultNudged = true;
              handle.send(RESULT_NUDGE);
```

The check is "this session recorded a result", so a result left by an earlier session never silences the nudge.

6c. Make `fail` mark the current step:

```ts
  function fail(id: WorkstreamId, fence: number, reason: string): void {
    const row = getWorkstreamRow(db, id);
    opts.state.write((ctx) => {
      transitionWorkstream(ctx, id, {
        to: S.Failed,
        fence,
        patch: {
          failureReason: reason,
          currentSessionId: null,
          ...(row.steps.length > 0 ? { steps: failStep(row.steps, row.stepIndex) } : {}),
        },
        reason,
      });
      releaseClaims(ctx, id);
      clearLease(ctx, id);
    });
    // the flag stays as it is
  }
```

6d. Add these helpers inside `createRunner`, beside `fail`:

```ts
  /** A step entered now; its floor is the sessions this workstream has run so far. */
  function entryFor(ctx: WriteContext, id: WorkstreamId): StepEntry {
    return { now: ctx.now, sessions: getWorkstream(ctx.tx, id).sessionCount };
  }

  /** Observed stats for the frontier: a finished step counts for its profile. */
  function countFinished(ctx: WriteContext, step: WorkstreamStep): void {
    if (step.profileId) recordProfileOutcome(ctx, step.profileId, { firstPass: step.attempts === 0, escalated: false });
  }

  /** One profile up a retried step's own score. */
  function escalated(row: WorkstreamRow, step: WorkstreamStep, why: string): { step: WorkstreamStep; moved: boolean } {
    const project = getProject(db, row.projectId);
    const result = escalateStep(step, { provider: project.provider, budgetCeiling: project.budgetCeiling, profiles: listModelProfiles(db), why });
    return { step: result.step, moved: result.escalated };
  }

  /** DONE: the task is done, claims are released and the builder gets a review card (spec §7). */
  function completeInTx(ctx: WriteContext, id: WorkstreamId, fence: number, row: WorkstreamRow, commitShas: readonly string[], reason: string): void {
    transitionWorkstream(ctx, id, { to: S.Done, fence, reason });
    setTaskStatus(ctx, row.taskId, 'done');
    releaseClaims(ctx, id);
    clearLease(ctx, id);
    insertInboxItem(ctx, {
      projectId: row.projectId,
      kind: 'review',
      title: `Review: ${getTask(ctx.tx, row.taskId).title}`,
      body: `Gate passed with ${String(commitShas.length)} commit(s).`,
      options: [{ label: 'accept', description: 'Looks good' }],
      recommendation: null,
      category: 'product',
      urgency: 'low',
      detail: { workstreamId: id, commits: [...commitShas] },
      foldKey: null,
      targets: [],
    });
  }

  /** After a read-only step's session: the next step in this lane, DONE, a rework, or a failure. */
  function finishReadOnlyStep(id: WorkstreamId, ctl: Control, row: WorkstreamRow): 'next' | 'stop' {
    const step = currentStep(row);
    const move = moveAfter(row.steps, row.stepIndex);
    switch (move.kind) {
      case 'no_result':
        fail(id, ctl.fence, `The ${step.role} step ended without calling complete_step`);
        return 'stop';
      case 'done': {
        const lastGate = listEvidence(db, id).filter((e) => e.kind === 'gate' && e.exitCode === 0).at(-1);
        opts.state.write((ctx) => {
          countFinished(ctx, step);
          patchWorkstream(ctx, id, ctl.fence, { steps: advanceSteps(row.steps, row.stepIndex, -1, entryFor(ctx, id)) });
          // The workflow has no RUNNING → DONE edge; a read-only step changed no code, so no second gate.
          transitionWorkstream(ctx, id, { to: S.Verifying, fence: ctl.fence, reason: 'steps complete' });
          completeInTx(ctx, id, ctl.fence, row, lastGate?.commitShas ?? [], `${step.role} approved`);
        });
        return 'stop';
      }
      case 'advance': {
        const next = row.steps[move.to];
        if (!next) return 'stop';
        opts.state.write((ctx) => {
          countFinished(ctx, step);
          patchWorkstream(ctx, id, ctl.fence, {
            steps: advanceSteps(row.steps, row.stepIndex, move.to, entryFor(ctx, id)),
            stepIndex: move.to,
            nextAction: { kind: 'start' },
            model: next.model,
            effort: next.effort,
          });
          ctx.emit({ type: EventType.StepChanged, entityType: 'workstream', entityId: id, data: { stepIndex: move.to, role: next.role } });
        });
        return 'next';
      }
      case 'send_back': {
        const attempt = row.attempt + 1;
        if (attempt > opts.limits.maxFixAttempts) {
          fail(id, ctl.fence, `The ${step.role} step rejected the work and the retry limit (${String(opts.limits.maxFixAttempts)}) is used up`);
          return 'stop';
        }
        const target = row.steps[move.to];
        if (!target) return 'stop';
        const up = escalated(row, target, `the ${step.role} step rejected it`);
        opts.state.write((ctx) => {
          if (up.moved && target.profileId) recordProfileOutcome(ctx, target.profileId, { firstPass: false, escalated: true });
          patchWorkstream(ctx, id, ctl.fence, {
            attempt,
            steps: sendBackSteps(row.steps, row.stepIndex, move.to, up.step, entryFor(ctx, id)),
            stepIndex: move.to,
            nextAction: { kind: 'revise', reviewStep: row.stepIndex },
            model: up.step.model,
            effort: up.step.effort,
          });
          ctx.emit({
            type: EventType.StepChanged,
            entityType: 'workstream',
            entityId: id,
            data: { stepIndex: move.to, role: target.role, sentBackBy: step.role },
          });
        });
        return 'next';
      }
    }
  }
```

6e. In `run`, in the `step_done` branch, after the cancellation check and before the `withoutHandoff` flag:

```ts
          const finished = getWorkstreamRow(db, id);
          if (currentStep(finished).role !== StepRole.Implement) {
            if (finishReadOnlyStep(id, ctl, finished) === 'next') continue;
            return;
          }
```

The rest of the branch (the flag and the move to VERIFYING) stays for implement steps.

6f. In `verify`, replace the pass block (`if (result.exitCode === 0) { … return; }`) with:

```ts
      if (result.exitCode === 0) {
        const step = currentStep(row);
        const move = moveAfter(row.steps, row.stepIndex);
        const next = move.kind === 'advance' ? row.steps[move.to] : undefined;
        if (move.kind === 'advance' && next) {
          opts.state.write((ctx) => {
            insertEvidence(ctx, evidence);
            countFinished(ctx, step);
            transitionWorkstream(ctx, id, {
              to: S.Queued,
              fence: ctl.fence,
              patch: {
                nextAction: { kind: 'start' },
                steps: advanceSteps(row.steps, row.stepIndex, move.to, entryFor(ctx, id)),
                stepIndex: move.to,
                model: next.model,
                effort: next.effort,
              },
              reason: `gate passed; next: ${next.role}`,
            });
            clearLease(ctx, id);
          });
          return;
        }
        opts.state.write((ctx) => {
          insertEvidence(ctx, evidence);
          countFinished(ctx, step);
          if (row.steps.length > 0) patchWorkstream(ctx, id, ctl.fence, { steps: advanceSteps(row.steps, row.stepIndex, -1, entryFor(ctx, id)) });
          completeInTx(ctx, id, ctl.fence, row, commitShas, 'gate passed');
        });
        return;
      }
```

6g. In `verify`'s failure path, escalate before re-queueing the fix. Replace the final `opts.state.write` that transitions to QUEUED with:

```ts
      const failedStep = currentStep(row);
      const up = row.steps.length > 0 ? escalated(row, failedStep, 'the gate failed') : null;
      opts.state.write((ctx) => {
        if (up?.moved && failedStep.profileId) recordProfileOutcome(ctx, failedStep.profileId, { firstPass: false, escalated: true });
        transitionWorkstream(ctx, id, {
          to: S.Queued,
          fence: ctl.fence,
          patch: {
            nextAction: { kind: 'fix', evidenceId },
            attempt,
            ...(up
              ? {
                  steps: row.steps.map((s, i) => (i === row.stepIndex ? { ...up.step, attempts: s.attempts + 1 } : s)),
                  model: up.step.model,
                  effort: up.step.effort,
                }
              : {}),
          },
          reason: `gate exit ${String(result.exitCode)}`,
        });
        clearLease(ctx, id);
      });
```

A workstream with no stored steps (`up === null`) keeps its model and effort, as before.

6h. Move `retryWorkstream`'s body from `apps/daemon/src/daemon/services.ts` into `apps/daemon/src/team/steps.ts` as `retryWorkstream(state: StateStore, id: WorkstreamId): WorkstreamDto`. It keeps the FAILED check and the resets, uses `latestHandoffForStep`, and restarts the current step clean:

```ts
export function retryWorkstream(state: StateStore, id: WorkstreamId): WorkstreamDto {
  const row = getWorkstreamRow(state.db, id);
  if (row.state !== WorkstreamState.Failed) throw new ConflictError('Only a failed workstream can be retried');
  return state.write((ctx) => {
    const steps = row.steps.length > 0 ? restartStep(row.steps, row.stepIndex, ctx.now) : row.steps;
    const latest = latestHandoffForStep(ctx.tx, { ...row, steps });
    return transitionWorkstream(ctx, id, {
      to: WorkstreamState.Queued,
      fence: null,
      patch: {
        attempt: 0,
        recoveryAttempts: 0,
        failureReason: null,
        steps,
        nextAction: latest ? { kind: 'continue_from_handoff', handoffId: latest.id } : { kind: 'start' },
      },
      reason: 'retried by the builder',
    });
  });
}
```

Keep whatever else the existing retry does (the reason text, any patch field not shown here) exactly as it is. `daemon/services.ts`'s `retryWorkstream` becomes `const ws = retryWorkstream(deps.state, id); deps.scheduler.requestTick(); return ws;`. Export it from `team/index.ts`, and add `retry(id)` to the test engine, calling it.

- [ ] **Step 7: Run the tests**

Run: `pnpm --filter @10db/daemon exec vitest run && pnpm -r typecheck && pnpm --filter @10db/desktop e2e`
Expected: PASS, every existing runner and recovery test included. The e2e loop now runs its review session through `complete_step` and reaches Done.

- [ ] **Step 8: Commit**

```bash
pnpm format && git add packages/contracts/src/entities.ts packages/contracts/generated apps/daemon/src/team apps/daemon/src/briefing apps/daemon/src/runner apps/daemon/src/recovery apps/daemon/src/daemon/services.ts apps/daemon/test/engine.ts && git commit -m 'feat(daemon): walk flow steps, send rejections back one profile up, and finish on the last step'
```

---
### Task 10: HTTP routes for the team, flows, profiles, benchmarks and step plans

M2b's Settings view, chart and approval sheet need these, and the builder can use them with `curl` until then.

**Files:**
- Modify: `apps/daemon/src/api/app.ts`, `apps/daemon/src/api/services.ts`, `apps/daemon/src/daemon/services.ts`, `apps/daemon/src/daemon/start.ts`, `apps/daemon/scripts/live-acceptance.ts`
- Test: `apps/daemon/src/api/app.test.ts`, `apps/daemon/src/daemon/start.test.ts`

**Interfaces:**
- Consumes: the contracts and repositories of Tasks 1–3, Task 6 (`resolveStepPlan`, `GET /flows`) and Task 7 (`RunningDaemon.benchmarks`).
- Produces these routes. Every body is parsed with its contracts schema, and every response is the DTO named:

| Method and path | Body | Answers |
|---|---|---|
| `GET /personas` | | `PersonaDto[]`, archived included |
| `POST /personas` | `PersonaInput` | 201 `PersonaDto` |
| `PATCH /personas/:personaId` | `PersonaPatch` | `PersonaDto` |
| `GET /people` | | `PersonDto[]` |
| `POST /people` | `PersonInput` | 201 `PersonDto` |
| `POST /flows` | `FlowInput` | 201 `FlowDto` |
| `PATCH /flows/:flowId` | `FlowPatch` | `FlowDto` |
| `GET /model-profiles` | | `ModelProfileDto[]` |
| `PATCH /model-profiles/:profileId` | `ModelProfilePatch` | `ModelProfileDto` |
| `GET /benchmarks/status` | | `BenchmarkStatusDto` |
| `POST /benchmarks/sync` | | `BenchmarkStatusDto`, after the sync finishes |
| `GET /benchmarks/models` | | `AaModelDto[]` |
| `PATCH /projects/:projectId` | `ProjectPatch` | `ProjectDto` |
| `GET /projects/:projectId/team` | | `TeamDto` |
| `PUT /projects/:projectId/team` | `TeamInput` | `TeamDto` |
| `GET /projects/:projectId/routing-rules` | | `RoutingRuleDto[]` |
| `PUT /projects/:projectId/routing-rules` | `RoutingRulesInput` | `RoutingRuleDto[]` |
| `PATCH /tasks/:taskId` | `TaskPatch` | `TaskDto` |
| `GET /tasks/:taskId/step-plan` | | `StepPlanDto` |

`ApiServices` gains one method per row: `listPersonas`, `createPersona`, `patchPersona`, `listPeople`, `createPerson`, `createFlow`, `patchFlow`, `listModelProfiles`, `patchModelProfile`, `benchmarkStatus`, `syncBenchmarks` (returns a `Promise`), `listAaModels`, `patchProject`, `getTeam`, `setTeam`, `listRoutingRules`, `setRoutingRules`, `patchTask` and `stepPlan`. `listFlows` exists from Task 6.

- [ ] **Step 1: Write the failing tests**

In `apps/daemon/src/api/app.test.ts`, add `beforeEach` to the `vitest` import. Add a `reached` list and a `track` helper above `stubServices`, and give every new method a tracking stub, so a test can see which service a route called:

```ts
const reached: string[] = [];
beforeEach(() => {
  reached.length = 0;
});
/** A stub that records the call and throws, so the route answers 500 after reaching the right service. */
const track =
  (name: string) =>
  (): never => {
    reached.push(name);
    throw new Error(`reached ${name}`);
  };
// in stubServices, after the existing entries:
    listPersonas: track('listPersonas'),
    createPersona: track('createPersona'),
    patchPersona: track('patchPersona'),
    listPeople: track('listPeople'),
    createPerson: track('createPerson'),
    createFlow: track('createFlow'),
    patchFlow: track('patchFlow'),
    listModelProfiles: track('listModelProfiles'),
    patchModelProfile: track('patchModelProfile'),
    benchmarkStatus: track('benchmarkStatus'),
    syncBenchmarks: track('syncBenchmarks'),
    listAaModels: track('listAaModels'),
    patchProject: track('patchProject'),
    getTeam: track('getTeam'),
    setTeam: track('setTeam'),
    listRoutingRules: track('listRoutingRules'),
    setRoutingRules: track('setRoutingRules'),
    patchTask: track('patchTask'),
    stepPlan: track('stepPlan'),
```

Then add:

```ts
describe('team, routing and benchmark routes', () => {
  const persona = { key: 'sec', name: 'Sec', role: 'review', tools: 'read_only', instructions: 'Check auth.' };
  const projectId = mintId('Project');
  const taskId = mintId('Task');
  it.each([
    { name: 'GET /personas', method: 'GET', path: '/personas', body: undefined, service: 'listPersonas' },
    { name: 'POST /personas', method: 'POST', path: '/personas', body: persona, service: 'createPersona' },
    { name: 'PATCH /personas/:id', method: 'PATCH', path: `/personas/${mintId('Persona')}`, body: { archived: true }, service: 'patchPersona' },
    { name: 'POST /people', method: 'POST', path: '/people', body: { handle: 'sam', name: 'Sam' }, service: 'createPerson' },
    { name: 'POST /flows', method: 'POST', path: '/flows', body: { name: 'mine', steps: [{ role: 'implement', need: 40 }] }, service: 'createFlow' },
    { name: 'PATCH /model-profiles/:id', method: 'PATCH', path: `/model-profiles/${mintId('ModelProfile')}`, body: { enabled: false }, service: 'patchModelProfile' },
    { name: 'GET /benchmarks/status', method: 'GET', path: '/benchmarks/status', body: undefined, service: 'benchmarkStatus' },
    { name: 'POST /benchmarks/sync', method: 'POST', path: '/benchmarks/sync', body: undefined, service: 'syncBenchmarks' },
    { name: 'GET /benchmarks/models', method: 'GET', path: '/benchmarks/models', body: undefined, service: 'listAaModels' },
    { name: 'PATCH /projects/:id', method: 'PATCH', path: `/projects/${projectId}`, body: { budgetCeiling: 2.5 }, service: 'patchProject' },
    { name: 'GET /projects/:id/team', method: 'GET', path: `/projects/${projectId}/team`, body: undefined, service: 'getTeam' },
    { name: 'PUT /projects/:id/team', method: 'PUT', path: `/projects/${projectId}/team`, body: { bindings: [], members: [] }, service: 'setTeam' },
    { name: 'PUT /projects/:id/routing-rules', method: 'PUT', path: `/projects/${projectId}/routing-rules`, body: { rules: [] }, service: 'setRoutingRules' },
    { name: 'PATCH /tasks/:id', method: 'PATCH', path: `/tasks/${taskId}`, body: { riskTags: ['auth'] }, service: 'patchTask' },
    { name: 'GET /tasks/:id/step-plan', method: 'GET', path: `/tasks/${taskId}/step-plan`, body: undefined, service: 'stepPlan' },
  ] as const)('routes $name to its service', async ({ method, path, body, service }) => {
    const res = await app().request(path, { method, ...(body === undefined ? auth : { ...json, body: JSON.stringify(body) }) });
    // The tracking stub throws after recording, so the API answers 500: the body passed validation.
    expect(res.status).toBe(500);
    expect(reached).toEqual([service]);
  });

  it.each([
    { name: 'a reviewer persona that edits', method: 'POST', path: '/personas', body: { ...persona, tools: 'edit' } },
    { name: 'an empty project patch', method: 'PATCH', path: `/projects/${projectId}`, body: {} },
    { name: 'a negative budget ceiling', method: 'PATCH', path: `/projects/${projectId}`, body: { budgetCeiling: -1 } },
    { name: 'a flow with no implement step', method: 'POST', path: '/flows', body: { name: 'talk', steps: [{ role: 'review', need: 48 }] } },
    { name: 'a malformed persona id', method: 'PATCH', path: '/personas/nope', body: { archived: true } },
  ])('answers 400 for $name without calling a service', async ({ method, path, body }) => {
    const res = await app().request(path, { method, ...json, body: JSON.stringify(body) });
    expect(res.status).toBe(400);
    expect(reached).toEqual([]);
  });
});
```

Success statuses (201 for a create) are checked against the real daemon in `start.test.ts`:

```ts
  it('seeds the team, reports no AA key, plans on hand-set scores, and refuses an over-budget start', async () => {
    const repo = createTempRepo();
    try {
      daemon = await startDaemon({ dataDir: dir.path, port: 0, adapter: new FakeAdapter({}), logLevel: 'warn', ...QUIET });
      const api = apiClient(daemon.url, daemon.token);
      expect((await api.get('/personas', z.array(PersonaDto))).map((p) => p.key)).toContain('reviewer');
      expect(await api.get('/benchmarks/status', BenchmarkStatusDto)).toMatchObject({ keyConfigured: false, outcome: 'no_key', models: 0 });
      const profiles = await api.get('/model-profiles', z.array(ModelProfileDto));
      const sonnetHigh = profiles.find((p) => p.model === 'sonnet' && p.effort === 'high');
      if (!sonnetHigh) throw new Error('not seeded');
      // Hand-set (invented) scores: the profile becomes manual and the only measured one.
      expect(
        await api.patch(`/model-profiles/${sonnetHigh.id}`, ModelProfileDto, { scores: { intelligence: 50, coding: 50, agentic: 50 }, costPerTaskUsd: 2 }),
      ).toMatchObject({ source: 'manual' });
      const project = await api.post('/projects', ProjectDto, { name: 'demo', repoPath: repo.path, gateCommand: 'true', areas: [{ name: 'src', globs: ['src/**'] }] });
      const task = await api.post(`/projects/${project.id}/tasks`, TaskDto, { title: 'T', acceptanceCriteria: ['x'], areas: ['src'] });
      const plan = await api.get(`/tasks/${task.id}/step-plan`, StepPlanDto);
      expect(plan).toMatchObject({ flowName: 'standard', overBudget: [] });
      expect(plan.steps.map((s) => `${s.role}:${s.model}@${s.effort}`)).toEqual(['implement:sonnet@high', 'review:sonnet@high']);
      await api.patch(`/projects/${project.id}`, ProjectDto, { budgetCeiling: 1 });
      await expect(api.post(`/tasks/${task.id}/start`, WorkstreamDto)).rejects.toThrow('-> 400');
    } finally {
      repo.cleanup();
    }
  });
```

Import `BenchmarkStatusDto`, `ModelProfileDto`, `PersonaDto`, `ProjectDto`, `StepPlanDto`, `TaskDto` and `WorkstreamDto` from `@10db/contracts` there.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @10db/daemon exec vitest run src/api src/daemon/start.test.ts`
Expected: FAIL with 404s for the new paths and missing service methods.

- [ ] **Step 3: Add the services**

In `apps/daemon/src/api/services.ts`, add one method per route, typed with the contracts DTOs and inputs (`api/` must not import `@10db/db`):

```ts
  listPersonas(): PersonaDto[];
  createPersona(input: PersonaInput): PersonaDto;
  patchPersona(id: PersonaId, patch: PersonaPatch): PersonaDto;
  listPeople(): PersonDto[];
  createPerson(input: PersonInput): PersonDto;
  createFlow(input: FlowInput): FlowDto;
  patchFlow(id: FlowId, patch: FlowPatch): FlowDto;
  listModelProfiles(): ModelProfileDto[];
  patchModelProfile(id: ModelProfileId, patch: ModelProfilePatch): ModelProfileDto;
  benchmarkStatus(): BenchmarkStatusDto;
  syncBenchmarks(): Promise<BenchmarkStatusDto>;
  /** AA's list as stored locally; the UI shows it only with AA's attribution. */
  listAaModels(): AaModelDto[];
  patchProject(id: ProjectId, patch: ProjectPatch): ProjectDto;
  getTeam(projectId: ProjectId): TeamDto;
  setTeam(projectId: ProjectId, input: TeamInput): TeamDto;
  listRoutingRules(projectId: ProjectId): RoutingRuleDto[];
  setRoutingRules(projectId: ProjectId, input: RoutingRulesInput): RoutingRuleDto[];
  patchTask(id: TaskId, patch: TaskPatch): TaskDto;
  /** What starting the task would run; throws InvalidError when no flow or profile fits. */
  stepPlan(taskId: TaskId): StepPlanDto;
```

In `apps/daemon/src/daemon/services.ts`, add `benchmarks: BenchmarkSync` to `createServices`' deps; `start.ts` passes the sync Task 7 created. Then implement each method with the repositories, writing through `deps.state.write`:

```ts
    listPersonas: () => listPersonas(db, { includeArchived: true }),
    createPersona: (input) => deps.state.write((ctx) => insertPersona(ctx, input)),
    patchPersona: (id, patch) => deps.state.write((ctx) => patchPersona(ctx, id, patch)),
    listPeople: () => listPeople(db),
    createPerson: (input) => deps.state.write((ctx) => insertPerson(ctx, input)),
    createFlow: (input) => deps.state.write((ctx) => insertFlow(ctx, input)),
    patchFlow: (id, patch) => deps.state.write((ctx) => patchFlow(ctx, id, patch)),
    listModelProfiles: () => listModelProfiles(db),
    patchModelProfile: (id, patch) => deps.state.write((ctx) => patchModelProfile(ctx, id, patch)),
    benchmarkStatus: () => deps.benchmarks.status(),
    syncBenchmarks: () => deps.benchmarks.sync(),
    listAaModels: () => listAaModels(db),
    patchProject: (id, patch) => deps.state.write((ctx) => patchProject(ctx, id, patch)),
    getTeam: (projectId) => {
      getProject(db, projectId);
      return getTeam(db, projectId);
    },
    setTeam: (projectId, input) => deps.state.write((ctx) => setTeam(ctx, projectId, input)),
    listRoutingRules: (projectId) => listRoutingRules(db, projectId),
    setRoutingRules: (projectId, input) => deps.state.write((ctx) => setRoutingRules(ctx, projectId, input)),
    patchTask: (id, patch) => deps.state.write((ctx) => patchTask(ctx, id, patch)),
    stepPlan: (taskId) => resolveStepPlan(db, taskId),
```

`getTeam` checks the project first, so an unknown project answers 404 instead of an empty team.

- [ ] **Step 4: Add the routes**

In `apps/daemon/src/api/app.ts`, chain the routes onto the same Hono expression as the existing ones (the desktop's typed client sees only chained routes). Follow the existing shapes, for example:

```ts
    .get('/personas', (c) => c.json(deps.services.listPersonas()))
    .post(
      '/personas',
      validator('json', (value): PersonaInput => PersonaInput.parse(value)),
      (c) => c.json(deps.services.createPersona(c.req.valid('json')), 201),
    )
    .patch(
      '/personas/:personaId',
      validator('json', (value): PersonaPatch => PersonaPatch.parse(value)),
      (c) => c.json(deps.services.patchPersona(PersonaId.parse(c.req.param('personaId')), c.req.valid('json'))),
    )
    .post('/benchmarks/sync', async (c) => c.json(await deps.services.syncBenchmarks()))
    .get('/tasks/:taskId/step-plan', (c) => c.json(deps.services.stepPlan(TaskId.parse(c.req.param('taskId')))))
```

Write the other fourteen the same way, parsing each path ID with its branded schema. A malformed ID throws a `ZodError`, which `onError` already answers with 400.

- [ ] **Step 5: Keep the live acceptance run on `quick`**

In `apps/daemon/scripts/live-acceptance.ts`, the §1.3 run stays an implement-only run until M2b adds review sessions to it. Before creating the project, look the flow up and pin it:

```ts
  const quick = (await api(z.array(FlowDto), '/flows')).find((f) => f.name === 'quick');
  if (!quick) throw new Error('the quick flow was not seeded');
```

Add `flowId: quick.id,` to the `POST /projects` body. Import `FlowDto` from `@10db/contracts`.

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @10db/daemon exec vitest run && pnpm -r typecheck`
Expected: PASS. The desktop typechecks against the new `AppType`.

- [ ] **Step 7: Commit**

```bash
pnpm format && git add apps/daemon/src/api apps/daemon/src/daemon apps/daemon/scripts/live-acceptance.ts && git commit -m 'feat(daemon): serve personas, people, flows, profiles, benchmarks, teams, routing rules and step plans'
```

---
### Task 11: The Factory view shows each workstream's step

**Files:**
- Create: `apps/desktop/src/views/factory/step-cell.tsx`, `apps/desktop/src/views/factory/step-cell.test.tsx`
- Modify: `apps/desktop/src/views/factory/factory-view.tsx`, `apps/desktop/src/daemon/events.ts`, `apps/desktop/src/views/factory/factory-view.test.tsx`

**Interfaces:**
- Consumes: `WorkstreamDto.steps` and `.stepIndex` (Task 3), the new event entity types (Tasks 1–3, 7).
- Produces: `StepCell({ workstream }: { workstream: WorkstreamDto })`, and `INVALIDATIONS` entries for `persona`, `person`, `flow`, `model_profile`, `team`, `routing_rules` and `benchmarks`, each `[]` until M2b adds the queries that read them.

- [ ] **Step 1: Write the failing test**

`apps/desktop/src/views/factory/step-cell.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import type { WorkstreamStep } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { workstreamDto } from '../../test/fixtures';
import { theme } from '../../theme';
import { StepCell } from './step-cell';

const step = (role: 'implement' | 'review', personaName: string, model: string, effort: 'medium' | 'high', attempts = 0): WorkstreamStep => ({
  role,
  personaId: null,
  personaName,
  tools: role === 'implement' ? 'edit' : 'read_only',
  score: role === 'implement' ? 'coding' : 'intelligence',
  profileId: null,
  model,
  effort,
  need: 40,
  reason: 'cheapest profile at or above 40 coding',
  overBudget: false,
  pinned: false,
  status: 'running',
  attempts,
  startedAt: null,
  sessionFloor: 0,
  result: null,
});

function show(ws: ReturnType<typeof workstreamDto>) {
  render(
    <MantineProvider theme={theme}>
      <StepCell workstream={ws} />
    </MantineProvider>,
  );
}

describe('StepCell', () => {
  it.each([
    {
      name: 'the step, its persona and its profile',
      ws: workstreamDto({ steps: [step('implement', 'Implementer', 'sonnet', 'medium'), step('review', 'Reviewer', 'sonnet', 'high')], stepIndex: 1 }),
      texts: ['2/2 review', 'Reviewer · sonnet@high'],
    },
    {
      name: 'a retry count once a step was sent back',
      ws: workstreamDto({ steps: [step('implement', 'Implementer', 'sonnet', 'high', 2)], stepIndex: 0 }),
      texts: ['1/1 implement', 'Implementer · sonnet@high', 'retry 2'],
    },
    {
      name: 'a workstream started before flows as its model alone',
      ws: workstreamDto({ steps: [], stepIndex: 0, model: 'opus', effort: 'high' }),
      texts: ['opus@high'],
    },
  ])('shows $name', ({ ws, texts }) => {
    show(ws);
    for (const text of texts) expect(screen.getByText(text)).toBeTruthy();
  });
});
```

In `apps/desktop/src/views/factory/factory-view.test.tsx`, extend the first test's row assertions with `expect(within(row).getByText('opus@high')).toBeTruthy();` after giving its `workstreamDto` `model: 'opus', effort: 'high'` (it has no steps, so it shows the model alone).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @10db/desktop exec vitest run src/views/factory`
Expected: FAIL, because `step-cell` doesn't exist.

- [ ] **Step 3: Write the cell and the column**

`apps/desktop/src/views/factory/step-cell.tsx`:

```tsx
import { Stack, Text } from '@mantine/core';
import type { WorkstreamDto } from '@10db/contracts';

/** The step a workstream is on, who runs it and on which profile; a pre-flow workstream shows its model. */
export function StepCell({ workstream }: { readonly workstream: WorkstreamDto }) {
  const step = workstream.steps[workstream.stepIndex];
  if (!step) return <Text size="sm">{`${workstream.model}@${workstream.effort}`}</Text>;
  return (
    <Stack gap={0}>
      <Text size="sm">{`${String(workstream.stepIndex + 1)}/${String(workstream.steps.length)} ${step.role}`}</Text>
      <Text size="xs" c="dimmed" title={step.reason}>
        {`${step.personaName} · ${step.model}@${step.effort}`}
      </Text>
      {step.attempts > 0 ? (
        <Text size="xs" c="orange">{`retry ${String(step.attempts)}`}</Text>
      ) : null}
    </Stack>
  );
}
```

In `factory-view.tsx`, add a `Step` header after `State` and `<Table.Td><StepCell workstream={ws} /></Table.Td>` after the state cell.

In `apps/desktop/src/daemon/events.ts`, add `persona: [], person: [], flow: [], model_profile: [], team: [], routing_rules: [], benchmarks: []` to `INVALIDATIONS`. A `StepChanged` event uses `entityType: 'workstream'`, which already invalidates the workstream lists.

The cell shows the step's persona and model, and its `reason` as a tooltip: the router's choice, the "no profile has a … score yet" fallback, or an escalation. It shows no AA scores; the M2b chart is where those appear, with AA's attribution.

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @10db/desktop exec vitest run && pnpm --filter @10db/desktop typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm format && git add apps/desktop/src/views/factory apps/desktop/src/daemon/events.ts && git commit -m 'feat(desktop): show each workstream’s step, persona and profile in the factory'
```

---

### Task 12: Decisions, open items, open questions and the gate

**Files:**
- Modify: `docs/architecture/decisions.md`, `docs/open-items.md`, `docs/architecture/open-questions.md`

- [ ] **Step 1: Record the decisions**

Append rows 56 to 65 from this plan's "New decisions" table to the decision log in `docs/architecture/decisions.md`, verbatim. `tests/repo/src/architecture-docs.test.ts` checks that the numbers run without gaps.

- [ ] **Step 2: Update the open questions**

In `docs/architecture/open-questions.md`, remove the row "Whether Artificial Analysis data may be imported into `model_profiles`" (decision 65 answers it), and add:

| Question | Who or what can answer it | Blocks |
|---|---|---|
| Whether showing AA data in a public open-source app's comparison view needs AA's written consent (Data Platform Terms §2.4(c), §2.5 "model/provider selection guidance") | Artificial Analysis (data-api contact) | shipping M2b's chart in a public release |
| Whether Claude Code's `opus`, `sonnet`, `haiku` and `fable` aliases run the configuration AA benchmarks ("default fallback") | Anthropic docs or a live comparison | trusting AA scores for routing |

- [ ] **Step 3: Update the open items**

In `docs/open-items.md`:
- Edit the line "Spec §4: the projects budget ceiling, the inbox delivery record and the workstream flow, persona and profile fields are not built yet." so it names only what is still missing: "Spec §4: the inbox delivery record, persona avatars and people's channels are not built yet."
- Tick the line "M2: reviewer approval in flows with a review step before DONE (spec §5.4)." and add after it: "(M2a: review, plan-review and QA steps give verdicts through `complete_step`.)"
- Add:
  - `- [ ] M2b: the board, the picker and PM-agent review (need estimates, optional steps), the batch approval sheet that edits a step plan before start, the consult step, ⌘K, and the Settings view (AA key, team bindings, routing rules, budget, flows, personas, profiles) with the AA Intelligence-vs-Cost chart: Pareto line, axis picker, AA logo and source link (plan 07).`
  - `- [ ] M2c: takeover and the PTY (plan 08).`
  - `- [ ] M2b: the live acceptance run adds a task on the standard flow, so a real reviewer calls complete_step (M2a keeps §1.3 on the quick flow).`
  - `- [ ] Spec §7: a card's owner is stored but nothing filters or notifies by owner yet; the inbox's "mine / teammate" filter is M2b.`
  - `- [ ] Spec §4 model_profiles: the observed stats count steps and escalations only; tokens per step are not recorded yet.`
  - `- [ ] Spec §8: a read-only step keeps its task's area claims while it reviews, so other implementers in that area wait; consider releasing claims for read-only steps and re-acquiring them on a send-back.`
  - `- [ ] AA: once a key exists, confirm the free API's slugs and its `page` query parameter match the catalogue's and the client's (the sync status lists unmeasured profiles), and that AA's index versions don't shift scores between syncs.`

- [ ] **Step 4: Run the gate**

Run: `make gate`
Expected: the last line is `GATE PASS format lint typecheck test build e2e drift knip rust (…)`.
- A `knip` failure names an export nothing imports: remove it from its `index.ts`, or use it.
- A `drift` failure names a generated file: regenerate it, and add it to the commit that owns its source.

- [ ] **Step 5: Commit and open the PR**

```bash
git add docs/architecture/decisions.md docs/architecture/open-questions.md docs/open-items.md && git commit -m 'docs(docs): record the m2a team, routing and artificial analysis decisions'
```

Push the branch and open a PR to `main` titled `feat(daemon): run tasks through flows of personas on aa-scored model profiles (m2a)`. Its body lists what M2a builds, what moves to M2b and M2c, and the `GATE PASS` line, and notes that no AA data is in the diff.

---

## Self-review notes

- **Spec coverage:**
  - Covered:
    - §4 teams and routing tables: Tasks 2 and 3.
    - §5.2.3 router and floors: Task 5.
    - §5.2.5 escalation: Tasks 5 and 9.
    - §5.2.7 per-provider cap: already built, named in the header.
    - §5.4 "Flows with review also need the reviewer's approval": Task 9.
    - §7 routing: Task 3.
    - §11.3 default personas: Task 4.
    - §14's AA question: decision 65 and Task 7.
  - Explicitly M2b: §5.2.1 picker, §5.2.2 PM review, §5.2.4 approval sheet, §5.2.6 consult; §10 board, Settings, ⌘K and the frontier chart; the Ready rule's blocking card.
  - Explicitly M2c: takeover.
- **The first review's findings, and where each is fixed:**
  1. Default flow and existing tests: Task 6 Step 6 and Task 10 Step 5.
  2. `readonly` steps in drizzle `.set()`: Task 3, mutable `WorkstreamPatch.steps`.
  3. Handoffs scoped to the step, by session floor: Tasks 1, 3 and 9.
  4. Read-only shell and no gate: Task 8.
  5. Retry restarts the step clean, and the nudge is per session: Task 9.
  6. The `commit` handler's `readOnly: false`: Task 8 Step 6.
  7. A failed step is marked: Task 9 `failStep`.
  8. Verdicts in "Earlier steps" and the reviser named: Tasks 8 and 9.
  9. knip and type re-exports: the Global Constraints, Tasks 8 and 9.
  10. The migration rebuild fallback: Task 3 Step 6.
  11. `insertTask` fields, the tie-break rows, full tool names in personas, decision 61's VERIFYING pass-through, and the persona and people fields named in the open items: Tasks 3, 5, 4 and 12 and decision 61.
- **The second review's findings, and where each is fixed:**
  1. Read-only commands that write (`sort -o`, `uniq`, `tree -o`, `rg --pre`): Task 8 `WRITING_OPTIONS`, with table rows.
  2. A failing background sync crashing the daemon: Task 7 `run()`, which never rejects, with a database-failure row.
  3. The literal `SecretSource` helper and the self-referencing `fetch` parameter: Task 7.
  4. The `as const` skip-rule table: Task 5.
  5. `acceptance-checks.test.ts` pinned, and the e2e review session first exercised in Task 9: Tasks 6 and 9.
  6. Decision numbers in comments: removed, and a Global Constraints line added.
  7. An unknown `flowId` answers 404: Task 3.
  8. Sync lifecycle: Task 7 (`keyConfigured` recorded at sync time, a `stopped` flag, unmeasured profiles named, decision 65 wording).
  9. Recovery marks a failed step, the retry-limit message, archived personas, the read-only handoff nudge and plan steps before implement: Tasks 9, 5, 8 and 1. Claims held during review: an open item in Task 12.
- **Types used across tasks:**
  - `WorkstreamStep` (with `score` and `sessionFloor`) and `currentStep`: Task 1. Read in Tasks 3, 8, 9 and 11.
  - `latestHandoffForStep`: Task 3. Used in Task 9.
  - `planSteps`, `escalateStep`, `NoProfileError`: Task 5. Used in Tasks 6 and 9.
  - `measureForTests` and `quickFlowId`: Task 6. Used in Tasks 9 and 10.
  - `createBenchmarkSync` and `RunningDaemon.benchmarks`: Task 7. Used in Task 10.
  - `RESULT_NUDGE`, `READ_COMMANDS` and `allowedToolsFor`: Task 8.
  - `moveAfter`, `advanceSteps`, `sendBackSteps`, `restartStep`, `failStep`, `StepEntry` and `retryWorkstream`: Task 9.
  - `readDefaultPersonas`: Task 4. Used in Tasks 6 and 7.
  - `BUILDER_HANDLE`: Task 2. Used in Tasks 3 and 6.
