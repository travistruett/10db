# 10db right-sized work: one rigor per task, one playbook, and the judge sizes the work

## Brief

**What changes for the builder**

- Every task gets a **rigor** (Light, Standard, Careful or Critical) and **kinds** (ui, schema, security…), set
  automatically, shown on the card, changeable in the drawer.
- Settings › Models becomes the one place: a table of rigor by role giving each step's model and effort, and
  what that resolves to today. Models by role, flows, patterns and floors go away.
- Plan and the Workbench get a model and effort picker.
- Light and Standard tasks in one goal ship as one pull request.

**What it buys:** fewer sessions, steps and pull requests on small work; strong models only where they pay
(security, auth and migration reviews on Frontier); one answer to "what will this task get, and why?"

**What could go wrong, and how we'd know**

- The judge sizes a risky task as Light: a kind's minimum rigor and the forced-review rules (big diff, lockfile,
  migration, CI) still catch it, and the builder's corrections are logged against the judge.
- A resumed build session misses its own blind spots when fixing review findings: only on Standard; Careful and
  up get fresh eyes.
- Moving old settings over loses something: whatever cannot be carried over is listed in one Inbox card.
- An account lists a Frontier model it cannot run (Fable on Bedrock): PR 2's plan checks; otherwise the step
  falls back a rung and says so.
- Conflicts with the Settings rework: nothing starts until it lands.

**Calls the builder might disagree with:** Critical waits for the builder's approval of the plan; Light runs no
review step; the names "rigor" and "AI"; patterns keyed on areas or "retry only" are reported, not carried over.

**Needed from the builder:** nothing. PR 1 starts when the Settings rework lands.

---

**Status:** designed on 2026-11-13 with the builder. Nothing in it is built. Calls the builder has not made are
marked **(call)** and listed in §13.

**Starts from:** the builder's QA of the Models page after #589 (§2), which asked where roles, models and effort
are set, where a role's "Needs" comes from, and why the process around a task runs heavier than the task.

**Lands after:** the Settings rework on `feat/settings-explicit` (and its OpenRouter follow-up), which renames
Settings sections, makes OpenRouter an account kind and gives Decisions a **Runs on** account. Every PR here
starts from a `main` that has it.

**Keeps:**

- The model catalogue, the four rungs and the score router (`decisions/2026-11-13-models-are-ranked-in-four-rungs.md`).
- The judge: typed questions, a confidence floor, a rule fallback, every call logged
  (`decisions/2026-10-31-openrouter-makes-routine-decisions.md`).
- Personas as hand-written prompts, skills, areas and hazards.
- Provider parity (`AGENTS.md`).

**Words:**

- **Rigor** is how much process a task gets: **Light**, **Standard**, **Careful** or **Critical** (§5). It is not
  Shape's `TaskSize` (S/M/L/XL), which estimates hours of lane time and stays as it is.
- A **kind** is what a task touches: `ui`, `schema`, `security`, and so on (§6).
- The **playbook** says what each rigor runs: its steps, and for each step a persona, a model and an effort (§7).
- A **cell** is one rigor and one role in the playbook.
- A **pin** is a value the builder set by hand. Nothing automatic changes a pinned value.

## 1. Intent

The builder wants two things:

1. **Explicit control when they are in the conversation.** In Plan and in the Workbench, pick the model and the
   effort by hand, as Claude Code's `/model` does.
2. **Right-sized work when 10db runs tasks on its own.** A UI tweak should not get the same process and models as
   a schema change or a security fix. 10db should measure each task, choose its process and its models, show why,
   and let the builder override any of it.

Underneath is a cost the builder has watched pile up: work that defaults to the heavy path. A new session for
every small fix, 25 steps where 4 would do, 10 pull requests where 2 or 3 would do. Choosing the model is one
sizing decision; how much process a task gets is the bigger one.

Today about ten mechanisms steer a step, each sensible alone: flows, step needs, skip rules, role settings,
patterns, risk floors, persona model pins and minimum scores, risk tags, areas, and the task's own model and flow.
Together nobody can predict what a task will get. This design replaces most of them with two ideas: a task's
**rigor** and the **playbook**.

## 2. The QA that started it

