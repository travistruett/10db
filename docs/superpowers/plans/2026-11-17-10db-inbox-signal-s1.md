# Inbox signal S1: tiers and notices

## Brief

**What changes for you.**

- About a dozen kinds of card stop landing in the Inbox. They tell you something and ask nothing. Examples: "Batch …
  abandoned: branch deleted", "<task> was resized", "Your folder stays on …", "Pass … did not open". They go to
  **Activity**, a fourth item after Resolved in the Inbox panel's switch. Activity isn't counted or badged, and it
  never notifies.
- Activity lists notices newest first and is searchable. The same notice repeated within 10 minutes shows as one row
  with ×n.
- A notice about a task also shows in that task's drawer, under the batch notices it shows today.
- Flags stop being "high" by default. Each kind of card now says how urgent it is. Work stopped is high. Something to
  decide is normal. An undo offer is low. So a flag no longer sorts above every question.
- When the new daemon starts, it closes any open cards of the kinds that are now notices. Each one moves to Resolved
  with the line "This kind of card is a notice now; it is in Activity."
- Not in S1, as the roadmap cut it: the status line (overload stays a card until S2), the new closers, Try Again,
  no-Dismiss for condition cards, the `.git` fixes and the repo test.

**What it buys.** Last week's 73 flags drop by the dozen or so that were notices, and every card that remains says
how urgent it is and how it closes. That second part is what S2's closers and S3's test build on.

**What could go wrong, and how we'd know.**

- *A real ask goes to Activity.* Only the 14 raisers in the table below change path, each by name in code.
  - Each one's existing test changes from "a card is raised" to "a notice is posted, and no card is stored", and
    each change is seen failing first.
  - The start sweep matches only those raisers' fold keys and exact titles. A pure table names each one and has a
    row for each near-miss that must not match.
- *A merged Workbench pass carries its pages over twice.* Its card was also the "carried over" marker. The notice
  becomes the marker, and a real-SQLite test plus the existing `merged-open` tests cover the restart.
- *Activity is slow on a big log.* No index is added. Task 2 times a first page against 250,000 events. If either
  read takes over 50 ms, the build stops and reports. An index would be a migration, and that needs the Sessions
  orchestrator.
- *Open's count moves.* The e2e deletes an empty branch, finds the notice in Activity, and checks Open's count before
  and after.

**Calls you might disagree with.**

1. **S1 sets values, not new answers.** §5's "Becomes" column adds answers for some cards: Switch Back, Open the
   Config, Choose Another Model, Delete Them / Keep, Open the Folder, Open the Checkout, and Open Capacity Settings on
   low disk. They move to S2 with the closers they go with. Each card carries a `// S2:` note, and the list is
   below. *Cost if wrong:* those cards stay Dismiss-only one milestone longer.
2. **A third way to close.** Many cards are already withdrawn by 10db's own code: the disk card, worktree cards, PR
   watch cards, account cards. They declare `closesWhen: { by: 'withdrawn', when: '<what withdraws it>' }` rather
   than pretend to close by answer. The spec named two forms.
3. **The overload, model-list and update-hold cards stay cards until S2,** declared `status`, at low urgency.
   Dropping them now would hide them with nothing to show them instead.
4. **A task's notice is posted on the task.** Its event has entity `task`, so the drawer reads it through the
   existing index without opening the JSON. Other notices go on `project`, or on `app` when they have no project.
   A project's Activity reads the project's notices and its tasks' notices.
5. **"Couldn't regenerate files" becomes a batch notice** (warning) on the batch's tasks. It offers no answer, and
   the gate catches stale generated files anyway. The lost-migrations card stays an ask, because its "Clear the
   notice" does act.
6. **A merged pass's card becomes a notice,** including the variant that says to push unpushed commits. That
   variant is a warning-tone notice. Its click-through to the follow-on pass is lost, but the body still names it.
7. **The start sweep resolves, not cancels.** Swept cards stay visible in Resolved with the reason. It runs at every
   start, which costs one read of the open flags.
8. **"<acct> cannot run <model>" splits.** It becomes a notice only when 10db is already running the step on another
   model. When the account has nothing left to run, the task is held, so it stays an ask (high).

**Needed from you:** nothing.

---

