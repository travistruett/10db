# The Open inbox is paged by row, and the daemon groups the rows

- **Date:** 2026-11-16

## Decision

The Open list pages the grouped rows, not the cards. The daemon decides which cards share a row, and
`GET /inbox/page` with `state: open` returns one page of rows with `total` the number of rows.

- A row is what the list shows once: a card, identical dismissable flags of one project (same title and
  body), or the Ready pages of one Workbench pass. The grouping rule is one pure function in
  `packages/contracts` that gives a card its row key (`pass:<passId>`, `flags:<projectId, title, body>`, or
  the card's id). The desktop's `views/inbox/inbox-rows.ts` calls it, and the daemon's query uses the same
  rule, so the two cannot drift. A table test pins the keys.
- The query orders rows 10db's own system cards first, then by the first card of each row, as the Open list
  is ordered today. A page holds whole rows: every member card of a row comes with it, so a row's count is
  never cut by a page boundary.
- Project and kind are filters in the query. Every card in a row has one project and, apart from a pass's
  Ready pages (all `check`), one kind, so a row is never half inside a filter.
- The Open count in the tab, the sidebar badge and the menu bar is the `total` of the Open query with no
  filter and a page size of one, so it is the number of rows `openCount` gives today, and a filter on the
  list never changes it. The query applies the same placement rule as `splitInbox`: a card sent to someone
  while Slack is connected belongs to Waiting, and a card triage has not placed yet is in no count.
- Answering a card removes it from the cache and selects the next row in the loaded pages; the next page is
  fetched when the selection runs off the end of what is loaded.

## Why

- Grouping the cards of a page in the browser gives a wrong picture at every seam: a flag seen three times
  could show on page one with a count of two and again on page two with a count of one, and "Showing n of
  total" would count cards while the rows are fewer.
- One grouping rule used by the query and the view keeps the count, the rows and the total in agreement, and
  the badge no longer needs every open card in the browser (the paged-lists rule).
- Paging cards and grouping in the browser was turned down for the seams above. Loading every open card and
  grouping all of them, as the view does now, was turned down because the list can grow without limit.
