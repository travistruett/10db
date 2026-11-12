# Start Pass picks pages in one searchable multi-select

- **Date:** 2026-11-11
- **Amends:** `docs/superpowers/specs/2026-11-09-10db-workbench-design.md` §4.2 (the picker)

## Decision

The Workbench with no pass open is full width, like Plan. Its pages and open UI tasks are one searchable
Mantine `MultiSelect` labelled Pages (`views/workbench/page-picker.tsx`), in place of a filter box over a
column of checkbox rows. The Add Page modal uses the same picker.

- **Options** are grouped Pages, then Open UI tasks (no groups when there is no task). A page shows its name,
  its route in monospace and, on the right, when its files last changed; under it, what holds it ("Waits for
  …"). A task shows its title and the pages it works on.
- **Search** matches a page's name and route and a task's title and pages.
- **An option that can't join what is picked** (it holds a file a picked row holds, or the pass is at its 6-page
  cap) stays in the list, disabled, with the reason under its name.
- **Pills** show what is picked: a page's name with its route dimmed, a task's title after a task icon. Pages
  and tasks a link names (the Board's Work on These, a goal's Work on This) arrive as pills.
- **Below the field:** "What's bothering you?", then one bar with what the picked pages take in and what the
  project lacks on the left and Start Pass on the far right, with no count
  (`decisions/2026-11-11-a-label-never-carries-its-count.md`).
- **The shared-area line is gone.** "Files under settings count as settings', not as shared src" explained
  spec §7.3's rule, asked nothing of the builder, and showed for almost every page of a project whose shared
  area spans its UI folder. The rule itself is unchanged.

## Why

The builder's call during the Workbench's QA. The builder comes to the Workbench knowing which pages they
want, so the picker is search first: a column of checkboxes is fine at six pages and unusable at a hundred,
and the separate filter box read as a second control for the same job. The multi-select keeps everything the
rows said (route, last change, the reason a row is disabled) inside each option.
