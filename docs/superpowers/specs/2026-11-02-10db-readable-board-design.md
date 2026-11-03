# 10db readable board: cards say what a task is worth, the drawer holds the rest

**Status:** designed on 2026-11-02 from a design conversation with the builder (Claude Code, with mockups); not
built. Calls the builder didn't make are marked **(spec's call)** and listed in §10.
**Amends:** `DESIGN.md` (Board cards, Card state, the batch strip) and the Factory sessions table from
`2026-10-29-10db-goals-design.md`.
**Leaves room for:** the context-aware task work (evals, schema changes, query counts, decisions and principles,
agent feedback), designed later. This design reserves the card's indicator row and the drawer's sections for it
and builds none of it.

## 1. Intent

The builder glazes over the Board. Each card's title is the task's precise promise, written for the agent and
the reviewer ("Stamping a write never blocks or stalls the daemon: no FIFO, symlink or huge file can hang
writeStamp"). Below it the card repeats things that are true of almost every card ("repo", "4 criteria", "Merges
into main when checks pass"). The builder can't tell at a glance what a task is for, so the board stops being
something he reads.

In his words, a card should show its value: **why** (optional), **what**, **status** ("could just be UI
decoration") and **annotation indicators** (eval, API performance, models). Everything else (the pull request,
CI checks, criteria, eval results, decisions and principles) is one click away in a side panel.

The same stuck task also showed in three places with three different faces: a red Blocked card, a strip above
the board with an Abandon button, and a Factory row under "Ungrouped" saying "FAI…" and "The review step ended
without calling complete_step" next to a bare Retry. The builder couldn't tell what had happened, what
"Ungrouped" meant or what Retry would do.

**Success means:**

1. A card's face is a plain-words title of a few words, an optional one-line why, the status as the card's edge
   color, and a row of small indicators. A line of text about the status appears only when the card needs the
   builder or has failed.
2. Clicking a card opens the existing task drawer, which leads with the plain title and why, then the precise
   promise, criteria, pull request and CI, the shared branch and its Abandon, then the edit form.
3. The batch strip above the Board's columns is gone. A task on a branch it shares with other tasks shows a
   shared-branch indicator, and Abandon is in the drawer and the card's menu, where it already is today.
4. A column's scrollbar never draws over its cards.
5. Factory says "Not in a goal" instead of "Ungrouped". A failed row says in plain words what happened and what
   Retry will do. Clicking a row opens the task's drawer on the Board, filtered to its goal. No state label is
   cut off.

## 2. Non-goals and anti-goals

- **Non-goals:**
  - Building any annotation kind (eval, query count, schema diff, decisions, feedback).
  - A board-wide Simple/Detailed switch. The builder chose the side panel over that switch and over a card
    that grows in place.
  - Changing pull request titles, commit subjects or branch names.
  - Backfilling the plain title on finished tasks.
- **Anti-goals:** these would be failures even if every test passed.
  - A card that hides a failure or a question waiting on the builder: getting quieter must not mean getting
    blind.
  - Two titles that drift into saying different things.
  - A redesign that adds a new detail surface instead of making the existing drawer the one place for detail.

## 3. Words

- **Title**: today's `tasks.title`, unchanged. It is the precise promise and stays the source of the batch, pull
  request and squash-commit title (`apps/daemon/src/delivery/start.ts`, `pr-text.ts`). The drawer calls it
  "What it promises".
- **Headline**: new. The plain-words what, a few words long ("Odd files can't freeze 10db"). The desktop names a
  task by its headline everywhere it names one: the card, the drawer, Factory's session rows, Factory's
  task lists and Inbox cards that name a task. It falls back to the title when the headline is empty. Git never
  sees it: pull requests, commits and branches keep the title. `WorkstreamDto` gets `taskHeadline` beside
  `taskTitle` so Factory rows can show it.
- **Why**: new and optional. One sentence on why the task matters ("A FIFO or huge file in a worktree could hang
  every lane").
- **Indicator**: a small labelled mark in a row on the card that says the task has a property worth knowing,
  such as a shared branch.

## 4. Data

- `tasks` gets two text columns, `headline` and `why`, both empty by default. Contracts:
  - `TaskDto` gets `headline: string` and `why: string`.
  - `TaskInput` and the task patch accept both as optional.
  - The headline is one line: no control characters, at most 80 characters **(spec's call)**.
  - The why is one sentence, at most 200 characters, also with no newlines **(spec's call)**.

  `v0.1.0` is tagged, so `packages/db/AGENTS.md` makes migrations forward-only. This is a new forward
  migration, never a regenerated baseline: regenerating would make the daemon refuse the builder's existing
  database.
- **Fallback:** a task with an empty headline shows its title on the card, exactly as today. A task with an
  empty why shows no why line. Nothing is backfilled automatically **(spec's call)**. After the build, the
  orchestrating session writes headlines for the open tasks by hand.
- **Who writes them:**
  - The New Task form gets a Headline field (optional, above Title) and a Why field (optional).
  - The drawer's form gets both fields too.
  - The builder MCP's `create_task` and `edit_task` accept both. Their drafting guidance
    (`packages/contracts/src/builder-mcp-tools.ts`) asks for a headline on every task and a why whenever the
    reason isn't obvious from the headline.
  - Goal briefs: each task in a brief (`GoalBriefTask` in `packages/contracts/src/goals.ts`, parsed in
    `apps/daemon/src/goals/brief.ts`) takes an optional headline and why, and adopting the goal stores them.
    The brief docs say so. Without this, every task a goal creates would show its long title.
  - The `10db-task` skill (`~/.claude/skills/10db-task`, outside the repo and due to be retired per
    `docs/builder-mcp.md`) is updated by hand by the orchestrating session. It is not part of the build.
- **Indicators** are derived in the desktop from data it already has. No new endpoint. The first kinds:
  - **shared branch**: the task's batch has more than one task, by `batchTaskCount` in `batch-strip.tsx`, which
    moves when the strip goes.
  - **CI**: passed or failed on a shipped pull request, from the same data as today's CI line.
  - **waits on**: the task has unfinished dependencies (today's "Waits on …" line becomes this indicator, with
    the titles in its tooltip).

  The row is one component that takes a list of indicators, so later kinds (eval, query count, schema,
  decisions, feedback) are added without reshaping the card.

## 5. The card

Top to bottom:

1. The goal label (unchanged: the goal's title, small and dimmed, when the task belongs to one).
2. The headline (or the title), weight 500, at most three lines.
3. The why, dimmed, `xs`, at most two lines.
4. The status line, only when the state's color is yellow (waiting on you), red (failed) or orange (paused).
   It is today's state line, except that a failure uses the plain-words line from §8.
5. The indicator row, only when there is at least one indicator.

**Status is decoration otherwise.** The border takes the state's color as today, including the 2 px yellow
border for a card waiting on the builder. Blue (running), green (done) and gray (queued) cards show no status
line **(spec's call)**: the column and the border already say it.

**What leaves the card face for the drawer:**
- the areas badge and the criteria count
- the landing line ("Merges into main when checks pass")
- the placement badge
- the pull request and CI links
- "Review sent back 1 of 3" and the shipped-at-limit line

The Cancelled badge stays, as an indicator.

The accessible summary (`cardSummary`) still speaks everything that left the face, so a screen reader loses
nothing.

The menu, drag behaviour and click-to-open stay as they are (`DESIGN.md`, Board cards).

## 6. The drawer

`apps/desktop/src/views/board/task-drawer.tsx` stays the one detail view for a task. Its order becomes:

1. **Headline**, with the why under it.
2. **Status**: the existing workstream line, notices, CI status line, closed-pull-request and at-limit alerts,
   unchanged.
3. **What it promises**: the title, then the acceptance criteria as a list.
4. **Pull request and CI** links.
5. **Shared branch**: the existing `BatchPanel`, which already holds Abandon. Its explanation of what Abandon
   does (from `abandon-note.ts`, today in the strip's tooltip) shows as text under the button.
6. Review rounds (unchanged).
7. The edit form: Headline, Why, Title, Areas, Description, Acceptance criteria, Flow, Risks, Landing,
   placement, then the task ID. The fields and their rules are unchanged apart from the two new ones.

Later work adds its sections between 5 and 6 (eval result, schema change, query counts, decisions and
principles, agent feedback). This design adds no empty sections for them.

## 7. Board fixes

- **Scrollbar:** a column's vertical scrollbar takes a gutter of its own beside the cards
  (`board-column.tsx`). Cards keep the same width whether or not the column scrolls. This is filed and running
  as its own task (`tsk_01a19d9f-870f`).
- **Batch strip:** `BatchStrip` and its place above the columns go (`board-view.tsx`, `batch-strip.tsx`).
  - `abandonNote` stays, used by the drawer.
  - The goal strip went later, with the goal drawer: a chosen goal shows one line beside the Goal select, and
    its detail is Factory's (`goal-line.tsx`).
  - `DESIGN.md` loses the batch strip and words the goal line in its place.

## 8. Factory

- **The name:** "Ungrouped" becomes "Not in a goal" everywhere it shows: the row, its region label, the order
  rule in `DESIGN.md` and the goals spec's wording.
- **A failed task explains itself, and says the same thing everywhere.** Instead of the raw failure reason
  alone, a failed task says in plain words what happened, then what Retry will do. For example: "The review
  session stopped without reporting a result. Retry runs the review again." The Board card's red status line,
  the drawer and Factory's row all show this one line, from one function in `task-state.ts`. The raw reason
  stays in a tooltip and in the drawer.
  - **The daemon records a typed failure kind.** Matching on free-text reasons would be fragile. A workstream
    records a failure kind next to `failureReason`, as batches already do with `batch.failure` and
    `FAILURE_LABELS`. That means a forward migration, a contract field, and every `fail()` call site in
    `apps/daemon/src/runner/runner.ts` passing a kind. Existing rows have no kind and get the generic line.
  - The implementer writes the wording for each kind. The kinds come from today's reasons: step ended without
    `complete_step`, gate failed, session failed, retry limit, and the reviewer rejecting at the limit. Any
    other kind gets a generic line. The builder reviews the wording in the pull request.
  - What Retry will do comes from what `retryWorkstream` (`team/steps.ts`) does for that kind. After a
    rejection at the limit, for example, it reruns an earlier step, not the failed one. The line never
    promises anything else.
- **One detail view, with its goal around it.** Clicking a Factory session row goes to the Board with that
  task's drawer open, and the Board filtered to the task's goal. That was the builder's call. The Board
  already opens a drawer from a `?task=` link (`use-linked-task.ts`) and has a goal filter (`filterGoalId` in
  `board-view.tsx`, local state today). The link gains `goal=<goalId>`, which sets that filter, and the builder
  can clear the filter as usual. A task not in a goal links with no goal, so the Board stays unfiltered. The
  row keeps Retry for speed.
- **Labels:** no state label is cut off. This is filed and running as its own task (`tsk_01a19d9f-879f`).

## 9. Build order

These are 10db tasks, chained in this order because they share files:

1. **Headline and why on tasks:** columns, contracts, the API, `WorkstreamDto.taskHeadline`, the New Task form,
   the drawer form, goal briefs, and the builder MCP tools and their guidance.
2. **Failures in plain words:** the typed failure kind (§8): migration, contracts, the runner's call sites, and
   the shared plain-words line in `task-state.ts`. It is independent of 1, but chained after it because both
   add a migration.
3. **The card face:** §5, including the indicator row and its first three kinds, plus `DESIGN.md`'s Board cards
   and Card state. Depends on 1 and 2.
4. **The drawer order and the strip's removal:** §6 and §7's batch strip, plus `DESIGN.md`. Depends on 3.
5. **Factory:** §8's name, the headline in rows, failed rows, and a row's link to the Board (the task's drawer,
   filtered to its goal), plus `DESIGN.md` and the goals spec. Depends on 4.

The two running fixes (scrollbar, labels) are independent of this chain.

## 10. Calls made without the builder

- The precise promise stays as `title` and keeps feeding pull request titles and commits. The headline names
  the task everywhere in the desktop and nowhere in git.
- A typed failure kind recorded by the daemon, rather than matching reason strings. The implementer writes the
  wording and the builder reviews it in the pull request.
- Goal briefs carry the headline and why.
- Lengths: headline at most 80 characters, why at most 200, both single-line.
- No automatic backfill. Open tasks get headlines by hand after the build. Finished tasks keep their titles.
- Blue, green and gray cards show no status line; the border and column carry it.
- The first indicators are shared branch, CI and waits on.
- The Cancelled badge becomes an indicator.
- The Abandon explanation shows as text in the drawer rather than a tooltip.
- "Not in a goal" as the new name for Ungrouped.
