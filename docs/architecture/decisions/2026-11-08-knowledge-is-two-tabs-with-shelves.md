# Knowledge is two tabs with shelves, its lists are mantine-datatable tables, and the principle form asks for no topic key

- **Date:** 2026-11-08
- **Amends:** `decisions/2026-11-03-knowledge-is-a-top-level-view-with-three-tabs.md`

## Decision

- **Two tabs, each with shelves.** Knowledge has a Principles tab and a Decisions tab, with New Principle or New
  Decision on the tab row. The first column's filter picks what the list holds: Pending (principle proposals,
  with their count; principles only), Current, and Past (superseded, retired and withdrawn), and holds the
  search; the Scope column's filter holds the scope. A banner says when proposals wait. The Proposals tab and
  the History switch are gone.
- **Only principle proposals are under Pending.** A proposal of a task, a task change or a note is answered in the
  Inbox and no longer listed in Knowledge.
- **The lists are `mantine-datatable` tables** (pinned at 9.4.0, which supports Mantine 9). Columns resize and
  hide, and the layout is kept per list in the window's local storage; Kind, Scope, Date and State sort; Kind
  has a column filter. Clicking a row opens where it came from; the info button is gone. Kind is a coloured
  badge (orange policy, blue heuristic, gray belief), State is shown only under Past, and the topic key is not
  shown.
- **The principle form asks for no topic key.** A new principle takes its key from its statement
  (`topicKeyFrom`); Edit and Accept keep the key of what they started from. Because a key decides what a
  principle replaces, New Principle and Accept ask the daemon by a dry run first, and a save that would replace
  a current principle names it and waits for Replace: an agent's proposal can't quietly replace a principle.
- **The kinds read Rule, Preference and Background.** The stored values stay `policy`, `heuristic` and `belief`
  (the API, the MCP tools and orgtools use them). The form offers them as three cards under "How agents use
  it", each saying what it does: a rule every session is briefed with, a preference briefed after rules,
  background agents find by search and are never briefed with.
- **Remove… replaces Retire… and Withdraw….** On a current principle it asks why: no longer applies retires
  it; recorded by mistake withdraws it, which can make an older version current again. A decision or an older
  version is withdrawn.
- **Scopes read All Projects, This Project and Only in <area>,** and an area that covers the whole repository
  is not offered as a scope, since it says no more than This Project.

## Why

The builder found the view hard to read: a third tab held what were only unconfirmed principles, a History
switch did not say what it showed, the create button sat on a row of its own, the table was cramped (a date over
three lines, a cut-off state badge), and the topic key, which only decides what a new principle replaces, was a
required-looking field with no explanation. Shelves say what a list holds, as the builder's orgtools Principles
ledger does; mantine-datatable is the table the builder already uses there.

Turned down:

- **A dropdown for Kind with a description per option.** With three choices, cards show every description at
  once.
- **Keeping the topic key as an advanced field.** Replacing a principle is what Edit… does; no other use of the
  field was found.
- **Column reordering.** The drag handles cluttered every header, and the lists have few columns.
- **Renaming the stored kinds or the `you` scope.** Every record, route and MCP tool carries them; only the
  words shown change.
- **Paging in this change.** The lists still read at most 100 records; server-side paging, filtering and
  sorting is its own change.
