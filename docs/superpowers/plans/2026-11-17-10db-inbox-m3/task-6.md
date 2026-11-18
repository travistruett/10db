# Task 6: desktop — Open on the panel, and its content

**Spec:** app shell spec:
- §1.3 The panel ("Head", "Rows");
- §1.4 Panel lists and performance;
- §3 Keyboard ("Inbox", "Focus");
- §4.1 Inbox: "The panel's head" (the segmented control and its counts), "A row" (Open's lines, the grouped "×n",
  the hover Dismiss and `e`), "The content" (Open, Open where it helps, the Open empty state), "Performance"
  ("Lazy load on scroll", "Virtualised rows", "The detail loads on selection", "Budget");
- §8 Tests, the Inbox's rendered rows.

The mockups' frame 3.

**State rows:** 1, 2, 3, 15, 16, 17, 18, 21, 23, 24, 25.

This is one vertical slice through `renderWithDaemon` (MSW), in a handful of commits. Waiting and Resolved keep
today's tables as their content until Task 7, so the branch works at every commit.

## Files

- Create, in `apps/desktop/src/views/inbox/`:
  - `inbox-search.ts` and its test;
  - `inbox-selection.ts` and its test;
  - `inbox-row-list.tsx` and its test;
  - `inbox-row-item.tsx`;
  - `inbox-panel.tsx`;
  - `open-content.tsx`;
  - `card-context.tsx`.
- Modify, in the same folder:
  - `inbox-view.tsx`, rewritten;
  - `inbox-card.tsx`: a `framed?: boolean` prop, default `true`. The `!selected` collapsed branch goes, since
    only the Inbox drew it. `selected` stays in the props for its other callers;
  - `system-card-list.tsx`: export `SystemCardView` with `framed`;
  - `pass-ready-row.tsx`: its expanded body is the content. Its collapsed row goes;
  - `use-inbox-keys.ts`;
  - `inbox-shortcuts.tsx`;
  - `inbox-view.test.tsx`, `pass-ready-row.test.tsx` and `system-card-list.test.tsx`.
- Shared files, one hunk each:
  - `apps/desktop/src/router.tsx`: `validateSearch: inboxSearch` on `/inbox`;
  - `apps/desktop/src/shell/rail.tsx`: the Inbox item's `<Link>` gets `search={lastInboxSearch.get()}`;
  - `apps/desktop/src/screens/render-layout.tsx`: a 260 px panel host in its slots.
- Delete `views/inbox/inbox-rows.ts` and `inbox-rows.test.ts` (Task 1 moved their rule and rows).

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
export const ROW_HEIGHT_PX = 52;
export function InboxRowList<T extends { readonly key: string }>(props: {
  readonly label: string; readonly rows: readonly T[]; readonly selected: string | null;
  readonly hasMore: boolean; readonly loadingMore: boolean; readonly onNearEnd: () => void;
  readonly renderRow: (row: T, selected: boolean) => ReactNode }): ReactNode;
```

Call these, from Tasks 1 and 5:

```ts
export function isDismissable(card: Pick<InboxItemDto, 'kind' | 'options'>): boolean;   // moved from the desktop
export function useInboxRows(list: InboxList): {
  rows: readonly InboxRow[]; hasMore: boolean; loadingMore: boolean; loadMore: () => void;
  isPending: boolean; error: Error | null };
