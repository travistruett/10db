# Suggestions open from Add Area's menu, lead with their changes, and drop the branch note

- **Date:** 2026-11-24
- **Amends:** `2026-11-24-the-workbench-setup-opens-in-a-modal-from-areas.md`,
  `2026-11-10-the-workbench-setup-rebuilds-the-areas-for-one-apply.md`,
  `2026-11-23-the-workbench-setup-is-reached-from-pages-and-pictures.md`

## Decision

- Add Area and Add Hazard are split buttons. Add Area's menu holds "Suggest from the repository…", which opens
  the setup in its modal; the count of suggestions sits on the caret and the menu item. The item shows whether
  or not there are suggestions. The Review Suggestions button is gone. Add Hazard's menu holds Look Again, in
  place of the wand icon.
- The modal leads with the changes: the Rebuild areas line and the new pages, each with its checkbox. What is
  kept as it is, the other areas and what was left out are each one count that opens in place.
- The modal shows no branch note. The daemon's `branch` field of the setup's answer is not read by the
  desktop; it leaves the contract with the next change to the setup's answer. The Workbench start page still
  says when the base branch has commits `origin` lacks.

## Why

The builder found the Areas heading's two buttons and the hazard wand scattered: each section has one way to
add a row by hand and one smart way, and a split button puts them in one place. The modal listed about 15 kept
areas, 20 others and 10 left out under 6 changes, which buried the changes. Pushing the base branch has nothing
to do with areas or settings, and Apply could not clear the note, so it read as part of the suggestions when it
was not.
