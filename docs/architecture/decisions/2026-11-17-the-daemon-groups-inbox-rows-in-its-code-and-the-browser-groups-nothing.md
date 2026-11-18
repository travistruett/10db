# The daemon groups Inbox rows in its code, and the browser groups nothing

- **Date:** 2026-11-17
- **Amends:** `decisions/2026-11-16-the-open-inbox-is-paged-by-row-and-the-daemon-groups-the-rows.md`

## Decision

The earlier record has the desktop call the grouping rule and the daemon's query use the same rule. This one
moves all of it to the daemon and says how the desktop keeps what it was sent current.

- The daemon calls the grouping rule (`inboxRowKey` in `packages/contracts`) over the light columns of every
  open card, in code (`openRowsPage` in `packages/db/src/store/inbox-open-rows.ts`). It is not written in SQL:
  a pass's Ready-page detail is a zod schema, and SQL would hold a copy of it.
- The desktop places the rows the daemon sends and never groups. A page's `rows` name the cards each row
  holds; `items` carries the cards.
- Pages are read by keyset (`after`, the last row's sort), not by page number. The live list is patched one
  row per event through `card` lookups (the page holding only that card's row). A whole refetch happens only
  on reconnect, on a Slack connection change, or after a failed lookup.
- A list nobody is looking at is marked stale on an event and reloads when it is shown. A lookup waits for a
  fetch in flight, so an event that races a page is never lost.
- A grouped row matches a search when any of its cards does.
- No index is added yet: every page filters on `state` (`inbox_state_idx`), and search is `LIKE`.

## Why

- SQL grouping was turned down because it drifts from the schema: the rule reads a detail that zod owns, and a
  second copy in SQL would disagree with it the first time the detail changes.
- Refetching every loaded page on every event was turned down: a busy Inbox raises events faster than
  pages load, and one row's change is one small lookup.
- Grouping in the browser was already turned down by the earlier record for its seams; a row the daemon sends
  is the only row there is, so the count, the rows and the total agree.
