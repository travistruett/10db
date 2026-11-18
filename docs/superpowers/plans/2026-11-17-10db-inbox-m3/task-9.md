# Task 9: docs

**Spec:** app shell spec §9 Docs (the Inbox's part).
**State rows:** none.

## Files

- `DESIGN.md`, in these paragraphs:
  - **Navigation:** the Inbox has a panel now, and the panel examples name it;
  - **Counts:** the Open count is the daemon's, and a filter never changes it;
  - **Primary color:** Open's tags stay yellow, and Waiting's and Resolved's are gray;
  - a new **Inbox rows** line: two lines, 52 px, the kind tag in uppercase, `×n`, a hover Dismiss, and `e`.
- **A new decision,** `docs/architecture/decisions/2026-11-17-the-daemon-groups-inbox-rows-in-its-code-and-the-browser-groups-nothing.md`.
  It **amends** `2026-11-16-the-open-inbox-is-paged-by-row-and-the-daemon-groups-the-rows.md` and records:
  - The grouping rule is called by the daemon over the open cards' light columns, not written in SQL. A pass's
    Ready-page detail is a zod schema that SQL would copy.
  - The desktop places rows the daemon sends and never groups.
  - Pages are read by keyset (`after`), and the live list is patched one row per event through `card` lookups. A
    whole refetch happens only on reconnect, on a Slack connection change, or after a failed lookup.
  - A grouped row matches a search when any of its cards does.
  - No index is added yet.
  - Why: the alternatives turned down were SQL grouping (it drifts from the schema) and refetching every loaded
    page per event.
- `apps/desktop/src/views/inbox/AGENTS.md`: rewrite it for the panel:
  - the route and its search, `lastInboxSearch`;
  - rows and `KIND_TAGS`;
  - the content per state;
  - the keys (`data-inbox-list`, `e`, ⌘F);
  - the live merge (`daemon/inbox-live.ts`);
  - counts (`useInboxCount`);
  - the remaining readers of `GET /inbox`.

  Drop the tables, `InboxTable`, `row-keys` and `splitInbox`.
- `apps/desktop/src/shell/AGENTS.md`: "today only Settings has a panel" becomes "Settings and the Inbox". Add a line
  that `RenderLayout` has a panel host.
- `apps/desktop/src/views/settings/AGENTS.md:28`: the `splitInbox` mention now names the daemon's placement rule
  (`InboxPlacement`).
- `apps/daemon/src/inbox/AGENTS.md`: check it against Task 4's notes.

## Steps

1. Write the files above. The repo's decision-link test needs every cited decision file to exist.
2. Run `pnpm --filter @10db/repo-checks exec vitest run --maxWorkers=2`.
   Expected: green.
3. Commit the files above, with the message `docs: the inbox on the panel, and where its rows are grouped`. The
   body needs no value card.
