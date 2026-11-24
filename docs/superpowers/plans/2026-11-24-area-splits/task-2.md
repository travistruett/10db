# Task 2: the setup proposes a split, and the modal offers it

Read the index's Brief and Global Constraints first. Task 1 has landed on this branch.

**Files:** `apps/daemon/src/folders/broad-areas.ts` (new, with `broad-areas.test.ts`), `rebuild-areas.ts`,
`workbench-setup.ts` (splits of kept areas), `propose-areas.ts`, `apps/daemon/src/folders/AGENTS.md`,
`packages/contracts/src/workbench-setup.ts` (`SplitRow`, `splits`, `withSplits`), `packages/contracts/generated/workbench-setup-dto.schema.json` (regenerated),
`apps/desktop/src/views/workbench/setup/{areas-section.tsx,setup-rules.ts,workbench-setup.tsx}`.

**Implements:** `SplitRow`, `withSplits`, `RebuildInput.splits` and `broadAreaSplit`, quoted in the index's Interfaces.

**The rule (`broadAreaSplit`, pure)** is drafted in `apps/daemon/src/folders/broad-areas.ts`; its doc comment is
the rule. Changes from the draft: `__init__.py` is no marker; a folder named `fixtures`, `examples`, `templates`,
`testdata` or `__fixtures__`, or under one, is never a package. Of the folders that qualify, the one with the most
packages wins.

**In a new project's proposal (`propose-areas.ts`).** After naming, each proposed area that `broadAreaSplit`
splits is replaced by its core and parts, with `taken` = every proposed name. A new project has no tasks, so this
needs no retag. This is where Ampsio's single `backend` came from.

**In `rebuildAreas`.** A structural area of `others` (no task names it) that splits is replaced the same way,
with no row: it is part of the rebuilt list. A kept area (open tasks name it) stays whole in `proposed`, exactly
as today. Its split comes in as `RebuildInput.splits` (computed by `proposeSetupAreas` from the project's own
list) and goes out as a `SplitRow` that carries `into`; it is returned on every path, the no-page return
included. The parts' names are reserved: other areas are made unique against them. A kept area that becomes a
page is never split. Apply applies the ticked rows with `withSplits`, rebuild on or off (the index's Apply
table).

**In the modal.** Each split is a checkbox row under the new pages, shown whether the rebuild is on or off:
"Split `backend` into N areas", a description line naming the core and the first parts ("backend (core),
methods, ingest and 23 more"), and "15 open tasks get all of them". `setupPatch` sends `areas` and `areaSplits`
for the ticked rows. `setUpCount` counts the rows, so the Add Area caret shows them, and `workbench-setup.tsx`'s `offered` gate and
"Nothing to set up" return count `setup.areas.splits`, so a setup whose only change is a split still shows it. Files:
`apps/desktop/src/views/workbench/setup/{areas-section.tsx,setup-rules.ts,workbench-setup.tsx}`. Drop
`WorkbenchSetupDto.branch` and the daemon's `branchNote`.

**Test (pure rule table, one file):** `broad-areas.test.ts`, in a few table rows: Ampsio's shape (a Django
`apps/` of `apps.py` apps with `core`, beside `config/` and `test_utils/`) splits under `apps/`, with the core
holding `core`, the root files, `config/` and `test_utils/`; a Django app whose `migrations/`, `tests/` and
`services/` carry `__init__.py` does not split; `tests/fixtures/*/package.json` does not split; a folder with two
packages, or a page or shared area, does not split; a part whose name is taken is prefixed; every file lands in
exactly one area. No rendered-component test; before review, a click-through of the modal against the Dev
window's daemon on a copy of Ampsio with tasks naming `backend`, Apply included (AGENTS.md).
