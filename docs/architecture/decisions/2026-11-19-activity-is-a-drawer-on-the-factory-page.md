# Activity is a drawer on the Factory page, not an Inbox list

- **Date:** 2026-11-19
- **Amends:** `docs/superpowers/specs/2026-11-17-10db-inbox-signal-design.md` decision 2 ("Activity lives in the
  Inbox panel")

## Decision

The notices that tell the builder something and ask nothing open from an **Activity** button (a history icon) in
the Factory's title row, in a drawer: newest first, for the project the Factory shows or every project, 20 at first
with Show More and a search field, a row opening its notice in the drawer. The Inbox's panel head has no Activity button, and its switch is Open, Waiting and Resolved, one of
which is always picked. The notices, their rows and their content are unchanged, and so is how they are read.

## Why

Activity had become a button in the Inbox panel's head, since four items don't fit the panel's switch. Pressing it
swapped the list for notices and left the switch with nothing picked, which the builder read as broken. A notice is
a log of what the factory did, not a state a card is in, so it belongs with the factory's own work, and since most of the time none of it matters, it waits behind a
button rather than taking room on the page.