Every note from the builder's QA of Settings › Models and benchmarks, and where it lands:

| Note | Lands in |
|---|---|
| The nav label wraps to two lines; call it **Models** | PR 1 (§10) |
| Rename the subhead above it (to **AI**) **(call: the name)** | PR 1 |
| The Account select and the refresh button differ in height | PR 1: the button takes `size="input-xs"`, the select's own size |
| The page is flat; give the tables and chart a raised surface | PR 1: this page only, until the Settings rework lands everywhere |
| Title Case role names ("Plan Review") | PR 1, in `role-labels.ts` |
| "Used by" reads as purple links | PR 1: plain text |
| Nest the models list by family | PR 1 |
| Paginate the list (OpenRouter will bring hundreds of models) | PR 1 |
| What is actionable here? Where do I set roles, models and effort? | PR 2: the playbook on Models (§7, §9) |
| Where does "Needs" come from? Make it configurable, with great defaults | PR 2: a cell's requirement, defaults shown, with reset |
| Fold Models by role into Models | PR 2 |
| Risk floors editable | PR 2: a kind's minimum rigor (§6) |
| Effort is Automatic but tunable | PR 2: cells, kind overrides, the task pin and the pickers |

The answers found while reading the code: "Needs" is `ROLE_NEED` in `apps/daemon/src/routing/catalogue.ts`, hand
set ("heuristics to tune, not AA data"), and each flow saved its own copy of it when seeded, which is what routing
reads. Risk floors are hard-coded in `routing/floors.ts`. Effort can be set only through a persona's model pin
(`ModelPin` in `packages/contracts/src/team.ts`), which no screen shows; otherwise it comes from `ROLE_DEFAULT`
or the router's choice.

## 2a. Goals, non-goals, anti-goals

**Goals**

- One place to see and change what each kind of work gets: the playbook on Settings › Models.
- Every task gets a rigor and kinds automatically, shown with the reason, and the builder can pin either.
- The process scales with rigor: steps, review rounds, how a fix is made, and how work ships.
- Explicit model and effort pickers in Plan, the Workbench and the task drawer, each starting at Automatic.
- Good defaults that need no setup, built on the builder's own working rules ("size the unit of work to the
  risk", reviews converge, at most two fix rounds).
- Today's settings carry over; nothing the builder set is silently lost.

**Non-goals**

- The other places 10db over-processes (§11): how a goal splits into tasks, batching beyond a goal, and what
  happens when a step fails. They become follow-up tasks on the same machinery.
- Rebuilding personas or skills. They stay; only where a persona is chosen moves.
- Changing Shape's hour estimates (`TaskSize`).

**Anti-goals**

- A grid of knobs nobody reads. Kinds get sparse overrides, not a column per kind.
- A judge that picks models. The judge measures the task; the playbook turns that into models, so every pick has
  a reason a person can read, and a new model release changes results without retraining anything.
- A feature that works only with the judge. Without a decision account, rules and the builder size the work.

## 3. Approaches

Three ways were weighed:

- **A. Rigor plus a playbook (chosen).** One rigor per task, one playbook. It replaces flows, needs, skip rules,
  floors, risk tags, role settings and most patterns. It is the biggest change, and the only one that removes the
  overlap the builder is confused by.
- **B. Kinds plus a rules list on top of today's pieces.** Merge patterns and floors into one list and add effort.
  Smaller, but every mechanism in §1 stays, so the page would still not answer "what will this task get?"
- **C. The judge picks model and effort directly.** Opaque, and stale with every model release.

An earlier step in the conversation settled where a role's settings live (on the role, folded into Models); A
grew from that once the builder asked for best practice over keeping what exists.

## 4. The model in one picture

```
Task → rigor + kinds          (the judge picks; rules without it; the builder's drawer pins)
  each step in the rigor's playbook row runs with:
    persona  = cell → kind override → task pin
    skills   = the persona's own + every kind's
    model    = cell → kind override → task pin
    effort   = cell → kind override → task pin
  the rigor's row also sets: review rounds, how a fix is made, how the task ships
```

A project can override any cell or any row setting; an unset project value uses the global one.

## 5. Rigor

Four values, ordered: **Light < Standard < Careful < Critical**. A task has exactly one.

