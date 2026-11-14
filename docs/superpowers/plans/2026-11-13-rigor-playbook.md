# Rigor and the playbook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Brief

**What changes for the builder**

- Settings › Models leads with the **playbook**: a row per rigor (Light, Standard, Careful, Critical) saying
  which steps run, and a cell per rigor and role with its persona, model and effort, showing what that resolves to
  on the selected account. "Who each role gets" and the global "Models by role" page go away; a project's
  "Models by role" page becomes that project's playbook and its default rigor.
- A **Kinds** list under it (security, auth, migration, dependency, schema, infra, ui, docs), each with a minimum
  rigor, its safety switches and per-role overrides.
- The task drawer shows **Rigor**, **Kinds**, **Model** and **Effort** instead of Flow, Risks and Model.
- Plan's model picker gains an effort.
- Your settings carry over on the first start; what can't is listed on Settings › Models and, per project, in an
  Inbox card.

**Changes you'll see** (the agreed design, listed so none is silent)

- Quick-flow tasks become Light: builds need at least 35 (40 today). Standard reviews need at least 40 (48), so
  they move from Opus at medium effort to Sonnet at high effort today.
- Full-flow tasks become Careful: they always plan; QA and Plan Review stop running (they ran only for more than
  3 criteria, or security/auth/migration tags). Migration tasks still get Plan Review (the kind adds it).
- A task tagged security, auth or migration is at least Careful, so a quick security fix now gets a Plan step;
  dependency is at least Standard, so it gets a Review.
- A quick security fix gains a Plan step and a Review (Careful runs both). Full-flow builds need at least 45
  (40 today).
- Security and auth reviews, and migration reviews and plan reviews, run on Frontier at high effort. Migration
  builds move from the top model at low effort (Fable today) to the top of Capable at high effort (Opus today).
  Security and auth builds move from Sonnet at high effort to the top of Capable at high effort (Opus today),
  and security, auth and migration plans to Capable at high effort (spec §6.1).
- Without scores (no Artificial Analysis key), every Careful step runs one effort up.
- A cell naming one model is never stepped up on a retry; today only a persona pin held a step.
- A task's own model choice beats a playbook cell that names one model (today a persona pin beat the task's
  choice). A step whose minimum no model on the account reaches runs on the strongest one instead of refusing
  to start.
- Plan conversations follow the Careful Plan cell, so a moved persona pin on the planner now applies to them.

**What could go wrong, and how we'd know**

- A moved setting routes differently than designed: a regression table feeds today's settings (seeded and
  builder-made: role settings, pins, bindings, patterns) through the move and the new router, and asserts both
  the step list and the pick for every case; only the changes above may differ.
- The move loses or doubles a setting: table-tested row by row on a real SQLite file, and run twice.
- An account lists a Frontier model it can't run: a refused pick falls back to the next model the account runs,
  and the step's reason says so (tested).

