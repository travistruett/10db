# Task 5: desktop data — the infinite rows, counts and the live merge

**Spec:** app shell spec §1.4 Panel lists and performance; §4.1 Inbox, "Performance" ("Lazy load on scroll",
"Counts never load lists", "Live updates").
**State rows:** 1-13, 19, 20, 22, 23, 25, 27, the data side of each. Each row is a case in the `mergeRow` table, or
in the replay test.

The live merge is concurrent state, so this card lands **six red-first commits**, each with its own value card
(`.claude/rules/testing.md`, "Size the unit of work to the risk").

## Files

- Create:
  - `apps/desktop/src/daemon/inbox-queries.ts`;
  - `apps/desktop/src/daemon/inbox-live.ts` and `inbox-live.test.ts`;
  - `apps/desktop/src/daemon/inbox-live-events.test.tsx`: the replay through MSW and the event socket.
- Modify:
  - `apps/desktop/src/daemon/events.ts`. The hunks are additive: one `applyInboxEvent(queryClient, client, event)`
    call in `receive`, after the invalidations, and `INVALIDATIONS.slack` becomes `[SLACK_KEY, queryKeys.inbox,
    ['inbox-rows']]`;
  - `apps/desktop/src/views/inbox/inbox-count.ts`;
  - `apps/desktop/src/test/inbox-page-fixtures.ts`: add `serveInboxRows`;
  - `apps/desktop/src/test/daemon.tsx`: the default `/inbox/page` handler answers `rows: []` and `next: null`.

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
  isPending: boolean; error: Error | null; moreError: Error | null };
export function useInboxCount(state: 'open' | 'waiting'): number | undefined;   // no filters, pageSize 1; undefined while loading
// useOpenInboxCount(): number keeps its signature: 0 while the count loads, as today, so the badge stays hidden.
export function fetchRowOf(client: DaemonClient, list: InboxList, card: InboxItemId): Promise<InboxRow | null>;
export function useCardContext(item: InboxItemDto | null): UseQueryResult<InboxCardContextDto>;   // questions only

// apps/desktop/src/daemon/inbox-live.ts
export class InboxRowsError extends Error { override readonly name = 'InboxRowsError' }   // a row names a card the page lacks
export function joinRows(page: InboxPageDto): InboxRowsPage;
export function flattenRows(pages: readonly InboxRowsPage[]): InboxRow[];   // one row per key; a later page wins
export function mergeRow(pages: readonly InboxRowsPage[], state: InboxListState,
  change: { readonly cardId: InboxItemId; readonly row: InboxRow | null }): InboxRowsPage[];
export function dropCard(queryClient: QueryClient, cardId: InboxItemId): void;   // through each list's chain
export function applyInboxEvent(queryClient: QueryClient, client: DaemonClient, event: DaemonEvent): void;
```

Call these, from Task 1:

```ts
export function inboxRowKey(card: InboxRowCard): string;
export function compareRowSort(state: InboxListState, a: InboxRowSort, b: InboxRowSort): number;
//   < 0 when a shows first; resolved runs newest first. Strings compare by code unit (<, >), as SQLite's BINARY
//   collation does, never localeCompare; a tie on `at` falls to the id, descending for resolved.
```

You also use the extended `InboxPageQuery` and `InboxPageDto`, and `InboxCardContextDto`.

## Commits

### 1. The rows and the counts

- **`useInboxRows`** is `useInfiniteQuery`:
  - `queryKey: inboxRowsKey(list)`, `initialPageParam: null`, `getNextPageParam: (page) => page.next`.
  - `queryFn` reads `GET /inbox/page` with `pageSize: 50` and `after` as JSON, then calls `joinRows`.
  - `placeholderData: keepPreviousData`.
  - `rows` is `flattenRows(data.pages)`.
  - `loadMore` calls `fetchNextPage` only while `hasNextPage && !isFetchingNextPage`.
  - `moreError` is a failed next-page fetch, which the list draws in its placeholder (state row 26).
  - A screen frame's project replaces `list.project`, as `useInboxPage` does (`useRenderMode`).
  - The key is outside `['inbox']`, so the entity invalidations never refetch a whole list. A reconnect's
    `invalidateQueries()` does.
- **`joinRows`** maps each `InboxRowRef`'s ids onto `items`. A missing id throws `InboxRowsError`, which the query
  reports as its error.
- **`useInboxCount`** reads `useInboxPage({ state, pageSize: 1 })`'s `total`. That stays under `['inbox']`, so every
  inbox event refreshes it.
- **`useOpenInboxCount`** keeps its signature and becomes `(useInboxCount('open') ?? 0) + systemCards(...).length`.
  It reads 0 while loading, as today, so the badge and the menu bar wait rather than show a wrong number. With no
  `useInbox`, they no longer load every card.
- **`useCardContext`** reads `GET /inbox/:id/context` for a `question`, and is disabled for every other kind.
  `staleTime: Infinity`.
- **`serveInboxRows`** (the fixture) serves `GET /inbox/page` from an array per state:
  - it groups Open with `inboxRowKey`;
  - it pages by `after`, `card` and `pageSize`;
  - it filters by `project`, `kind` and `q`. Match `q` with ASCII-only case folding, as SQLite's `LIKE` does: lower
    A-Z only, never `toLowerCase()`;
  - it returns the asked queries, as `serveInboxPage` does.

  This is test code calling the production rule. It adds no production export.
- **Red first:**
  - `inbox-live.test.ts`: `joinRows` (a missing id throws `InboxRowsError`) and `flattenRows` (a key on pages 1 and 2
    shows once, from page 2).
  - `inbox-live-events.test.tsx`: `useInboxRows` through `serveInboxRows` loads page two by `after`.
  - The rail's badge test (`app-frame.test.tsx`) stays green on the new count read. Point its fixture at
    `/inbox/page`'s `total`.
- Value card:

  ```
  Value: protects=the Inbox pages rows by cursor and counts without loading the list;
    fails_when=a row repeats across pages or the badge loads every card; why_new=the list and
    count read GET /inbox whole; no_claim=live updates
  ```

### 2. The pure merge

**`mergeRow`:**
1. Take `cardId` out of every row, and drop a row left empty.
2. With `change.row`:
   - take out any row with its key;
   - insert it before the first loaded row that sorts after it, in that row's page;
   - when no loaded row sorts after it, add it to the last page only if that page's `next` is null or sorts after
     it. Otherwise drop it: the next page brings it.

**Red first:** `inbox-live.test.ts`, a table. Each row has its input pages, its change and the expected keys per
page, and is named for its state-table row:
- 1/2: drop a card;
- 3: a group shrinks, then is gone;
- 4: insert mid-page;
- 5: past `next`, dropped;
- 6: the last page with `next` null;
- 7: a join replaces in place;
- 8: a sort change moves the row, or drops it past `next`;
- 11: a re-keyed card leaves its row;
- 22: Resolved inserts at the top, and a tie on `at` places by id, descending;
- idempotent: the same change twice equals once.

Value card:

```
Value: protects=a row's place after any change matches what the daemon's pages would give;
  fails_when=a row shows twice or never, or a card past the loaded end jumps in;
  why_new=nothing merged rows before; no_claim=event order or timing
