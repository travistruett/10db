# The judge sizes the work Implementation Plan (PR 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Brief

**What changes for the builder**

- **A new task sizes itself.**
  - Rules go first. A task whose areas include the `migrations` hazard is a migration task. One whose areas
    include the `deps` hazard is a dependency task. The rigor rises to its kinds' minimum.
  - Then the judge (Jev by default, on your Decisions account) answers two questions. "How much process does this
    task need?" picks one of the four rigors. "Does this task touch <kind>?" is asked once per kind.
- **The card says who sized the task.**
  - The rigor badge reads "Careful · judged", "· rules", "· agent" or "· you", and its hover gives the reason.
  - Without a Decisions account, or with the judge off, it says "Sized by rules".
- **Your choices pin.**
  - Rigor or kinds you set when creating or editing a task are never changed by the rules, the judge or an agent.
    Neither is a kind you removed.
  - When you change a judged value, the judge's log records it as overridden. Settings › Decisions counts these
    beside each decision's calls, so you can see how often it is right.
- **Edits re-measure.** Editing a never-started task's title, description or criteria sizes it again, unless you
  pinned it. Clearing a rigor you set hands it back to sizing.
- **Starting waits briefly for sizing.** Start from the Board, the API or the builder's MCP waits for sizing still
  in flight, at most 4 s, then goes on with the rules' answer. Automatic starts don't wait: a page moved to a copy,
  a CI fix, and Inbox start cards (a click on one starts at once, without the wait).
- **Agents can resize.** Plan and Build sessions get `resize_task { rigor, why }`.
  - The steps still to come follow the new row.
  - The card shows the agent's reason, and an Inbox notice tells you.
  - It can't go below the kinds' minimum, can't change a rigor you pinned, and isn't offered on a Workbench page.
- **Light and Standard tasks of one goal ship as one pull request.** Each row gains **Ships**: "With its goal"
  for Light and Standard, "Alone" for Careful and Critical. When such tasks of one goal start together they share
  a batch. A later one joins the goal's open batch when it can. When it can't (the batch is shipping, failed or
  placed differently), it starts its own. Joining a goal is never a reason to refuse a start.
  - Your folder still runs one batch for everything, as today.
  - `dependsOn` and Shape's landing groups still group tasks on top of this.
  - A kind with its own copy (migration, dependency) never joins a goal batch.
- **Kinds get two more fields:**
  - **Implied by:** area and hazard names. Seeded: migration ← `migrations`, dependency ← `deps`.
  - **Skills:** the craft skills every step of a task of that kind loads. Seeded: none.
- **Settings › Decisions** gains a Sizing group with the two decisions.

**What it buys:** most tasks get the right process without you choosing, and the judge's record shows whether to
trust it.

**What could go wrong, and how we'd know**

- **The judge sizes a risky task Light.** Kinds' minimums, rules' kinds and PR 2b's review safety net still apply.
  Your overrides are logged against the judge.
- **A late or stale answer lands.** An answer is applied only to an unstarted task whose text and pins are the
  same as when it was asked. Otherwise it is logged as `stopped`. Tests cover an edit, a pin and a start during
  the call.
- **Cost bursts.**
  - Calls run at most 4 at a time.
  - Pass pages and CI fixes, which start at once, are never sized by the judge.
  - The start-up sweep judges only tasks created in the last 24 hours. Older unsized tasks get rules only.
  - A task is re-judged only when its fingerprint changes. Unrelated changes, such as a thread message or a move,
    don't trigger it.
- **An agent sizes its own task down and drops its review.** The kinds' minimum and the safety net still hold, and
  the Inbox notice shows it.

**Calls you might disagree with**

- **One judge call per kind, in parallel.** The judge interface picks one option, so a multi-label call would need
  a new interface.
- **A kind's skills are the harness's craft skills** (planning, test-first, review-checklist, brainstorming,
  handoff). Your own skills come later.
- **A rigor set by the builder's MCP or by a proposal pins it as "agent".** One from the Board or the API pins it
  as "you".
- **Rules don't store a rigor.** A task the rules raise keeps no rigor of its own and follows the project default
  and its kinds, so removing a kind lowers it again.
- **Ships is a row setting.** Joining a goal is best effort and never refuses a start.
- **Builder-facing starts wait for sizing; automatic starts don't.**

**Needed from you:** nothing.

---

