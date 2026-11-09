# Knowledge is two tabs with shelves, its lists are mantine-datatable tables, and the principle form asks for no topic key

- **Date:** 2026-11-08
- **Amends:** `decisions/2026-11-03-knowledge-is-a-top-level-view-with-three-tabs.md`

## Decision

- **Two tabs, each with shelves.** Knowledge has a Principles tab and a Decisions tab. A shelf control in each
  tab's one toolbar row picks what the list holds: Pending (principle proposals, with their count; principles
  only), Current, and Past (superseded, retired and withdrawn). The Proposals tab and the History switch are gone.
  The search, the scope select and New Principle or New Decision share that row.
- **Only principle proposals are under Pending.** A proposal of a task, a task change or a note is answered in the
  Inbox and no longer listed in Knowledge.
- **The lists are `mantine-datatable` tables** (pinned at 9.4.0, which supports Mantine 9). Columns resize and
  hide, and the layout is kept per list in the window's local storage; Kind, Scope, Date and State sort; Kind
  has a column filter. Clicking a row opens where it came from; the info button is gone. Kind is a coloured
  badge (orange policy, blue heuristic, gray belief), State is shown only under Past, and the topic key is not
  shown.
- **The principle form asks for no topic key.** A new principle takes its key from its statement
  (`topicKeyFrom`); Edit and Accept keep the key of what they started from, so saving replaces that record.
  Kind is three cards, each saying what it does to an agent: a policy is a rule every session is briefed with,
  a heuristic a preference briefed after policies, a belief context agents find by search and are never
  briefed with.

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
