# 10db goals: a goal engine, and Factory as goal mission control

**Status:** written on 2026-10-29 from a design session with the builder (gstack /office-hours, Builder mode),
a cold read by a Claude subagent, two rounds of an independent spec review, a plan-reviewer pass (Fable) and a
design review with the builder (gstack /plan-design-review, 14 decisions in §8, §9 and §11). Every premise and the approach
are the builder's; calls this spec made without the builder are marked **(spec's call)** and listed in §14.
**Extends:** `2026-10-13-10db-factory-loop-design.md` §10 (Factory, Board, Inbox) and §4 (decisions, people).
**Supersedes:** the done rule in `scratch/design-note-2026-10-28-starting-work-and-goals.md` ("every task's
criteria are met and merged"); the note's name (Goal), its steps-vs-tasks rule and its goal card stand.
**Keeps:** batch delivery, worktree mode, the lane sandbox and the M3 knowledge plan, which §7's decisions
migration extends additively.

Each part is marked:

- **Built:** on `main` today.
- **Designed:** new work. The phase (§12) says when.

## 1. Intent

The builder runs several projects. A real outcome takes about fifteen sessions, and the builder is the glue
between them: pasting handoffs, shepherding sessions, relaying screenshots and questions to stakeholders in
Slack and folding their answers back into the work. 10db automates the inside of one task (steps, handoffs,
gates, review, pull requests). Everything above the task is still manual; this week a separate Claude Code
session does it by hand (files and starts tasks, watches pull requests, answers routine Inbox cards under
standing instructions, holds the builder's decisions, writes handoff notes).

Factory, meant to show this work, is one row per workstream (state, step, context, sessions, last activity),
with a queued task showing its planned step as if it ran, a red Cancel on every row and a list of every batch
ever. It answers none of the builder's questions.

A **goal** is an outcome with acceptance criteria that 10db pursues across many tasks. The builder describes
it once; 10db runs its tasks, decides what it may decide, asks only where it must, and shows the builder what
happened while they were away.

**What makes it different.** The agent tools checked on 2026-10-29 (OpenAI Codex goals, Factory.ai Missions,
Devin's and Cursor's Slack integrations) loop in whoever started or follows the run. None documents routing a
question or screenshot to a stakeholder by role and recording the answer as a decision the work then follows.
A 10db goal is a team: an owner, stakeholders and agents, each with a role.

**Success means:**

- Phase 1: opening Factory shows, for each goal and without opening a transcript, its tasks done, who is working
  on which model, open cards, the next task, deviations, recorded decisions and tokens used. Running tasks with
  no goal still show. No unlabeled columns; red only for failure.
- Phase 2: a goal run on the engine reaches done with every criterion proven and zero manual continuation
  actions (§13).
- Phase 3: a question for a stakeholder reaches them in Slack, and their answer resumes the waiting task with no
  relay by the builder.

## 2. Principles

1. The builder manages goals, not tasks. Workstreams, batches and steps are a goal's internals and leave the
   main surfaces.
2. Each surface has one job. **Board:** tasks, grouped and filtered by goal. **Inbox:** what needs a person,
   across goals. **Factory:** goals running.
3. **Decide, show, let me reverse it.** In the builder's words: "almost everything is a two-way door + I often
   just have to see it live to get a real feel for it." A goal makes two-way calls itself, attaches something to
   look at and offers Keep / Flip.
4. **10db, not the agent, decides which calls are one-way**: fixed, testable classes plus a dependency count
   (§7). An agent the builder rates 50/50 on judgment doesn't classify its own doors.
5. **Done is proven, not claimed**: a criterion ticks on a check the daemon runs or on a named person accepting
   the proof (§5).
6. **Deterministic engine.** The daemon owns the goal state machine, criteria checks, door classes and routing.
   An LLM is used only where judgment is needed, and its output is a proposal the engine validates.
7. **One decisions store.** A goal's decisions are knowledge decisions (§7); a stakeholder's answer becomes one.
8. Safety for commands stays where it is: the sandbox, auto mode, the guard.

## 3. Not in this spec

Separate projects, each with its own design:

- **Review lenses**: a schema diff ("Model changes") and per-endpoint query counts and plans ("Query changes"),
  shown to the people who care about them (`docs/open-items.md`).
- **Knowledge**: principles, the context pack, stakeholder-visible principles and decisions
  (`docs/superpowers/plans/2026-10-22-10db-11-m3-knowledge.md`).
- **Model intelligence**: OpenRouter, Artificial Analysis, System One models such as Jev.
- **Inbound intake**: a stakeholder emails a document or posts in a connected Slack channel.
- **Global mission control**: Factory across every project, above the project switcher.

## 4. The goal

**Designed.** A goal has a title, an objective, criteria (§5), what the owner cares about most, an owner,
people (§10), tasks, a budget (§6) and a state (§6).

- The owner is a person (`goals.owner_id` references `people`), defaulting to the builder, whom the team seed
  already inserts. Phase 1 adds `goals.state` with §6's states in `@10db/contracts` but writes only `draft`;
  Factory's status is derived (§8) until phase 2 wires the transitions.

- A task belongs to at most one goal. A goal's task can still be started by hand from its card and runs as it
  would alone; starting one doesn't change the goal's state. **(spec's call)**
- Delivery stays per task, as the project sets it (one pull request per task in worktree mode).
- Two ways in: **Adopt a Plan** (§11, phase 1) and **New Goal** from chat, assets or a form (phase 4).

## 5. Criteria and proof

**Designed.** Each criterion has a check kind, fixed when the goal is written:

| Check     | Proven when                                                                                                                                                                                         | Who ticks                                                    |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `task`    | the named task is done (its own gate, review and delivery passed)                                                                                                                                   | the daemon                                                   |
| `merged`  | the named task's pull request is merged on the base branch                                                                                                                                          | the daemon                                                   |
| `command` | the project's gate command, or a command the owner approved when adopting the goal, passes in the lane sandbox in a clean worktree at the base branch's head, run once no goal task is left unmerged | the daemon                                                   |
| `accept`  | a named person (the owner by default) accepts the linked proof                                                                                                                                      | that person; an agent or anyone may attach proof, never tick |

**Done rule:** a goal is done when every criterion is proven. Tasks are how criteria get proven, not the
measure.

- **Tasks exhausted, criteria unproven:** the goal goes to `waiting` with an owner card ("All tasks are done; 2
  criteria are unproven") offering: add a task, accept the proof that exists, drop the criterion (recorded as a
  decision), or cancel the goal. Phase 4 adds a proposed re-plan.
- **A goal task fails:** the goal goes to `waiting` with the existing failed-task card (Retry, Ship Anyway,
  Later), owned by the goal's owner. Other ready tasks keep running.
- **A goal task is cancelled or abandoned:** it counts as finished for the exhausted-tasks rule; the goal goes
  to `waiting` with an owner card listing its blocked dependents and the unproven criteria, with the
  exhausted-tasks choices.
- **Criteria proven, tasks left:** the goal is done. Unstarted tasks stay on the Board, outside the goal's
  progress, and are listed on the done card; running ones run to their own end, and the done card offers to
  cancel them. **(spec's call)**

Criteria are stored in a `goal_criteria` table (goal, text, check kind, the named task, command or person,
state, proof as a list of evidence ids, pull request URLs or file paths, proven at, proven by). Phase 1 creates
the table, writes criteria from the brief with state `unproven` and shows them read-only; a `command` criterion
is stored unapproved. Phase 2 adds the checks, ticking, and the owner's approval of a `command` at adoption.

## 6. States, budget and scheduling

**Designed (phase 2).**

| State       | Entered by                                         | Effect                                                                                                                                                                  |
| ----------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `draft`     | Adopt a Plan, New Goal                             | nothing runs; the tasks are on the Board under the goal                                                                                                                 |
| `running`   | Start Goal, Resume                                 | the scheduler starts the goal's ready tasks                                                                                                                             |
| `waiting`   | a card owned by a person blocks the goal           | other ready tasks keep running                                                                                                                                          |
| `paused`    | Pause, or the budget is crossed                    | no new task starts; running steps finish their current step, then park, as an account pause does today                                                                  |
| `done`      | every criterion proven                             | nothing new starts                                                                                                                                                      |
| `cancelled` | Cancel, confirmed                                  | running workstreams are cancelled as Cancel does today; unstarted tasks are removed (the remove-unstarted route) or kept, chosen in the confirm                          |

- Editing a running goal: unstarted tasks can be added or removed at any time. A criteria edit is a one-way
  decision for the owner.
- **Budget:** the goal's own field, in tokens and, on metered accounts, dollars; unset means no spend check.
  (It is not the project's `budget_ceiling`, which caps the price of the model the router picks per step.)
  Crossing it pauses the goal with a one-way owner card: raise the budget or cancel.
- **Scheduling:** goal tasks join the existing picker with no priority of their own. The project's "Most tasks
  at once", areas and dependencies decide, as today; two running goals share lanes in task-creation order.
  **(spec's call; revisit with data.)**

## 7. Decisions and doors

**Built:** the `decisions` table (question, choice, rationale, decided by, scope `you | project | area`,
supersession, source) and the `record_decision` MCP tool; the `deviations` table and `report_deviation`.

**Designed (phase 2).**

A schema change extends `decisions` with `goal_id`, `task_id` (the task whose session made it), `door`
(`two_way` | `one_way`), `door_reason` (the rule that classed it), `evidence` (a list of evidence ids or URLs),
`undo` (the reversal kind) and `state`. Before v0.1.0 the migration baseline is regenerated
(`packages/db/AGENTS.md`); after it, this is a forward migration. `decided_by` becomes a person id or `agent`:
`record_decision` writes `agent:<sessionId>` today, which maps to `agent`. A goal decision is project-scoped
with `goal_id` set. The M3 knowledge plan reads scope, question, choice, rationale and supersession, which
don't change.

**How decisions enter.** Agents record them with `record_decision`. It already records the session, and the
decision's source links it to the workstream, so the task link is a join that the new `task_id` column stores. At each step's
end the daemon compares the step's diff with the one-way path classes; a diff that touches one with no matching
one-way decision (recorded in the same step, its `door_reason` naming the same class) raises one itself
("Schema change in `packages/db` with no recorded decision"). An unreported structural decision is still caught.

**Fixed one-way classes.** Paths and patterns are project settings with these defaults. **(spec's call)**

| Class          | Rule                                                                                                                                                                      | Blocks                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Schema         | the diff touches the schema paths (10db: `packages/db/src/schema.ts`, `packages/db/drizzle/`)                                                                             | at the end of the step                   |
| Contracts      | the diff touches the contract paths (10db: `packages/contracts/src/`)                                                                                                     | at the end of the step                   |
| Deletes        | the diff removes tracked files outside the task's areas, or a migration drops a table or column                                                                           | at the end of the step                   |
| Spend          | the goal's sessions cross its budget (§6)                                                                                                                                 | in the scheduler                         |
| Ship           | a command matching the ship patterns (defaults: `git tag`, `git push --tags`, a push of a tag, the project's deploy commands); not merging a pull request                  | before the command runs, held by the guard |
| Outside people | a message to anyone not on the goal                                                                                                                                       | before it is sent                        |
| Membership     | adding or removing a person on a goal                                                                                                                                     | before it applies                        |

A step-end block leaves the step's work committed on its branch; the task waits, as a `check` card does today,
with the decision card open.

**Dependency count.** A decision is linked to its task. Its dependents are the tasks that depend on that task
through `task_deps`, transitively. When the dependents started after the decision reach N (default 3, a project
setting), a two-way decision that is still flippable becomes `needs_owner`: Flip then needs the owner and shows
what it would affect. **(spec's call)**

**States.**

- Two-way: `standing` (unanswered; it stands), `kept`, `flipped`, `needs_owner`. Flippable until `needs_owner`
  or the goal is done.
- One-way: `pending_owner`, then `approved` (the task resumes) or `rejected` (the rejection is injected into the
  task's next step as a reversal).
- No pull request merges while a decision on its task is `pending_owner` or `needs_owner`.

**Keep / Flip.** Keep marks a decision `kept`. Flip records a superseding decision ("flip of D-12") and files a
reversal task under the goal with the original decision, its task's pull request and the evidence in its
description; if the original task is still running, the flip is injected into its next step instead.
Unstarted dependents wait on the reversal task (a dependency the engine adds). Phase 4 adds a proposed re-plan.

**Merging.** A merge stays the builder's call (`decisions/2026-10-28-allow-auto-merge.md`), and the main
ruleset's code-owner review gates every merge. The engine never merges. Whether it may queue a merge for a goal
task under a rule is open (§14).

## 8. Factory

**Built:** Factory lists workstreams (task, state, step, context, sessions, last activity, Retry, Cancel) and,
below them, every batch with its pull request (`apps/desktop/src/views/factory/`).

**Designed.** Factory becomes the project's goals, with the project switcher above it as today.

```
┌ Factory ─────────────────────────────────────────────────────── [Adopt a Plan…] ┐
│ Goals 10db is pursuing in this project · since you left: 3h ago                │
│ ┌────────────────────────────────────────────────────────────────────────────┐ │
│ │ Real areas                                                             ⋯   │ │
│ │ ● Running · 6 of 11 tasks done                                             │ │
│ │ ▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬ │ │
│ │ Working now  ● Implementer · sonnet-5.5@high · "Task patch route" · 2 of 3 │ │
│ │              ● Reviewer · opus-5.5@high · "Propose project areas"          │ │
│ │              Team: Planner fable-5.1 · Implementer sonnet-5.5 · Reviewer … │ │
│ │ Waiting on   ● You · "Which name reads best?" · Inbox · 2h                 │ │
│ │ Next         "Edit areas in the drawer" when "Task patch route" merges     │ │
│ │ Deviations   Split "Propose task areas" in two: too big for one review     │ │
│ │ Decisions    Areas follow workspace packages, not folders                  │ │
│ │ Cost         412k tokens · 14 sessions                                     │ │
│ └────────────────────────────────────────────────────────────────────────────┘ │
│ ┌ Goals engine, phase 1 ── ● Waiting on you · 1 card · 1 of 8 tasks done ──── ┐ │
│ ┌ Ungrouped ────────────── ● 2 tasks running ────────────────────────────────┐ │
└────────────────────────────────────────────────────────────────────────────────┘
```

The sketch shows phase 1. Phase 2 turns the bar into criteria proven and adds Keep / Flip and "needs you" on
decisions; phase 3 adds "Waiting on Mark" with the evidence sent.

- **One list, not cards:** goals are rows of one list separated by hairline dividers; the open goal's area takes
  the `bg_1` fill. No borders or shadows on rows (cards stay the Board's draggable things). The sketch's boxes
  are for reading only.
- **One row per goal:** title, a status dot and one line. **Status, first match wins:** failed (red: a goal
  task failed and isn't retried), waiting on you (yellow: a card owned by the owner), waiting on someone (yellow:
  a card owned by another person), paused (orange), running (blue: a goal task's workstream is active), not
  started (gray: nothing of it is running and tasks wait unstarted; "Not started · 11 tasks · Start Ready Tasks
  on the Board"), done (green). Phase 1 has failed, waiting on you, running, not started and done. Colors follow
  DESIGN.md (gray is queued).
- **Done in phase 1** means every goal task that isn't cancelled is done and its pull request merged (the pull
  request state 10db already tracks); until then the goal is blue, "Shipping · 11 of 11 tasks done · 3 pull
  requests open". In a project without pull requests, done means every task done. From phase 2, done is
  every criterion proven (§5).
- **Ungrouped** holds the tasks with no goal that are running or failed, under the same status rule as a goal
  ("2 running · 1 failed"); expanded, it shows their Sessions table with Retry and Cancel. Finished work is
  reached from each task's drawer (its latest run), not from Factory.

| Surface         | Loading                              | Empty                               | Error                                                     |
| --------------- | ------------------------------------ | ----------------------------------- | --------------------------------------------------------- |
| Goal list       | `Loader size="sm"`, as Factory today | the guided line above, Ungrouped    | red `Alert` "Couldn't load the goals" with the message    |
| A goal's digest | its rows' skeleton lines             | a row with nothing says "None"      | a red `Alert` inside the expanded goal; the row stays     |
| Adopt a Plan    | the primary's `loading` state        | not applicable                      | the refusal sheet (§11); a daemon error beside Pick Again |
| Ungrouped       | with the list                        | hidden when nothing runs or failed  | with the list                                             |

The list and Adopt rows restate Factory's and DESIGN.md's existing conventions; the digest's loading and
"None" rows are the spec's call.
- **Order:** failed, waiting on you, waiting on someone, paused, running, then Ungrouped, then done goals under
  one collapsed "Done (n)" line; within a status, the most recently changed first.
- **No goals yet:** one dimmed line under the header, "Goals are outcomes 10db pursues across many tasks. Adopt
  a plan to start one, or ask Claude Code to with the 10db-task skill.", with Adopt a Plan… as the header's
  primary and the Ungrouped row below it when tasks are running.
- **Every goal starts collapsed** to its one-line verdict; clicking a row (or Enter on it) opens it, one at a
  time. The ASCII sketch shows one opened.
- **The digest** opens under the selected goal. Its window is since the owner last opened this goal in Factory,
  stored per person and goal. Rows marked Δ show changes in the window; the rest show current state.
- **Keyboard and sizes:** each goal row is a button with `aria-expanded` controlling its region (`role="region"`,
  labelled by the goal's title). Tab moves between rows and into an open digest; Enter or Space toggles;
  Escape collapses. Checked at 1440x900 and 1280x720 like the Board, with axe in Playwright. Fast row keys like
  the Inbox's can come later.
- **News:** a collapsed goal's line ends with "· 3 new since 3h ago" in plain text (no badge, no color) when its
  Δ rows have items. Inside, each Δ row's label reads "Deviations · since 3h ago", lists only those items, and
  offers **Show Earlier** for the rest.

| Row            | Phase 1 source                                                                  | Later                                         |
| -------------- | ------------------------------------------------------------------------------- | --------------------------------------------- |
| Progress bar   | tasks done of total, labelled "tasks"                                           | phase 2: criteria proven of total             |
| Working now    | running workstreams: persona, `model@effort`, task, step                        |                                               |
| Team           | the personas and models the goal's tasks are routed to                          |                                               |
| Waiting on (Δ) | open Inbox cards on the goal's tasks                                            | phase 3: per person, with what was sent       |
| Next           | the next ready task, or the one it waits on, from `task_deps`                   |                                               |
| Deviations (Δ) | `deviations` rows on the goal's workstreams                                     | phase 2: the engine's deviations too          |
| Decisions (Δ)  | the project's decisions recorded in the window, read only                       | phase 2: the goal's own, with Keep / Flip     |
| Cost           | tokens over all the goal's sessions; dollars where `cost_usd` is set            |                                               |

- **Progress** counts the goal's tasks with status `done` (their pull request may still be open) over its
  tasks that aren't cancelled; cancelled ones are listed in the goal's drawer.
- **The digest API.** The daemon computes the digest: `GoalDigestDto` in `@10db/contracts` and
  `GET /goals/:goalId/digest`, one response with the status, progress and every row from the sources above.
  Team is the steps of the goal's started workstreams. The window comes from `goal_views` (goal, person, opened
  at): the route computes Δ rows from the previous mark, then advances it, so a refresh in the same visit keeps
  them. The same response carries the Ungrouped group (`goalId: null`).

- **The goal's detail** is the expanded goal in Factory: the digest, then **Sessions** (the goal's workstreams as
  today's table, with Retry and Cancel), then **Pull requests** (its batches). It is one self-contained
  component, so it can move into a drawer or a page; which one is settled live once Real areas has run (§14).
- **Goes:** the workstream table (its rows move into the goal's detail and each task's drawer), batch history
  (each task's drawer already keeps its branch and pull request), and the red Cancel on every row. Cancel for a
  running task moves to its drawer and card menu, beside Retry and Abandon, and into the goal's detail. Pause
  and Cancel for a goal live in its menu.
- **Header:** in phase 1, **Adopt a Plan…** is the one filled primary. New Goal arrives in phase 4 and becomes the
  primary then, with Adopt a Plan… as `default`. A goal's menu (⋯) holds only what exists in its phase: no
  Pause before phase 2.

**The journey this serves:**

| Step | The builder                                      | Feels                         | What supports it                                              |
| ---- | ------------------------------------------------ | ----------------------------- | ------------------------------------------------------------- |
| 1    | asks Claude Code to turn a spec into a goal      | handing off, not filling a form | the 10db-task skill's `goal` command, dry run first          |
| 2    | opens Factory                                    | oriented in five seconds      | status order, one line per goal, "3 new since 3h ago"         |
| 3    | opens the goal with news                         | caught up, not reading logs   | the digest rows, Δ only, Show Earlier for the rest            |
| 4    | sees "Waiting on you"                            | knows the one thing to do     | yellow first in order; the card in the Inbox                  |
| 5    | sees a failed task                               | in control                    | red first; Retry and Cancel in the goal's Sessions            |
| 6    | sees "Shipping · 3 pull requests open"           | trusts green when it comes    | green only once everything merged                             |
| 7    | comes back after a week                          | the record holds              | Done (n) collapsed; decisions in the knowledge store          |

## 9. Board and Inbox

**Built:** the Board's task cards, drawer and Start Ready Tasks…; the Inbox's cards with an assignee field.

**Designed.**

- **Board (phase 1):** a goal is a slim **goal strip** above the columns, like `BatchStrip` and in the same scroll
  area: title, "6 of 11 tasks", the status dot. Clicking it opens the goal drawer (objective, criteria
  read-only, tasks, blockers). A goal isn't a card in a column; the columns stay about tasks. Each of its task
  cards carries the goal's title as a small dimmed label, and a goal filter (a `Select` in the Board header)
  shows one goal's tasks. The drawer's **Start Ready Tasks**
  opens the existing sheet scoped to the goal: `GET /projects/:projectId/candidates` and `proposeCandidates`
  take an optional `goalId` that limits the Ready pool before picking, so "Most tasks at once" fills with the
  goal's tasks. Phase 2 replaces it with **Start Goal**.
- **Inbox (phase 1, derived):** cards carry their goal (card → workstream → task → goal; no schema change).
- **Inbox (phase 3):** a card assigned to a person with no connected channel stays in the owner's Inbox. A card
  waiting on someone else escalates to the owner after the project's `humanWaitMinutes`.

## 10. People and the stakeholder loop

**Built:** the `people` and `team_members` tables, and `routing_rules` with `assigneeFor` (a question's
category and area → a person), which the judge's rules extend rather than replace. **Designed (phase 3):** the
rest.

The loop the builder runs by hand today: a stakeholder sends customer feedback, it becomes a brief, the brief
becomes tasks, screenshots and questions go to the stakeholder, and their answers come back into the work. A
goal owns this loop.

- **A person on a goal:** a role (owner, stakeholder), a channel (in-app, Slack) and what they receive (a
  digest, questions, screenshots). Only the owner adds or removes people; an adopted or shaped goal proposes
  them and the owner confirms. Being on the goal authorizes 10db to message them directly.
- **Authority (spec's call):** the owner decides everything. A stakeholder answers questions routed to them and
  may Keep or Flip two-way decisions; one-way decisions need the owner. A stakeholder's Flip after the owner's
  Keep becomes a question to the owner. The owner's latest answer wins.
- **Slack:** a Slack app over Socket Mode (no public URL); its bot and app tokens are kept in the Keychain like
  account secrets. Someone with rights installs it in the workspace. A Slack user is bound to a person on first
  contact, confirmed by the owner.
- **Offline:** a button pressed while 10db is down fails with Slack's own error and isn't recorded. On
  reconnect, 10db reads typed replies from the conversation history and re-posts unanswered questions with
  fresh buttons. Every message says "or reply in text".
- **Outbound policy (spec's call):** text and attachments are scanned with gitleaks; a hit holds the message as
  an owner card. Screenshots can't be secret-scanned, so they are taken from the app window under test data.
  The owner approves the first message to each person on each goal. Every message sent is recorded (goal,
  person, content hash, time). At most one digest a day per person; questions go as they come.
- **An answer** is recorded as a decision and injected into the waiting task's next step, which resumes.
  Re-planning from it is phase 4.
- **The judge:** rules map a question's kind to a role. An optional model (Haiku, on the subscription) only
  picks recipients and timing among escalations the rules already require. It never downgrades a one-way
  decision or skips an approval.
- **Evidence:** phases 1–2 use today's kinds (gate, agent, builder) and pull request links. Phase 3 adds
  screenshots, captured by a step that runs the app, stored with the workstream's evidence and linked from the
  decision or criterion. Previews and clips wait for a mechanism.

## 11. Adopt a Plan

**Designed (phase 1).** A goal brief is a Markdown file with YAML front matter, validated by a zod schema in
`@10db/contracts`: title, objective, criteria (text and check kind), budget, tasks (a key, title, description,
acceptance criteria, areas, and the keys it depends on), and optional people (proposed; the owner confirms).
Adoption is deterministic:

- **Two ways in, one route.** In the app, Adopt a Plan… opens the native panel (as the project folder is
  picked) and posts the file's path. From any Claude Code session, the 10db-task skill gains
  `node $T goal <projectId> <brief.md> [--dry-run]`: the session turns a spec, a PDF or a conversation into a
  brief and posts its text. Both reach `POST /projects/:projectId/goals/adopt` with `{ path }` or `{ text }`
  and an optional `dryRun`, which validates without writing. The skill lives outside the repository
  (`~/.claude/skills/10db-task/`), so its command is added by hand once the route lands. This is how plans
  arrive until New Goal's own conversation (phase 4).
- The daemon reads the file, splits the front matter, parses it with a YAML library (a new dependency, pinned
  exactly), and validates it with the `GoalBrief` schema, then by rule: task keys are unique, every
  depends-on and every criterion's task names a key in the brief, the dependencies have no cycle, and every
  area exists in the project.
- It writes the goal (`draft`), its criteria, tasks and `task_deps` in one transaction, so a refusal leaves
  nothing behind. It answers 201 with the `GoalDto`, or 400 with `{ errors: [{ path, message }] }`, each error
  shown in the refusal sheet below.
- **A refused brief** opens a form modal, "This plan can't be adopted yet", naming the file and listing every
  error as a row: where it is in plain words ("Task 3, depends on") and what's wrong ("no task has the key
  drawer-editr"). **Pick Again…** is the primary; Cancel closes it. The skill's `--dry-run` prints the same
  list.

An example brief:

```markdown
---
title: Real areas
objective: 10db proposes a project's areas from its repository, proposes each task's areas, and lets the builder edit them.
cares_most: Areas a non-engineer can read; no task blocked by an area it doesn't touch.
criteria:
  - text: A new project gets proposed areas it can edit before saving
    check: task
    task: propose-project-areas
  - text: The builder accepts the area names after seeing them
    check: accept
tasks:
  - key: task-patch-route
    title: Patch a task's areas and dependencies
    areas: [repo]
    criteria: [PATCH /tasks/:id changes areas and dependencies, and refuses unknown areas]
  - key: drawer-editor
    title: Edit areas and dependencies in the task drawer
    areas: [repo]
    depends_on: [task-patch-route]
  - key: propose-project-areas
    title: Propose a new project's areas from its repository
    areas: [repo]
---

Notes below the front matter are kept as the goal's description.
```

The first goal is **Real areas**, from the build order in the spec PR #131 (its first slice is PR #138),
converted into a brief by hand. Its tasks use the project's current areas (`repo` over `**` today) until the
areas work it builds lands. Extraction from a free-form document by an LLM is phase 4.

## 12. Phases

1. **Goals you can see** (filed now). The goal contracts and the brief schema; `goals` (owner, state `draft`),
   `goal_criteria` (unproven), `goal_views` and `tasks.goal_id`; Adopt a Plan, in the app and in the 10db-task
   skill; the digest API; goal-scoped
   candidates; the Board's goal card, markers, filter and scoped Start Ready Tasks; Factory per goal with the
   phase 1 digest, the Ungrouped row and the phase 1 status rule; the workstream table and batch history moved
   to detail; Cancel in the drawer and card menu.
2. **The engine.** States and transitions, Start Goal, the budget, criteria checks and ticking, the decisions
   schema change, the step-end path check, doors, Keep / Flip, the dependency count.
3. **People.** People and authority, Inbox ownership and escalation, the Slack app, the outbound policy,
   screenshots as evidence, the rules judge.
4. **Shaping and re-planning.** New Goal as a native conversation in 10db, its own terminal-like session (the
   builder's way of shaping work in Claude Code today, inside the app; the takeover and PTY work in
   `docs/open-items.md` is its base), taking chat, assets or a form; LLM extraction for Adopt; re-plan
   proposals on the exhausted-tasks and Flip paths; the digest in prose.

## 13. Measures

- **Manual continuation actions per goal** (the factory-loop spec's measure, lifted from workstream to goal):
  the owner starting, retrying or relaying anything the engine's rules cover. Answering a one-way decision and
  merging (until §14's merge question is decided) don't count. Target 0 from phase 2.
- **Door rules:** across at least 20 two-way decisions over the first goals, the owner's re-grade finds at most
  2 that should have been one-way. More means the classes or N tighten.
- **Unlogged decisions:** one-way paths touched in a goal's merged diffs with no recorded decision. Target 0.

Before the engine exists, Real areas runs by hand: the orchestrator session works from its brief and records
every decision; at the end the classes and N are applied by rule, the merged diffs are scanned for unlogged
one-way changes, and the builder re-grades the two-way calls.

## 14. Open

- **Merging goal tasks (the builder's call).** May the engine queue a merge for a goal task under a rule (gate
  and review passed, no open decision on it)? That would supersede "a merge stays the builder's call" and needs
  an answer for the code-owner review.
- **Where a goal's detail lives (settle live).** Phase 1 expands it in Factory (§8). Once Real areas has run, try
  it against a drawer or a goal page and keep what reads best.
- **The name Factory.** Factory.ai uses "Missions" and "Mission Control". Keep "Factory" for the tab?
- **The brief in the repository.** Import only, or also kept in the repository as a record?
- **Defaults to tune with data:** N = 3, the per-person message limit, first-message approval.
- **The spec's calls to confirm:** hand-starting a goal's task (§4), what done does to leftover tasks (§5),
  scheduling order (§6), the class paths and patterns (§7), N (§7), stakeholder authority and the outbound
  policy (§10).