**Goal:** PR 3 of `docs/superpowers/specs/2026-11-13-10db-right-sized-work-design.md` (§5, §6, §8, §10.4, §12),
on top of PR 2b (`docs/superpowers/plans/2026-11-13-process-per-rigor.md`).

**Architecture:**

- `apps/daemon/src/sizing/` owns sizing:
  - `rules.ts` is pure;
  - `judge-sizing.ts` asks the judge;
  - `sizing-service.ts` subscribes to `task.created` and `task.changed`;
  - `fingerprint.ts` hashes what was sized.
- When the fingerprint differs from the stored one, the service:
  - applies the rules at once, through `applyTaskSizing`;
  - asks the judge off the request path;
  - applies the answers in one write, under the same guard;
  - keeps an in-flight map that builder-facing start entry points await, at the very top, before any read.
- A task stores:
  - `rigorSource` and `rigorReason`, only while it has a rigor of its own;
  - `kindsOff`;
  - `sizedFor`, the fingerprint;
  - `sizingCalls`, the judge call ids.

**Tech stack:** TypeScript, zod, Drizzle + SQLite, Hono, React + Mantine, Vitest.

## Global constraints

- Follow `.claude/rules/*`. Each newly tested behaviour carries its value card.
- `packages/contracts/src/judge.ts` and `packages/db/src/store/judge-call-stats.ts` are shared with session 10db-31.
  Changes there are additive. The controller tells 10db-31 before the commit is pushed.
- Judge state is fenced as data, as the forced-review and triage code fence it. It holds the title, description,
  criteria, areas and goal title. Nothing else.
- No test makes a network call. The judge is a scripted fake injected where `Judge` is taken, with an injectable
  timeout.

## Provider parity

| Piece | Claude plan, API key, Bedrock | ChatGPT/Codex plan |
| --- | --- | --- |
| Rules sizing, pins, sources | yes | yes |
| Judge sizing | with a Decisions account (OpenRouter today) | same |
| No Decisions account | rules and default, "Sized by rules" | same |
| `resize_task` | the 10db MCP server every lane gets | same |
| Kinds' skills | named in the step brief; bodies in the harness plugin dir | bodies inlined in the prompt (`runner.ts` `skillBodies`) |
| Ships with its goal | yes | yes |

The gap: a builder with only a Claude or Codex plan gets rules-only sizing, because decisions run on OpenRouter.
Task 8 files the follow-up that lets a project's own account run decisions (spec §12).

## Review focus

1. Nothing automatic changes a pinned rigor or kind, a started task, or a kind the builder took off. Pins set at
   creation count.
2. A judge answer is applied only under the same fingerprint and pins it was asked under.
3. A builder-facing start waits at most 4 s before any read, so two quick Starts can't both pass the checks.
4. `resize_task` refuses below the kinds' minimum, on a pinned rigor and on a pass page, and replays by `opId`.
5. Goal batching never refuses or blocks a start, and never puts an own-copy kind or a Careful or Critical task in
   a goal batch, unless `dependsOn` or a Shape landing group puts it there.

---

### Task 1: Contracts and storage (lands first)

**Files and what they produce:**

- **`packages/contracts/src/skills.ts`** (new): `SkillName`, the craft skills' closed list. `packages/harness`
  (gaining a `@10db/contracts` dependency) imports it from contracts in place of its own list, and never the other way round, since contracts is bundled
  into the desktop app.
- **`packages/contracts/src/rigor.ts`:**
  - `RigorSource = { Judge, Agent, Builder }`, the sources a stored rigor can have;
  - `TaskKindSource` gains `Rules: 'rules'` and `Judge: 'judge'`;
  - `KindFields` gains `impliedBy: string[]` (default `[]`) and `skills: SkillName[]` (default `[]`);
  - the row process gains `ships` (`Ships = { WithGoal: 'with_goal', Alone: 'alone' }`).
- **`entities.ts`:**
  - Task DTOs gain:
    - `rigorSource: RigorSource | null` and `rigorReason: string | null`, null when the task has no rigor of its
      own;
    - `kindsOff: string[]`;
    - `sizedByRules: boolean`, true while no judge answer has been applied, on a project or install without a
      Decisions account or with the judge off;
    - `effectiveRigorSource: 'judge' | 'rules' | 'agent' | 'builder' | 'default'` with
      `effectiveRigorReason`. Derived: the stored source when there is a rigor; else `rules` when kinds raised it
      (reason "at least Careful: migration"); else `default`.
  - `TaskPatch` gains `kindsOff`.
