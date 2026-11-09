# Knowledge lists are paged where they are read, and filtered, sorted and counted in the query

- **Date:** 2026-11-08
- **Amends:** `decisions/2026-11-08-knowledge-is-two-tabs-with-shelves.md`

## Decision

- **`GET /projects/:projectId/knowledge` answers one page and the total.** It takes `page` (from 1, default 1)
  and `pageSize` (default 25, at most 100) and answers `items` with `total` (how many match on every page),
  `page` (the page answered: a page past the end answers the last one) and `pageSize`. `limit` and `truncated`
  are gone: the total says what a cut-short answer said.
- **A shelf instead of `history`.** `shelf` is `current` (the default), `past` (superseded, retired and
  withdrawn; never current, never proposed) or `all` (every state, proposed included, what `history=1`
  answered). The values are `KnowledgeListShelf` in `@10db/contracts`; `PAST_KNOWLEDGE_STATES` is the one list
  of past states, which the query and the view share.
- **`kind` repeats.** Each value names decisions, every principle or one principle kind, and the list holds
  what any of them names, so the Type filter's choices narrow on the daemon.
- **`sort` and `dir`.** `sort` is `createdAt`, `kind` (policies, heuristics, beliefs, then decisions), `scope`
  (builder-wide, project, then area by name) or `state` (by the state's name), and `dir` is `asc` (the
  default) or `desc`; ties go to the newest, and every order ends on the id, so a row never moves between
  pages. With no `sort`, a search answers the best match first, each kind's best in turn, and a list without
  one the newest first. A `sort` applies with a search too. The Principles list asks for `kind` ascending
  unless a search is typed, as it showed before.
- **All of it is in SQL** (`pageKnowledge`, `packages/db/src/store/knowledge-list.ts`): both tables' matching
  rows in one `UNION ALL`, the shelf as the derived state in the `WHERE`, a search as a join on the FTS index's
  ranked rows with each kind's rank position from `row_number()`, then `ORDER BY`, `LIMIT` and `OFFSET`, and a
  `COUNT(*)` over the same rows. Only the page's records are read in full. A search has no cap: its total is
  every match.
- **The builder's `search_knowledge` tool pages too.** It takes `shelf`, `page` and `pageSize` in place of
  `history` and `limit`, and answers what the route answers.
- **The Knowledge view pages with the table's own pager.** Each list sends the shelf, kinds, sort, page and page
  size and shows `mantine-datatable`'s pager (25, 50 or 100 a page); a change of filter, search, shelf, sort or
  page size goes back to the first page, and the last page stays up while the next loads. Nothing is narrowed,
  sorted or counted in the browser. Pending, which reads `GET /projects/:id/proposals`, still narrows and sorts
  its proposals in the browser.
- `PROTOCOL_VERSION` is 7: the list's query and answer lost fields.

## Why

The builder's rule: any list that can grow without limit is paged where it is read. The server returns one page
and the total count, and filtering and sorting happen in the query, never by loading every record into the client
to filter, sort or count it. The lists read the first 500 records and narrowed, sorted and counted them in the
browser, so a project with more showed a list cut short.

Turned down:

- **Paging a search over a capped list of ranked ids.** Its total would be the cap, not the matches, and a deep
  page would need ever more ids; ranking inside the query pages a search like any other list.
- **Keeping `history` and `limit` beside the new parameters.** Nothing sends them once the view and the tool
  change, and two ways to say one thing would need rules for when they disagree.
- **Paging Pending now.** The proposals route serves every list of proposals, the Inbox's included; its paging is
  its own change.
