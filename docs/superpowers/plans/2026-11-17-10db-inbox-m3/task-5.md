# Task 5: desktop data — the infinite rows, counts and the live merge

**Spec:** app shell spec §1.4 Panel lists and performance; §4.1 Inbox, "Performance" ("Lazy load on scroll",
"Counts never load lists", "Live updates", "The detail loads on selection").
**State rows:** 1-13, 19, 20, 22, 23, 25. Each row is a case in the `mergeRow` table, or in the replay test below.

## Files

- Create:
  - `apps/desktop/src/daemon/inbox-queries.ts`;
  - `apps/desktop/src/daemon/inbox-live.ts` and `inbox-live.test.ts`;
  - `apps/desktop/src/daemon/inbox-live-events.test.tsx` (the replay through MSW and the event socket).
- Modify these. The `events.ts` hunks are additive:
  - `apps/desktop/src/daemon/events.ts`: one `applyInboxEvent(queryClient, client, event)` call in `receive`,
    after the invalidations, and `['inbox-rows']` added to `INVALIDATIONS.slack`;
  - `apps/desktop/src/views/inbox/inbox-count.ts`;
  - `apps/desktop/src/test/inbox-page-fixtures.ts`: add `serveInboxRows`.

## Interfaces

Implement these:

```ts
// apps/desktop/src/daemon/inbox-queries.ts
export type InboxList = Omit<InboxPageQuery, 'after' | 'page' | 'pageSize' | 'sort' | 'dir' | 'card'>;
export interface InboxRow { readonly key: string; readonly sort: InboxRowSort; readonly passId: PassId | null;
  readonly items: readonly [InboxItemDto, ...InboxItemDto[]] }
export interface InboxRowsPage { readonly rows: readonly InboxRow[]; readonly next: InboxRowSort | null }
export const INBOX_ROWS_PAGE = 50;
export const inboxRowsKey = (list: InboxList) => ['inbox-rows', list] as const;
export function useInboxRows(list: InboxList): {
  rows: readonly InboxRow[]; hasMore: boolean; loadingMore: boolean; loadMore: () => void;
  isPending: boolean; error: Error | null };
export function useInboxCount(state: 'open' | 'waiting'): number | undefined;   // no filters, pageSize 1
export function fetchRowOf(client: DaemonClient, list: InboxList, card: InboxItemId): Promise<InboxRow | null>;
export function useCardContext(item: InboxItemDto | null): UseQueryResult<InboxCardContextDto>;   // questions only

// apps/desktop/src/daemon/inbox-live.ts
export function joinRows(page: InboxPageDto): InboxRowsPage;
export function flattenRows(pages: readonly InboxRowsPage[]): InboxRow[];   // one row per key; a later page wins
export function mergeRow(pages: readonly InboxRowsPage[], state: InboxListState,
  change: { readonly cardId: InboxItemId; readonly row: InboxRow | null }): InboxRowsPage[];
export function dropCard(queryClient: QueryClient, cardId: InboxItemId): void;
export function applyInboxEvent(queryClient: QueryClient, client: DaemonClient, event: DaemonEvent): void;
```

Call these, from Task 1:

```ts
export function compareRowSort(state: InboxListState, a: InboxRowSort, b: InboxRowSort): number;
//   < 0 when a shows first; resolved runs newest first
```

The extended `InboxPageQuery` and `InboxPageDto`, and `InboxCardContextDto`.

## What each does

- **`useInboxRows`** is `useInfiniteQuery`:
  - `queryKey: inboxRowsKey(list)`, `initialPageParam: null`, and `getNextPageParam: (page) => page.next`.
  - `queryFn` reads `GET /inbox/page` with `pageSize: 50` and `after` as JSON, then `joinRows`.
  - `placeholderData: keepPreviousData`.
  - `rows = flattenRows(data.pages)`, and `loadMore` calls `fetchNextPage` only while `hasNextPage &&
    !isFetchingNextPage`.
  - A screen frame's project replaces `list.project`, as `useInboxPage` does (`useRenderMode`).
  - The key is outside `['inbox']`, so the entity invalidations never refetch a whole list. A reconnect's
    `invalidateQueries()` does.