- **`judge.ts`:**
  - `JudgeDecision.TaskRigor = 'task_rigor'` and `TaskKinds = 'task_kinds'`, each with the `shapeDecision()`
    default in the config, its default and its patch;
  - `JudgeOutcome.Overridden = 'overridden'`.
- **`apps/daemon/src/routing/playbook-defaults.ts`** `DEFAULT_PROCESS` gains `ships`, and so does
  `apps/desktop/src/test/playbook-fixtures.ts`.
- **`apps/desktop/src/views/settings/decision-catalogue.ts`** gets two entries, in group `sizing`:
  - `task_rigor`: "How much process a task needs". It asks "How much process does this task need?". On each
    answer it "sets the task's rigor unless it was set by you or an agent". When it isn't sure, "the rules and
    the project's default decide". Acting.
  - `task_kinds`: "What a task touches". It asks "Does this task touch this kind of work?", one call per kind.
    Acting.
  - `decision-numbers.ts` gets the `overridden` label ("Overridden by you"). Both are here so the build stays
    green.
- **`packages/db/src/schema.ts`:**
  - `tasks`: `rigor_source` (nullable), `rigor_reason`, `kinds_off` (json, default `'[]'`), `sized_for`,
    `sizing_calls` (json: `{ rigor: JudgeCallId | null, kinds: Record<key, JudgeCallId> }`);
  - `kinds`: `implied_by` and `skills` (json);
  - `playbook_rows`: `ships`.

  The migration is generated. A hand-authored `--custom` step sets `rigor_source = 'builder'` where `rigor` is not
  null.
- **`store/tasks.ts`:**
  - `insertTask`, `insertTaskFromProposal` and `insertFollowUpTask` take a `rigorSource` whenever a rigor is
    given;
  - `services.createTask` (API, Board) passes `builder`;
  - the builder MCP's `create_task`, proposals and follow-ups pass `agent`;
  - `team/move-to-playbook.ts` writes `builder` with its pins.
- **`applyTaskSizing(ctx, taskId, { fingerprint, kinds, rigor?, rigorReason?, sizingCalls? })` never throws**, and
  writes only what its guard allows:
  - nothing at all on a started task;
  - otherwise kinds without pins: `builder` and `agent` kinds kept, nothing in `kindsOff` added;
  - a rigor only when the stored source is not `builder` or `agent`;
  - always `sized_for`;
  - when the kinds change, the placement rule runs again, as `services.patchTask` does (services.ts:821-844).
    Move that rule into one function both callers use. Inside `applyTaskSizing` a task whose join is pending
    (`refuseIfJoining` would throw) keeps its placement: the rule is skipped, never thrown.
- **The kinds seed.** It is idempotent and gated by app setting `kinds.implied-seeded`. It sets `impliedBy` on
  migration and dependency only while their `impliedBy` is still empty.

**Value:** `protects=a task's sizing provenance and pins persist, old rows read, and sizing never writes a
started or pinned field; fails_when=a set rigor reads as unpinned, a creation pin is lost, or applyTaskSizing
throws or writes past a pin; why_new=no provenance existed; no_claim=who calls it`

- [ ] Real-SQLite tests:
  - the data step maps a set rigor to `builder`;
  - creation by API vs builder MCP stores `builder` vs `agent`;
  - an `applyTaskSizing` table: started, pinned rigor, a builder kind, a `kindsOff` key, plus a kinds change that
    re-runs placement;
  - the seed runs once.

  Red, generate, green. The build is typecheck-green, the desktop included. Commit.

### Task 2: Rules sizing (Track C)

**Files:** `apps/daemon/src/sizing/rules.ts` (new, pure), `sizing/index.ts`, tests.

**Produces:** `sizeByRules({ task, kinds, judged? }): { kinds: TaskKind[]; rigor?: { value; source: 'judge';
reason } }`:

- keep `builder` and `agent` kinds, and `judge` kinds from `judged` when given;
- add each kind whose `impliedBy` meets the task's areas, with source `rules`;
- never add one in `kindsOff`;
- drop `rules` kinds no longer implied;
- the rigor is only ever the judge's; the rules never store one (the brief's call). `effectiveRigor` raises it by
  kinds.

**Value:** `protects=rules settle what is certain and never override a pin; fails_when=an implied kind is missed,
a removed kind returns, or a rules value is stored as the task's own; why_new=new module; no_claim=the judge`

- [ ] Named table, red, green, commit.

