# Plan: the Factory measures each rigor

## Brief

**What changes for the builder.** The Factory gets a second panel beside "Human touch": **Rigor**. For a chosen
period (7, 14 or 30 days, 14 by default), one row per rigor (Light, Standard, Careful, Critical) and one for all of
them, it shows the tasks done, the average steps run, sessions and send-back rounds per task, the pull requests per
goal, and the share of tasks that shipped with findings filed as a follow-up. A line under the table gives how often
the builder overrode the judge's sizing in the same period. The Human touch table gains a **Plan** column (Critical
plan cards) and a **Move report** column, so its columns add up to its Cards total.

**What it buys.** A number for "is right-sizing working": if Light runs fewer steps and sessions than Standard, and
the override rate is low, rigor saves work and the judge sizes well.

**What could go wrong, and how we'd know.**

- *It counts the wrong thing.* The store function is table-tested on a real SQLite file with seeded tasks,
  workstreams, sessions and batches, one row per figure, so each definition below is pinned by a test.
- *A task's rigor changed after it ran.* The workstream doesn't store the rigor it planned with (`StepPlanDto.rigor`
  is computed, never written), so a task counts under its effective rigor today. A resize after the run moves it.
  Storing the planned rigor would need a migration that collides with 10db-ef's seven. Cost if wrong: one task in
  the wrong row; a later column fixes it.
- *A new Inbox kind lands uncounted again.* The human-touch counts are built from a `Record<InboxKind, …>`, so a
  kind added later (10db-ef's PR3a may add one) fails typecheck until it has a column.

**Calls the builder might disagree with.**

- The period control is a SegmentedControl of 7, 14 and 30 days on the Rigor panel only. The Factory has no period
  control today; Human touch stays at its 14 days.
- A task counts in the period when it **became done** in it: the first `task.changed` event that set its status to
  `done`, and its `updated_at` when no such event was logged.
- Pull requests per goal is per rigor: for each goal with a done task of that rigor in the period, the distinct
  pull requests (batches with a PR URL) that carried its tasks of that rigor; averaged over those goals. Tasks in no
  goal count in no "per goal" figure.
- The override rate is app-wide (judge calls are not per project), labelled so.

**Provider parity.** Every figure comes from 10db's own rows (tasks, workstreams and their steps, sessions,
batches, judge calls), so it is the same for a Claude plan, Bedrock or an API key, and a Codex plan. Nothing reads a
provider.

**Needed from the builder:** nothing.

---

## Definitions (the store function implements exactly these)

For project P and a window [from, to):

| Figure | Definition |
| --- | --- |
| tasks done | tasks of P with status `done` whose done time is in the window, grouped by `effectiveRigor` |
| steps per task | over those tasks, the steps of all their workstreams that started (`startedAt` set), counted once each, averaged |
| sessions per task | rows in `sessions` whose `workstream_id` is one of the task's workstreams, averaged |
| send-back rounds per task | Σ `sentBack` over all steps of the task's workstreams, averaged |
| pull requests per goal | see the brief; null when no done task of the rigor is in a goal |
| shipped with findings filed | share of the done tasks with any step carrying `shippedAtLimit` |
| judge overridden | `task_rigor` judge calls created in the window: overridden ÷ calls (from the judge call rows; null when none) |

Averages are null for a rigor with no done task. The "All" row is computed over every done task, not averaged from
the rows.

## Tasks

### Task 1: plan and move-report columns in Human touch (small; do first)

- `packages/contracts/src/human-touch.ts`: add `plan` and `moveReport` to `HumanTouchDayDto`; regenerate.
- `packages/db/src/store/human-touch.ts`: count every kind through one `Record<InboxKind, …>`-typed map (flags split
  by the failure prefix as now), so `cards` equals the sum of the columns by construction.
- `human-touch-panel.tsx`: columns `Plan` and `Move report` after `Check`.
- Tests: extend the existing `human-touch` store table with a plan card and a move report row and assert the
  columns sum to `cards`; extend the panel's render test (find it first) with the two headers.

### Task 2: the rigor figures, store to panel (one vertical slice)

