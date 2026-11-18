# Task 6c: desktop — coming back, focus, prefetch and the screen frame's panel

**Spec:** app shell spec:
- §1.4 Panel lists and performance: "Selection, scroll position and the open filter survive switching sections
  and coming back";
- §3 Keyboard ("Focus");
- §4.1 Inbox, "Performance": "The detail loads on selection", "j/k prefetches the next row's detail".

**State rows:** 23 (the view's half), 25.

## Files

- Modify:
  - `apps/desktop/src/views/inbox/inbox-view.tsx` and `open-content.tsx`;
  - `apps/desktop/src/views/inbox/inbox-view.test.tsx`;
  - `apps/desktop/src/shell/rail.tsx`, one hunk: the Inbox item's `<Link>` gets `search={lastInboxSearch.get()}`;
  - `apps/desktop/src/screens/render-layout.tsx`, plus the render-mode Inbox test. Find it with
    `grep -rln "ScreenName.Inbox\|'/inbox'" apps/desktop/src/screens`.

## Interfaces

Call these, from Tasks 5 and 6a, and from M1:

```ts
export const lastInboxSearch: { get(): InboxSearch; set(search: InboxSearch): void };   // module memory
export function useCardContext(item: InboxItemDto | null): UseQueryResult<InboxCardContextDto>;   // questions only
export function Panel({ section, children }: { readonly section: RailSection; readonly children: ReactNode }): ReactNode;
```

## What to build

- **Coming back.**
  - `InboxView` writes each search it shows to `lastInboxSearch`, so the rail brings the builder back to it.
  - On mount, it restores the state's stored selected key and `scrollTop` from 6a's module memory, and stores them
    on change.
  - A list that was marked stale while hidden (Task 5) refetches on mount with its old rows up. The selection
    follows its key, else its index.
- **Focus.** Arriving from the rail puts focus on the selected row's `option`, so `j`/`k` work at once. A click or
  a Tab elsewhere is left alone, and the panel never takes focus otherwise.
- **Prefetch.** On a selection change, prefetch what the next row's content reads:
  - for a question, its `useCardContext` query;
  - for a check, the `useWorkstreamChanges` query that `CheckCard` reads.
- **The screen frame's panel.** `RenderLayout` gets a panel host only while a section registers a panel. It tracks
  `registerPanel` as `AppFrame` does, and draws the column only then, so a picture of Board or a task keeps its
  full width. If Task 10 already added this, reuse it and add nothing.
  - The frame's lists, counts and context read the frame's project (Task 5), and its token may read
    `/inbox/:id/context` (Task 4).

## Steps

1. **Red,** in `inbox-view.test.tsx`:
   - open Open with `?project=` (Resolved and the search field come in Task 7), select the third row and scroll; go
     to Board, then back through the rail → the same state, filter, selected row and scroll (row 23). Task 7 adds a
     row for Resolved with a search;
   - while on Board, an event resolves a loaded Open card; coming back shows the list without it, and no lookup was
     made while away (row 23);
   - arriving from the rail, the selected row has focus, and `j` moves at once;
   - moving to a question row prefetches the next row's context read: the request is made before the next row is
     selected.
2. **Red,** in the render-mode test:
   - an Inbox screen frame draws the panel's list, and asks for the frame's project (row 25);
   - a Board screen frame has no panel column.
3. Implement, then make it green. Run `pnpm --filter @10db/desktop exec vitest related src/views/inbox
   src/shell/rail.tsx src/screens/render-layout.tsx --run --maxWorkers=2`, then typecheck and lint the desktop.
4. Commit the files above, with the message `feat(desktop): the inbox keeps its place, prefetches and draws in a
   screen frame`. The body carries:

   ```
   Value: protects=leaving and coming back keeps the Inbox where it was, and a screen frame shows its
     list; fails_when=the rail resets the filters, focus is lost, or every screen picture loses
     the panel's width; why_new=no test left the Inbox and came back; no_claim=scroll restored to
     the pixel in WebKit
   ```
