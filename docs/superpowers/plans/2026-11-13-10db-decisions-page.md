# The Decisions page (PR 2) Implementation Plan

## Brief

**What changes for the builder:** Settings › Decisions becomes one table of every decision 10db makes, grouped
(Delivery, Plan, Stakeholder questions; Sizing appears once it has rows), each row with its status (Acting, Shadow,
Off), model, "Sure enough" and its last 30 days. A row opens a drawer: what the decision asks, what 10db does with
each answer and when the model is unsure, its switch, its model picker, a "Sure enough" slider with "At 80%, 10db
would have acted on 62 of your last 120 answers", its numbers and its own recent calls. "Runs on" is renamed
**Paid by** and sits beside the master switch at the top. Recent decisions becomes a fixed-height table the daemon
pages, filtered by decision and outcome from its headers. Sizing and Questions leave Settings for Plan's view, beside
the recent conversations.

**What it buys:** each setting sits with the decision it belongs to, every decision is on one page, and the
threshold is set against the builder's own answers instead of a bare 0.8.

**What could go wrong, and how we'd know:**

- A decision's settings read as if they applied to every decision again: Task 4's drawer test patches one decision
  and checks the request names that decision alone.
- Recent decisions asks the daemon for a page it doesn't serve, or keeps a stale filter: Task 2's tests check the
  query each filter and page sends; the e2e (Task 6) pages and filters seeded calls through the real daemon.
- Plan's measures disappear from both places: Task 5 moves their tests with them, and Settings' test checks they
  are gone.
- The playbook session's `task_rigor` and `task_kinds` need new layout: no, they are two rows in
  `decision-catalogue.ts`'s table, which the type keyed by `JudgeDecision` forces them to add.

**Calls you might disagree with:** Plan's measures sit beside the recent conversations on a new Plan (`/shape`),
not inside an open conversation, and say they count every project; the grouped table draws its group labels as
rows of the same table (`rowFactory`), not as separate tables; a decision's drawer keeps its state in the page,
not the address; Shape's three decisions read Shadow, since no switch to show them is built; the slider saves once,
0.6 s after the builder stops moving it; with no OpenRouter key every status says "· no key".

**Needed from you:** nothing.

---

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Settings › Decisions shows every decision as one grouped table with a drawer per decision and a paged
Recent decisions table, and Plan's measures move to Plan's view.

**Architecture:** a pure catalogue (`decision-catalogue.ts`) keyed by `JudgeDecision` holds each decision's group,
words and mode; pure number helpers (`decision-numbers.ts`) turn PR 1's `GET /judge/decisions` stats into the row's
text and the threshold preview. The page reads `/judge`, `/judge/decisions`, `/judge/calls/page`, `/judge/models` and
`/shape-measures` through `daemon/judge-queries.ts`. No daemon, contract or migration change.

