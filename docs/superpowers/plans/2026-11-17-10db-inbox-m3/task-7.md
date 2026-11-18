# Task 7: desktop — Waiting and Resolved on the panel, search and filters

**Spec:** app shell spec:
- §1.4 Panel lists and performance (rows kept while a filter changes);
- §3 Keyboard (⌘F);
- §4.1 Inbox: "The panel's head" (search, the filter menu, the URL), "A row" (Waiting's and Resolved's second
  line), "The content" (Waiting, Resolved, the empty states and No matches), "Performance" ("Search and filters
  run on the server");
- §8 Tests ("A filter change keeps the old rows until the new page arrives").

**State rows:** 14, 22.

## Files

- Create, in `apps/desktop/src/views/inbox/`:
  - `inbox-filter-menu.tsx`;
  - `waiting-content.tsx`;
  - `resolved-content.tsx`.
- Modify, in the same folder:
  - `inbox-panel.tsx`: search and the filter menu;
  - `inbox-view.tsx`;
  - `inbox-row-item.tsx`: Waiting's and Resolved's second lines;
  - `waiting-row.tsx`: keep `WhoCell`'s words, `WaitingDetail` and the Take Back modal. Remove `WaitingActions`'
    table cell and `ActionsCell`;
  - `resolved-detail.tsx`, unchanged in what it shows;
  - `use-inbox-keys.ts`: ⌘F.
- Rewrite `waiting-inbox.test.tsx` onto the panel, and move the resolved tests of `inbox-view.test.tsx` onto the
  panel in place.
- Delete:
  - `views/inbox/inbox-table.tsx`;
  - `views/inbox/waiting-inbox.tsx`;
  - `views/inbox/resolved-inbox.tsx`;
  - `views/inbox/row-keys.ts` and `row-keys.test.ts` (only the tables used them);
  - from `apps/desktop/src/test/inbox-page-fixtures.ts`, `tableRows` and `openEveryRow`. `serveInboxPage` stays for
    the chat tab's test.

  `shell/table-pager.ts` and `shell/column-header.tsx` stay: Knowledge and Settings use them.

## Interfaces

Call these, from Tasks 5 and 6:

```ts
export interface InboxSearch { readonly state?: InboxListState; readonly q?: string; readonly project?: ProjectId;
  readonly kind?: InboxKind; readonly outcome?: InboxOutcome; readonly person?: PersonId; readonly since?: InboxSince }
export function inboxList(search: InboxSearch, now: Date): InboxList;   // since → local midnight, 0, 6 or 29 days back
export function useInboxRows(list: InboxList): {
  rows: readonly InboxRow[]; hasMore: boolean; loadingMore: boolean; loadMore: () => void;
  isPending: boolean; error: Error | null };
export function InboxRowList<T extends { readonly key: string }>(props: {
  readonly label: string; readonly rows: readonly T[]; readonly selected: string | null;
  readonly hasMore: boolean; readonly loadingMore: boolean; readonly onNearEnd: () => void;
  readonly renderRow: (row: T, selected: boolean) => ReactNode }): ReactNode;
export function nextSelection(keys: readonly string[], selected: string | null, lastIndex: number):
  { readonly key: string | null; readonly index: number };
```

## What to build

- **Search.** A `TextInput` in the panel's head (`aria-label="Search the Inbox"`), with a search icon. ⌘F focuses it
  while the Inbox is shown. It holds its own text and writes `q` to the URL 250 ms after the last keystroke
  (`useDebouncedValue`). Clearing it removes `q`.
- **The filter menu** is a "Filter" `Menu` button in the head, showing a dot when a filter is set. It holds:
  - Project: today's `ProjectFilter` choices;
  - Kind: Any Kind and each `KIND_LABELS` entry;
  - Waiting: With (Anyone, and each person from `usePeople`, builder excluded);
  - Resolved: Outcome (Any Outcome, Answered, Closed by 10db, Slack Answer) and When (Any Time, Today, Last 7 Days,
    Last 30 Days → `since`);
  - Clear Filters.

  Each filter writes to the URL, and a check marks the chosen item on the right (DESIGN.md, Checks). A filter that
  doesn't apply to the state is left out of `inboxList`.
- **10db's own cards** are hidden while `kind` or `q` is set.
- **The rows kept.** A change of `q` or a filter changes the list key. `useInboxRows`' `keepPreviousData` holds the
  old rows until the first new page arrives. The selection keeps its key if the new rows hold it, else takes the
  first row (`nextSelection` with index 0).
- **Waiting's rows.**
  - Line 1: the kind tag (gray), the title, and the age since sent.
  - Line 2: the project and "Waiting on <recipients> · <shortAgo(sentAt)>". The recipients come from `WhoCell`'s
    rule, joined with " + ".
  - Its content (`waiting-content.tsx`): who it waits on and since when, then today's `WaitingDetail`, then a
    Take It Back button that opens `TakeBackModal`, with the thread link.
  - Without a Slack connection, the content says "Slack isn't connected, so questions sent there wait in Open."
    and the list asks for no page, as today.
- **Resolved's rows.**
  - Line 2: the project and "<outcome words> · <answer words>". The outcome words are `OUTCOME_LABELS`, moved here
    from `resolved-inbox.tsx`. The answer is the option's label through `optionLabel`, or "Dismissed".
  - Its content (`resolved-content.tsx`): the title and today's `ResolvedDetail`.
- **Empty states:**
  - "Nothing is waiting on anyone" (Waiting);
  - "Nothing resolved yet" (Resolved);
  - with `q` or a filter set, "No matches" and a Clear Filters button, in every state.

## Steps

1. **Red.** Rewrite `waiting-inbox.test.tsx` as panel tests through `serveInboxRows`:
   - the rows read "Waiting on Mark Ellis · 3h";
   - a click shows the message, the conversation and Answer Myself;
   - Take It Back asks first, then posts;
   - with Slack not connected, the content explains and no page is asked for;
   - the With filter sends `person`.
2. **Red.** Move the resolved tests in `inbox-view.test.tsx` onto the panel, keeping their assertions on the
   detail:
   - the first page asks `state=resolved&pageSize=50` with no `page`;
   - rows are newest first;
   - a click shows how it closed: the Slack answer's lines, 10db's reason, the failed send's words, and each
     principle link;
   - Outcome and When send `outcome` and `since`;
   - the project filter goes in the URL and the query;
   - "Nothing resolved yet".
3. **Red.** New tests in the same files:
   - typing "retry" sends one query with `q=retry` after the debounce, not one per keystroke;
   - while it's in flight, the old rows stay in the listbox (§8);
   - `q` set and no rows → "No matches", and Clear Filters empties the URL's `q` and filters;
   - ⌘F focuses the search;
   - the URL `/inbox?state=resolved&q=x&kind=flag` opens Resolved with the search field and the menu showing them.
4. Implement, then make it green. Run `pnpm --filter @10db/desktop exec vitest related src/views/inbox --run
   --maxWorkers=2`. Then typecheck and lint the desktop, and `grep -rn "inbox-table\|row-keys\|ResolvedInbox\|
   WaitingInbox\|tableRows\|openEveryRow" apps/desktop/src` finds nothing.
5. Commit with the message `feat(desktop): waiting and resolved on the inbox panel, with search and filters`,
   naming every path, the deletions included. The body carries:

   ```
   Value: protects=search and filters run on the daemon and keep the old rows up while they load;
     fails_when=a keystroke per request, a flicker to empty, or a filter that never reaches the
     query; why_new=the tables filtered by column headers; no_claim=search speed at scale
   ```