### Task 3: Judge sizing, the service and the start wait (Track C)

**Files:**

- `sizing/judge-sizing.ts`, `sizing/sizing-service.ts`, `sizing/fingerprint.ts` (a hash of the title,
  description, criteria, areas and goal id), and tests;
- `daemon/start.ts` (wiring and the sweep);
- the start entry points that wait, each at the very top, before any read:
  - `POST /tasks/:taskId/start` (`api/app.ts` about 1498);
  - `POST /projects/:projectId/batches` (about 838; the handler becomes async);
  - the builder MCP's start (`builder/tools.ts` about 228).

**Behaviour:**

- **Which events start sizing.** `task.created`, and `task.changed`, for a task that:
  - has never started;
  - is not a pass page or a CI fix;
  - has a fingerprint different from `sized_for`.

  The service:
  - runs the rules in one write;
  - then, unless the judge is off or has no account, asks the judge. That goes through a queue of at most 4 tasks
    at a time, in creation order.
- **What it asks.**
  - `task_rigor`, unless the rigor is pinned (`builder` or `agent`). Its options and criteria are:
    - Light: "a small, contained change: a fix or a copy edit";
    - Standard: "ordinary feature work with tests";
    - Careful: "touches shared contracts, data, money or many modules; worth a plan";
    - Critical: "irreversible, security-sensitive or production-critical; the builder should see the plan".
  - `task_kinds`, once per kind that is not pinned either way (not `builder` or `agent`, not in `kindsOff`), in
    parallel. It answers `yes` or `no`, with the kind's description as the criteria.
  - Every call passes `taskId`.
- **How the answers are applied.** In one write, through `applyTaskSizing`, with the guard of Task 1 plus one more:
  the fingerprint must still match, and the rigor and kinds pins must be the same as when the calls were made.
  - An answer at or above the floor sets a judged rigor (reason "judged Careful (0.86)"), adds a `yes` kind or
    drops a judged `no` kind. The rules then run over the result.
  - The outcomes are Acted or BelowFloor.
  - If the guard fails, or a pin changed, each call's outcome becomes `stopped` and nothing is applied.
  - A fallback leaves the rules' value.
- **The listener never throws** into the bus or into task creation. Errors are logged.
- **The start-up sweep:**
  - every unstarted task whose `sized_for` is null gets the rules;
  - those created in the last 24 hours also get the judge.
- **The start wait.** `sizing.settled(taskIds, timeoutMs = JUDGE_TIMEOUT_MS)` resolves when the tasks' in-flight
  sizing ends, or at the timeout. The timeout is injectable for tests. Two Starts of one task both wait and then
  run their synchronous checks one after the other, so the second sees the first's write.

**Tests:**

- **Service over real SQLite with a scripted judge.** This is the cheapest rung that reaches the store and the
  queue:
  - create, and the judged rigor and kinds land with their sources;
  - a pinned rigor is never asked;
  - an edit re-measures;
  - an edit during the call means `stopped` and nothing applied;
  - a builder pin during the call means `stopped`;
  - a start during the call means `stopped`;
  - below the floor, the rules' value stays;
  - judge off means `sizedByRules`;
  - the cap of 4, with five held calls;
  - a throwing judge never fails creation;
  - a pass-page task is not judged.
- **Through the real wiring, one test:** `createTestEngine` with the scripted judge. Create a task, start it while
  the judge is held, and the start waits until the timeout (injected at 50 ms), then starts on the rules' value.
  The late answer is `stopped`.
- **A table for the state text:** it is fenced, and it has only the listed fields.

**Value:** `protects=tasks are judged off the request path and a stale or late answer never lands; fails_when=
creation blocks, a started or pinned task is re-sized, or a start waits unbounded or double-starts;
why_new=no sizing existed; no_claim=that the judge's answers are good`

- [ ] Red-first, one commit per behaviour:
  - (a) rules on events;
  - (b) the calls and how they are applied;
  - (c) the guard and `stopped`;
  - (d) the start wait;
  - (e) the sweep.

### Task 4: Overrides, the card, the drawer and the Decisions page (Track C)

**Files:**

- `daemon/services.ts` (`patchTask`, the builder-facing path) and `builder/tools.ts` (`edit_task`);
- `packages/db/src/store/judge-call-stats.ts` and its test (additive);
- `apps/desktop/src/views/settings/recent-decisions.tsx`;
- `apps/desktop/src/views/board/task-card.tsx`, `task-drawer.tsx`, `task-fields.tsx` and tests.