- **`useInboxCount`** reads `useInboxPage({ state, pageSize: 1 })`'s `total`. That stays under `['inbox']`, so every
  inbox event refreshes it. **`useOpenInboxCount`** keeps its signature and becomes `useInboxCount('open') +
  systemCards(...).length`. With no `useInbox`, the rail badge and the menu bar no longer load every card.
- **`joinRows`** maps each `InboxRowRef`'s ids onto `items`.
- **`mergeRow`** (pure):
  1. Take `cardId` out of every row, and drop a row left empty.
  2. With `change.row`: take out any row with its key. Insert it before the first loaded row that sorts after it,
     in that row's page. When no loaded row sorts after it, add it to the last page only if that page's `next` is
     null, or sorts after it. Otherwise drop it, because the next page brings it.
- **`applyInboxEvent`**:
  - It acts on an event with `entityType` `inbox` (the card is `entityId`) or `stakeholder_send` (the card is
    `data.inboxItemId`, parsed with zod).
  - For each cached `['inbox-rows', list]` query with data:
    1. Look up the card with `fetchRowOf(list, card)` and `mergeRow` the answer.
    2. If the card had been in a row whose other cards remain, and whose key differs from the answer's, look up
       one of those cards and merge again.
  - Lookups for one list run one at a time, in event order: one promise chain per key.
  - Before it merges, each lookup waits until that query's `fetchStatus` is `idle`. Subscribe through the
    `QueryCache`, with no polling and no sleeps.
  - A failed lookup invalidates that one list.
- **`dropCard`** runs `mergeRow` with `row: null` on every cached list. Task 6's answer calls it on success.
- **`useCardContext`** reads `GET /inbox/:id/context` for a `question`, and is disabled for every other kind.
  `staleTime: Infinity`, so it reads once per selection, as §4.1 says.
- **`serveInboxRows`** (the fixture) serves `GET /inbox/page` from an array per state:
  - it groups Open with `inboxRowKey`;
  - it pages by `after`, `card` and `pageSize`;
  - it filters by `q`, `project` and `kind` the way Task 2 does;
  - it returns the asked queries, as `serveInboxPage` does.

  It's test code that calls the production rule, and it adds no new export to production.

## Steps

1. **Red.** Write `inbox-live.test.ts`, a pure table of `mergeRow`. Each row has its input pages, its change and the
   expected keys per page. Name each row after its state-table number:
   - 1/2: drop a card;
   - 3: a group shrinks, then is gone;
   - 4: insert mid-page;
   - 5: past `next`, dropped;
   - 6: the last page with `next` null;
   - 7: a join replaces in place;
   - 8: a sort change moves the row, or drops it past `next`;
   - 11: a re-keyed card leaves its row;
   - 22: Resolved inserts at the top;
   - idempotent: the same change twice equals once.

   `flattenRows`: a key on pages 1 and 2 shows once, from page 2.
2. **Red.** Write `inbox-live-events.test.tsx`. Drive `useInboxRows` in a `renderHook` under
   `renderWithDaemon`'s providers, with `serveInboxRows`. Send events through `eventStream`. The cases:
   - `inbox.opened` for a new card sorting first → it is row 0 with no whole refetch: the asked queries show only
     a `card=` read;
   - `inbox.changed`, resolved → gone;
   - a `stakeholder_send` → looked up by `data.inboxItemId`;
   - two events in one tick → two lookups, in order;
   - an event while page two is fetching → the merge lands after page two, and the card is present once (row 12);
   - a lookup answering 500 → the list refetches from the first page (row 20);
   - the socket reopening → every loaded page is read again (row 19).
3. Implement, then make it green. Run `pnpm --filter @10db/desktop exec vitest related src/daemon/inbox-live.ts
   src/daemon/inbox-queries.ts src/daemon/events.ts src/views/inbox/inbox-count.ts --run --maxWorkers=2`, then
   typecheck and lint the desktop. The rail's badge test (`app-frame.test.tsx`) must stay green on the new count
   read. Point its fixture at `/inbox/page`'s `total`.
4. Commit the files above, with the message `feat(desktop): inbox rows page by cursor and follow the event stream
   by row`. The body carries:

   ```
   Value: protects=a loaded Inbox list stays right as cards come, go, join and leave rows;
     fails_when=a row shows twice or never, a new card past the loaded end jumps in, or an event
     racing a page fetch is lost; why_new=the list was refetched whole on every event; no_claim=what
     the panel draws or selects
   ```