- **Stored** on the task as `rigor` plus `rigorPinned` (the builder set it) and `rigorSource`
  (`judge`, `rules`, `agent`, `builder`, `default`) with a one-line reason for the card.
- **Default** for a project is a project setting (Standard to start). It replaces the project's default flow.
- **Never below** the highest minimum rigor of the task's kinds (§6), whatever set it, the builder's pin included:
  the drawer shows the floor and refuses a lower value with the kind that holds it.
- **Re-measured** when the title, description or acceptance criteria change while the task has never started,
  unless the rigor is pinned. A started task changes rigor only through the resize tool (§8.3) or the builder.

## 6. Kinds

A kind is a row in a global list, seeded and editable in Settings › Models.

| Field | Meaning |
|---|---|
| `key`, `label` | `schema`, "Schema" |
| `description` | one line the judge reads to decide whether a task is this kind |
| `minimumRigor` | the lowest rigor a task of this kind gets; replaces risk floors |
| `safety` | the four switches risk tags carry today (below), each its own |
| `impliedBy` | area names and hazard names that make a task this kind without asking the judge |
| `overrides` | per role, optional: persona, model requirement, effort |
| `addsSteps` | steps the rigor's row does not run that a task of this kind runs anyway, such as Plan Review |
| `skills` | skills every step of a task of this kind loads |

The four risk tags do different things today, so a kind carries each behaviour as its own switch, and the seeded
kinds reproduce today's behaviour exactly:

| Switch | Today | Seeded on |
|---|---|---|
| `alwaysReviewed`: review is never skipped | all four tags (`runner/review-size.ts:14-19`) | security, auth, migration, dependency |
| `failsAtLimit`: a send-back at the round limit fails rather than ships | security, auth (`runner/limit-ship.ts:4`) | security, auth |
| `ownCopy`: placement puts the task in its own copy | migration, dependency (`placement/propose.ts:28-31`) | migration, dependency |
| `toInbox`: a lane's proposal goes to the Inbox, not the Icebox | all four tags (`inbox/proposal-task.ts:25-30`) | security, auth, migration, dependency |

`propose` and the builder MCP take kinds where they took risk tags.

**Seeded kinds (call: the set and their values):**

| Kind | Minimum rigor | Notes |
|---|---|---|
| security | Careful | overrides and steps in §6.1 |
| auth | Careful | overrides and steps in §6.1 |
| migration | Careful | overrides and steps in §6.1; `impliedBy`: the project's migration hazard |
| dependency | Standard | `impliedBy`: lockfile hazards |
| schema | Careful | |
| infra | Careful | CI, deploy, build config |
| ui | none | |
| docs | none | |

### 6.1 Security, auth and migration: the money goes to review

Decided with the builder. These kinds stay Careful (no QA, no plan approval) and carry overrides that put the
strongest model where it pays, on review:

| Kind | Plan | Plan Review | Build | Review |
|---|---|---|---|---|
| security, auth | Capable · high | — | top of Capable · high | **Frontier · high** |
| migration | Capable · high | **Frontier · high** (`addsSteps`) | top of Capable · high | **Frontier · high** |

Why: a missed permission check or an irreversible column drop costs far more than a model bill, and these tasks
are a small share of the work. Writing the code is the easier half; finding what is missing in it takes the
deepest reasoning, and a stronger model of a different rung than the builder brings fresh eyes as well.
Migrations get Plan Review because they cannot be undone; for an ordinary security fix it is ceremony. The cells
name a **rung**, not a score: "at least 52" drifts with each Intelligence Index version, while Frontier always
means the maker's top band and moves to the next top model by itself.

This is **stronger than today**, on purpose. Today these tags get the dearest model of each step's own rung (the
seeded "High-risk work" pattern, `team/seed-patterns.ts`), Review and Plan Review at least 52 for security and
auth, and Build at least 45 for migration (`routing/floors.ts`), with Plan Review only on the full flow. The
migration in §10.3 says so rather than calling it a carry-over.

A Frontier cell on an account that lists a Frontier model it cannot run would fail every risky review. PR 2's plan
checks that each account's offer leaves out models it cannot run (Fable on Bedrock answers only under the right
data retention mode), and if that cannot be guaranteed, a cell whose model fails to start falls back one rung and
the card says so.

