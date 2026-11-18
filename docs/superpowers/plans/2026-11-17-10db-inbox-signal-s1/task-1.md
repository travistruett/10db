# Task 1: contracts — `notice.posted` and the Activity page

**Spec:** §4.2 Notices (the payload, the entity, "Activity reads those events newest first, paged by event `seq`",
"Identical notices with one `key` within 10 minutes show as one row with a count"). **Part:** A.

## Files

- Create `packages/contracts/src/activity.ts` and `activity.test.ts`.
- Modify, in `packages/contracts/src/`:
  - `events.ts`: `EventType.NoticePosted`, with its comment;
  - `index.ts`: export lines;
  - `json-schema.ts`: add `'notice-posted-data'`, `'activity-page-query'` and `'activity-page-dto'` to
    `CONTRACT_SCHEMAS`.
- Regenerate with `pnpm --filter @10db/contracts generate`, and commit the three new
  `packages/contracts/generated/*.schema.json` files. Commit `event-type` too, or whichever generated file carries
  `EventType`, if it changes. `contracts.test.ts` compares them byte for byte.

## Interfaces (implement, exactly)

Quoted in the index under "Interfaces": `EventType.NoticePosted`, `ACTIVITY_PAGE_SIZE`, `ACTIVITY_PAGE_SIZE_MAX`,
`ACTIVITY_GROUP_WINDOW_MS`, `NoticeEntity`, `APP_ENTITY_ID`, `NoticePostedData`, `ActivityPageQuery`, `ActivityRow`
and `ActivityPageDto`.

- `NoticePostedData` reuses `Notice.shape`'s `key`, `tone`, `line` and `body` from `entities.ts`, so a notice's
  limits are a batch notice's limits.
- `ActivityPageQuery`'s `.refine` is the one refusal: project and task together. `CONTRACT_SCHEMAS` renders with
  `io: 'input'`, so the coercions are fine there.

## Steps

1. **Red.** `activity.test.ts`, one table of `ActivityPageQuery.safeParse`, a row per case:
   - `{}` → `pageSize: 50`, nothing else set;
   - `{ after: '12' }` → `after: 12`;
   - `{ after: '0' }` fails, and so does `{ after: 'x' }`;
   - `{ pageSize: '101' }` fails;
   - `{ q: '  ' }` fails;
   - `{ project: <ProjectId>, task: <TaskId> }` fails with "project or task, not both";
   - `{ recent: '1' }` fails, because the object is strict.

   Then:
   - `NoticePostedData.parse` of a payload with `tone: 'error'` fails;
   - a `line` of 501 characters fails;
   - `ActivityRow.parse` of a row with `count: 0` fails.

   Run `pnpm --filter @10db/contracts exec vitest run src/activity.test.ts`. Expected: it fails, because the module
   is missing.
2. Implement `activity.ts` and the event type. Register the schemas and run the generate script.
3. **Green.** Run `pnpm --filter @10db/contracts exec vitest related src/activity.ts src/events.ts src/json-schema.ts
   --run --maxWorkers=2`, then typecheck and lint contracts.
4. Commit, naming every path: the source files above and the generated schema files. The message is
   `feat(contracts): a notice.posted event and the activity page`. The body carries:

   ```
   Value: protects=what a notice event holds and what the Activity read accepts; fails_when=a query
     with both project and task, a zero cursor or an overlong line is accepted; why_new=no schema
     for notices outside a batch existed; no_claim=that anything posts or reads them (tasks 2-3)
   ```
