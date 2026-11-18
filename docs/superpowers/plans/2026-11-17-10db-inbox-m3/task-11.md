# Task 11 (M4): run it, the e2e sweep and docs

**Spec:** app shell spec §2 Widths ("The Workbench's queue strip"); §4.2 UI Workbench; §8 Tests (e2e, the
Workbench sweep); §9 Docs.
**State rows:** none.

## Files

- `apps/desktop/e2e/workbench.spec.ts`;
- `DESIGN.md`;
- `apps/desktop/src/shell/AGENTS.md`.

## Steps

1. **Run it.**
   - Start a pass on the real daemon and the dev build.
   - At 1280 px, check:
     - the queue is in the panel;
     - the title row names the page;
     - ⌘\ hides the panel and brings the strip and the pass header back.
   - At 900 px, check the strip, then the overlay holding the queue.
   - At 520 and 420 px, check the strip.
   - Do it in dark and light. Screenshots go to the scratch folder.
2. **e2e.** In `workbench.spec.ts`:
   - At 1280 px, `headerFits` checks the panel's head: the pass's name and ⋯ on screen. Below 1000 px, and after
     ⌘\ at 1280, it checks the title row as today.
   - Add a check that exactly one "Open pages" list is in the DOM at 420, 520, 900 and 1280 px.
   - Run `pnpm --filter @10db/desktop exec playwright test e2e/workbench.spec.ts e2e/shell.spec.ts`.
3. **Docs.**
   - DESIGN.md's Navigation: the Workbench has a panel while a pass is open.
   - `shell/AGENTS.md`: `panelShown`, and "Settings, the Inbox and the Workbench have a panel".
4. Commit the files above, with the message `test(desktop): the workbench queue in the panel across widths`. The
   body needs no value card: these are new rows in an existing sweep.
