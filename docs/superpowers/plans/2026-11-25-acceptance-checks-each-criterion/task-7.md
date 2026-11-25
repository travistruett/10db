# Task 7: the Board counts

**Size: Feature.** Read the index's Brief and Global Constraints first. Needs task 1.

## Files

- `packages/db/src/store/acceptance-figures.ts`: `acceptanceFigures(db, projectId, days, now)`. Export it from the
  db entry point.
  - **completed:** tasks of the project whose last `task.changed` to done falls in the window, whose workstream
    raised no `acceptance` card. Pass tasks are left out, as `rigor-figures.ts` does.
  - **sentBack:** `step.changed` events in the window whose `sentBackBy` is set to anything but `builder`. They are
    joined through `workstreams` to the project, leaving out pass batches.
  - **sentToYou:** `inbox_items` of the project of kind `acceptance` with `createdAt` in the window.
- `apps/daemon/src/api/app.ts`: `GET /projects/:projectId/acceptance-figures?days=7|14|30` (default 7) returns
  `AcceptanceFigures`.
  - `checking` is `{on: false, reason: 'no_account'}` when no decisions account is set or it can't answer.
  - It is `{on: false, reason: 'off'}` when the master switch or `acceptance` is off.
  - Otherwise it is `{on: true}`.
- Desktop:
  - `src/daemon/acceptance-queries.ts`: the query.
  - `views/board/board-view.tsx`: the header shows "Completed N · Sent back N · Sent to you N, last 7 days".
    - When not checking, a muted line says "Acceptance isn't checking: no account can answer decisions", or "…: it's
      off in Settings".
    - Each number links to Factory.
  - `views/factory/`: Factory lists the runs behind each count. Reuse `rigor-panel`'s list pattern.
- `apps/desktop/e2e/`: extend the Board flow. The header shows the counts and the "not checking" line (the e2e daemon
  runs with the judge off).

## Interfaces

`acceptanceFigures` and `AcceptanceFigures`, as the index quotes them.

## Spec sections

"The Board counts".

## Tests

- A store test on a real SQLite file in a temp directory. Count rules are core data, so this is allowed. Each count
  has one row in the window and one outside it, and a pass task is left out.
  - Value card: `why_new=core data: counts the builder reads to trust the factory`.
- The e2e extension above.
- Before review, run the Board in the dev window against the real daemon and take screenshots (the `screens` skill).