**Calls you might disagree with:** process per rigor (review rounds, resumed-session fixes, Critical's plan
approval, Light's review safety net) moves to PR 2b; kinds' skills, `impliedBy` and how a rigor was set (judge,
rules) come later, so their fields aren't shown yet; the Workbench picker is a follow-up; old tables stay until a
cleanup PR.

**Needed from you:** nothing.

---

**Goal:** PR 2 of `docs/superpowers/specs/2026-11-13-10db-right-sized-work-design.md` (§4–7, §9, §10.3), minus PR
2b's process settings, kinds' skills and `impliedBy` (PR 3), and the Workbench picker (follow-up).

**Architecture:** defaults live in code; rows hold overrides, global or per project, so Reset deletes a row. A
pure resolver turns a task's rigor, kinds and the playbook into each step's persona, requirements and effort;
`chooseModel` takes the strongest requirement under the task's pin. Today's settings move at daemon start, once;
the old tables stay, read only by the move.

**Tech Stack:** TypeScript, zod, Drizzle + SQLite, Hono, React + Mantine + mantine-datatable, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-13-10db-right-sized-work-design.md`.

## Global Constraints

- `.claude/rules/code-style.md`, `.claude/rules/testing.md`. Each newly tested behavior carries its value card
  (below, per task) in its commit.
- Forward-only migrations: change `schema.ts`, `pnpm --filter @10db/db generate`; never edit generated SQL.
  `pnpm --filter @10db/contracts generate` after contract changes.
- Branded IDs via `packages/contracts/src/ids.ts` (`Kind: idSchema('knd', 'KindId')`).
- No copy names a model; the minimum scores are 10db's thresholds, not Artificial Analysis data.

## Provider parity

| Piece | Claude plan, API key, Bedrock | ChatGPT/Codex plan |
| --- | --- | --- |
| Rigor, kinds, playbook, the move | yes | yes |
| Cells resolve | the account's offer | the account's offer; Frontier is OpenAI's top band |
| A fixed effort | low…max | the levels Codex offers; snaps via `atEffort` (tested in Task 4b) |
| Plan picker effort | the model's efforts | the model's efforts (Codex levels) |
| A Frontier model listed but refused | falls back to the next offered (tested in Task 4c) | same |

## Review Focus

1. A kind override never makes a step weaker than its cell, across every pair of setting types.
2. A task whose kinds raise its rigor gets the raised row's steps; a moved task is stored at that raised rigor.
3. An unknown persona id or kind key is ignored at start, never a crash.
4. The move runs once, and a project's own settings keep winning over global ones as they do today.
5. With no scores (no Artificial Analysis key), rigor still changes the model: each cell has a fallback rung.

---

### Task 1: Contracts

**Files:** `packages/contracts/src/rigor.ts` (new), `catalogue.ts`, `entities.ts`, `shape.ts`, `ids.ts`, `index.ts`; tests beside each.

**Produces:**

- `Rigor` (`light`, `standard`, `careful`, `critical`), `RIGORS`, `rigorAtLeast(a, b)`.
- `ModelSetting`: `automatic.minimum?` (0–100), `top_of_tier.tier?`; old rows still parse.
- `CellSetting { personaId: PersonaId | null; model: ModelSetting | null; effort: Effort | null }` (null = inherit).
- `PlaybookInput { rows: { rigor; steps: StepRole[] | null }[]; cells: ({ rigor; role } & CellSetting)[] }`,
  steps must include `implement`. `PlaybookDto` resolved per field with `source: 'default' | 'global' |
  'project'`.
- `KindDto { id; key; label; description; minimumRigor: Rigor | null; alwaysReviewed; failsAtLimit; ownCopy;
  toInbox; addsSteps: StepRole[]; overrides: Partial<Record<StepRole, CellSetting>>; position }`. `KindInput`;
  `KindPatch` (no `key`: a key is immutable).
- `TaskKind { key; source: 'builder' | 'agent' }` (PR 3 adds `rules`, `judge`). Task: `rigor: Rigor | null`,
  `kinds`, `effortPin`; `TaskDto.effectiveRigor`. Project: `defaultRigor`. Shape: `effort`.
- `riskTags`, `flowId` and the old DTOs stay until Task 9.

**Value:** `protects=the shapes every boundary parses; fails_when=an old row stops parsing or a playbook without
Build is accepted; why_new=no rigor contracts existed; no_claim=that the daemon uses them`

- [ ] Tables: `rigorAtLeast`; old and new ModelSetting JSON; PlaybookInput without implement refused; KindPatch
      refuses `key`. Red, green, regenerate, commit.

### Task 2: Storage

**Files:** `packages/db/src/schema.ts`, generated `0069_*.sql`, `store/kinds.ts`, `store/playbook.ts` (new),
`store/tasks.ts`, `store/projects.ts`, `store/shapes.ts`, `store/legacy-routing.ts` (new: typed readers of
`flows`, `patterns`, `role_settings`, `team_bindings`, persona pins, task `risk_tags`/`flow_id`, project
`flow_id`, for the move only); `packages/db/AGENTS.md`; tests on real SQLite.

**Produces:** tables `kinds`; `playbook_rows` (rigor, project_id nullable, steps json nullable) and
`playbook_cells` (rigor, role, project_id nullable, persona_id, model json, effort), each with **partial unique
indexes** for the global and project scopes as `role_settings` has; columns `tasks.rigor`, `tasks.kinds` (default
`'[]'`), `tasks.effort_pin`, `projects.default_rigor`, `shapes.effort`. Stores: `listKinds`, `insertKind`,
`patchKind`, `deleteKind`, `moveKind`; `getPlaybook(projectId | null)`, `setPlaybook(ctx, projectId | null, input)`.

**Value:** `protects=playbook overrides per scope and a task's rigor and kinds persist; fails_when=a scope write
clobbers the other scope or two global cells coexist; why_new=new tables; no_claim=routing from them`

- [ ] Real-SQLite tests: scopes independent; a second global cell for one rigor/role is refused; round-trips.
      Red, generate, green, commit.

### Task 3: Defaults and seeded kinds

**Files:** `apps/daemon/src/routing/playbook-defaults.ts`, `team/seed-kinds.ts` (new), `team/seed.ts`; tests.

**Produces:**

- `DEFAULT_ROWS`: Light `[implement]`; Standard `[implement, review]`; Careful `[plan, implement, review]`;
  Critical `[plan, plan_review, implement, review, qa]`.
- `DEFAULT_CELLS`, model `automatic` with minimum: Light implement 35; Standard implement 40, review 40; Careful
  plan 45, implement 45, review 48; Critical plan 50, plan_review 52, implement 50, review 52, qa 35.
- `FALLBACK_RUNG` per cell, for when no profile is scored: Light and Standard the role's `ROLE_DEFAULT` tier and
  effort; Careful the same, one effort up; Critical the top of Capable+Frontier, one effort up (today's floored
  behaviour).
- `SEEDED_KINDS` (spec §6, §6.1): security, auth (careful; alwaysReviewed, failsAtLimit, toInbox; plan `tier
  capable`/high, implement `top_of_tier capable`/high, review `tier frontier`/high); migration (careful;
  alwaysReviewed, ownCopy, toInbox; addsSteps `[plan_review]`; same plus plan_review `tier frontier`/high);
  dependency (standard; alwaysReviewed, ownCopy, toInbox); schema, infra (careful); ui, docs.
- `seedKinds(ctx)`, once, gated by app setting `kinds.seeded`.

**Value:** `protects=the shipped defaults and kinds; fails_when=a seed reruns over the builder's edits;
why_new=new seeds; no_claim=that the defaults are the right numbers`

- [ ] Tests: seeds once; a deleted seeded kind stays deleted. Commit.

### Task 4a: The pure resolver

**Files:** `apps/daemon/src/routing/playbook.ts` (new), tests.

**Produces:** `effectiveRigor(task, project, kinds)`; `resolveSteps({ rigor, taskKinds, kinds, rows, cells }):
ResolvedStep[]`, `ResolvedStep { role; personaId; requirements: ModelSetting[]; effort; need; fallback;
pinned }`. Steps: project row ?? global ?? default, plus kinds' `addsSteps`, in role order. Per field: project
cell ?? global cell ?? default. `requirements` = `[cell.model, ...kinds' override models]`. `need` = the highest of
the cell's own minimum (its `automatic.minimum`; when the cell's model sets none — `tier`, `top_of_tier`, or
`automatic` without one — the default cell's minimum) and every kind override's minimum. A builder's "at least 30"
on Light Build routes at 30. `effort` = the highest set. Persona = first
kind override persona (list order) ?? cell persona. `pinned` = the cell's model is `{ kind: 'model' }`.

**Value:** `protects=what each step of a task gets; fails_when=inheritance skips a scope, a kind weakens a
step, or a moved tier setting loses its need; why_new=new module; no_claim=model availability on an account`

- [ ] Named table: inheritance per field; kinds raise rigor; `addsSteps` order; need keeps the default minimum
      under a `tier` cell; a cell's own lower minimum wins; unknown kind ignored. Red, green, commit.

### Task 4b: `chooseModel` and every caller

**Files:** `routing/choose-model.ts`, `routing/router.ts`, `routing/role-picks.ts`, `routing/plan-steps.ts`,
`routing/retry-step.ts`, `team/steps.ts`, `runner/resolve-step.ts`,
`runner/runner.ts` (`escalated`, `resolveOn`), `daemon/start.ts` (`planModel`), `daemon/account-judges.ts`,
`daemon/area-namer.ts`, `daemon/services.ts`, `delivery/pass-open.ts`, `team/routing-inputs.ts`; delete
`routing/floors.ts`, `routing/skip-rules.ts`; tests. Every caller changes here so the task typechecks.

**Produces:** `chooseModel` input drops `roleSettings`, `patterns`, persona pin and minimum, floors and
`stakes.retry` patterns; gains `requirements`, `effort`, `fallback`, `pinned`. Order: task pin
(`modelSetting`, `effortPin`) → `plannedSetting`/`startOverTier` → the **strongest** requirement's choice
(higher Intelligence; unscored: higher rung, then price; then effort). `automatic` routes at the step's `need`
(Task 4a); none reaching it → the strongest offered, the reason says so. A fixed effort routes among that effort's
profiles, snapping with `atEffort`. Unscored → `fallback`. Callers: `planModel` reads the **Careful Plan** cell
(project, then global, then default) with `byScore: false`, plus `shape.effort`; `accountJudges` reads
**Standard Build**; `areaNamer` stays the cheapest; `resolveOn` rebuilds requirements from `step.setting`;
`pinned` stops escalation. `planSteps` builds from `resolveSteps` (persona null → `DEFAULT_PERSONA_FOR`, then any
of the role; unknown id ignored); `retryStep` = `escalateStep`.

**Value:** `protects=the pick for a step's requirements on an account; fails_when=a weaker requirement wins, a
pin is ignored, or a fixed effort picks another; why_new=the precedence changed; no_claim=which requirements a
task has`

- [ ] `choose-model.test.ts` tables: every setting-type pair (strongest wins); pin beats requirements; none
      reaches minimum; fixed effort on a Codex-shaped offer snaps. Red, green, commit.

### Task 4c: Picks per rigor, the step plan's rigor, and the regression table

**Files:** `routing/role-picks.ts`, `packages/contracts/src/steps.ts` (`StepPlanDto.flowName` → `rigor: Rigor |
null`, null for a merge-fix plan), `routing/plan-steps.ts`, `delivery/pass-open.ts`, `delivery/ship.ts` (merge
plan: `rigor: null`), desktop fixtures; `routing/routing-regression.test.ts`.

**Produces:** `rolePicks(…, rigor)` (Standard by default); `StepPlanDto.rigor` with every user changed in this
task. A Frontier pick the account refuses falls back to the next model it runs via `resolveOn`, with the reason
(test).

**Value:** `protects=a task's steps and models end to end; fails_when=a task gets another step list or pick than
designed; why_new=steps came from flows; no_claim=the move itself`

- [ ] Regression table on seeded settings (Task 5 extends it with moved ones): step lists, picks and whether a
      retry may step up, per case; every difference asserted against the Brief's list. Commit.

### Task 5: Move today's settings (daemon start, once)

**Files:** `apps/daemon/src/team/move-to-playbook.ts` (new), `daemon/start.ts` (after `seedKinds`); tests on real
SQLite; extend `routing-regression.test.ts` with moved settings.

**Produces:** `moveToPlaybook(ctx): MoveReport`, gated by app setting `playbook.moved`, one transaction, reading
through `store/legacy-routing.ts`:

| Today | Becomes |
| --- | --- |
| task/project flow quick / standard / full | rigor light / standard / careful |
| a custom flow | has plan → careful; has review → standard; else light |
| task `risk_tags` | `kinds` `{ key, source: 'builder' }`; the task's `rigor` is raised to the kinds' minimum |
| role setting, global or project | that role's cell `model`, every rigor, same scope, unless a pin wins (next rows); a cell's own minimum is kept only if the setting had one |
| team binding (project) | that role's cell `personaId`, every rigor, project scope |
| persona pin (model, effort) | as today, a pin beats every role setting: the global cell takes the default persona's pin over the global role setting; each project's cell takes the pin of the persona that fills the role there (its binding, else the default persona) over the project's role setting; a project binding a persona with no pin keeps its own role setting or inherits, so a global pin never leaks into it |
| persona minimum score | the cell's automatic minimum, if higher |
| flow step persona | cell `personaId`, global, mapped rigor; collisions reported |
| global pattern on risk tags (and roles) | an override on each kind for those roles (all if none); the first by position wins; it raises the seeded override only if stronger |
| the seeded "High-risk work" pattern (found by content: tags security/auth/migration, setting `top_of_tier`) | dropped |
| project patterns, patterns that would lower a model, area or retry patterns | reported |

**Report:** project entries → one Inbox card per affected project (InboxKind `playbook_move_report`); global entries → app setting
`playbook.moveReport`, shown as a dismissible note on Settings › Models. Each entry names the setting and its
value.

**Value:** `protects=the builder's settings survive the upgrade; fails_when=a setting is lost, doubled or wins
where it lost before; why_new=new move; no_claim=that reported settings are recreated`

- [ ] One table row per mapping above, plus: runs once; precedence as today (pin > project role setting > global role setting) per project;
      a global pin doesn't leak into a project with another bound persona. Commit.

### Task 6: HTTP routes and events

**Files:** `apps/daemon/src/api/app.ts`, `daemon/services.ts`, `daemon/model-settings-services.ts`,
`shape/service.ts`, events; `test/*-api.test.ts`.

**Produces:** `GET/PUT /playbook`, `GET/PUT /projects/:id/playbook`; `GET/POST /kinds`,
`PATCH/DELETE /kinds/:kindId`, `PUT /kinds/order`; `GET /models/picks?account=&rigor=`; task create/patch take
`rigor`, `kinds`, `effortPin`, refusing a rigor below the kinds' minimum (typed error naming the kind) and
re-checking placement when kinds change; project patch `defaultRigor`; `PUT /shapes/:id/model { model, effort }`;
`GET /playbook/move-report`, `DELETE` dismisses it; events `playbook`, `kind`.

**Value:** `protects=each route's contract and refusals; fails_when=a low rigor is accepted under a kind floor;
why_new=new routes; no_claim=the screens`

- [ ] `app.request()` tests per route, refusals included. Commit.

### Task 7: Kind switches, agent tools and proposals

**Files:** `runner/review-size.ts`, `runner/limit-ship.ts`, `placement/propose.ts`, `inbox/proposal-task.ts`,
`inbox/service.ts`, `mcp/tools.ts`, `builder/tools.ts`, the `proposePlacement` callers (`shape/convert.ts`,
`goals/adopt.ts`, `delivery/start.ts`, `daemon/services.ts`), `packages/contracts/src/mcp-tools.ts`,
`builder-mcp-tools.ts`; tests.

**Produces:** consumers read the task's known kinds: `alwaysReviewed` forces review, `failsAtLimit` refuses
shipping at the limit, `ownCopy` forces a worktree, `toInbox` (or an undeclared risk word) sends a proposal to
the Inbox. `propose` takes `kinds`; an open card's old `detail.riskTags` is read as kinds when accepted. Builder
`create_task`/`edit_task` take `rigor`/`kinds` through Task 6's services, so the kinds' floor refusal applies; `list_kinds` replaces `list_flows`.

**Value:** `protects=risk behaviour now follows kinds; fails_when=a seeded kind loses a behaviour its tag had, or
an old card files without kinds; why_new=tags were the input; no_claim=custom kinds beyond one row per switch`

- [ ] Each table extended with seeded kinds and one custom-kind row per switch; an old card accepted. Commit.

### Task 8a: Playbook on Settings

**Files:** `apps/desktop/src/views/settings/playbook-table.tsx`, `playbook-cell-editor.tsx`,
`playbook-row-drawer.tsx`, `move-report-note.tsx` (new), `models-section.tsx`, `section-body.tsx`,
`sections.ts`, `daemon/playbook-queries.ts`; delete `role-settings.tsx`, `role-picks-panel.tsx`; tests.

**Produces:** Settings › Models: header, move-report note (when present), **Playbook** in a `RaisedPanel`: rows
Light…Critical, columns Plan, Plan Review, Build, Review, QA; a cell shows the resolved model · effort and "Auto"
for automatic, blank where the row doesn't run that role; a popover edits Persona, Model (with minimum for
Automatic), Effort, shows the resolved pick and cost, and Reset; a row header opens a drawer of step checkboxes
(Build fixed). The chart's rings follow a rigor select (Standard first). Project "Models by role" (`team`): the
same table at project scope with "Use global", and Default rigor. `personas-and-flows` is removed; its URL lands
on Models.

**Value:** `protects=editing the playbook per scope; fails_when=a cell edit writes the wrong scope or Reset
leaves an override; why_new=new screen; no_claim=routing`

- [ ] Render tests with real handlers; click-through on a dev daemon, dark and light, 1440 and 900 px. Commit.

### Task 8b: Kinds on Settings

**Files:** `kinds-section.tsx`, `kind-drawer.tsx` (new), `daemon/kind-queries.ts`; tests.

**Produces:** the Kinds list under the Playbook; a drawer edits label, description, minimum rigor, the four
switches, adds steps and per-role overrides (key read-only); Add Kind; delete with confirm; reorder.

**Value:** `protects=kinds edited from the app; fails_when=a key changes or an override saves to another role;
why_new=new screen; no_claim=its effect on tasks`

- [ ] Render tests; click-through. Commit.

### Task 8c: The task

**Files:** `views/board/task-drawer.tsx`, `batch/batch-candidate.tsx`, `task-card.tsx`; delete
`flow-select.tsx`; project General's Flow row; tests.

**Produces:** drawer Rigor (options below the kinds' floor disabled, naming the kind), Kinds, Model, Effort;
batch candidate Rigor and Kinds; the card's indicator row shows rigor and kinds.

**Value:** `protects=a task's rigor and kinds set from the board; fails_when=a rigor below the floor is offered;
why_new=new fields; no_claim=the routing that follows`

- [ ] Render tests; click-through. Commit.

### Task 8d: Plan's picker

**Files:** `views/shape/model-picker.tsx`, `daemon/shape-queries.ts`; tests.

**Produces:** model and effort, effort listing only the chosen model's efforts; Automatic keeps today's rule.

**Value:** `protects=a conversation's effort choice; fails_when=an effort the model lacks is offered;
why_new=effort was fixed; no_claim=the session's own effort handling`

- [ ] Render test. Commit.

### Task 9: Remove what was replaced

**Files:** flows, patterns, role-settings, team routes and services; contracts `riskTags`, `flowId`, `FlowDto`,
`PatternDto`, `RoleSettingDto`, `ModelSettingsDto`, `TeamDto`, persona `modelPin`/`minimumScore`;
`routing/catalogue.ts` flows and `ROLE_NEED`; `team/seed-patterns.ts`; docs in `apps/daemon/AGENTS.md`,
`apps/desktop/AGENTS.md`, `packages/db/AGENTS.md` (old tables listed as read only by the move).

**Produces:** nothing outside `store/legacy-routing.ts` and `team/move-to-playbook.ts` reads the old tables. The
types `schema.ts` imports for them (`FlowStepDef`, `RiskTag`, `ModelPin`, `PatternMatch`) move into
`packages/db/src/legacy-types.ts` as zod schemas the legacy store parses with. The spec's §10.3 report line is
updated to match Task 5.

- [ ] `git grep` for each removed name prints nothing outside `docs/`, `schema.ts`, the legacy store and the move;
      `make gate` passes. Commit.

## Follow-ups filed when this lands

- PR 2b: process per rigor.
- PR 3 adds kinds' skills (harness and Codex prompt), `impliedBy`, and how a rigor was set.
- The Workbench's model and effort picker.
- A migration dropping the old tables and columns once every install has moved.