**Behaviour:**

- **`services.patchTask` (Board, API):**
  - **Rigor.**
    - Setting `rigor` sets its source to `builder`.
    - If the previous rigor was judged and differs, `recordJudgeOutcome(sizing_calls.rigor, Overridden)` runs in
      the same write.
    - `rigor: null` clears the source and `sized_for`, so the next `task.changed` re-measures.
  - **Kinds.**
    - Additions get source `builder`.
    - A removed key goes into `kindsOff`, and a re-added key leaves it.
    - Removing a judged kind, or adding one the judge said `no` to, records `Overridden` on that kind's call.
- **The builder MCP's `edit_task`:** its rigor gets source `agent`, as its kinds do. No outcome is recorded.
- **`judge-call-stats.ts`:**
  - `overridden` counts as answered: in `ANSWERED`, cost, latency and confidence;
  - the stats gain an `overridden` count;
  - Recent decisions can filter on it.
- **The card's rigor badge:**
  - It is shown when `effectiveRigorSource` is not `default`, or when the rigor differs from the project's
    default.
  - It reads "Careful · judged", "· rules", "· agent" or "· you".
  - Its tooltip is the reason, or "Sized by rules" when `sizedByRules`.
- **Kind badges and the drawer** show their source the same way.

**Tests:**

- Real-SQLite services rows: each override records `Overridden`, `rigor: null` re-measures, and `kindsOff`
  round-trips.
- A stats row: an overridden call counts.
- Desktop: the card and drawer show each source.

**Value:** `protects=builder corrections are recorded against the judge, shown, and pin; fails_when=an override
goes unlogged or uncounted, or a removed kind comes back; why_new=no outcome after the fact existed;
no_claim=judge quality`

- [ ] Red, green, commit per side.

### Task 5: `resize_task` (Track D)

**Files:**

- `packages/contracts/src/mcp-tools.ts` (name, input `{ rigor, why: string 1–300, opId }`, output);
- `apps/daemon/src/mcp/tools.ts` (description and handler), and the handler's tests;
- the notice: `InboxService.flag` with one option, `{ key: 'ok', label: 'Got it' }`, and `foldKey`
  `resize:<taskId>`, raised after the tool's write through the service's own write.

**Behaviour:**

- **When it is refused.** Each refusal is a result the agent reads, never an error:
  - for any step but Plan or Implement: "Only a plan or build session can resize its task";
  - on a Workbench pass page: "A Workbench page runs no rigor's steps";
  - when the rigor is pinned by the builder: "The builder set this task's rigor; carry on at <rigor>";
  - when the new rigor is below the kinds' minimum: "<Kind> work is at least <minimum>".
- **Otherwise:**
  - one write sets the rigor with source `agent` and the reason `why`, and records the op for replay;
  - then one notice: "<role> resized <task> to <Rigor>: <why>". It is raised in the service's own write after the
    tool's write; a crash between the two loses the notice (known gap: the card still shows the agent's reason).
  - The runner's next step boundary re-plans (PR 2b's `withCurrentPlan`).
- **Replay.** A replay by `opId` returns the first result and raises nothing.

**Tests:**

- Handler tests over real SQLite: each refusal, success, and replay.
- Pipeline, one test: a Build session resizes Light → Standard, and after the gate a Review runs.

**Value:** `protects=an agent can resize within the floor and never over a pin; fails_when=a pin or floor is
broken, a replay doubles, or the steps don't follow; why_new=no such tool; no_claim=that agents call it wisely`

- [ ] Red, green, commit.

### Task 6: Ship by rigor (Track D)

**Files:**

- `apps/daemon/src/delivery/goal-batches.ts` (new, pure);
- `delivery/grouping.ts`: one more union key, passed in;
- `delivery/start.ts`, the worktree path only: compute the goal pairs, and offer goal joins;
- tests in the delivery vitest project (`pnpm exec vitest run -c vitest.delivery.config.ts <files>` from
  `apps/daemon`).

**Behaviour:**

- **A task ships with its goal** when all of these hold:
  - it has a `goalId`;
  - its row's `ships` is `with_goal` (`rowProcess` at its effective rigor);
  - none of its kinds has `ownCopy`;
  - its placement is a worktree.

  Nothing is stored. It is computed at each start, so a resize before start takes effect.