A task's kinds are a set, each with a source (`judge`, `rules`, `agent`, `builder`); the builder's additions and
removals pin. Kinds are global; a project changes what they *get* through playbook overrides, not by redefining
them **(call)**.

A kind's model and effort overrides **only raise**, never lower: each candidate (the cell, every kind's override)
is resolved to a concrete model and effort on the account, and the stronger result wins: higher Intelligence at
its effort; without scores, the higher rung, then the higher price; then the higher effort. So a kind cannot make
a Critical task's Review weaker than its cell. A kind's persona replaces the cell's; two kinds naming different
personas for one role take the first kind in the list's order, and the card says so **(call)**.

## 7. The playbook

### 7.1 Rows: what each rigor runs

| | Light | Standard | Careful | Critical |
|---|---|---|---|---|
| Steps | Build | Build, Review | Plan, Build, Review | Plan, Plan Review, Build, Review, QA |
| Review rounds | none | 1 | 2 | 2 |
| A send-back is fixed by | — | the build session, resumed | a fresh build session | a fresh build session |
| The builder approves the plan | no | no | no | yes |
| Ships | with its goal | with its goal | alone | alone |

All values are defaults **(call)**, editable per row globally and per project.

- **Light runs no review step**, but the forced-review rules in `review-size.ts` still apply as a safety net: a
  Light task whose diff turns out large, binary, or touching a hazard, manifest, lockfile, migration or CI path
  gets a review step added. The `review_size` judge decision is retired; rigor makes that call up front **(call)**.
- **Review rounds** are a new counter for reviewer send-backs, apart from today's shared `attempt` counter. Today
  reviewer, gate and builder send-backs share one count against `FIX_ATTEMPT_LIMIT = 3`
  (`runner/runner.ts:1372`); after this, reviewer send-backs count against the row's rounds and gate and builder
  send-backs keep `attempt` and its limit. At the round limit, a task ships with the findings filed as a
  follow-up task, as `limit-ship.ts` does now, unless one of its kinds has `failsAtLimit`, which fails it.
- **"Fixed by the build session, resumed"** is the new `revise` behaviour for Standard: the reviewer's findings go
  to the build step's own provider session, which has the context, instead of a new session that re-reads
  everything. The resumed session **keeps its model**; today's move up a rung on a send-back
  (`routing/retry-step.ts`) applies only when a fresh session makes the fix. Careful and Critical keep a fresh
  session, so the fix is made by eyes that did not write the code, and keep the move up **(call)**. Whether a
  Codex thread resumes on the same model is checked in PR 2's plan; if it cannot, Codex fixes in a fresh session
  and the parity table says so.
- **The builder approves the plan** for Critical: the plan step ends in an Inbox card; Build starts when the
  builder approves it.
- **Ships** is used by §8.4.

Shape's flows go away: a step skipped "unless criteria over 3" was a way of saying "this task is bigger", which
rigor now says directly.

### 7.2 Cells: who runs a step

Each cell (rigor × role) holds three fields:

