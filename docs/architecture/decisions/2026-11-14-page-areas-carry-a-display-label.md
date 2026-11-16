# A page area carries a display label, and the setup offers pages it finds later

- **Date:** 2026-11-14
- **Amends:** `decisions/2026-11-10-the-workbench-setup-rebuilds-the-areas-for-one-apply.md`, whose picker
  badge counted settings only so that a page left out was never asked for again

## Decision

- **A label is display only.** `AreaDef.label` (one line, 1-40 characters, on a page area only) is what the
  builder reads for a page: the picker, queue, page, notifications, dialogs, the pass's name and the task a
  pass makes ("Plan: UI work"). `pageLabel(area)` is the one place that falls back to the name with its first
  letter capitalised. The name stays the key everywhere (claims, `task.areas`, passes), so a label never
  changes behaviour. Settings › Areas edits it; emptied means absent.
- **The setup guesses it from the nav.** For a code-routed app the setup reads the router files and up to 20
  more source files an app has whose names say layout, nav, sidebar, menu or shell, and takes the `label` of an
  object literal that also holds the route as `to`, `path` or `href`, in one linear scan. A page named by its
  files is not guessed. A label the builder set beats the guess, and an existing page with none takes it.
- **A label alone is never a new page.** `areas.pages` holds only pages whose name matches no page area
  of the project, so unticking a row can never demote a page the project has; a label difference is offered
  through the rebuild and both `sameArea` functions compare it.
- **The picker notices new pages.** With page areas Workbench Settings (called Set Up when this was decided) is always on the start page's title row, badged with the new
  pages not left out plus the settings, and a line under the Pages field names them. The rebuild starts ticked
  when one is counted. A page unticked at Apply is stored in `ProjectDto.leftOutPages`, still shows unticked in
  the rebuild, and is not counted again; ticking it removes it from the list.

## Why

The area names are file-system words (`shape`), while the app's nav says "Plan"; a builder reading the picker
should see the words the app shows. Keeping the name as the key means no claim, task or pass migrates. The
badge counted settings only because an unticked page would otherwise keep the badge up forever; remembering
what was left out lets it count pages without that. Turned down: deriving the label at read time from the nav
(a repository read on every screen) and storing it on the task (a second source that drifts from the area).
Provider parity: nothing here depends on the account's provider.
