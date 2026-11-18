# Task 3: db — Waiting and Resolved by keyset

**Spec:** app shell spec §4.1 Inbox, "The panel's head" (the filter menu: for Resolved, who answered and when) and
"Performance" ("The route grows a cursor", "Search and filters run on the server").
**State rows:** 9, 10 and 22 on the daemon's side: the card lookup in Waiting and Resolved, and the Resolved tie.

## Files

- Modify `packages/db/src/store/inbox-page.ts` (the Waiting and Resolved branch) and
  `packages/db/src/store/inbox-page.test.ts`. Use `textMatches` and `SENT_AT` from `inbox-sql.ts` (Task 2).

## Interfaces

Implement this:

```ts
export function pageInbox(db: DbReader, q: InboxPageQuery, placement: InboxPlacement): InboxPageDto;
```

Call these, from Task 1:

```ts
export function inboxRowSort(state: InboxListState, card: SortCard): InboxRowSort;
//   open [high 0 | normal 1 | low 2, createdAt, id] · waiting [sentAt === null ? 1 : 0, sentAt ?? '', id]
//   · resolved [0, updatedAt, id]
// packages/db/src/store/inbox-sql.ts: SQL both page modules share (sendIsOut, textMatches); imports neither
```

`InboxPageQuery`'s `after`, `q`, `since` and `card`, and `InboxPageDto`'s `rows` and `next`, as Task 1 wrote
them.

## What changes

- `whereOf` gains three filters:
  - `q`: `textMatches(q)`, the same escaped `LIKE` as Task 2.
  - `since`: `updated_at >= since`.
  - `card`: `id = card`.
- With `after`, `whereOf` adds the keyset bound in the default order, as an SQLite row-value comparison:
  - Waiting: `(SENT_AT IS NULL, coalesce(SENT_AT, ''), id) > (?, ?, ?)`.
  - Resolved: `(updated_at, id) < (?, ?)`.

  `after` is only valid with the default order (Task 1 refuses the rest).
- `rows` are filled since Task 1, one per card. `sentAt` comes from the card's live send (`item.send?.sentAt ??
  null`).
- `next` is now the last row's sort when a row exists after it. Read `pageSize + 1` rows and drop the extra.
- `page` is 1 on a keyset or card answer.
- `total` stays the filtered count. With `after` it is still the whole list's count.
- The page-number readers (`page`, `sort`, `dir`) answer exactly as before. Their rows in `inbox-page.test.ts` stay
  as they are.

## Steps

1. **Red.** Add rows to `inbox-page.test.ts`:
   - **Resolved seam:** 60 resolved cards with distinct `updated_at` and two that tie. Walk the pages by `after`.
     Every card comes once, newest first, and the tie is ordered by id descending;
   - **Waiting seam:** the same, by `sentAt`, the longest out first;
   - **`since`:** cards updated before it are left out;
   - **search:** `q` matches the title, matches the body, ignores ASCII case, and treats `_` literally;
   - **`card`:** a resolved card answers its one row, and an open card asked for in `resolved` answers none;
   - **the tie in both sorts:** for the two tied cards, the SQL order equals `compareRowSort('resolved', …)` on
     their sorts. The browser's merge then places them as the pages do.

   Run. Expected: fails on the missing filters.
2. Implement, then make it green. Run `pnpm --filter @10db/db exec vitest related src/store/inbox-page.ts --run
   --maxWorkers=2`, then typecheck db.
3. Commit `inbox-page.ts` and `inbox-page.test.ts`, with the message
   `feat(db): waiting and resolved inbox pages read by keyset, search and date`. The body carries:

   ```
   Value: protects=Waiting and Resolved page by cursor without skipping or repeating a card;
     fails_when=a tie on the timestamp repeats or drops a card at a seam, or search matches a
     wildcard; why_new=inbox-page.test.ts covers page numbers only; no_claim=the panel's scroll
   ```