> **For agentic workers:** read this Brief, the Global constraints and your card,
> `2026-11-17-10db-inbox-signal-s1/task-<n>.md`. **Part A** (Tasks 1-7) builds now on `feat/inbox-signal-s1`.
> **Part B** (Tasks 8-9) starts only after `feat/sessions-and-inbox` (Inbox M3) has merged into main. Its first step
> merges main into this branch and re-checks its card against the code as merged. Both parts ship as one pull
> request. Commit after every green step. Run related tests only:
> `pnpm --filter <pkg> exec vitest related <files> --run --maxWorkers=2`, plus typecheck and lint of the package.
> **The branch typechecks after every task.**

**Spec:** `docs/superpowers/specs/2026-11-17-10db-inbox-signal-design.md`. S1 builds these sections:

- §4 The three tiers;
- §4.1 What an ask must have, its compile-time bullet;
- §4.2 Notices;
- §4.4 Urgency;
- §4.5 How a card closes, the first two bullets and "Tiers aren't stored";
- §5 Every card type, sorted.

**Roadmap:** `docs/superpowers/plans/2026-11-17-10db-inbox-signal-roadmap.md`, S1.

**Where:** one implementer, in `../10db-worktrees/inbox-signal-s1` on `feat/inbox-signal-s1`. It is already cut. No
migration.

## Global constraints

- Code style and testing rules as in the repo:
  - `as const` objects;
  - zod at every boundary, including an event's `data` read back from the log;
  - no `as` outside a validated boundary;
  - no non-null `!`;
  - exhaustive switches over `CardTier` and `CardClosesWhen['by']`.
- **No migration and no index.** The events table and `events_entity_idx` (`entity_type`, `entity_id`, `type`) are
  enough. If Task 2's timing says otherwise, stop and report. Don't add one.
- **No tier is stored.** A notice never becomes an `inbox_items` row. `notice.posted` is a plain event in the
  caller's transaction (`WriteContext.emit`). `openRowsPage`/`pageInbox` don't change.
