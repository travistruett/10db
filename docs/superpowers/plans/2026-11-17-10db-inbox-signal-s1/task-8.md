# Task 8: desktop — Activity in the Inbox panel, and a task drawer's notices

**Spec:**

- Brief: "What tells you something and asks nothing goes to **Activity**, a list beside Open, Waiting and Resolved.
  It is kept, searchable and never counted";
- Calls 2 and 3;
- §4 The three tiers, the Notice row;
- §4.2 "A notice with a `taskId` links to the task, and the task's drawer lists its notices";
- §11 "How the desktop draws the Activity switch item … They must follow Inbox M3's panel and `DESIGN.md`".

**State rows:** 2, 3, 4, 5, 9. **Part:** B. **Consumes:** Task 3's route.

## Before you start

Part B begins only once `feat/sessions-and-inbox` (Inbox M3) is on main.

1. Merge main into `feat/inbox-signal-s1` and resolve it. Then point `activity-routes.test.ts`'s `/inbox/page` stub
   at what serves that route on main (`openRowsPage` for `state=open`), and see it green.
2. **Re-check this card against main.** The names below are M3's plan
   (`git show feat/inbox-m3:docs/superpowers/plans/2026-11-17-10db-inbox-m3/task-6b.md`, `task-7.md`):
   - `views/inbox/inbox-panel.tsx` (the `SegmentedControl` with `aria-label="Inbox state"`);
   - `inbox-row-list.tsx` (`InboxRowList`, `ROW_HEIGHT_PX`);
   - `inbox-row-item.tsx`;
   - `inbox-search.ts` (`InboxSearch`, `inboxSearch`, `inboxList`);
   - `inbox-filter-menu.tsx`;
   - `inbox-view.tsx`;
   - `daemon/inbox-queries.ts` (`useInboxRows`, `INBOX_ROWS_PAGE`).

   Where main differs, follow main and note each difference in the commit body. Also check where the task drawer
   lives on main, since Sessions M2 moved task tabs. Today it is `views/board/task-drawer.tsx`, with `TaskNotices`
   at `:669`.
3. Read `views/inbox/AGENTS.md`, `shell/AGENTS.md` and `DESIGN.md` as merged.

## Files

- Create `apps/desktop/src/daemon/activity-queries.ts` and `activity-queries.test.ts`.
- Create, in `apps/desktop/src/views/inbox/`:
  - `activity-row-item.tsx`;
  - `activity-content.tsx`;
  - `activity-list.test.tsx`.
- Modify `apps/desktop/src/daemon/events.ts`: `EVENT_INVALIDATIONS['notice.posted'] = [activityKeys.all]`, with a
  comment.
- Modify, in `apps/desktop/src/views/inbox/`:
  - `inbox-search.ts`: `InboxPanelState`. `inboxSearch` keeps `state=activity`. `inboxList` is never called for
    Activity; `activityList(search)` is, and it maps `q` and `project` to an `ActivityList`;
  - `inbox-panel.tsx`: the fourth item;
  - `inbox-view.tsx`: Activity's list and content;
  - `inbox-filter-menu.tsx`: in Activity, only the project filter shows;
  - `use-inbox-keys.ts`, or whatever holds `e` on main: `e` does nothing on an Activity row.
- Modify the task drawer file: `TaskNotices` also lists `useTaskNotices(task.id)`, after the batch notices and
  history. Modify its test file too.
- Modify `apps/desktop/src/test/daemon.tsx`: a default `/activity/page` handler answering
  `{ rows: [], next: null }`.

## Interfaces (implement, exactly)

`ActivityList`, `activityKeys`, `useActivityRows`, `useTaskNotices` and `InboxPanelState`, quoted in the index.

- **`useActivityRows`** is `useInfiniteQuery` on `activityKeys.list(list)`. It reads `GET /activity/page` with
  `pageSize` 50 and `after` from the last page's `next`, and keeps previous data. Its return shape is
  `useInboxRows`'s, so `InboxRowList` takes it as is.
