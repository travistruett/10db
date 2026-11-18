# Task 2: db — Open's grouped rows

**Spec:** app shell spec §4.1 Inbox, "Performance" ("The route grows a cursor", "Counts never load lists",
"Search and filters run on the server"); decision
`docs/architecture/decisions/2026-11-16-the-open-inbox-is-paged-by-row-and-the-daemon-groups-the-rows.md`
(every bullet of its Decision).
**State rows:** 4, 5, 7, 8, 9 and 10 on the daemon's side. A row is never split across pages, a card can join or
leave a row, and placement follows Slack both ways.

## Files

- Create, in `packages/db/src/store/`:
  - `inbox-sql.ts`: `sendIsOut`, `LIVE_SEND_STATES`, `SENT_AT` and a `textMatches(q)` builder, moved out of
    `inbox-page.ts`. It imports neither page module, so the two never import each other;
  - `inbox-open-rows.ts` and `inbox-open-rows.test.ts`.
- Modify, in the same folder:
  - `inbox-page.ts`: `state: open` goes to `openRowsPage`, and the `placement` argument is added;
  - `inbox-page.test.ts`: callers pass `{ waitingOut: false }`;
  - `index.ts`: exports.
- Modify `apps/daemon/src/daemon/services.ts`, `pageInbox: (query) => pageInbox(db, query, { waitingOut: false })`,
  only so the branch typechecks. Task 4 wires the real value.

## Interfaces

Implement these:

```ts
export function pageInbox(db: DbReader, q: InboxPageQuery, placement: InboxPlacement): InboxPageDto;
export interface InboxPlacement { readonly waitingOut: boolean }   // Slack connected: a sent, unreturned card is Waiting's
// packages/db/src/store/inbox-sql.ts: SQL both page modules share (sendIsOut, textMatches); imports neither
export function openRowsPage(db: DbReader, q: InboxPageQuery, placement: InboxPlacement): InboxPageDto;
```

Call these, from Task 1:

```ts
export function inboxRowKey(card: InboxRowCard): string;
export function readyPassOf(card: InboxRowCard): PassId | null;   // a Ready page's pass (PassCheckDetail), else null
export function inboxRowSort(state: InboxListState, card: SortCard): InboxRowSort;
export function compareRowSort(state: InboxListState, a: InboxRowSort, b: InboxRowSort): number;
```

## The algorithm, which the tests don't fix on their own

`openRowsPage`:

1. **One `SELECT` of the light columns,** without `toInboxItemDto`: `id, kind, project_id, title, body, options,
   detail, urgency, created_at, updated_at, routed_by`, plus `hit`.
   - The `WHERE` is `state = OPEN`, plus `project` and `kind` when given.
   - With `placement.waitingOut`, add `NOT EXISTS` a send for which `sendIsOut` holds.
   - `hit` is `textMatches(q)`: `title LIKE ? ESCAPE '\' OR body LIKE ? ESCAPE '\'`, with `%`, `_` and `\`
     escaped and the text wrapped in `%…%`. SQLite's `LIKE` folds ASCII case only. Without `q`, `hit` is 1.
   - `ORDER BY INBOX_URGENCY_ORDER, created_at, id`.
2. **Fold the cards into rows** in that order with `inboxRowKey`.
   - A row's sort is its first card's `inboxRowSort('open', …)`, with `sentAt: null`.
   - A row is `counted` when any of its cards has a `routed_by` other than `triage_pending`.
   - A row is `hit` when any of its cards hits.
3. **Keep the rows that are `hit`.** `total` is the number of kept rows that are `counted`.
4. **Narrow to the page.**
   - With `card`, keep only the row that holds it, or none.
   - With `after`, keep the rows that `compareRowSort` puts after it.
   - With `page`, offset `(page - 1) * pageSize` rows. The page-past-the-last rule stays as `pageInbox` has it.
   - Take `pageSize` rows. `next` is the last row's sort when more rows remain, else null.
   - `page` is 1 on a keyset or card answer.
5. **Read the page's cards whole,** with one `inArray(id)` `SELECT`, and map them with `toInboxItemDto`, in row
   order. `items` is every card of every row, in order. `rows` holds `{ key, sort, passId: readyPassOf(first),
   ids }`.

## Steps

1. **Red.** Write `inbox-open-rows.test.ts` on `createTestStore` (a real SQLite file). Seed with `insertInboxItem`
   and the stakeholder-sends store. Use a fixed clock per card, so `created_at` orders them. One named row per case:
   - three identical flags → one row, `ids.length` 3, `total` 1;
   - two flags with the same title in two projects → two rows;
   - a pass's two Ready pages and a failed-turn flag of the same pass → one `pass:` row and one row of its own;
   - **seam:** 60 single cards, `pageSize` 25. Walk the pages with `after = next`. Every card comes exactly once,
     the order matches `compareRowSort`, the last `next` is null, and each answer has `page` 1;
   - **a row never split:** 24 single cards, then a flag ×3, `pageSize` 25. Page one ends with the whole flag row,
     ids 3;
   - **a card joins:** read page one, add a fourth identical flag, read with `card` = the new id. The row holds 4,
     with the same key and the same sort;
   - **a card leaves:** resolve the flag row's first card, then read with `card` = the second. The row holds 2,
     and its sort is now the second card's;
   - **filters:** `project` and `kind: check` keep the pass row whole. `kind: flag` leaves it out;
   - **search:** a pass row where only one page's title matches `q` → the whole row, both ids. `q` holding `%`
     matches only a literal `%`. `q: 'RETRY'` matches "retry", while a non-ASCII case difference doesn't (SQLite's
     own folding);
   - **placement, ported from the desktop's `splitInbox` table** (`apps/desktop/src/views/inbox/inbox-rows.test.ts`,
     "splitInbox: what needs the builder and what waits on someone"). Each row's card in Open, by its send, with
     `waitingOut` true and then false:
     - sent → absent when true, present when false;
     - a draft → present;
     - a failed send → present;
     - no send → present;
     - a send the timer returned → present;
     - a send whose recipients disagree (returned) → present.

     The rows for each connection state are Task 4's, since here they are only true or false;
   - **counts:** a `triage_pending` card is in `rows` but not in `total`. A flag row with one pending card and one
     placed is counted;
   - **total by hand:** a mixed seed (a ×3 flag, a pass row, two singles, one pending single, one sent card) with
     no filter and `waitingOut: true` → `total` 4, worked out by hand and written as the literal;
   - **page numbers:** `page: 2` with no `after` still answers the second page of rows.

   Run it. Expected: fails, because `openRowsPage` is missing.
2. Implement, then make it green. Run `pnpm --filter @10db/db exec vitest related src/store/inbox-open-rows.ts
   src/store/inbox-page.ts src/store/inbox-sql.ts --run --maxWorkers=2`, then typecheck db and daemon.
3. Commit, naming these paths:
   - `inbox-sql.ts`;
   - `inbox-open-rows.ts` and its test;
   - `inbox-page.ts` and `inbox-page.test.ts`;
   - `store/index.ts`;
   - `apps/daemon/src/daemon/services.ts`.

   The message is `feat(db): the open inbox pages grouped rows by keyset`. The body carries:

   ```
   Value: protects=Open's rows, total and pages agree, on the real query; fails_when=a row is split
     across a page seam, a card shows twice, a filter or search cuts a row, or a sent card
     counts in Open while Slack is connected; why_new=inbox-page.test.ts pages cards, not rows;
     no_claim=the route's Slack wiring (task 4) or the browser's merge (task 5)
   ```
