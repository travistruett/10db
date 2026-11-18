# Task 2: db — Open's grouped rows

**Spec:** app shell spec §4.1 Inbox, "Performance" ("The route grows a cursor", "Counts never load lists",
"Search and filters run on the server"); decision
`docs/architecture/decisions/2026-11-16-the-open-inbox-is-paged-by-row-and-the-daemon-groups-the-rows.md`
(every bullet of its Decision).
**State rows:** 4, 5, 7, 8 and 9 on the daemon's side. A row is never split across pages, a card can join or
leave a row, placement follows Slack.

## Files

- Create `packages/db/src/store/inbox-open-rows.ts` and `inbox-open-rows.test.ts`.
- Modify:
  - `packages/db/src/store/inbox-page.ts`: route `state: open` to `openRowsPage`, and add the `placement` argument;
  - `packages/db/src/store/inbox-page.test.ts`: callers pass `{ waitingOut: false }`;
  - `packages/db/src/store/index.ts`: exports.
- Modify `apps/daemon/src/daemon/services.ts`, `pageInbox: (query) => pageInbox(db, query, { waitingOut: false })`,
  only so the branch typechecks. Task 4 wires the real value.

## Interfaces

Implement these:

```ts
export function pageInbox(db: DbReader, q: InboxPageQuery, placement: InboxPlacement): InboxPageDto;
export interface InboxPlacement { readonly waitingOut: boolean }   // Slack connected: a sent, unreturned card is Waiting's
export function openRowsPage(db: DbReader, q: InboxPageQuery, placement: InboxPlacement): InboxPageDto;
```

Call these, from Task 1:

```ts
export function inboxRowKey(card: InboxRowCard): string;
export function readyPassOf(card: InboxRowCard): PassId | null;
export function inboxRowSort(state: InboxListState, card: SortCard): InboxRowSort;
export function compareRowSort(state: InboxListState, a: InboxRowSort, b: InboxRowSort): number;
```

## The algorithm, which the tests don't fix on their own

`openRowsPage`:

1. One `SELECT` of the light columns, without `toInboxItemDto`: `id, kind, project_id, title, body, options,
   detail, urgency, created_at, updated_at, routed_by`, plus `hit`.
   - The `WHERE` is `state = OPEN`, plus `project` and `kind` when given.
   - With `placement.waitingOut`, add `NOT EXISTS` a send that is out. Reuse `sendIsOut` from `inbox-page.ts`;
     move it to a shared spot in that file and export it within the package.
   - `hit` is `title LIKE ? ESCAPE '\' OR body LIKE ? ESCAPE '\'` when `q` is set. Escape `%`, `_` and `\` in `q`
     and wrap it in `%…%`. Without `q`, `hit` is 1.
   - `ORDER BY INBOX_URGENCY_ORDER, created_at, id`.
2. Fold the cards into rows in that order with `inboxRowKey`. The parse of `detail` happens inside the contracts
   function. A row's sort is its first card's `inboxRowSort('open', …)`, with `sentAt: null`. A row is `counted`
   when any card has `routed_by` other than `triage_pending`, and `hit` when any card hits.
3. Keep the rows that are `hit`. `total` is the number of kept rows that are `counted`.
4. With `card`, keep only the row that holds it, or none. With `after`, keep the rows that `compareRowSort` puts
   after it. With `page`, offset `(page - 1) * pageSize` rows. The page-past-the-last rule stays as `pageInbox`
   has it. Take `pageSize` rows. `next` is the last row's sort when more rows remain, else null.
5. Read the page's cards whole with one `inArray(id)` `SELECT`, and map them with `toInboxItemDto`, in row order.
   `items` is every card of every row, in order. `rows` holds `{ key, sort, passId: readyPassOf(first), ids }`.

## Steps

1. **Red.** Write `inbox-open-rows.test.ts` on `createTestStore` (a real SQLite file). Seed with `insertInboxItem`.
   Use a fixed clock per card, so `created_at` orders them. One named row per case:
   - three identical flags → one row, `ids.length` 3, `total` 1;
   - two flags with the same title in two projects → two rows;
   - a pass's two Ready pages and a failed-turn flag of the same pass → one `pass:` row and one row of its own;
   - **seam:** 60 single cards, `pageSize` 25. Walk the pages with `after = next`. Every card comes exactly once,
     the order matches `compareRowSort`, and the last `next` is null;
   - **a row never split:** 24 single cards, then a flag ×3, `pageSize` 25. Page one ends with the whole flag
     row, ids 3;
   - **a card joins:** read page one, add a fourth identical flag, read with `card` = the new id. The row holds 4,
     with the same key and the same sort;
   - **a card leaves:** resolve the flag row's first card, then read with `card` = the second. The row holds 2,
     and its sort is now the second card's;
   - **filters:** `project` and `kind: check` keep the pass row whole. `kind: flag` leaves it out;
   - **search:** a pass row where only one page's title matches `q` → the whole row, both ids. `q` holding `%`
     matches only a literal `%`;
   - **placement:** a card whose send is `sent` and not returned is in Open with `waitingOut: false`, and absent
     with `true`;
   - **counts:** a `triage_pending` card is in `rows` but not in `total`. A flag row with one pending card and one
     placed is counted;
   - **total matches splitInbox:** for a mixed seed with no filter, `total` equals what today's desktop
     `openCount(splitInbox(items, 'connected').open)` gives. Write the expected number as a literal, worked out
     by hand from the seed;
   - **page numbers:** `page: 2` with no `after` still answers the second page of rows.

   Run it. Expected: fails, because `openRowsPage` is missing.
2. Implement, then make it green. Run `pnpm --filter @10db/db exec vitest related src/store/inbox-open-rows.ts
   src/store/inbox-page.ts --run --maxWorkers=2`, then typecheck db and daemon.
3. Commit `packages/db/src/store/inbox-open-rows.ts`, its test, `inbox-page.ts`, `inbox-page.test.ts`,
   `store/index.ts` and `apps/daemon/src/daemon/services.ts`, with the message
   `feat(db): the open inbox pages grouped rows by keyset`. The body carries:

   ```
   Value: protects=Open's rows, total and pages agree, on the real query; fails_when=a row is split
     across a page seam, a card shows twice, a filter or search cuts a row, or a sent card
     counts in Open while Slack is connected; why_new=inbox-page.test.ts pages cards, not rows;
     no_claim=the route's Slack wiring (task 4) or the browser's merge (task 5)
   ```
