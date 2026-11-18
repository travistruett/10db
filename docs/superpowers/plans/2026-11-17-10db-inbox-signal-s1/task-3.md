# Task 3: daemon — post a notice, and serve `GET /activity/page`

**Spec:**

- §4 The three tiers (the Notice row: "Counted, badged, notified: no", "Stored as: the `events` log");
- §4.2 Notices: the entity type, "A notice with a `taskId` links to the task";
- §11 "How a task's drawer finds its notices without reading inside the event's JSON". This plan posts it on the
  task.

**State rows:** 1. **Part:** A. **Consumes:** Tasks 1 and 2.

This is a vertical slice: the post, the route and the read, tested through real SQLite and `app.request()`.

## Files

- Create, in `apps/daemon/src/inbox/`:
  - `card-tier.ts`: `CardTier`, `StoredTier`, `CardClosesWhen` and `BY_ANSWER`. Nothing uses the last three until
    Task 5, but they live with the tier;
  - `notice.ts` and `notice.test.ts`.
- Modify `apps/daemon/src/inbox/service.ts`: `InboxService.notice(input)`, implemented as
  `deps.state.write((ctx) => postNotice(ctx, input))`.
- Modify `apps/daemon/src/inbox/index.ts`: export `CardTier`, `StoredTier`, `CardClosesWhen`, `BY_ANSWER`,
  `NoticeInput` and `postNotice`.
- Modify `apps/daemon/src/delivery/cards.ts`: `DeliveryNotice`.
- Modify `apps/daemon/src/delivery/context.ts`: `post` and `postIn`.
- Modify `apps/daemon/src/api/app.ts`, beside `/inbox/page`:
  `.get('/activity/page', validator('query', (query) => ActivityPageQuery.parse(query)), (c) =>
  c.json(deps.services.pageActivity(c.req.valid('query'))))`.
- Modify `apps/daemon/src/api/services.ts`: `pageActivity(query: ActivityPageQuery): ActivityPageDto`.
- Modify `apps/daemon/test/api-stub.ts`: the stub's default.
- Modify `apps/daemon/src/daemon/services.ts`: `pageActivity: (query) => pageActivity(db, query)`.
- Modify `apps/daemon/src/screens/render-access.ts`: `{ route: '/activity/page' }` in `RENDER_READS`, with the
  comment "The Inbox's Activity list and a task's notices: one page of notice events. A database read."
- Create `apps/daemon/src/api/activity-routes.test.ts`, on the pattern of `api/skips-routes.test.ts`:
  `createTestStore` plus `stubServices` backed by the real db functions.

## Interfaces (implement, exactly)

Quoted in the index: `CardTier`, `StoredTier`, `CardClosesWhen`, `BY_ANSWER`, `NoticeInput`, `postNotice`,
`DeliveryNotice`, `post`, `postIn`, and `ApiServices.pageActivity`.

`postNotice(ctx, notice)`:

- **Its event.** It emits one `EventType.NoticePosted` event whose `data` is
  `NoticePostedData.parse({ projectId, taskId, ...fitted })`, where `fitted` is
  `fitNotice({ key, tone, line, body })`'s shown fields.
- **The entity:**
  - a `taskId` → `task` and the task id;
  - else a `projectId` → `project` and the project id;
  - else `app` and `APP_ENTITY_ID`.
- **Its guard.** A `taskId` with a null `projectId` throws `InvalidNoticeError` (`name = 'InvalidNoticeError'`). It
  is the caller's bug and never the builder's data. `NoticeInput`'s callers all pass both.

`post(inbox, projectId, notice)` calls `inbox.notice({ ...notice, projectId })`. `postIn(write, projectId, notice)`
calls `postNotice(write, { ...notice, projectId })`.

## Steps

1. **Red.** `inbox/notice.test.ts` (real SQLite, `createTestStore`), one table over `postNotice`. Each row checks
   the event's `entityType`, `entityId` and parsed `data`:
   - with a task and a project → `task`;
   - with a project only → `project`;
   - with neither → `app` / `app`;
   - a 600-character line → cut to 500, ending in "…".

   Then:
   - **rollback:** a `store.write` that posts a notice and then throws leaves no `notice.posted` row (state row 1);
   - **guard:** a task with no project throws `InvalidNoticeError`;
   - **no card:** after a post, `listInbox(db, { states: ['OPEN'] })` is empty.
2. **Red.** `api/activity-routes.test.ts`, through `app.request()`:
   - `GET /activity/page` after two posts answers both, newest first, as an `ActivityPageDto`;
   - `?task=<id>` answers only that task's;
   - `?project=<id>&task=<id>` → 400;
   - `?pageSize=101` → 400;
   - **the count doesn't move:** `GET /inbox/page?state=open&pageSize=1` answers the same `total` before and after
     a notice is posted. On this branch's base that's `pageInbox`. After main gains M3, Task 8's merge points the
     stub at what serves `/inbox/page` there, `openRowsPage`'s total included;
   - `render-reads.test.ts` stays green, since the new route is named.

   Run both files with `vitest run`. Expected: they fail, because `postNotice` and the route are missing.
3. Implement.
4. **Green.** Run `pnpm --filter @10db/daemon exec vitest related src/inbox/notice.ts src/inbox/service.ts
   src/delivery/context.ts src/api/app.ts src/screens/render-access.ts src/daemon/services.ts --run
   --maxWorkers=2`, then typecheck and lint the daemon.
5. Commit, naming every path. The message is `feat(daemon): post a notice as an event and read activity by page`.
   The body carries:

   ```
   Value: protects=a notice is an event on its task, project or the app, never a card, and
     /activity/page serves it; fails_when=a notice is stored as a card, survives a rolled-back
     write, moves the open count, or a task's notice is filed where the drawer can't read it by
     index; why_new=no notice outside a batch existed; no_claim=that any raiser posts one (task 4)
   ```
