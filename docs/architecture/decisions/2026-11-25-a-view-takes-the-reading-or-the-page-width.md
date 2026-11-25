# A view's content takes the Reading or the Page width, set once on Mantine's Container

- **Date:** 2026-11-25

## Decision

A view's content grows to one of two widths and then centres in the content area:

- **Reading (720 px):** prose and conversation. This covers a session, the Inbox's card, a Plan's record and the
  Workbench setup.
- **Page (1080 px):** pages of rows, tables and figures. This covers Factory, Settings and Knowledge.

A workspace whose content is the work (the Board, an open Workbench pass) takes neither and fills the window.

The widths are set once, in `apps/desktop/src/shell/content-width.ts`. The theme maps them onto Mantine's
`Container` (`Container.extend`, no padding of its own), so a view says `<Container size={ContentWidth.Page}>`. A
flex column that can't be a `Container`, such as Settings' page with its save bar, reads the same map. A
stylesheet reads `--tendb-width-reading` or `--tendb-width-page`.

## Why

Widths had grown one view at a time:

- 720 px for a conversation and the Workbench setup.
- 760 px for the Inbox's card and a Plan's record.
- 1040 or 1120 px, left-aligned, for Factory.
- Nothing at all for Settings and Knowledge.

On a wide window, a page of rows ran off to the right, or sat against the left edge while the conversation
beside it was centred. The builder asked for one rule, set in one place. Mantine's `Container` with theme sizes
is the library's own way to say it, so a view names a width instead of a number.