- **`flagCard` never throws for a missing or odd tier.** The contract is compile-time only (§4.1 "Never at
  runtime").
- **A notice never notifies.** It adds no rail, menu-bar or macOS count. Notifications still read `GET /inbox`.
- **Every `closesWhen` uses only what exists today:** `{ by: 'answer' }`, `{ by: 'event', when }` with today's
  `CardResolvesWhen` (`tasks_started`, `batch_shipped`, `checkout_trusted`), or `{ by: 'withdrawn', when }`.
  - Where §5 names an S2 closer or answer, write `{ by: 'answer' }` and a comment
    `// S2: <closer or answer from §5>`.
  - For S4, write `// S4: <…>`.
- **Urgency follows §4.4:**
  - high: work is stopped or will be lost until the builder acts;
  - normal: something to decide, nothing stopped;
  - low: an undo offer or an optional choice.
  - The questions and permissions that `InboxService.ask` raises keep the urgency they pass today.
- **Notice text fits `Notice`.** `postNotice` runs `fitNotice` (line ≤ 500, body ≤ 8,000) and `fitNoticeKey`
  (key ≤ 200: a readable prefix, `…`, and a sha256 for an over-long tail), so a notice never fails to parse inside
  the caller's write.
- `PROTOCOL_VERSION` isn't bumped. The new event type, route and DTOs are additive, and an older desktop ignores an
  event it can't parse.
- **Copy is exact:**
  - the sweep's reason: "This kind of card is a notice now; it is in Activity.";
  - the switch item: "Activity";
  - Activity empty: "Nothing has happened yet";
  - with a search or filter set: M3's "No matches" and Clear Filters.
- No new dependencies.

## Review focus

These are inputs the spec implies that no task's tests would otherwise exercise. Each line names the test that pins
it.

- **A notice whose text is longer than a batch notice allows** (a gh error, a long path list). It is cut with "…"
  and still parses. Task 3 has a 600-character row.
- **A search containing `%` or `_`.** It matches literally. Task 2 has the row.
- **A task notice and the desktop's `task` entity invalidations.** A `notice.posted` on a task also refetches that
  entity's task lists (`INVALIDATIONS.task`). That's accepted and cheap. Task 8's live test checks that Activity
  refreshes, and nothing more.
- **A card that changes from ask to notice for one pass** (abandoned, then the Move option goes). The open card is
  withdrawn in the same write that posts the notice. Task 4 commit B has the row.
- **A matcher that would sweep an ask sharing a notice's fold-key prefix.** Task 6 has a near-miss row for each
  shared prefix.

## Provider parity

Tiers, urgency, closers, notices and Activity are 10db's own records and events. No provider is called.

| Feature | Claude plan | Bedrock / API key | Codex plan |
| --- | --- | --- | --- |
| Tier, urgency, `closesWhen` on every raiser | 10db's code | same | same |
| `notice.posted` and Activity | 10db's event log | same | same |
| Runner notices ("cannot run", "left changes", "ended without the handoff") | raised by the runner from the Claude adapter's outcome | same adapter | raised by the runner from the Codex adapter's outcome, same notices |
| A task's notices in its drawer | event log by task | same | same |

No feature refuses a provider.

## The sort table, as applied

Task 5's card holds the full table: every raiser with its tier, urgency and `closesWhen`. It is verified against this
branch and was built from a read of every builder in `delivery/cards.ts` and every `flag(`/`flagCard(`/`raise(`
site. Here are the decisions and the differences from the spec's §5.

**Becomes a notice in S1 (Task 4).** Each "with task" row posts with the task's id.

| Raiser | Posted as |
| --- | --- |
| `branchCards.abandonedBranchDeleted` (`delivery/branch-cleanup.ts`) | Activity, info |
| `worktreeCards.orphanNotRemoved` (`delivery/worktree-card.ts`) | Activity, warning |
| `movedCard` (`delivery/retired-landings.ts`) | Activity, info |
| `baseCards.regenerate` (`delivery/base-update.ts`) | **batch notice**, warning, key `base-regenerate` |
| `pass/merged-open.ts` follow-on card | Activity, info; warning when it names unpushed commits |
| `pass/close.ts` gate failed as the pass closed | Activity, warning |
| `pass/fast-forward.ts` Your folder stays on | Activity, warning |
| `pass/abandon.ts` with no Move option | Activity, info (with a Move option it stays an ask) |
| `runner.ts` "<acct> cannot run <model>", retried on another model | Activity, warning, with task |
| `runner.ts` "The <role> step left changes in its claims" | Activity, warning, with task |
| `runner.ts` "Session ended without the requested handoff" | Activity, warning, with task |
| `mcp/tools.ts` "<task> was resized" | Activity, info, with task |
| `daemon/start.ts` openWhenBusy `notify`: "Pass ‘…’ did not open" | Activity, warning |
| `daemon/start.ts` update drain: "Pass ‘…’ was cancelled for 10db’s update" | Activity, info |

**Rows added or corrected against the spec's §5** (the spec's text isn't edited; this list is the record):

- **Added:** `inbox/docker-card.ts` `raiseDockerOnNote`, "Docker is on for <project>'s gate and lanes" (Keep / Turn
  it off). It is an ask, low, closed by answer. §4.4 names it, but §5's list doesn't.
- **Split:** "Couldn't regenerate files / lost migrations" is two builders:
  - `baseCards.regenerate` has no option, so it becomes a batch notice;
  - `baseCards.lostUnreadable` and `shipCards.migrationsLost` (unreadable) offer Clear the notice, which acts
    (`delivery/lost-migrations.ts` hides the notice and withdraws the card), so they stay asks, high.
- **Moved:** `wrongBranchCard`'s outcomes go to different rows:
  - `not_joined` is wrapped by `forTasks` (Retry start / Cancel task, `tasks_started`), so it belongs under "Not
    started";
  - `not_shipped` carries Retry/Abandon and `batch_shipped`, so it belongs under "Batch not shipped";
  - only `waits` and `failed` are the Dismiss-only wrong-branch row (S2).
- **Corrected:** the spec says one shared notify callback raises the pass-cancelled and did-not-open cards. There
  are two sites: `openWhenBusyDeps.notify` (did not open) and an inline flag in the update drain (cancelled). Both
  post notices. Neither takes a tier.
- **Found Dismiss-only with no closer, kept as asks.** S2 must decide each, and S3's test will name them:
  - `prCards.rerunFailed`;
  - `shipCards.baseConflict`: no `actions`, despite its comment, though it closes on `batch_shipped`;
  - `leftOutCards.notStarted` when not answerable;
  - `leftOutCards.revertKept` when the batch shipped, closed or was abandoned.
- **Low disk** has no option today. §5's "Open Capacity settings added" is S2's.
- **Account cards**, assigned by §4.4:
  - `movedCard` (Move back / Stay), `recordedCard` (Record again) and `move-back.ts` are low;
  - `usageHighCard` is normal;
  - limit, cap, refused, sign-in, credentials, confirm and secret are high.

**Owed to S2, each marked `// S2:` where it's raised:**

| Card | Gets |
| --- | --- |
| Updating 10db failed | `update_installed`, Try Again |
| wrong branch `waits` / `failed` | `branch_ready`, Switch Back |
| the three repo MCP config cards | `mcp_config_changed`, Open the Config |
| git refusal without a candidate | the next git call passing, Open the Checkout |
| "<acct> cannot run <model>" (not retried, and nothing left) | Choose Another Model |
| branches under `10db/` without a task | Delete Them / Keep |
| `passCards.unopened` | Open the Folder, and closes when the branch is gone |
| low disk | Open Capacity Settings |

The stray-write and claim-foreign cards get `// S4: Trust This Version`.

## Interfaces

```ts
// packages/contracts/src/events.ts — EventType gains
NoticePosted: 'notice.posted',   // a notice that asks nothing (NoticePostedData); entity task | project | app

// packages/contracts/src/activity.ts
export const ACTIVITY_PAGE_SIZE = 50;
export const ACTIVITY_PAGE_SIZE_MAX = 100;
export const ACTIVITY_GROUP_WINDOW_MS = 10 * 60_000;
/** The entity a notice.posted event is filed under: its task, else its project, else the app. */
export const NoticeEntity = { Task: 'task', Project: 'project', App: 'app' } as const;
export type NoticeEntity = (typeof NoticeEntity)[keyof typeof NoticeEntity];
export const APP_ENTITY_ID = 'app';
export const NoticePostedData = z.strictObject({
  projectId: ProjectId.nullable(),
  taskId: TaskId.nullable(),
  key: Notice.shape.key,
  tone: Notice.shape.tone,
  line: Notice.shape.line,
  body: Notice.shape.body,
});
export type NoticePostedData = z.infer<typeof NoticePostedData>;
export const ActivityPageQuery = z.strictObject({
  project: ProjectId.optional(),
  task: TaskId.optional(),
  q: z.string().trim().min(1).max(200).optional(),          // line or body; LIKE, ASCII case folded
  after: z.coerce.number().int().positive().optional(),     // the page's `next`
  pageSize: z.coerce.number().int().min(1).max(ACTIVITY_PAGE_SIZE_MAX).default(ACTIVITY_PAGE_SIZE),
}).refine((q) => q.project === undefined || q.task === undefined, { message: 'project or task, not both' });
export type ActivityPageQuery = z.infer<typeof ActivityPageQuery>;
export const ActivityRow = NoticePostedData.extend({
  seq: z.int().positive(),     // the newest grouped notice's event seq: the row's key
  at: z.iso.datetime(),        // the newest's time
  firstAt: z.iso.datetime(),   // the oldest's time
  count: z.int().min(1),
});
export type ActivityRow = z.infer<typeof ActivityRow>;
export const ActivityPageDto = z.object({ rows: z.array(ActivityRow), next: z.int().positive().nullable() });
export type ActivityPageDto = z.infer<typeof ActivityPageDto>;

// packages/db/src/store/activity-group.ts (pure)
export interface PostedNotice { readonly seq: number; readonly at: string; readonly data: NoticePostedData }
export function groupNotices(notices: readonly PostedNotice[], pageSize: number):
  { readonly rows: ActivityRow[]; readonly consumed: number; readonly full: boolean };
// packages/db/src/store/activity.ts
export function pageActivity(db: DbReader, q: ActivityPageQuery): ActivityPageDto;
export function hasNoticeKey(db: DbReader, projectId: ProjectId, key: string): boolean;

// apps/daemon/src/inbox/card-tier.ts
export const CardTier = { Ask: 'ask', Notice: 'notice', Status: 'status' } as const;
export type CardTier = (typeof CardTier)[keyof typeof CardTier];
/** What a stored flag can be: a notice is never stored. */
export type StoredTier = typeof CardTier.Ask | typeof CardTier.Status;
export type CardClosesWhen =
  | { readonly by: 'answer' }
  | { readonly by: 'event'; readonly when: CardResolvesWhen }
  | { readonly by: 'withdrawn'; readonly when: string };   // names the code that withdraws or resolves it
export const BY_ANSWER: CardClosesWhen = { by: 'answer' };

// apps/daemon/src/inbox/notice.ts
export interface NoticeInput {
  readonly tier: typeof CardTier.Notice;
  readonly projectId: ProjectId | null;
  readonly taskId: TaskId | null;   // set only with a projectId
  readonly key: string;
  readonly tone: Notice['tone'];
  readonly line: string;
  readonly body: string;
}
export function postNotice(ctx: WriteContext, notice: NoticeInput): void;
export function fitNoticeKey(key: string): string;   // ≤ 200 unchanged; else first 135, '…', 64 hex of sha256

// apps/daemon/src/inbox/service.ts — FlagInput (now exported as a type) gains, required:
  readonly tier: StoredTier;
  readonly urgency: Urgency;
  readonly closesWhen: CardClosesWhen;
// flagCard inserts input.urgency; with closesWhen.by === 'event' it writes detail[CARD_RESOLVES_WHEN] = when,
// on insert and on a refresh. InboxService gains notice(input: NoticeInput): void (one write).

// apps/daemon/src/delivery/cards.ts — Card: `resolvesWhen?` goes; gains, required:
  readonly tier: StoredTier; readonly urgency: Urgency; readonly closesWhen: CardClosesWhen;
export type CardText = Pick<Card, 'title' | 'body' | 'foldKey' | 'detail'>;   // a refusal's words
export function forTasks(card: CardText, taskIds: Iterable<TaskId>, request?: Partial<StartRequest> | null): Card;
//   tier ask, urgency high, closesWhen tasks_started (by answer when taskIds is empty)
export type DeliveryNotice = Omit<NoticeInput, 'projectId'>;
// apps/daemon/src/delivery/context.ts
export function post(inbox: InboxService, projectId: ProjectId, notice: DeliveryNotice): void;
export function postIn(write: WriteContext, projectId: ProjectId, notice: DeliveryNotice): void;

// apps/daemon/src/api — ApiServices gains pageActivity(query: ActivityPageQuery): ActivityPageDto;
// route GET /activity/page (validator ActivityPageQuery.parse); RENDER_READS gains { route: '/activity/page' }.

// apps/daemon/src/daemon/notice-sweep.ts
export const NOTICE_SWEEP_REASON = 'This kind of card is a notice now; it is in Activity.';
export function noticeTypeOf(card: OpenFlagRow): string | null;   // the notice type's name, or null
export function resolveNoticeCards(db: DbReader, inbox: Pick<InboxService, 'resolve'>): number;

// Part B — apps/desktop/src/daemon/activity-queries.ts
export type ActivityList = Omit<ActivityPageQuery, 'after' | 'pageSize'>;
export const activityKeys = { all: ['activity'] as const, list: (list: ActivityList) => ['activity', list] as const };
export function useActivityRows(list: ActivityList): { rows: readonly ActivityRow[]; hasMore: boolean;
  loadingMore: boolean; loadMore: () => void; isPending: boolean; error: Error | null; moreError: Error | null };
export function useTaskNotices(taskId: TaskId | null): readonly Notice[];   // first page, 20 rows, as Notices
// apps/desktop/src/views/inbox/inbox-search.ts (M3's) — the state widens:
export type InboxPanelState = InboxListState | 'activity';
// packages/db/src/store/inbox.ts — InboxItemDto carries no fold key, so the sweep reads its own light rows:
export interface OpenFlagRow { readonly id: InboxItemId; readonly foldKey: string | null; readonly title: string;
  readonly body: string; readonly optionCount: number }
export function listOpenFlagRows(db: DbReader): OpenFlagRow[];   // kind flag, state OPEN
```


## State and event table

| # | State | Event | Outcome | Test |
| --- | --- | --- | --- | --- |
| 1 | a raiser's write with a notice in it | the write throws | no event: the notice is emitted in the same transaction | 3 |
| 2 | Activity observed, loaded | `notice.posted` | `activityKeys.all` is invalidated. It refetches from page 1, keeping its rows on screen. The selection follows the row's `seq`; when a newer notice joined the selected group, the seq changes and the row at the same index is selected | 8 |
| 3 | Activity cached, not observed | `notice.posted` | marked stale, and refetched when shown | 8 |
| 4 | `loadMore` in flight | `notice.posted` | the infinite query refetches every loaded page in order. A group split across a page boundary may show twice for a moment; the refetch settles it | 8 |
| 5 | a task drawer open | `notice.posted` on that task | `useTaskNotices` refetches. The notice appears under the batch notices | 8 |
| 6 | the start sweep running | the daemon is killed | each resolve is its own write. The next start sweeps what is left (idempotent) | 6 |
| 7 | the start sweep | the card was answered or dismissed between the read and the resolve | `resolve` returns a closed card as it was | 6 |
| 8 | a merged pass carried over | the daemon restarts before the notice is written | `carryOverDue` finds no notice (and no card), so the carry-over runs again, as it does today with the card | 4 |
| 9 | the socket reopens | — | `invalidateQueries()` refetches Activity, as every list | 8 |

## Tracks and tasks

One track, in order. Part B waits for M3 on main.

| # | Card | Part | What it builds |
| --- | --- | --- | --- |
| 1 | `task-1.md` | A | contracts: `notice.posted`, `NoticePostedData`, the Activity query, row and page, generated schemas |
| 2 | `task-2.md` | A | db: `groupNotices`, `pageActivity`, `hasNoticeKey`; the 250k timing |
| 3 | `task-3.md` | A | daemon: `CardTier`, `postNotice`, `InboxService.notice`, `post`/`postIn`, `GET /activity/page` |
| 4 | `task-4.md` | A | daemon: the 14 notice raisers post notices (four commits by module) |
| 5 | `task-5.md` | A | daemon: required `tier`, `urgency`, `closesWhen` on `FlagInput` and `Card`; every raiser; the sort table test |
| 6 | `task-6.md` | A | daemon: the start sweep of open cards that are notices now |
| 7 | `task-7.md` | A | docs: the decision, module notes |
| 8 | `task-8.md` | B | desktop: Activity in the panel's switch, its list and content; a task drawer's notices |
| 9 | `task-9.md` | B | run it against the real daemon; the e2e; desktop docs |

**Why this order.** Task 4 moves the notice raisers off `flag` before Task 5 makes the new fields required. So no
notice ever needs a stored tier, and `FlagInput.tier` can exclude `notice` at compile time.

## Files and conflicts

- **S1 owns:**
  - the new `packages/contracts/src/activity.ts`;
  - `packages/db/src/store/activity*.ts`;
  - `apps/daemon/src/inbox/{card-tier,notice}.ts`;
  - `apps/daemon/src/daemon/notice-sweep.ts`;
  - the new `apps/desktop/src/daemon/activity-queries.ts`;
  - `apps/desktop/src/views/inbox/activity-*.tsx`.
- **Shared with M3** (`feat/sessions-and-inbox`):
  - `apps/daemon/src/inbox/service.ts`: M3 doesn't touch `flag`;
  - `apps/daemon/src/api/app.ts`, `api/services.ts`, `daemon/services.ts`: Task 3 adds a route and a service beside
    `/inbox/page`;
  - `screens/render-access.ts`;
  - `apps/desktop/src/views/inbox/**`, which Part B edits only after M3 is on main.
- **Task 5 touches about 45 raiser files** across `delivery/`, `accounts/`, `pass/`, `runner/`, `watcher/`, `load/`,
  `inbox/`, `mcp/`, `self-update/`, `recovery/` and `daemon/`.
  - Each edit adds three fields. Merge main into the branch before Task 5 starts, and again before the pull request.
  - A new raiser that main gained meanwhile gets its values in that merge.

## After the tasks (coordinator)

- Code review round 1 (opus `code-reviewer`), Part A and Part B together, then converge.
- File as 10db tasks:
  - give `shipCards.baseConflict` Retry/Abandon `actions`, as its comment says;
  - the four Dismiss-only asks above, for S2 to decide;
  - the S2 list above, handed to S2's plan.
