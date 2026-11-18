# Task 6a: desktop — the search module, the selection rule and the row list

**Spec:** app shell spec:
- §1.4 Panel lists and performance (selection survives);
- §4.1 Inbox: "The panel's head" (the URL holds the state, search and filters), "Performance" ("Lazy load on
  scroll", "Virtualised rows", "Budget");
- §8 Tests ("The DOM holds under 100 rows with 10,000 loaded", "Scrolling near the end loads the next page").

**State rows:** 14 (the selection after a list change, its pure part), 18, 26 (the list's half).

These are the building blocks 6b and 6c draw with. Nothing here is mounted in the app yet.

## Files

Create, in `apps/desktop/src/views/inbox/`:
- `inbox-search.ts` and `inbox-search.test.ts`;
- `inbox-selection.ts` and `inbox-selection.test.ts`;
- `inbox-row-list.tsx` and `inbox-row-list.test.tsx`.

## Interfaces

Implement these:

```ts
// apps/desktop/src/views/inbox/inbox-search.ts
export const InboxSince = { Day: 'day', Week: 'week', Month: 'month' } as const;
export interface InboxSearch { readonly state?: InboxListState; readonly q?: string; readonly project?: ProjectId;
  readonly kind?: InboxKind; readonly outcome?: InboxOutcome; readonly person?: PersonId; readonly since?: InboxSince }
export function inboxSearch(search: Record<string, unknown>): InboxSearch;   // keeps each key only when it parses
export function inboxList(search: InboxSearch, now: Date): InboxList;   // since → local midnight, 0, 6 or 29 days back
export const lastInboxSearch: { get(): InboxSearch; set(search: InboxSearch): void };   // module memory

// apps/desktop/src/views/inbox/inbox-selection.ts (pure)
export function nextSelection(keys: readonly string[], selected: string | null, lastIndex: number):
  { readonly key: string | null; readonly index: number };

// apps/desktop/src/views/inbox/inbox-row-list.tsx
export const ROW_HEIGHT_PX = 52;   // §4.1 "Performance": rows are a fixed height
export function InboxRowList<T extends { readonly key: string }>(props: {
  readonly label: string; readonly rows: readonly T[]; readonly selected: string | null;
  readonly hasMore: boolean; readonly loadingMore: boolean; readonly moreError: Error | null;
  readonly onNearEnd: () => void; readonly renderRow: (row: T, selected: boolean) => ReactNode }): ReactNode;
```

Call this, from Task 5:

```ts
export type InboxList = Omit<InboxPageQuery, 'after' | 'page' | 'pageSize' | 'sort' | 'dir' | 'card'>;
```

## What to build

- **`inbox-search.ts`.**
  - `inboxSearch` keeps each URL key only when it parses.
  - `inboxList` leaves out a filter that doesn't apply to the state: `person` outside Waiting, and `outcome` and
    `since` outside Resolved. It turns `since` into the local midnight 0, 6 or 29 days before `now`, so the query
    key stays put within a day.
  - The same module memory holds, per state, the selected row's key and the list's `scrollTop`.
    `inbox-selection.ts` stays pure.
- **`nextSelection`:**
  - the stored key, when it's present;
  - else the row now at `lastIndex`, clamped to the list;
  - else null.

  A list key change (a search or a filter, state row 14) calls it with index 0.
- **`InboxRowList`.**
  - It's a Mantine `ScrollArea` marked `data-inbox-list`, with `useVirtualizer` (fixed `ROW_HEIGHT_PX`, overscan
    10, `getItemKey` = the row's key). Write it by hand, as `conversation-list.tsx` does, because the compiler
    skips a component that calls `useVirtualizer`.
  - It calls `onNearEnd` when the last virtual index is within 10 of `rows.length`.
  - While `loadingMore`, a static placeholder row follows the rows. With `moreError`, the placeholder says
    "Couldn't load more". The next near-end retries (state row 26).
  - The list is `role="listbox"`, named by `label`. Each row is an `option` with `aria-selected` and
    `data-inbox-row`.
  - The look is §1.3's "Rows" and §4.1's "A row": draw it through the theme's tokens, as the Global constraints say.

## Steps

1. **Red.** `inbox-selection.test.ts`, a table:
   - the key is present → it stays;
   - the selected row left the middle → the next row;
   - it left the end → the new last row;
   - the list is empty → null;
   - nothing was selected yet → the first row;
   - a new list without the key, at index 0 → the first row.

   `inbox-search.test.ts`:
   - each key kept when it parses and dropped when it doesn't;
   - the `since` presets give local midnight today, 6 days back and 29 days back for a fixed `now`;
   - `person` is dropped in Open.

   Implement, then commit `inbox-search.ts`, `inbox-selection.ts` and their tests, with the message
   `feat(desktop): the inbox's search and selection rules`. The body carries:

   ```
   Value: protects=answering selects the next row, and the URL's filters reach the query;
     fails_when=selection jumps to the top or off the list when a row leaves, or a date preset
     changes the query key every render; why_new=the rule lived inside OpenInbox; no_claim=the keys
   ```
2. **Red.** `inbox-row-list.test.tsx`, with the setup's 600 px `ScrollArea` viewport:
   - **budget:** 10,000 rows → fewer than 100 `[data-inbox-row]`. Set the viewport's `scrollTop` to row 5,000's
     offset and fire `scroll` → row 5,000 is in the DOM, still under 100;
   - **near end:** with 30 rows and `hasMore`, scrolling to the bottom calls `onNearEnd`;
   - `loadingMore` → one placeholder after the rows;
   - `moreError` → the placeholder says "Couldn't load more".

   Implement, then commit the list and its test, with the message `feat(desktop): a virtualised inbox row list`.
   The body carries:

   ```
   Value: protects=a list of 10,000 keeps under 100 rows in the DOM and loads on scroll;
     fails_when=virtualisation breaks or the next page never loads; why_new=no Inbox list was
     virtualised; no_claim=60 fps, which only the running app shows
   ```
3. Each time, run `pnpm --filter @10db/desktop exec vitest related src/views/inbox/inbox-search.ts
   src/views/inbox/inbox-selection.ts src/views/inbox/inbox-row-list.tsx --run --maxWorkers=2`, then typecheck and
   lint the desktop.