- **Started together.** `goalPairs(tasks)` unions every two such tasks of one goal in the start set **whose
  landing targets match** (`taskTarget` and `same` from `delivery/landing.ts`, exported). Tasks with different
  targets stay apart, as today, so `sharedLanding` never throws for a goal pair.
  `groupByDependency` takes these pairs as one more union input, beside `dependsOn` and landing groups.
- **Started later.** `goalJoin(task, openBatches)` names an open batch of the same project to join. The batch must:
  - be in worktree placement;
  - be in a state that `planLandings` would accept, so not cutting, shipping or failed;
  - hold a task of the same goal that ships with its goal;
  - hold no task that does not;
  - have a landing that matches the task's target (`batchLanding(batch)`), so `joinsLanding` never throws.

  Otherwise it returns null, and the task starts its own batch. It never refuses. A task already in a Shape
  landing group keeps `planLandings`' rule and is not offered a goal join.
- **Your folder is unchanged:** one batch.

**Tests (delivery project, real SQLite and git):**

- two Light tasks of one goal started together make one batch;
- a later Standard task joins the goal's open batch;
- a later Light task, while that batch is shipping, starts its own batch and is not refused;
- a Careful task of the goal is alone;
- a dependency-kind Standard task is alone;
- a Careful task that `dependsOn` a goal task joins through the dependency, as today;
- two Light tasks of one goal with different landing targets start in separate batches and are not refused;
- a later goal task whose target differs from the goal's open batch starts its own batch;
- a task with no goal is unchanged.

Pure tables cover `goalPairs` and `goalJoin`.

**Value:** `protects=small tasks of a goal land in one pull request and risky or own-copy ones alone, without ever
refusing a start; fails_when=a Careful or own-copy task joins a goal batch, goal tasks split, or a goal join refuses;
why_new=goal tasks were never batched; no_claim=PR titles`

- [ ] Red, green, commit.

### Task 7: Kinds' skills and implied-by, in the sessions and the drawers (Track D)

**Files:**

- `runner/step-skills.ts` (new, pure): `stepSkills(persona, kinds)`, the persona's skills plus its task's kinds'
  skills, deduplicated, in that order. It is used at `runner.ts` near 2045.
- `apps/desktop/src/views/settings/kind-drawer.tsx`, `kinds-section.tsx` and tests:
  - Implied by is a `TagsInput`. Its suggestions are the stock hazard names and the areas and hazards of every
    project.
  - Skills is a `MultiSelect` of `SkillName`.
- The row drawer: Ships, a `Select` of "With its goal" and "Alone".

**Tests:**

- A pure `stepSkills` table.
- One pipeline test: a task of a kind with `skills: ['test-first']` whose persona lacks it gets the skill's body
  inlined in a Codex step's prompt. Also check that a Claude step's brief names it.
- Desktop: the kind drawer saves `impliedBy` and `skills`, and the row drawer saves `ships`.

**Value:** `protects=a kind's skills reach every step of its tasks on both providers; fails_when=a kind skill is
dropped or Codex gets only names; why_new=skills came from personas only; no_claim=skill content`

- [ ] Red, green, commit per side.

### Task 8: Docs and follow-ups (controller)

- `apps/daemon/src/sizing/AGENTS.md` (new), the runner, judge and delivery `AGENTS.md` (goal batches).
- A decision, `docs/architecture/decisions/2026-11-13-the-judge-sizes-tasks-and-agents-can-resize.md`, with this
  plan's calls.
- `~/.claude/skills/10db-task/` (outside the repo) speaks kinds and rigor instead of `riskTags` and `flowId`.
- File on the 10db board:
  - the spec's §11 follow-ups;
  - **decisions run on a project's own Claude or Codex account** (provider parity, §12);
  - the Workbench model and effort picker;
  - the migration dropping the old routing tables;
  - a multi-label `task_kinds` call;
  - builder skills on kinds.

## Order and tracks

1. Task 1 runs on `feat/judged-sizing`, branched from `feat/process-per-rigor` once PR 2b is final. `main` is
   merged into it when PR 2b lands.
2. Then two tracks run:
   - **C:** Tasks 2, 3, 4;
   - **D:** Tasks 5, 6, 7.

   C edits `api/app.ts` and `builder/tools.ts` for the start wait, and D edits `delivery/start.ts` grouping, so the
   files barely overlap.
3. Code review per track, with at most two fix rounds. Then:
   - a click-through covering a new task judged by a stub decision model, an override shown on Decisions, and two
     Light goal tasks landing in one batch;
   - the gate;
   - the PR.