1. **Contract** `packages/contracts/src/rigor-figures.ts`: `RigorFiguresPeriod` (`7 | 14 | 30`, as const),
   `RigorFiguresRowDto` (rigor or `'all'`, the figures above), `RigorFiguresDto` (`period`, `rows`,
   `judgeOverride: { calls, overridden } | null`). Export from the entry point; regenerate.
2. **Store** `packages/db/src/store/rigor-figures.ts`: `rigorFigures(db, projectId, now, days)`. Use `getTask`/
   `listTasks`'s `effectiveRigor` rather than recomputing it. Read the judge counts from the judge call rows the
   way `judge-call-stats.ts` does (decision `task_rigor`). Table-driven test in `rigor-figures.test.ts` on
   `createTestStore`: one row per definition, plus window edges (done just before `from` excluded, at `from`
   included), a task with two workstreams (a retry), a goal whose Light tasks share one PR and a Careful one has
   its own, a task never done, a cancelled task.
3. **Service and route**: `services.rigorFigures(projectId, days)` next to `humanTouch`;
   `GET /projects/:projectId/rigor-figures?days=14` with the query parsed by zod (default 14, refuse others
   with 400). Extend `app.test.ts`'s human-touch case pattern: 200 for a project, 404 for none, 400 for `days=9`.
4. **Desktop**: `daemon/rigor-figures-queries.ts` (`useRigorFigures(projectId, days)`, key
   `['rigor-figures', projectId, days]`, invalidated in `events.ts` on the events that invalidate human touch);
   `views/factory/rigor-panel.tsx` with title "Rigor", a SegmentedControl `7 days | 14 days | 30 days`, a table
   (`aria-label="Work per task by rigor"`), averages to one decimal, a dash for null, and the override line
   ("You changed the judge's sizing N of M times (all projects)", or nothing when there were no calls). Mount it in
   `factory-view.tsx` beside `HumanTouchPanel`. Add the MSW default handler in `src/test/daemon.tsx`. One render
   test: rows and the period switch refetching.
5. **Docs**: `apps/desktop/src/views/factory/AGENTS.md` and `packages/db/AGENTS.md` one line each.

### Task 3: the e2e

`apps/desktop/e2e/rigor-figures.spec.ts`, after the pattern of `process-per-rigor.spec.ts` (`TENDB_FAKE_SCRIPTS`):
make two tasks, one Light and one Standard, in the project the spec finds by name (never the first project), run
each to done through the fake agent, open the Factory, and see the Rigor table's Light and Standard rows with one
task done each and Standard's steps above Light's. Run it alone with `pnpm exec tsx e2e/prepare.ts` then
`pnpm exec playwright test -c e2e/playwright.config.ts e2e/rigor-figures.spec.ts` from `apps/desktop`.

## Review focus

The definitions against the code (does "started" mean what a step that ran means; does the done event exist as
assumed); the window edges; the `Record<InboxKind>` count; the query key invalidation.

## Round 1 amendments (they override the text above)

- **All six figures (A1, blocking).** Steps, sessions and pull requests, each per task **and** per goal. Per goal
  is over goals with at least one done task of that rigor in the period, counting that rigor's tasks of the goal
  (their steps, sessions, distinct PR URLs), averaged over those goals. Tasks in no goal count only per task.
- **Pull requests are distinct PR URLs** (A6), never batches: a CI-fix or re-cut batch reuses its PR.
- **Override rate (A2, A3).** Per project: `task_rigor` judge calls joined to the project's tasks through
  `judge_calls.task_id`, in the window. Denominator = answered calls (acted + overridden, as `judge-call-stats.ts`
  `ANSWERED` treats them); null and no line when zero. Label: "You changed the judge's sizing N of M times".
- **Send-backs (A4).** Count reviewer send-backs from the `step.changed` events whose `sentBackBy` is not
  `builder` (runner.ts ~1682), not `sentBack` (a retry resets it). Gate failures are not counted. Label
  "Sent back"; fix the contract comment.
- **Workbench pass tasks are left out** (A5): a task with a pass never ran a rigor's plan.
- **Done time** is the **last** `task.changed` to `done` (A7): a task reopened by a base-merge run and done again
  counts when it finished. A second workstream in the fixtures comes from that reopen, not a retry.
- **Invalidation** (A8): task and batch events (as events.ts already does in the slice), not inbox events.