- **Persona:** a persona of that role, or "the role's own" (the seeded persona, or the project's choice).
- **Model:** one of
  - **Automatic, at least N** (an Intelligence Index score): the cheapest model and effort on the account that
    reaches N. Without scores (no Artificial Analysis key, or a model without one), the cell's fallback rung and
    the role's default effort apply, as `ROLE_DEFAULT` does now.
  - **A rung** (Efficient, Balanced, Capable, Frontier): the cheapest model of that rung.
  - **Top of a rung.**
  - **One model.**
- **Effort:** Automatic or one level. A level the chosen model lacks snaps to the nearest one it offers
  (`atEffort`).

When no model on the account reaches a cell's "at least N", the step runs on the strongest model the account
offers and the card says so; a cell never stops work for lack of a model **(call)**.

**Default minimum scores (call):** these replace `ROLE_NEED` and the floors. They are 10db's own thresholds, not
data from Artificial Analysis.

| Role | Light | Standard | Careful | Critical |
|---|---|---|---|---|
| Plan | — | — | 45 | 50 |
| Plan Review | — | — | — | 52 |
| Build | 35 | 40 | 45 | 50 |
| Review | — | 40 | 48 | 52 |
| QA | — | — | — | 35 |

The editor shows each cell's requirement *and* what it resolves to on the selected account today
("Automatic, at least 40 → Sonnet 5.5 · medium, $1.20 a task"), so the builder sees models and never has to
edit a table when a new model ships.

### 7.3 Precedence

For each field of a step, the first that says something wins:

1. The task's pin (drawer: model, effort; persona is not pinned per task **(call)**).
2. The task's kinds' overrides for the role (strongest, §6).
3. The project's cell.
4. The global cell.

A floor from `minimumRigor` already moved the task to a higher row, so no separate floor applies.

## 8. How a task gets its rigor and kinds

### 8.1 Rules first

Rules settle what is certain, before any model is asked:

- a kind is set when the task's areas or the hazards it touches are in the kind's `impliedBy`;
- the builder's pins stand;
- the rigor is raised to the kinds' highest minimum.

### 8.2 The judge answers the rest

Two new judge decisions, each with the existing switch, model (`typesafe/jev-1.13` by default) and confidence
floor in Settings › Decisions:

- **`task_rigor`**: "How much process does this task need?" Options: the four rigors, each with its one-line
  meaning as criteria.
- **`task_kinds`**: "Does this task touch <kind>?" Options `yes`/`no` with the kind's description, one call per
  kind in parallel, or one call when the model answers several labels at once **(builder)**.

State: the task's title, description, acceptance criteria, areas and its goal's title, fenced as data. Calls run
when a task is created and when it is re-measured (§5), after the rules, and never block creating the task: the
task is created at the project default and updated when the answers arrive. Starting a task whose sizing is in
flight waits for it, at most the judge's timeout (`JUDGE_TIMEOUT_MS`, 4 s); after that the task starts on the
rules' value and a late answer is logged but not applied. An answer below the floor, or a
fallback, leaves the rules' value. Each call is logged, and when the builder later changes a judged rigor or kind,
the change is recorded as that call's outcome, so the log shows how often the judge is right.

**Without a decision account** (§12), rules and the project default size the task, and the card says "Sized by
rules".

### 8.3 Agents can resize

A new MCP tool, `resize_task { rigor, why }`, for plan and build sessions. A session that finds the task bigger
or smaller than its rigor calls it; the remaining steps follow the new row, the card shows the agent's reason, and
an Inbox notice tells the builder. It cannot go below the kinds' minimum, and it cannot change a pinned rigor: the
tool returns that, and the agent carries on **(call)**.

**A rigor change on a started task**, by the tool or the builder, changes only steps that have not started: a
running step finishes on what it has; steps of the new row that come after the current step are added or dropped
and their models are picked again; steps of the new row that come before it (a Plan added while Build runs) are
not run. The review-round limit of the new row applies to rounds still to come **(call)**.

### 8.4 Shipping follows rigor

When tasks of one goal start together, those whose rigor ships "with its goal" and that share a landing target go
in one batch, so one pull request. A later task of the goal with the same rigor setting joins the goal's open
batch, as a landing group's later task does (`delivery/landing-join.ts`). Careful and Critical tasks get a batch
of their own. Dependency and landing-group grouping (`delivery/grouping.ts`) still apply on top **(call)**.

## 9. Screens

### 9.1 Settings › Models (global)

Under the **AI** subhead **(call)**, the nav item is **Models**. The page, top to bottom:

1. **Header:** title, the catalogue line and the Artificial Analysis status line, the Account select and the
   refresh icon, the same height.
2. **Playbook:** a table with a row per rigor and a column per role. A row header shows the rigor's process (steps,
   rounds, how a fix is made, how it ships), editable in a drawer. A cell shows what it resolves to
   ("Sonnet 5.5 · medium") with a small "Auto" mark when the requirement is Automatic; clicking it opens the cell
   editor: persona, model requirement, effort, the resolved model and its cost, and "Reset to default". A role a
   rigor does not run is an empty cell.
3. **Kinds:** a list of kinds with minimum rigor, safety switches, implied by and override count; a row opens its drawer.
   Add Kind at the end.