**Tech Stack:** React 19, Mantine 9.8, mantine-datatable 9.4, TanStack Query, Testing Library + MSW, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-13-10db-models-and-decisions-design.md` (§6, §8, §9 PR 2, §10, §12).

## Global Constraints

- Branch `feat/decisions-page` in `../10db-worktrees/decisions-page`. Root, `apps/desktop`,
  `apps/desktop/src/views/settings` and `apps/desktop/src/views/shape` `AGENTS.md` bind; so do
  `.claude/rules/code-style.md` and `.claude/rules/testing.md`.
- **Never edit** (another session owns them until its PR merges): `models-section.tsx`, `sections.ts`,
  `section-body.tsx`, `models-table.tsx`, `model-drawer.tsx`, `rightsizing-chart.tsx`, `role-picks-panel.tsx`,
  `playbook-*`, `kinds-*`, `apps/daemon/src/routing/**`, `packages/contracts/src/rigor.ts`, `ModelSetting`.
- Desktop only, plus one seed script in `apps/daemon/scripts/` for the e2e. No contract, route or migration change.
- Words (spec §6, §12): **Paid by** (not Runs on); **Sure enough** (not Confidence needed); statuses **Acting**,
  **Shadow**, **Off**, and **Off (all decisions)** for every row while the master switch is off or the daemon runs
  with `TENDB_JUDGE=off`.
- Tables use `mantine-datatable` (the Models page's props: `withTableBorder`, `borderRadius="md"`,
  `verticalSpacing="sm"`, `horizontalSpacing="md"`, `highlightOnHover`) and `withColumnHeader` for a header that
  filters.
- Recent decisions: `maxHeight={420}` (mantine-datatable's header is sticky already; there is no `stickyHeader`
  prop), newest first, paged by the daemon (`/judge/calls/page`, `limit` and `offset`), filtered by `decision` and
  `outcome`. A `Select` inside a header filter's popover takes `comboboxProps={{ withinPortal: false }}`
  (`views/settings/AGENTS.md`; `views/knowledge/knowledge-filters.tsx` does it), or picking an option closes the
  popover. This table doesn't sort: give `withColumnHeader` a fixed sort status and a no-op `onSort`.
- Sure enough: a slider from 50% to 99%.
- Provider parity (spec §8, root `AGENTS.md`). Decisions always run on an OpenRouter account, whatever the agent
  accounts are, so the page behaves the same for a builder with a Claude plan, Claude through Bedrock or an API key,
  or a ChatGPT/Codex plan:
  - no OpenRouter account: Paid by says "No account can run decisions yet." with Add OpenRouter Account (today's);
    every row's status is followed by a dimmed "· no key" and the table still lists every decision with its saved
    model id; every call falls back to today's rule, which Recent decisions shows as "No key; …";
  - an OpenRouter account whose key is missing or changed: the same "· no key" mark and Paid by's key state;
  - Plan's measures and Recent decisions read only the daemon's own log and don't depend on any provider.
- Tests use invented numbers only; no AA or OpenRouter numbers in fixtures.
- No test passes its own `timeout` to a query or `findBy*`. Run named test files with `--maxWorkers=2`, never
  `vitest related` on a hub file.

## Review Focus

1. Filters that match nothing: Recent decisions keeps its header (the filters stay in reach) and says so in its
   body. Task 2.
2. A filter change while on page 3 goes back to page 1 (`usePaging(listed, …)`). Task 2.
3. `TENDB_JUDGE=off`: every row reads Off (all decisions), the drawer's controls are disabled, and the stats and
   calls still show. Task 3 and Task 4.
4. A floor saved outside 50–99% (the contract allows 0 to 1): the slider shows the nearest end, the line under it
   says the saved value, and nothing is saved until the builder moves it (a click on the thumb that doesn't move
   it saves nothing). Task 4.
5. `GET /judge/decisions` fails: the table still lists every decision with a dash in Last 30 days. A decision with
   no calls in 30 days, which the daemon leaves out of the list, reads "No calls", never the dash. Task 1 and
   Task 3.
6. Holding an arrow key on the slider saves once, after the builder stops, and the slider never jumps back under
   the keyboard. Task 4.

---

## File map

| File | Job |
| --- | --- |
| `views/settings/decision-catalogue.ts` (new) | every decision's group, label, words and mode; `groupedDecisions` |
| `views/settings/decision-numbers.ts` (new) | status, Last 30 days text, threshold preview, outcome text, `formatDecisionUsd` |
| `views/settings/recent-decisions.tsx` (new) | the daemon-paged, filtered calls table |
| `views/settings/decisions-table.tsx` (new) | the grouped table of decisions |
| `views/settings/paid-by.tsx` (new) | today's `RunsOn`, renamed, with its key state |
| `views/settings/decision-drawer.tsx` (new) | one decision's drawer |
| `views/settings/sure-enough.tsx` (new) | the slider and its preview line |
| `views/settings/decisions-section.tsx` | the page: header (master switch, Paid by), table, drawer, Recent decisions |
| `views/settings/decision-model-picker.tsx` | uses `formatDecisionUsd`; "choose an account under Paid by" |
| `daemon/judge-queries.ts` | `useDecisionStats`, `useJudgeCallsPage`; `useJudgeCalls` goes |
| `test/judge-fixtures.ts` | fixtures for stats and pages |
| `views/shape/plan-measures.tsx` (new) | Sizing and Questions, moved |
| `views/shape/conversation-pane.tsx` | mounts `PlanMeasures` beside `RecentConversations` |
| `apps/daemon/scripts/seed-judge-calls.ts` (new) | writes judge calls for the e2e |
| `e2e/settings.spec.ts` | the Decisions page through the real daemon |

All desktop paths are under `apps/desktop/src/` except `e2e/`.

---

### Task 1: The decision catalogue and its numbers (pure)

**Files:**
- Create: `apps/desktop/src/views/settings/decision-catalogue.ts`, `decision-catalogue.test.ts`
- Create: `apps/desktop/src/views/settings/decision-numbers.ts`, `decision-numbers.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const DecisionGroup = { Delivery: 'delivery', Sizing: 'sizing', Plan: 'plan', Stakeholders: 'stakeholders' } as const;
  export type DecisionGroup = (typeof DecisionGroup)[keyof typeof DecisionGroup];
  export const DECISION_GROUP_ORDER: readonly DecisionGroup[]; // Delivery, Sizing, Plan, Stakeholders
  export const DECISION_GROUP_LABEL: Readonly<Record<DecisionGroup, string>>; // 'Delivery', 'Sizing', 'Plan', 'Stakeholder questions'
  export const DecisionMode = { Acting: 'acting', Shadow: 'shadow' } as const; // + type
  export interface DecisionEntry {
    readonly group: DecisionGroup;
    readonly label: string;      // the row's name
    readonly asks: string;       // what it asks, in plain words
    readonly onAnswer: string;   // what 10db does on each answer at or above Sure enough
    readonly whenUnsure: string; // what 10db does below it, or when the call can't run (today's rule)
    readonly fellBack: string;   // short clause for Recent decisions: 'the review ran'
    readonly mode: DecisionMode;
  }
  export const DECISIONS: Readonly<Record<JudgeDecision, DecisionEntry>>;
  export function groupedDecisions(configured: readonly JudgeDecision[]):
    readonly { readonly group: DecisionGroup; readonly decisions: readonly JudgeDecision[] }[];
  ```
  ```ts
  export const DecisionStatus = { Acting: 'Acting', Shadow: 'Shadow', Off: 'Off', AllOff: 'Off (all decisions)' } as const; // + type
  export function decisionStatus(mode: DecisionMode, decisionOn: boolean, allOn: boolean): DecisionStatus;
  /** The decision's stats: its entry, a zero entry when the list loaded without it (no calls), undefined while unread. */
  export function statsFor(list: DecisionStatsListDto | undefined, decision: JudgeDecision): DecisionStatsDto | undefined;
  export function lastThirtyDays(stats: DecisionStatsDto | undefined, mode: DecisionMode, agreement: ShadowAgreementDto | undefined): string;
  export interface ThresholdPreview { readonly acted: number; readonly total: number; readonly otherModels: readonly string[] }
  export function thresholdPreview(answers: DecisionStatsDto['answers'], floor: number, model: string): ThresholdPreview;
  export function previewText(percent: number, preview: ThresholdPreview): string;
  export function outcomeText(call: Pick<JudgeCallDto, 'decision' | 'outcome' | 'answer'>): string;
  export function answerText(call: Pick<JudgeCallDto, 'answer' | 'confidence'>): string;
  export function formatDecisionUsd(usd: number): string; // named apart from accounts/usage-text.ts's formatUsd
  export function modelName(id: string, models: readonly DecisionModelDto[] | undefined): string;
  ```

`DECISIONS` holds (`label` is today's label where one exists; the rest is the copy, exact):

| Decision | Group | Label | Mode | fellBack |
| --- | --- | --- | --- | --- |
| `review_size` | Delivery | Skip review for small changes (the spec's shorter label) | Acting | the review ran |
| `shape_ready` | Plan | Enough to propose | Shadow | nothing shown |
| `shape_record` | Plan | Record as a decision? | Shadow | nothing shown |
| `shape_elsewhere` | Plan | Question for someone else? | Shadow | nothing shown |
| `question_route` | Stakeholders | Who a question goes to | Acting | you answer it |
| `thread_answer` | Stakeholders | Which option a conversation chose | Acting | 10db asked which way |
| `reply_match` | Stakeholders | Which question a reply answers | Acting | 10db asked which one |
| `approval_read` | Stakeholders | Whether a reply approves | Acting | read with the word list |

`asks` / `onAnswer` / `whenUnsure`:

- `review_size`: "After a step's checks pass: is this change small and well tested enough to skip the independent
  review?" / "Skip: the review is skipped. Review: it runs." / "The review runs."
- `shape_ready`: "After each message, until the first Propose: have you said enough to propose?" / "Logged and
  scored against what you did next; nothing is shown yet." / "Nothing is logged as an answer."
- `shape_record`: "Does this message state a decision or principle worth recording?" / same onAnswer / same.
- `shape_elsewhere`: "Is this a question only someone else can answer?" / same onAnswer / same.
- `question_route`: "Which of the project's routes a question an agent asked belongs to, or nobody." / "A route:
  the card goes to its people. Nobody: it stays with you." / "It stays with you, with the top route's people
  suggested under Ask Someone."
- `thread_answer`: "Once a Slack conversation settles: which option did it land on?" / "10db posts \"Sounds like
  B\" in the thread for the asker to approve." / "10db asks the asker which way it should go."
- `reply_match`: "A reply typed outside a thread, with several questions open: which one does it answer?" / "The
  reply joins that question's conversation." / "10db asks \"Which one is this for?\" with a numbered list."
- `approval_read`: "Does this reply approve the proposed answer?" / "Approves: the card is answered as the asker."
  / "A short list of words (yes, ok, sounds good…) is read instead."

Shape decisions add, in the drawer, the note today's page carries: "Plan asks these only for a project with “Send
brainstorm messages to fast models” on in its settings, and only logs the answers until each has 20 scored answers
with 75% agreeing." Put it on the entry as `readonly note?: string`.

- [ ] **Step 1: Write the failing tests**

`decision-catalogue.test.ts`:
- `it.each(Object.values(JudgeDecision))('%s has a group, a label and its words')`: every field non-empty.
- `groupedDecisions(Object.values(JudgeDecision))` equals Delivery `[review_size]`, Plan
  `[shape_ready, shape_record, shape_elsewhere]`, Stakeholders `[question_route, thread_answer, reply_match,
  approval_read]`, in that order, and has no Sizing group (it has no rows).
- `groupedDecisions` without `review_size` has no Delivery group (the retired case, spec §6.1).

`decision-numbers.test.ts` (tables, one named row each):
- `decisionStatus`: all off → `Off (all decisions)` for both modes and a decision that is off; all on, decision
  off → `Off`; Acting; Shadow.
- `statsFor`: list undefined → undefined; list without the decision → a zero entry for it; list with it → its
  entry.
- `lastThirtyDays`: `undefined` stats → `—`; 0 calls → `No calls`; Shadow with 0 calls and no agreement →
  `No calls · 0 of 20 scored`; Acting with `{ calls: 120, acted: 62,
  costUsd: 0.0123 }` → `120 calls · 62 acted · $0.0123`; one call → `1 call · …`; Shadow with 14 calls and
  agreement `{ scored: 3 }` → `14 calls · 3 of 20 scored`; Shadow with `{ scored: 24, agreed: 18 }` →
  `24 calls · 18 of 24 agreed`. (20 is `SHADOW_MIN_SCORED`.)
- `thresholdPreview`: answers `[0.5, 0.8, 0.95]` all on `m`, floor 0.8, model `m` → `{ acted: 2, total: 3,
  otherModels: [] }` (equal to the floor acts); an answer on `old` → `otherModels: ['old']`, each named once.
- `previewText(80, { acted: 62, total: 120, otherModels: [] })` →
  `At 80%, 10db would have acted on 62 of your last 120 answers.`; `total: 0` →
  `No answers in the last 30 days to try it against.`; one other model appends
  ` Some were answered by old, not the model picked now.`
- `outcomeText`: `review_size` acted `skip` → `Skipped the review`; acted `review` → `Ran the review`;
  `question_route` acted → `Followed the answer`; `question_route` `fallback_timeout` → `Timed out; you answer
  it`; `below_floor` on `reply_match` → `Not sure enough; 10db asked which one`; `fallback_no_key` →
  `No key; …`; `fallback_off` → `Decisions were off; …`; `fallback_error` → `The call failed; …`; `stopped` →
  `Stopped before it answered`; `shadow` → `Logged in shadow; nothing shown`.
- `answerText`: `{ answer: 'skip', confidence: 0.92 }` → `skip (92%)`; null confidence → `skip`; null answer →
  `no answer`.
- `formatDecisionUsd`: `0.0123` → `$0.0123`, `0` → `$0`, `1.23456` → `$1.23` (three significant figures, as the picker).
- `modelName('typesafe/jev-1.13', [{ id: 'typesafe/jev-1.13', name: 'Jev 1.13', … }])` → `Jev 1.13`; without the
  list → `jev-1.13`.

- [ ] **Step 2: Run them and see them fail** —
  `pnpm --filter @10db/desktop exec vitest run src/views/settings/decision-catalogue.test.ts src/views/settings/decision-numbers.test.ts --maxWorkers=2`.
  Expected: FAIL, modules not found.
- [ ] **Step 3: Implement both modules.** `groupedDecisions` walks `DECISION_GROUP_ORDER` and keeps a group only when
  one of `configured` is in it, in `DECISIONS`' key order. `outcomeText`'s fallback prefixes are today's
  (`OUTCOME_TEXT` in `decisions-section.tsx`) with "the review ran" replaced by the decision's `fellBack`.
- [ ] **Step 4: Run them and see them pass**; then `pnpm --filter @10db/desktop exec tsc --noEmit` and
  `pnpm exec eslint` on the four files.
- [ ] **Step 5: Commit** — `feat(desktop): every decision has a group, words and a status in one table keyed by
  decision` with the value card:
  `Value: protects=each decision's group, words, status and 30-day text; fails_when=a decision has no row or group, a
  decision with no calls reads as a failed read, or the threshold count is off by the boundary; why_new=no test
  covered a catalogue or these numbers, decisions-section.test.tsx renders labels only; no_claim=that the page draws
  them.`

### Task 2: Queries and the Recent decisions table

**Files:**
- Modify: `apps/desktop/src/daemon/judge-queries.ts`, `apps/desktop/src/test/judge-fixtures.ts`,
  `apps/desktop/src/views/settings/decisions-section.tsx` (today's `RecentDecisions` list and `RecentCall` give way
  to the new table, so nothing this task exports is unused: knip runs on push), `decisions-section.test.tsx` (the old
  recent-calls cases go)
- Create: `apps/desktop/src/views/settings/recent-decisions.tsx`, `recent-decisions.test.tsx`

**Interfaces:**
- Consumes: Task 1's `DECISIONS`, `outcomeText`, `answerText`, `modelName`.
- Produces:
  ```ts
  judgeKeys.callsPage = (query: JudgeCallsPageQuery) => ['judge', 'calls', query]; // under judgeKeys.calls
  export function useJudgeCallsPage(query: JudgeCallsPageQuery): UseQueryResult<JudgeCallsPageDto>;
  export function RecentDecisions(props: { readonly decision?: JudgeDecision; readonly models?: readonly DecisionModelDto[] }): JSX.Element;
  // test/judge-fixtures.ts: judgeCallDto exists already
  // serveJudge(...) gains GET /judge/decisions and GET /judge/calls/page, recording each page query
  ```

`useJudgeCallsPage` polls every 30 s and refetches on focus, as `useJudgeCalls` does today, and keeps the previous
page up while the next loads (`placeholderData: keepPreviousData`). The section mounts `RecentDecisions` in place of
its old list in this task, so `useJudgeCalls`, `JudgeCallList` and `RECENT_CALLS` go now (knip fails an unused
export); `useTestAccount` keeps invalidating `judgeKeys.calls`, which covers every page. The daemon's
`GET /judge/calls` stays. `serveJudge`'s recorded requests gain a `query` (the request's search params as an object)
so tests can assert what a page asked for, and it serves `GET /judge/calls/page` (from a `calls` option, filtered and
sliced as the daemon does, newest first).

`RecentDecisions`: a `DataTable` with `aria-label="Recent decisions"` (or `Recent decisions: <label>` with a
`decision`), `maxHeight={420}`, columns When (`absoluteTime` on hover, `fromNow` shown, from `shell/relative`),
Decision (hidden when `decision` is given; filters from its header with a `Select` of the decisions' labels,
`Any decision` first), Model (`modelName`), Answer (sure) (`answerText`), What 10db did (`outcomeText`; filters
from its header with a `Select` of outcomes: Acted, Not sure enough, Shadow, Fell back: off, no key, timed out,
failed, Stopped), Task (a "Open on the board" link to `/board?task=` when `taskId` is set). Pages 25, 50, 100
(`TABLE_PAGE_SIZES`, `usePaging(<decision>|<outcome>, 25)`, `pagerProps`); offset `(page - 1) * pageSize`. Empty:
"No decisions yet." with no filter, "No decision matches these filters." with one; the header stays drawn.

- [ ] **Step 1: Write the failing tests** (`recent-decisions.test.tsx`, `renderWithDaemon` + `serveJudge`; the
  section's old recent-calls cases in `decisions-section.test.tsx` go with the old list):
  - `lists a page newest first and asks the daemon for limit 25, offset 0`: three calls, rows in order, the
    recorded query is `{ limit: '25', offset: '0' }`.
  - `pages through the daemon`: total 60; Next page sends `offset: '25'`.
  - `filters by decision and outcome from the headers, back on page 1`: on page 2, pick Who a question goes to
    → query has `decision: 'question_route', offset: '0'`; pick Not sure enough → `outcome: 'below_floor'`.
  - `keeps its header when nothing matches`: an empty page with a filter shows "No decision matches these
    filters." and the Decision filter button is still there.
  - `a decision's own table hides the Decision column and asks for that decision`.
  - `a call on a task links to it on the board`.
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement** the queries, fixtures and table.
- [ ] **Step 4: Run** `recent-decisions.test.tsx` and `decisions-section.test.tsx` and see them pass; typecheck;
  lint; `pnpm exec knip` from the root (or the repo's knip script) shows nothing new.
- [ ] **Step 5: Commit** — `feat(desktop): recent decisions is a fixed-height table the daemon pages, filtered by
  decision and outcome` with the value card:
  `Value: protects=the calls table asks the daemon for the page and filters shown; fails_when=a filter or page is not
  sent, a filter change keeps a later page, or an empty filter hides the header; why_new=the old list's cases fetched
  20 calls with no paging or filter, so they can't catch these, and they go with that list; no_claim=that
  the daemon pages correctly (PR 1's tests) or that the height looks right (Task 6).`

### Task 3: The page: header, Paid by and the grouped table

**Files:**
- Create: `apps/desktop/src/views/settings/paid-by.tsx`, `decisions-table.tsx`
- Modify: `apps/desktop/src/views/settings/decisions-section.tsx` (rewritten),
  `decision-model-picker.tsx` (copy: "choose an account under Paid by"; `formatDecisionUsd` from Task 1 replaces its
  `dollars`), `shape-jev-setting.tsx` and `shape-jev-setting.test.tsx` (its link's focus, `?focus=paid-by`),
  `daemon/judge-queries.ts` (`judgeKeys.decisions = ['judge', 'decisions']` and
  `useDecisionStats(): UseQueryResult<DecisionStatsListDto>`, polling every 30 s and refetching on focus),
  `test/judge-fixtures.ts` (`decisionStatsDto(decision, overrides?)`, and `serveJudge` serves `GET /judge/decisions`
  from a `stats` option, by default a list with every decision absent), `decisions-section.test.tsx`
- Create: `apps/desktop/src/views/settings/decision-drawer.tsx` as a `Drawer` titled with the decision's label and an
  empty body; Task 4 fills it

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces:
  ```ts
  export function PaidBy(props: { readonly status: JudgeStatusDto; readonly disabled: boolean }): JSX.Element; // focus target 'paid-by'
  export function DecisionsTable(props: {
    readonly status: JudgeStatusDto;
    readonly stats: DecisionStatsListDto | undefined;
    readonly shadow: readonly ShadowAgreementDto[] | undefined;
    readonly models: readonly DecisionModelDto[] | undefined;
    readonly onOpen: (decision: JudgeDecision) => void;
  }): JSX.Element;
  ```
  The section reads `useDecisionModels(keyed)` with the picker's rule (`keyed = !status.off &&
  status.account?.secretSet === true`; `/judge/models` answers 409 with the judge off) and passes the list to the
  table, the drawer and Recent decisions, so every place names a model the same way.

The page, top to bottom: the intro line (today's text); a header `Group justify="space-between"` holding, on the
right, the master switch (`aria-label="Fast-model decisions"`, label "Fast-model decisions") and under it Paid by;
the off alert and the patch error (today's); the decisions table; today's Sizing and Questions card (the
`ShapeMeasures` block without its three Shape decision rows, which the table now holds, and without its note, which
moves to the Plan decisions' drawer); Recent decisions (Task 2) in place of today's list. Task 5 moves Sizing and
Questions to Plan's view. `PaidBy` is today's
`RunsOn` with the label **Paid by**, the same select, key state, Add OpenRouter Account and modal; its focus
target is `paid-by`, and `shape-jev-setting.tsx`'s link to `focus: 'runs-on'` moves to it (the picker's hint names
Paid by too).

`DecisionsTable`: one `DataTable` (`aria-label="Decisions"`) whose records are the groups' labels and their
decisions from `groupedDecisions(Object.values(JudgeDecision).filter((d) => d in status.config.decisions))`; a group
record draws one full-width header cell (`rowFactory`: a `Table.Tr` holding a `Table.Th scope="rowgroup" colSpan`
in `xs`, weight 600, dimmed, uppercase; a decision record's row spreads `rowProps` so its click stays), takes no
click, and overrides the hover background (`highlightOnHover` styles every body row). Columns: Decision (the label as an `UnstyledButton`, so Enter opens it, as `models-table.tsx` does; a
decision row's click opens it too), Status (`decisionStatus`, a light `Badge`: Acting teal, Shadow gray, Off and Off
(all decisions) gray outline), Model (`modelName`), Sure enough (`Math.round(floor * 100)%`), Last 30 days
(`lastThirtyDays(statsFor(stats, d), …)`). Master off and `status.off` both count as all off. With no usable key
(`status.account` null, or its `secretState` not `set`) each status is followed by a dimmed "· no key".

- [ ] **Step 1: Rewrite `decisions-section.test.tsx` to fail**, keeping today's still-true cases (judge off alert,
  disabled controls, account select, Add OpenRouter Account, key states, patch error, and the Sizing and Questions
  cases, which Task 5 moves) under the new names:
  - `groups every decision, with no Sizing group until it has rows`: rowgroup headers (`getAllByRole('rowheader')`
    or `columnheader` with `scope`; check what jsdom maps `scope="rowgroup"` to) Delivery, Plan, Stakeholder
    questions in order; no "Sizing".
  - `a decision with no calls in 30 days reads No calls`: stats list loaded without `thread_answer`.
  - `with no key every status says so`: `account: null` → "Acting · no key".
  - `each row shows its status, model, sure enough and last 30 days`: Skip review for small changes → Acting,
    `jev-1.13`, `80%`, `120 calls · 62 acted · $0.0123` from `decisionStatsDto`.
  - `every status reads Off (all decisions) while the master switch is off`, and the same with `off: true`.
  - `a stats failure still lists every decision, with a dash`.
  - `Paid by sits beside the master switch`: a combobox named Paid by; "Runs on" is nowhere.
  - `a row, or Enter on its name, opens that decision`: the dialog named Who a question goes to appears (the
    stub drawer).
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement** `paid-by.tsx`, `decisions-table.tsx` and the section.
- [ ] **Step 4: Run** `decisions-section.test.tsx`, `recent-decisions.test.tsx`, `shape-jev-setting.test.tsx`
  and the Task 1 tests with `--maxWorkers=2`; typecheck; lint; knip shows nothing new.
- [ ] **Step 5: Commit** — `feat(desktop): settings › decisions is one grouped table, and runs on is paid by`
  with the value card:
  `Value: protects=every decision listed under its group with status, model, sure enough and 30 days, and Paid by;
  fails_when=a group shows empty, a status ignores the master switch or the kill switch, a decision with no calls
  reads as a failure, or a row doesn't open; why_new=decisions-section.test.tsx tested a flat list of switches, which
  this replaces (still-true cases kept); no_claim=the drawer's contents (Task 4).`

### Task 4: A decision's drawer and Sure enough

**Files:**
- Create: `apps/desktop/src/views/settings/decision-drawer.tsx`, `sure-enough.tsx`, `decision-drawer.test.tsx`
- Modify: `apps/desktop/src/views/settings/decisions-section.tsx` (mount the drawer)

**Interfaces:**
- Consumes: Tasks 1–3; `DecisionModelPicker` as built.
- Produces:
  ```ts
  export function DecisionDrawer(props: {
    readonly decision: JudgeDecision | null; // null: closed
    readonly status: JudgeStatusDto;
    readonly stats: DecisionStatsDto | undefined;
    readonly shadow: ShadowAgreementDto | undefined;
    readonly models: readonly DecisionModelDto[] | undefined;
    readonly onClose: () => void;
  }): JSX.Element;
  export function SureEnough(props: {
    readonly decision: JudgeDecision;
    readonly floor: number;
    readonly answers: DecisionStatsDto['answers'];
    readonly model: string;
    readonly disabled: boolean;
  }): JSX.Element;
  ```

The drawer follows `model-drawer.tsx`: `Drawer position="right" size="lg"`, title the decision's label,
`closeButtonProps={{ 'aria-label': 'Close' }}`, its body keyed by decision. Top to bottom: `asks`; "On each
answer" `onAnswer`; "When it isn't sure" `whenUnsure`; the entry's `note` (a Shape decision's, with its shadow
agreement as today's row words it, "In shadow: 3 of 20 scored answers agreed (15%)", and the "Ready to show" badge when
`canShow`); its switch (`aria-label` the label;
patch `{ decisions: { [decision]: { enabled } } }`); Model (`DecisionModelPicker`); Sure enough; "Last 30 days":
calls, acted, not sure enough, shadow, fell back (off, no key, timed out, failed, each shown only when non-zero),
cost (`formatDecisionUsd`), median time (`medianLatencyMs` as seconds, one decimal, or a dash), or "No calls in
the last 30 days" for a zero entry; then `<RecentDecisions decision={decision} models={models} />`.

`SureEnough`: a Mantine `Slider` (`thumbLabel="Sure enough"`, which names the `role="slider"` thumb; `aria-label`
lands on the root div and leaves the thumb unnamed), `min={50}`, `max={99}`, `step={1}`, label `${v}%`, keyed by
decision only. It holds a local edit (`number | null`; null follows the saved floor, so a saved change from elsewhere
shows when nothing is being edited). Mantine calls `onChangeEnd` on every arrow keydown as well as on pointer
release, so the save is debounced: `onChange` sets the edit, and a `useDebouncedCallback` from `@mantine/hooks`
(`{ delay: 600, flushOnUnmount: true }`, and `flush` on the slider's blur, so closing the drawer or opening another
decision straight after a move still saves it) sends one
`{ decisions: { [decision]: { floor: v / 100 } } }` when the edit differs from the value drawn before the edit began
(so a click on the thumb that doesn't move it saves nothing), then clears the edit once the PATCH settles, only when
the edit still equals the value it sent (a newer edit stays drawn). Under it
`previewText(v, thresholdPreview(answers, v / 100, model))`. A saved floor outside 50–99 draws the slider at the
nearest end and adds "Saved at 30%." until moved. Disabled with the page's `disabled`.

- [ ] **Step 1: Write the failing tests** (`decision-drawer.test.tsx`):
  - `the drawer says what the decision asks and what 10db does`, for `question_route`.
  - `its switch patches that decision alone`: the recorded PATCH body is
    `{ decisions: { question_route: { enabled: false } } }`.
  - `sure enough previews against the builder's answers`: answers `[0.6, 0.85, 0.9, 0.95]` on the saved model,
    floor 0.8 → "At 80%, 10db would have acted on 3 of your last 4 answers."; ArrowRight × 10 on
    `getByRole('slider', { name: 'Sure enough' })` (90%) → "… on 2 of your last 4 …" at once; then exactly one PATCH,
    with `floor: 0.9` (wait for it with `waitFor`, then assert the recorded count is 1; no sleeps).
  - `a click on the thumb that doesn't move it saves nothing`: a pointer down and up on the thumb, then blur; no
    PATCH.
  - `closing the drawer right after a move still saves it`: ArrowRight once, then Escape; exactly one PATCH.
  - `the preview says when another model answered`.
  - `a saved floor below 50% shows at 50% and says what is saved, and saves nothing until moved`.
  - `with the judge off its controls are disabled and its numbers still show`.
  - `its recent calls are that decision's`: the recorded page query has `decision: 'question_route'`.
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement.** Check `thumbLabel` and `onChangeEnd` in the MCP docs (`mcp__mantine__get_item_props`
  for Slider) against Mantine 9.8.
- [ ] **Step 4: Run** the drawer, section and recent-decisions tests; typecheck; lint.
- [ ] **Step 5: Commit** — `feat(desktop): each decision opens a drawer, and sure enough previews against your
  answers` with the value card:
  `Value: protects=one decision's switch, floor and preview change that decision alone, with one save per
  adjustment; fails_when=a patch names another decision, the preview miscounts, the slider saves per keypress or on a
  click that didn't move it; why_new=nothing tested a per-decision floor or a preview; no_claim=that the daemon applies
  the floor (judge tests).`

### Task 5: Plan's measures move to Plan's view

**Files:**
- Create: `apps/desktop/src/views/shape/plan-measures.tsx`, `plan-measures.test.tsx`
- Modify: `apps/desktop/src/views/shape/conversation-pane.tsx:336`,
  `apps/desktop/src/views/settings/decisions-section.tsx` (the Sizing and Questions card Task 3 kept goes;
  `useShapeMeasures` stays for the shadow agreement the table reads), `apps/desktop/src/test/daemon.ts`
  (`baseHandlers` serve `/shape-measures` with `shapeMeasuresDto()`: about 30 tests render `/shape` with unhandled
  requests failing)
- Move: the Sizing and Questions cases out of `decisions-section.test.tsx` into `plan-measures.test.tsx`

**Interfaces:**
- Consumes: `useShapeMeasures()` (`daemon/shape-measures-queries.ts`), `SizingMeasureDto`, `QuestionMeasureDto`.
- Produces: `export function PlanMeasures(): JSX.Element | null`.

`PlanMeasures` draws a `section` (`aria-label="How Plan is doing"`) titled "How Plan is doing" with a dimmed
"All projects" beside it, then Sizing and Questions with today's text exactly (labels, descriptions, the
`role="group"` names and every line `SizingRow`/`QuestionsRow` draw), as `Text` in a `Stack`, not `SettingRow`.
Nothing while the measures load or fail. `conversation-pane.tsx` draws, when `shapeId === null`, a `Flex
wrap="wrap" gap="md" align="flex-start"` holding `RecentConversations` (`flex: 1 1 240px`) and `PlanMeasures`
(`flex: 0 1 280px`), so at the chat's 420 px minimum they stack. The wrapper takes over `RecentConversations`' own
`flex: 'none', maxHeight: '45%', overflowY: 'auto'` (its `Box` then only pads), so the pair together never squeezes
the transcript and composer.

- [ ] **Step 1: Write the failing test** `plan-measures.test.tsx` from the moved cases (the same assertions and
  fixtures: `shapeMeasuresDto`), `Sizing and Questions are not on Settings › Decisions` in
  `decisions-section.test.tsx`, plus `shows on a new conversation beside the recent ones` through `ShapeView`
  with `shapeId={null}` (extend `shape-view.test.tsx` if it already renders that state; one case).
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement** and remove the rows from Settings.
- [ ] **Step 4: Run** `plan-measures.test.tsx`, every test file in `src/views/shape/` (by name, `--maxWorkers=2`),
  `src/router.test.tsx` and `decisions-section.test.tsx`; typecheck; lint.
- [ ] **Step 5: Commit** — `feat(desktop): plan's sizing and questions sit in plan's view beside the recent
  conversations` with the value card:
  `Value: protects=Sizing and Questions shown with Plan's conversations, with the same words and data; fails_when=they
  vanish from both places or show on Settings too; why_new=the moved cases tested them inside Settings only;
  no_claim=the layout at every width (Task 6's click-through).`

### Task 6: The Decisions page through the real daemon (e2e)

**Files:**
- Create: `apps/daemon/scripts/seed-judge-calls.ts`
- Modify: `apps/desktop/e2e/settings.spec.ts`

`seed-judge-calls.ts <database> <json>` follows `seed-question-card.ts`: zod-parses
`{ calls: { decision, model, answer, confidence, outcome, latencyMs, costUsd }[] }` and writes each through
`insertJudgeCall` (and `recordJudgeOutcome` where the outcome is not the provisional one) in one `store.write`.
The e2e daemon runs with `TENDB_JUDGE=off`, which still serves `/judge/decisions` and `/judge/calls/page`.

- [ ] **Step 1: Write the spec** `Decisions lists every decision, opens one, previews sure enough and pages its
  calls`: seed 30 calls (26 on `question_route`, 4 on `review_size`, invented numbers, mixed outcomes); open
  `/settings/decisions`; the table shows Delivery, Plan and Stakeholder questions and every status Off (all
  decisions); Recent decisions shows 25 rows and a pager; filter Decision to Skip review for small changes → 4
  rows (assert filtered counts: other specs share the daemon and stakeholder triage logs `question_route` calls even
  with the judge off); open Who a question goes to → the drawer's preview line names its answers; axe scan with the
  drawer open (`expectAccessible(page, 'settings decisions drawer')`) dark and light; close with Esc; axe scan the
  page dark and light. Update the existing Paid by empty-state test's
  name and words.
- [ ] **Step 2: Run it** — `pnpm --filter @10db/desktop e2e -- settings.spec.ts` (one spec; it builds the daemon
  first). Expected: PASS. Fix the page, not the test, when it fails for a page reason.
- [ ] **Step 3: Click through by hand** with `pnpm dev`: the page at 1280 and at 800 wide, dark and light, the
  drawer, the slider by keyboard; note anything off in the ledger.
- [ ] **Step 4: Commit** — `test(desktop): the decisions page through the real daemon, with seeded calls` with the
  value card:
  `Value: protects=the page reads real stats and pages and filters real calls, and the drawer previews against them;
  fails_when=the desktop and daemon disagree on a query, a filter or a stats shape; why_new=component tests stop at
  MSW; no_claim=the slider's keyboard save (component test and click-through) or the page with the judge on.`

### Task 7: Docs

**Files:**
- Modify: `apps/desktop/src/views/settings/AGENTS.md` (the Decisions bullet: the grouped table and
  `decision-catalogue.ts` as the one place a decision is added, the drawer, Sure enough, Paid by, Recent decisions;
  `useJudgeCalls` gone), `apps/desktop/src/views/shape/AGENTS.md` (Plan's measures on `/shape`), and the living docs
  and code comments that say "Runs on" for this page (`AGENTS.md` files, `docs/architecture/*.md` other than
  decision records, `apps/desktop/src/views/settings/accounts/used-by.ts`). Dated specs, plans and decision records
  stay as written.

- [ ] **Step 1: Update the notes.** Timeless wording, no "new".
- [ ] **Step 2: Run** `pnpm exec prettier --check` on the changed docs and the repo test that reads AGENTS.md
  (`tests/repo/src/agent-docs.test.ts`, run from `tests/repo` with `--maxWorkers=2`).
- [ ] **Step 3: Commit** — `docs(desktop): the decisions page and plan's measures`.