- **`useTaskNotices(taskId)`** reads one page of 20 with `task` and maps each row to a `Notice`:
  - `key`: `activity:<seq>`;
  - `tone`: the row's tone;
  - `line`: the row's line, plus ` ×<count>` when `count > 1`;
  - `body`: the row's body.

  With `taskId` null it reads nothing and answers `[]`.

## What to build

- **The switch** gets a fourth item, "Activity", after Resolved. It has no `CountBadge`, ever.
  - Changing to it navigates with `state=activity`.
  - The rail badge, the menu bar and `useOpenInboxCount` don't change.
- **Activity's list** is `InboxRowList` labelled "Activity", over `useActivityRows(activityList(search))`. Row keys
  are `notice:<seq>`, and selection uses M3's `nextSelection`.
- **A row** (`activity-row-item.tsx`) has M3's row geometry, through the theme's tokens:
  - **line 1:** a gray `NOTICE` tag (`orange` for `warning`, matching `TaskNotices`), the line with ` ×n` when
    grouped, and the age of `at` by `shortAgo`;
  - **line 2:** the project (`ProjectLabel`) or "10db" with no project, then the body's first line.
- **The content** (`activity-content.tsx`) shows:
  - the line as its title;
  - the body, in `plain-message` style;
  - "n times, from <firstAt> to <at>" when grouped;
  - the project;
  - with a task, an **Open Task** link to `/board?task=<taskId>`, or main's equivalent from step 2.
  - It has no answer and no Dismiss.
- **Empty:** "Nothing has happened yet". With a search or the project filter set, it shows M3's "No matches" and
  Clear Filters.
- **Search** applies `q`. The project filter applies `project`. Kind, outcome, person and since are hidden in
  Activity.
- **Live:** `notice.posted` invalidates `activityKeys.all`. That refetches the observed list with its rows kept, and
  marks the others stale (state rows 2-4). It also refetches an open drawer's notices (state row 5).

## Steps

1. **Red.** `activity-queries.test.ts` (`renderHook` with the MSW daemon). One table:
   - the first page reads `pageSize=50` and no `after`;
   - `loadMore` sends `after=<next>`;
   - `next: null` → `hasMore` false;
   - `useTaskNotices` maps a ×3 row to a line ending ` ×3`, with key `activity:<seq>`;
   - with null it sends no request.
2. **Red.** `activity-list.test.tsx` (`renderWithDaemon`):
   - the switch shows four items, and Activity has no count badge, though `/activity/page` answers rows;
   - choosing Activity lists the rows, and selecting one shows its body, its "3 times, from … to …" and Open Task;
   - an empty page shows "Nothing has happened yet";
   - a search sends `q`, and an empty answer shows "No matches";
   - a `notice.posted` event refetches the list, and the new row shows;
   - `e` on an Activity row sends no request.
3. **Red.** In the drawer's test, a task whose `/activity/page?task=` answers one warning notice shows it in
   `task-notice`, after the batch notice.

   Run the three files with `vitest run`. Expected: they fail, because the hooks and the item are missing.
4. Implement.
5. **Green.** Run `pnpm --filter @10db/desktop exec vitest related src/daemon/activity-queries.ts
   src/daemon/events.ts src/views/inbox/inbox-panel.tsx src/views/inbox/inbox-view.tsx src/views/inbox/inbox-search.ts
   <the drawer file> --run --maxWorkers=2`. Then typecheck and lint the desktop.
6. Commit, naming every path. The message is `feat(desktop): activity in the inbox panel, and a task's notices in
   its drawer`. The body carries the differences from step 2, and:

   ```
   Value: protects=notices show in Activity and on their task, and Activity is never counted;
     fails_when=Activity gets a badge, a notice.posted doesn't refresh it, a grouped notice loses
     its count, or a task's notice is missing from its drawer; why_new=no view read notices
     outside a batch; no_claim=that the real daemon posts them (task 9)
   ```