4. **Intelligence and cost:** the chart, its rings showing the selected rigor's picks (Standard to start)
   **(call)**.
5. **All models:** nested by family (§10), paginated.

Tables and the chart sit on the raised surface. The global "Models by role" page (formerly "Personas and flows")
is removed; its role settings and patterns move as §10.3 says.

### 9.2 A project's settings

The project's "Models by role" page (formerly "Team") becomes the project's playbook: the same table, each cell
and row setting showing the global value until changed, with "Use global" to undo. It also sets the project's
default rigor, replacing its default flow in General.

### 9.3 The task

- **Card:** the rigor and kinds, with the source on hover ("Careful · schema, infra, judged" or "Light, sized by
  rules").
- **Drawer:** **Rigor** (select, showing the kinds' floor) and **Kinds** (multi-select) replace Flow and Risks;
  **Model** and **Effort** (Automatic or a value) replace Model. Each shows "judged", "rules", "agent" or "you".

### 9.4 Plan and the Workbench

- **Plan's model picker** gains effort: "Automatic" or a model and an effort from the account's offer. Automatic
  keeps today's rule for Plan conversations (the plan role's default, never routed by score, so never refused,
  `daemon/start.ts:1319-1330`) **(call)**. The choice is stored on the shape (`shapes.model` plus a new
  `shapes.effort`) and applies from the next turn.
- **The Workbench** gets the same picker for the pass's build sessions, defaulting to each task's own Build cell.
  A pass is attended work, so of a task's rigor it uses only the Build cell: plan approval, review rounds and
  shipping do not apply, and the pass's one pull-request review uses the strongest Review cell among its tasks'
  rigors **(call)**.

## 10. Delivery: three pull requests

Each starts from a fresh `main` and gets its own plan.

### 10.1 PR 1: Models page polish

Everything in §2 that does not need the playbook:

- nav label **Models**, the subhead renamed, page title Models;
- refresh icon at `size="input-xs"`, the Account select's size;
- raised panels for this page's tables and chart, through one component the rest of Settings can adopt later;
- Title Case role labels;
- "Used by" as plain text (the violet dot stays in the roles table only);
- the models list nested by family (`family` from models.dev, already on `ModelRowDto`): the parent row is the
  family's current model, its older versions in the expansion; sorting ranks families by their best model;
  filters apply to models inside;
- the list paginated by family, 25 a page, on the client;
- "Trust" listed twice in the sidebar, if the Settings rework has not already fixed it.

"Who each role gets" gets only the cheap fixes; PR 2 replaces it.

### 10.2 PR 2: rigor and the playbook, end to end

Contracts, migration, routing, the Models page editor, the project playbook, the task card and drawer, the Plan
and Workbench pickers, and §10.3. One vertical slice, tested through the real backend.

### 10.3 Carrying today's settings over (PR 2's migration)

| Today | Becomes |
|---|---|
| `ROLE_NEED`, floors | the default cells and kinds' minimum rigor (§7.2, §6) |
| Flows `quick`, `standard`, `full` | Light, Standard, Careful |
| A custom flow | the rigor whose steps it is closest to: has a plan step → Careful; has review → Standard; else Light |
| A task's `flowId`, a project's flow | the task's pinned rigor, the project's default rigor |
| Risk tags on a task | the same-named kinds, pinned |
| A role setting (global or project) | that role's cell in every rigor, at that scope |
| A pattern matching only risk tags (and roles) | an override on each of those kinds |
| The seeded "High-risk work" pattern and the floors | the security, auth and migration kinds of §6.1, deliberately stronger than today |
| Any other pattern (areas, retry only) | reported, below |
| A team binding (persona per role per project) | that role's persona in every rigor of the project's playbook |
| A flow step's persona | that role's persona in the matching rigor, at global scope |
| A persona's model pin (model and effort) | the model and effort of every cell that persona fills, at the scope it fills it |
| A persona's minimum score | the "at least N" of every cell that persona fills, when higher than the cell's |
| A task's model setting | the task's model pin |

What has no home is not dropped silently: each affected project gets one Inbox card listing every pattern and
persona pin that was not carried over for it, with its content; the entries that apply everywhere are kept as a note
at the top of Settings › Models until the builder dismisses it.

Removed with it: the `flows` table and API, `FlowStepDef.need`, skip rules, `routing/floors.ts`, patterns and
their Settings section, `ROLE_NEED`, risk tags, persona `modelPin` and `minimumScore`, and `review_size`.

### 10.4 PR 3: the judge sizes the work

`task_rigor` and `task_kinds` (§8.2), `resize_task` (§8.3), shipping by rigor (§8.4), and the outcome rows that
record when the builder overrides a judged value.

## 11. Follow-up tasks

Filed on the 10db board when PR 3 lands, each a judge decision on the same pattern (rules settle what is certain,
the judge answers from a closed list, the builder's edit pins, every call is logged against what happened):

1. **A goal becomes tasks:** "should these proposals be one task?" in Shape's convert. The source of most of the
   10-pull-request runs.
2. **Ready tasks become pull requests,** beyond one goal: "do these tasks ship together?"
3. **A review finding:** "is this a fix the session makes now, or a follow-up?"
4. **A step fails:** "retry, step up a model, or ask the builder?"
5. **Measure the waste:** steps, sessions and pull requests per task and per goal, by rigor, beside the Factory
   view's "how often a person was needed".

## 12. Provider parity

| Piece | Claude plan | Claude via Bedrock or API key | ChatGPT/Codex plan |
|---|---|---|---|
| Rigor, kinds, playbook | yes | yes | yes |
| Cells resolve to models | the account's offer | the account's offer; a Frontier cell needs a Frontier model the account can run (§6.1) | the account's offer; Frontier is OpenAI's top band |
| Effort levels | low to max | low to max | the levels Codex offers; a cell's level snaps to the nearest |
| Personas and kind skills | harness plugin dir | harness plugin dir | inlined in the prompt, as today |
| Resumed build session for Standard fixes | yes | yes | yes |
| Plan and Workbench pickers | the account's offer | the account's offer | the account's offer |
| The judge sizes tasks | with a decision account | with a decision account | with a decision account |

The judge runs on the account Settings › Decisions › Runs on names, which today can only be OpenRouter. With none,
every provider gets rules-and-default sizing, and the card says so; nothing else changes. A follow-up lets a
project's own account run decisions, so a builder with only a Claude plan or a Codex plan gets judged sizing too.

## 13. Calls made in the builder's absence

- The rigor names, Light/Standard/Careful/Critical, and the field name `rigor`, chosen to avoid Shape's
  `TaskSize`.
- The subhead name **AI**.
- The seeded kinds and their values (§6) other than security, auth and migration (§6.1, decided with the
  builder), and the default rows and cells (§7).
- A kind's model and effort overrides only raise; persona overrides replace.
- When no model reaches a cell's "at least N", the strongest offered runs the step.
- A Standard fix keeps the build session's model; only a fresh session moves up a rung.
- A rigor change on a started task changes only steps not yet started; earlier steps are not run.
- Starting a task waits up to 4 s for sizing in flight, then starts on the rules' value.
- Plan's Automatic keeps today's rule (never routed by score); a Workbench pass uses only the Build cell, and its
  review the strongest Review cell among its tasks.
- Reviewer send-backs get their own round counter, apart from the gate's and the builder's.
- Kinds are global; projects change what kinds get through overrides.
- Persona conflicts between kinds go to the first kind in list order.
- Light runs no review, with the forced-review rules as a safety net; `review_size` is retired.
- Standard fixes resume the build session; Careful and Critical start a fresh one.
- Critical waits for the builder's approval of the plan.
- Persona is not pinned per task.
- `resize_task` cannot override a pin or go below the kinds' minimum.
- Shipping with the goal applies to Light and Standard and sits on top of dependency grouping.
- The chart's rings show one rigor's picks, Standard first.
- Unmapped patterns and persona pins are reported once in an Inbox card.

## 14. Left to the builder of each PR

- One judge call per kind or one multi-label call (§8.2).
- The playbook table's exact layout at narrow widths.
- How the migration matches a custom flow to a rigor when its steps fit none cleanly.
- Test rungs, per `.claude/rules/testing.md`: routing precedence and the migration as table-driven rows on a real
  SQLite file; the resize and resumed-fix paths through the real pipeline.