```

### 3. Lookups in event order

- **`applyInboxEvent`** acts on an event with `entityType` `inbox`, whose card is `entityId`, and on one with
  `stakeholder_send`, whose card is `data.inboxItemId`, parsed with zod. It acts for each cached
  `['inbox-rows', list]` query that is **observed**: one with data, and one that is pending or fetching too
  (state row 12):
  1. Look up the card with `fetchRowOf(list, card)`, and `mergeRow` the answer.
  2. If the card had been in a row whose other cards remain, and the answer is null or has another key, look up one
     of those cards and merge again (state row 8).
- Lookups for one list run one at a time, in event order: one promise chain per key.
- **`dropCard`** queues `mergeRow(row: null)` on the same chain for every cached list.
- **A cached list with no observer** is marked stale with `invalidateQueries({ queryKey, refetchType: 'none' })`,
  and isn't looked up. It refetches from its first page when it's shown again (state row 23).
- **Red first,** `inbox-live-events.test.tsx`. Drive `useInboxRows` in a `renderHook` under `renderWithDaemon`'s
  providers, with `serveInboxRows`, and send events through `eventStream`:
  - `inbox.opened` for a new card sorting first → it is row 0, with no whole refetch (the asked queries show only a
    `card=` read);
  - `inbox.changed`, resolved → gone;
  - a `stakeholder_send` → looked up by `data.inboxItemId`;
  - two events in one tick → two lookups, in order (row 13);
  - the first card of a ×2 row resolved → the lookup answers null, and a second lookup for the other card moves the
    row (row 8);
  - unmount the hook, send an event, remount → no lookup was made, and the remount reads page one with the new card
    (rows 19, 23).
- Value card:

  ```
  Value: protects=live events patch the lists on screen, in order; fails_when=two events reorder,
    a shrunk row keeps its old place, or hidden lists cost a lookup per event; why_new=events
    refetched the whole list; no_claim=a fetch in flight
  ```

### 4. Waiting for a fetch in flight

- Before it merges, each lookup and each `dropCard` waits until that query's `fetchStatus` is `idle`. Subscribe
  through the `QueryCache`, with no polling and no sleeps. A pending list waits for its first page.
- **Red first:**
  - an event while page two is fetching → the merge lands after page two, and the card is there once (row 12);
  - an event while the first page of a new list is in flight, where the served first page predates the event → the
    card is present once the lookup merges (row 12, the pending list);
  - `dropCard` while page two is fetching, where page two holds that card → it's gone after page two lands (row 27).
- Value card:

  ```
  Value: protects=an event or an answer racing a page fetch is never lost or undone;
    fails_when=a page that read the daemon before the event overwrites the merge; why_new=the
    merge alone ignores timing; no_claim=failures
  ```

### 5. A failed lookup

- A lookup that fails invalidates that one list: a whole refetch.
- **Red first:** a lookup answering 500 → the list reads from the first page again (row 20).
- Value card:

  ```
  Value: protects=a failed lookup heals by refetching; fails_when=a failed lookup leaves the list
    wrong; why_new=no failure path existed; no_claim=retry timing
  ```

### 6. Slack and reconnect

- **Red first:**
  - a `slack` connection event → Open's and Waiting's rows and every `['inbox', 'page', …]` count are read again
    (row 10);
  - the socket reopening → every loaded page is read again, with the old rows kept meanwhile (row 19);
  - a screen frame's project goes into every row and count query (row 25).
- Value card:

  ```
  Value: protects=a Slack change moves sent cards and their counts at once; fails_when=the badge
    keeps the old placement after a daemon start; why_new=counts followed only the open-card
    query; no_claim=Slack's own state
  ```

## Running

After each commit, run `pnpm --filter @10db/desktop exec vitest related src/daemon/inbox-live.ts
src/daemon/inbox-queries.ts src/daemon/events.ts src/views/inbox/inbox-count.ts --run --maxWorkers=2`, then
typecheck and lint the desktop. Each commit names its paths. The message for commit n is
`feat(desktop): <what commit n adds>`; the first is `feat(desktop): inbox rows page by cursor and counts read the
daemon's total`.
