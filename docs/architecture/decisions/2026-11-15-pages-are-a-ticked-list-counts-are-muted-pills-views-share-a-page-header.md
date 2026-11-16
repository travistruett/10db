# Pages are a ticked list, counts are muted pills, and the main views share a page header

- **Date:** 2026-11-15
- **Amends:** `decisions/2026-11-11-start-pass-picks-pages-in-one-searchable-multi-select.md`,
  `decisions/2026-11-11-a-label-never-carries-its-count.md`,
  `decisions/2026-11-08-knowledge-is-two-tabs-with-shelves.md`

## Decision

- **The Workbench start page is a list of rows to tick**, not a searchable multi-select
  (`views/workbench/page-list.tsx`). Each page is a checkbox named by its label, with its route in monospace, when
  it last changed and "Waits for <task>" when held; then an "Open UI tasks" subhead with the joinable tasks. A row
  that can't join what is ticked is disabled with the reason under it (`blockedReason`, unchanged). The searchable
  `MultiSelect` stays for the Add Page dialog inside an open pass. "What's bothering you?" is gone: the request
  sends no first message and each page waits for the builder's. Start Pass sits at the list's foot with what is
  ticked in words ("2 pages · 1 task") before it. Set Up is now Workbench Settings, on the title row; the setup's
  new pages are one dimmed line at the list's foot, "<pages> found in code · Review", Review opening the setup.
- **A count is a muted pill no taller than its label's text.** It is a light gray `Badge`; it is filled primary
  (`tone="attention"`) only when it means something needs the builder: Inbox's Open tab and the Sessions and
  Workbench needs-you counts. A needs-you count shows nothing at 0.
- **Inbox, Factory, Knowledge, Board and the Workbench start page share `PageHeader`**
  (`shell/page-header.tsx`): the title with the view's actions on its row, an optional one-line byline, an
  optional toolbar of tabs (left) and filters (right). Knowledge's New Principle and New Decision are on the
  title row, no longer on the tab row. Sessions, Plan and an open Workbench pass keep compact headers.
- **A page that loads shows its header, then static placeholder rows after 300 ms** (`shell/page-loading.tsx`),
  never a lone spinner.

## Why

The builder's call on 2026-11-15. A project's pages are a bounded list the builder reads whole, so ticking rows
is plainer than searching; search earns its place only where a list grows without bound. Counts that were all
bright circles taller than their text competed with the controls they sit in, and only the ones that need the
builder should draw the eye. Four views drew their title, actions and tabs four ways.

Turned down: keeping the multi-select on the start page with the list beside it (two controls for one job).