export function useInboxCount(state: 'open' | 'waiting'): number | undefined;   // no filters, pageSize 1
export function useCardContext(item: InboxItemDto | null): UseQueryResult<InboxCardContextDto>;   // questions only
export function dropCard(queryClient: QueryClient, cardId: InboxItemId): void;
```

## What to build

- **The route.** The search lives in the URL, through `inboxSearch`. `InboxView` writes each search it shows
  to `lastInboxSearch`, so the rail brings the builder back to it. The selected row's key and the list's
  `scrollTop` are kept per state in the same module memory as `lastInboxSearch`, in `inbox-search.ts`.
  `inbox-selection.ts` stays pure. Coming back restores both (§1.4).
- **The title row** holds `TitleRow title="Inbox"`, a meta of "n open" from `useOpenInboxCount`, and the `?` keys
  button in its actions. `PageIntro` and the `Tabs` go.
- **The panel** is `Panel section="inbox"`, drawn by `inbox-panel.tsx`:
  - the head's first row is "Inbox" (14 px, weight 600). Task 7 adds search and the filter menu there;
  - the second row is a `SegmentedControl` (`aria-label="Inbox state"`) labelled Open, Waiting and Resolved,
    with `CountBadge`s:
    - Open is `useOpenInboxCount`, in attention tone;
    - Waiting is `useInboxCount('waiting')`, neutral, shown only while Slack is connected;
    - Resolved has none.
  - Changing the state navigates with `state`.
- **The list** is `InboxRowList` inside a Mantine `ScrollArea`, marked `data-inbox-list`:
  - It uses `useVirtualizer` with a fixed 52 px size, overscan 10 and `getItemKey` = the row's key. Write the
    component by hand, as `conversation-list.tsx` does, because the compiler skips a component that calls
    `useVirtualizer`.
  - It calls `onNearEnd` when the last virtual index is within 10 of `rows.length`.
  - While `loadingMore`, one placeholder row (52 px, static) follows the rows.
  - Each row carries `data-inbox-row`. The list is `role="listbox"`, named by `label`, and each row is an
    `option` with `aria-selected`.
- **Open's rows** start with 10db's own cards, as rows keyed `system:<card.key>`. They show under a project
  filter, and Task 7 hides them under a kind or a search. Then come `useInboxRows(inboxList(search))`'s rows.
- **A row** (`inbox-row-item.tsx`, the §4.1 "A row" lines):
  - **Line 1:**
    - the kind tag, uppercase from `KIND_TAGS` (exported here, an exhaustive `Record<InboxKind, string>`), at
      9.5 px, weight 700, yellow in Open and gray elsewhere;
    - the title, weight 500, with `×n` after it for a row of n;
    - the age, dim, by `shortAgo`.
  - **Line 2 in Open** is the project (`ProjectLabel`) and the body's first line. A pass's row reads
    `passReadyTitle(n)`.
  - **A dismissable row** shows Dismiss (or Dismiss All) on hover and on focus. Its error shows on the row.
  - Tags: Question → ASK, Permission → ALLOW, Proposal → PROPOSAL, Review → REVIEW, Flag → FLAG, Check → CHECK,
    Plan → PLAN, PlaybookMoveReport → SETTINGS.
- **The content** (`open-content.tsx`) shows the selected row:
  - `InboxCard` with `framed={false}`, `selected`;
  - a pass's Ready pages (`PassReadyRow`'s body);
  - or a `SystemCardView` with `framed={false}`.

  For a question, `card-context.tsx` adds "Last messages", from `useCardContext`: up to three lines, "You:" or
  "Agent:" and the text, as text only. Nothing shows while it loads, and nothing when it's empty. The draft, note,
  record, dismiss and Send logic of today's `OpenInbox` moves here unchanged, still keyed by row key.
- **Selection.** `nextSelection` gives the selected key from the row keys, the stored key and the last index:
  - the stored key, if it's present;
  - else the row now at the last index, clamped;
  - else null.

  `j`/`k` past the loaded end with `hasMore` call `loadMore`, and the move is applied once the page lands (rows
  15-17). On a selection change, prefetch the next row's content reads: `useCardContext`'s query for a question,
  and the `useWorkstreamChanges` query `CheckCard` reads for a check.
- **Answering.** On success, `dropCard(id)`. On a 409, as today, plus `dropCard`.
- **Keys:**
  - `use-inbox-keys.ts`'s `inScope` accepts targets inside `[data-inbox-list]` too;
  - `e` dismisses the selected row when it's dismissable (`onDismiss`);
  - `inbox-shortcuts.tsx` lists `e`;
  - the rest is unchanged.
  - Opening the Inbox from the rail puts focus on the selected row's option, where it was before (§3, "Focus"),
    so `j`/`k` work at once. Add this as a row in the view test.
- **The empty state:** "Nothing needs you", centred in the content. The list's own space stays empty.
- **`render-layout.tsx`** gets a panel host, a 260 px column left of its content. A screen frame then draws the
  Inbox's list.

## Steps

1. **Red, pure.** `inbox-selection.test.ts`, a table:
   - the key is present → it stays;
   - the selected row left the middle → the next row;
   - it left the end → the new last row;
   - the list is empty → null;
   - nothing was selected yet → the first row.

   `inbox-search.test.ts`: each key kept when it parses and dropped when it doesn't; `since` presets give local
   midnight today, 6 days back and 29 days back for a fixed `now`. Then implement both and commit. The body
   carries:

   ```
   Value: protects=answering selects the next row; fails_when=selection jumps to the top or off the
     list when a row leaves; why_new=the selection rule lived inside OpenInbox; no_claim=the keys
   ```
2. **Red, rendered.** `inbox-row-list.test.tsx`, with the setup's 600 px `ScrollArea` viewport:
   - **budget:** 10,000 rows → fewer than 100 `[data-inbox-row]`. Set the viewport's `scrollTop` to 5,000 × 52
     and fire `scroll` → row 5,000 is in the DOM, still under 100;
   - **near end:** with 30 rows and `hasMore`, scrolling to the bottom calls `onNearEnd` once;
   - `loadingMore` → one placeholder after the rows.

   Implement it and commit. The body carries:

   ```
   Value: protects=a list of 10,000 keeps under 100 rows in the DOM and loads on scroll;
     fails_when=virtualisation breaks or the next page never loads; why_new=no Inbox list was
     virtualised; no_claim=60 fps, which only the running app shows
   ```
3. **Red, the view.** Move `inbox-view.test.tsx` onto the panel:
   - its `inbox(items)` helper serves the rows through `serveInboxRows`, and still serves `GET /inbox` for the
     other readers;
   - every key, draft, flag, permission, knowledge and pass test keeps its assertions. Only the way it finds a row
     changes: `getByRole('option', { name })` in the "Inbox" listbox, and the expanded card in the content;
   - "selects a collapsed card when clicked" becomes "a click on a row shows it in the content".

   Add these:
   - answering the second of three rows selects the third (row 1);
   - an `inbox.changed` event resolving the selected card selects the next one and drops its draft (row 2);
   - Dismiss All on a ×3 row sends three answers and the row leaves (row 3);
   - `e` on a selected flag dismisses it;
   - `j` on the last of 50 loaded rows reads page two, shows a placeholder, then selects row 51 (rows 15-16);
   - `j` at the true end does nothing (row 17);
   - a system card leaving selects the next row (row 24);
   - a question shows its last messages, and a flag reads no context;
   - leaving for Board and coming back via the rail keeps the state, search and selected row (row 23);
   - "Nothing needs you" with no rows.

   In `pass-ready-row.test.tsx` and `system-card-list.test.tsx`, keep the assertions and render the content forms.
   Add a render-mode row for a screen frame, wherever the existing render-mode Inbox test lives (find it with
   `grep -rn "ScreenName.Inbox\|/inbox" src/screens`): the frame draws the panel, and the list asks for the frame's
   project (row 25).
4. Implement, then make it green. Run `pnpm --filter @10db/desktop exec vitest related src/views/inbox
   src/router.tsx src/shell/rail.tsx src/screens/render-layout.tsx --run --maxWorkers=2`, then typecheck and lint
   the desktop.
5. Commit with the message `feat(desktop): the open inbox on the panel, paged and virtualised`, naming every
   path, the deletions included. The body carries:

   ```
   Value: protects=Open's rows, keys, answers and dismissals on the panel; fails_when=j/k, digits,
     Enter, e or answering act on the wrong row, or the next page never loads from the keys;
     why_new=OpenInbox's tests drew a whole list; no_claim=Waiting and Resolved (task 7)
   ```
