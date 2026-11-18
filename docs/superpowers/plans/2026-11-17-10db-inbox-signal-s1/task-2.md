# Task 2: db — the Activity read, its grouping, and the notice marker

**Spec:** §4.2 Notices:

- "Activity reads those events newest first, paged by event `seq` with Inbox M3's keyset shape";
- "It reads per project through `events_entity_idx`";
- "If the plan measures a cross-project page as too slow on a 250k-row log";
- "Identical notices … within 10 minutes show as one row with a count, grouped when read".

**Part:** A. **Consumes:** Task 1's contracts.

## Files

- Create, in `packages/db/src/store/`:
  - `activity-group.ts` and `activity-group.test.ts` (pure);
  - `activity.ts` and `activity.test.ts` (real SQLite).
- Modify `packages/db/src/store/index.ts` and the package entry (export lines).

## Interfaces (implement, exactly)

```ts
// activity-group.ts (pure)
export interface PostedNotice { readonly seq: number; readonly at: string; readonly data: NoticePostedData }
export function groupNotices(notices: readonly PostedNotice[], pageSize: number):
  { readonly rows: ActivityRow[]; readonly consumed: number; readonly full: boolean };
// activity.ts
export function pageActivity(db: DbReader, q: ActivityPageQuery): ActivityPageDto;
export function hasNoticeKey(db: DbReader, projectId: ProjectId, key: string): boolean;
```

**The grouping rule.** `groupNotices` walks the notices in the order given, which is newest first:

- A notice **joins** an open row with the same `key`, `projectId` and `taskId` when the row's newest `at` minus the
  notice's `at` is at most `ACTIVITY_GROUP_WINDOW_MS`.
  - It adds 1 to `count`.
  - `firstAt` becomes the notice's `at`.
  - The row keeps its newest notice's `seq`, `at`, `tone`, `line` and `body`.
- A notice that joins no row **starts** one. If `rows.length === pageSize` already, the walk stops before it, and
  `full` is true.
- `consumed` counts the notices walked, joined or started.
- A burst that interleaves with another key across a page boundary can split into two rows. That's accepted, and
  `pageActivity`'s comment says so.

**The read.** `pageActivity` reads `events` rows whose type is `notice.posted` and whose seq is below `q.after`
(when set), newest seq first. It reads in chunks of `max(100, 4 × pageSize)` rows:

- It parses each row's `data` with `NoticePostedData.safeParse`. That's the boundary. A row that fails is skipped
  and still counts toward the cursor.
- It calls `groupNotices` over everything read so far. It reads another chunk only while the result isn't `full`
  and the last chunk came back whole.
- `next` is the seq of the last consumed row when `full`, else null.

The filters:

- **`task`:** `entity_type = 'task' AND entity_id = :task AND type = 'notice.posted'`. That's an `events_entity_idx`
  range, and the index carries the rowid, so its order is seq.
- **`project`:** `type = 'notice.posted' AND ((entity_type = 'project' AND entity_id = :p) OR (entity_type =
  'task' AND entity_id IN (SELECT id FROM tasks WHERE project_id = :p)))`.
- **Neither:** `type = 'notice.posted'`. That's a walk down the rowid.
- **`q`:** `(json_extract(data, '$.line') LIKE :q ESCAPE '\' OR json_extract(data, '$.body') LIKE :q ESCAPE '\')`,
  with `%`, `_` and `\` escaped. If M3's `textMatches` in `inbox-sql.ts` is on main, reuse its escaping.

`hasNoticeKey`:
`entity_type = 'project' AND entity_id = :projectId AND type = 'notice.posted' AND json_extract(data, '$.key') =
:key`, limit 1. It's the marker read for Task 4's merged pass. It reads inside the JSON only across one project's
notices.

## Steps

1. **Red.** `activity-group.test.ts`, one table, a row per case. Each row gives notices (`seq`, `at`, `key`,
   project, task) and `pageSize`, and expects the rows (`seq`, `count`, `firstAt`), `consumed` and `full`:
   - three notices of one key 1 min apart → one row ×3, `firstAt` the oldest;
   - the same key 11 min apart → two rows;
   - the same key, other project → two rows;
   - the same key, other task → two rows;
   - A, B, A within 10 min → A×2 then B (non-adjacent members join);
   - `pageSize` 1 with A, A, B → one row A×2, `consumed` 2, `full` true;
   - `pageSize` 2 with A, B, C → `full`, `consumed` 2;
   - all join, page not full → `full` false;
   - an empty list → no rows, `consumed` 0, `full` false.
2. **Red.** `activity.test.ts`, real SQLite (`createTestStore`). Seed notice events through `store.write((ctx) =>
   ctx.emit({ type: EventType.NoticePosted, … }))`, with other events between them. One table:
   - no filter: newest first, other event types skipped, `next` null on the last page;
   - `pageSize` 2 over 5 distinct notices → pages chained by `next` give all 5, none twice;
   - `project`: a project notice and a notice on one of its tasks both come; another project's and an `app` one
     don't;
   - `task`: only that task's;
   - `q: 'branch'` matches line or body, and a `%` in `q` is literal;
   - a row whose `data` doesn't parse is skipped, and the page after it still continues;
   - a group of 3 within 10 min comes as one row ×3;
   - `hasNoticeKey`: true for a posted key in that project; false for another project's, and false for a
     `task`-entity notice.

   Run `pnpm --filter @10db/db exec vitest run src/store/activity-group.test.ts src/store/activity.test.ts`.
   Expected: both fail, because the modules are missing.
3. Implement.
4. **Measure.** This step is not committed. In the session's scratchpad, write a script that opens a temp database
   through `createTestStore` and seeds 250,000 events:
   - 10,000 of them `notice.posted`, spread over 10 projects with 50 tasks each, a third on tasks;
   - the rest `task.changed` and `inbox.changed`.

   Then a second, sparse database: the same 250,000 events with only 20 of them `notice.posted`, spread through the
   log. The unfiltered read walks the rowid until it fills a page, so a sparse log is its worst case.

   Time the median of 20 runs of each, on both databases:
   - a first page with no filter;
   - a page from the middle (`after` at seq 125,000);
   - a first page for one project;
   - a first page for one task.

   **If any median is over 50 ms, stop.** Report the numbers to the coordinator and don't add an index (that would
   be a migration). Otherwise put the eight medians in the commit body.
5. **Green.** Run `pnpm --filter @10db/db exec vitest related src/store/activity-group.ts src/store/activity.ts --run
   --maxWorkers=2`, then typecheck and lint db.
6. Commit, naming every path. The message is `feat(db): the activity page reads notices by keyset and groups
   repeats`. The body carries the medians and:

   ```
   Value: protects=Activity's paging, filters and grouping, and the notice marker; fails_when=a
     page repeats or drops a notice, a task's notice misses its project's Activity, a repeat within
     10 minutes shows twice, or a marker reads another project's notice; why_new=no read of the
     event log by notice existed; no_claim=that the route serves it (task 3)
   ```
