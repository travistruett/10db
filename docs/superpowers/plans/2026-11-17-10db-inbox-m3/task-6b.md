# Task 6b: desktop — Open on the panel, its rows, content and keys

**Spec:** app shell spec:
- §1.3 The panel ("Head", "Rows");
- §3 Keyboard ("Inbox");
- §4.1 Inbox:
  - "The panel's head": the segmented control and its counts;
  - "A row": Open's lines, the grouped "×n", the hover Dismiss and `e`;
  - "The content": Open, "Open, where it helps", and the Open empty state;
  - "Performance": "The detail loads on selection";
- §8 Tests: "j/k move the panel's selection, and answering selects the next row".

Also the mockups' frame 3.

**State rows:** 1, 2, 3, 15, 16, 17, 21, 24, and 26 (the keys' half).

This is one vertical slice through `renderWithDaemon` (MSW). Waiting and Resolved keep today's tables as their
content until Task 7, so the branch works at every commit.

## Files

- Create, in `apps/desktop/src/views/inbox/`:
  - `inbox-row-item.tsx`;
  - `inbox-panel.tsx`;
  - `open-content.tsx`;
  - `card-context.tsx`.
- Modify, in the same folder:
  - `inbox-view.tsx`, rewritten;
  - `inbox-card.tsx`: a `framed?: boolean` prop, default `true`. The `!selected` collapsed branch goes, since only
    the Inbox drew it. `selected` stays in the props for its other callers;
  - `system-card-list.tsx`: export `SystemCardView` with `framed`;
  - `pass-ready-row.tsx`: its expanded body is the content, and its collapsed row goes;
  - `use-inbox-keys.ts`;
  - `inbox-shortcuts.tsx`;
  - `inbox-view.test.tsx`, `pass-ready-row.test.tsx` and `system-card-list.test.tsx`.
- Modify `apps/desktop/src/router.tsx`, the `/inbox` route only: `validateSearch: inboxSearch`. The view reads
  `state` from the URL.
- Delete `views/inbox/inbox-rows.ts` and `inbox-rows.test.ts`. Their rule and rows moved to contracts in Task 1,
  and their placement rows to Tasks 2 and 4. `grep -rn "inbox-rows'" apps/desktop/src` finds nothing.

## Interfaces

Call these, from Tasks 1, 5 and 6a, and from M1:

```ts
export function isDismissable(card: Pick<InboxItemDto, 'kind' | 'options'>): boolean;   // moved from the desktop
export function useInboxRows(list: InboxList): {
  rows: readonly InboxRow[]; hasMore: boolean; loadingMore: boolean; loadMore: () => void;
  isPending: boolean; error: Error | null; moreError: Error | null };
export function useInboxCount(state: 'open' | 'waiting'): number | undefined;   // no filters, pageSize 1; undefined while loading
export function useCardContext(item: InboxItemDto | null): UseQueryResult<InboxCardContextDto>;   // questions only
export function fetchRowOf(client: DaemonClient, list: InboxList, card: InboxItemId): Promise<InboxRow | null>;
export function dropCard(queryClient: QueryClient, cardId: InboxItemId): void;   // through each list's chain
export function inboxSearch(search: Record<string, unknown>): InboxSearch;   // keeps each key only when it parses
export function inboxList(search: InboxSearch, now: Date): InboxList;   // since → local midnight, 0, 6 or 29 days back
export function nextSelection(keys: readonly string[], selected: string | null, lastIndex: number):
  { readonly key: string | null; readonly index: number };
export function InboxRowList<T extends { readonly key: string }>(props: {
  readonly label: string; readonly rows: readonly T[]; readonly selected: string | null;
  readonly hasMore: boolean; readonly loadingMore: boolean; readonly moreError: Error | null;
  readonly onNearEnd: () => void; readonly renderRow: (row: T, selected: boolean) => ReactNode }): ReactNode;
export function Panel({ section, children }: { readonly section: RailSection; readonly children: ReactNode }): ReactNode;
export function TitleRow({ title, meta, switcher, actions, lines }: { readonly title: ReactNode;
  readonly meta?: ReactNode; readonly switcher?: ReactNode; readonly actions?: ReactNode;
  readonly lines?: 1 | 2 }): ReactNode;
```

`useOpenInboxCount(): number` (Task 5) reads 0 while it loads.

## What to build

- **The title row** is `TitleRow`. Its title is "Inbox". Its meta is "n open" from `useOpenInboxCount`, left out at
  0. Its actions hold the `?` keys button. `PageIntro` and the `Tabs` go.
- **The panel** is `Panel section="inbox"`, drawn by `inbox-panel.tsx` as §1.3 "Head" and §4.1 "The panel's head"
  say:
  - **The head's first row** is the section's name, "Inbox". Task 7 adds search and the filter menu there.
  - **The second row** is a `SegmentedControl` (`aria-label="Inbox state"`) with Open, Waiting and Resolved, and
    `CountBadge`s:
    - Open is `useOpenInboxCount`, in attention tone, shown above 0;
    - Waiting is `useInboxCount('waiting')`, neutral, shown only while Slack is connected and once loaded;
    - Resolved has none.
  - Changing the state navigates with `state`.
- **Open's list** is `InboxRowList` labelled "Inbox". It starts with 10db's own cards as rows keyed
  `system:<card.key>`, then `useInboxRows(inboxList(search, now))`'s rows. `now` is `useNow()`, rounded to the day
  by `inboxList`.
- **A row** (`inbox-row-item.tsx`) follows §4.1 "A row", with its padding, radius and selected fill as that section
  and §1.3 "Rows" say, through the theme's tokens:
  - **Line 1:**
    - the kind tag, from `KIND_TAGS`, exported here as an exhaustive `Record<InboxKind, string>`: Question → ASK,
      Permission → ALLOW, Proposal → PROPOSAL, Review → REVIEW, Flag → FLAG, Check → CHECK, Plan → PLAN,
      PlaybookMoveReport → SETTINGS;
    - the tag is yellow in Open (DESIGN.md's rule) and gray elsewhere;
    - the title, with `×n` after it for a row of n;
    - the age, by `shortAgo`.
  - **Line 2 in Open:**
    - the project (`ProjectLabel`), then the body's first line;
    - for a chat's card, the session's title (`SessionBadge`'s "Chat" and title) in place of the body's line;
    - a pass's row reads `passReadyTitle(n)`.
  - The "n identical flags" words move to the content, where `InboxCard` already says them.
  - A dismissable row shows Dismiss (Dismiss All for ×n) on hover and on focus, and its error on the row.
- **The content** (`open-content.tsx`) shows the selected row:
  - `InboxCard` with `framed={false}`, `selected`, and `count` the row's size;
  - a pass's Ready pages (`PassReadyRow`'s body);
  - or `SystemCardView` with `framed={false}`.

  For a question, `card-context.tsx` adds "Last messages" from `useCardContext`: up to three lines, "You:" or
  "Agent:" and the text, rendered as text only. Nothing shows while it loads, and nothing when it's empty.
  The draft, note, record, dismiss and Send logic of today's `OpenInbox` moves here unchanged, still keyed by row
  key.
- **Selection.** `nextSelection` over the shown keys, with the last index kept in state.
  - `j`/`k` past the loaded end with `hasMore` call `loadMore`. One pending move is applied when the page lands
    (rows 15-16).
  - At the true end, `onMove` answers false (row 17).
  - If `moreError` arrives, the pending move is dropped (row 26).
- **Answering.**
  - On success, `dropCard(id)`.
  - **On a 409 (row 21):**
    - a notice, "This card was already answered.", shows above the content;
    - the card's `fetchRowOf` lookup runs through the chain, via `applyInboxEvent`'s path, so the row leaves;
    - the next row is selected;
    - the notice stays until the selection moves again.

    Any other error shows on the card, as today.
- **Keys:**
  - `use-inbox-keys.ts`'s `inScope` accepts targets inside `[data-inbox-list]` too;
  - `e` dismisses the selected row when it's dismissable (`onDismiss`);
  - `inbox-shortcuts.tsx` lists `e`;
  - the rest is unchanged.
- **The empty state:** "Nothing needs you", in the content.

## Steps

1. **Red.** Move `inbox-view.test.tsx` onto the panel.
   - Its `inbox(items)` helper serves the rows through `serveInboxRows`, and still serves `GET /inbox` for the other
     readers.
   - Every key, draft, flag, permission, knowledge and pass test keeps its assertions. Only the way it finds a row
     changes: `getByRole('option', { name })` in the "Inbox" listbox, and the card in the content.
   - "selects a collapsed card when clicked" becomes "a click on a row shows it in the content".
   - "explains a card answered elsewhere and refreshes the list" keeps "This card was already answered." and adds
     that the row leaves and the next is selected (row 21).
2. **Red.** Add these to `inbox-view.test.tsx`:
   - answering the second of three rows selects the third (row 1);
   - an `inbox.changed` event resolving the selected card selects the next and drops its draft (row 2);
   - Dismiss All on a ×3 row sends three answers, and the row leaves (row 3);
   - `e` on a selected flag dismisses it;
   - `j` on the last of 50 loaded rows reads page two, shows a placeholder, then selects row 51 (rows 15-16);
   - `j` at the true end does nothing (row 17);
   - page two answering 500 → "Couldn't load more", and the selection stays (row 26);
   - a system card leaving selects the next row (row 24);
   - a question shows its last messages, and a flag reads no context;
   - a chat's card shows its session's title on line 2;
   - "Nothing needs you" with no rows.

   In `pass-ready-row.test.tsx` and `system-card-list.test.tsx`, keep the assertions and render the content forms.
3. Implement, then make it green. Run `pnpm --filter @10db/desktop exec vitest related src/views/inbox
   src/router.tsx --run --maxWorkers=2`, then typecheck and lint the desktop.
4. Commit with the message `feat(desktop): the open inbox on the panel`, naming every path, the deletions
   included. The body carries:

   ```
   Value: protects=Open's rows, keys, answers and dismissals on the panel; fails_when=j/k, digits,
     Enter, e or answering act on the wrong row, a 409 leaves a dead card selected, or the next page
     never loads from the keys; why_new=OpenInbox's tests drew a whole list; no_claim=Waiting and
     Resolved (task 7)
   ```
