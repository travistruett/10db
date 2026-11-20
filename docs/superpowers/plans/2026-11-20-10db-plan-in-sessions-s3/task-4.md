# Task 4: Accept ▾ with Accept and Start, and Undo Accept

**Spec:** §2 The Plan panel ("Head: … Accept ▾"); §5 Accept; §1 (the Accepted state's "Undo Accept while nothing
it wrote started"); §1.1 (the confirm counts).
**Track:** B. Read `apps/desktop/AGENTS.md` and `apps/desktop/src/views/sessions/plan/AGENTS.md` once. Needs Tasks
2 and 3 on the branch (their contracts and routes). Mantine's docs server (MCP `mantine`) has `Menu` and
`Button.Group`.

## Files

### `apps/desktop/src/daemon/shape-queries.ts`

- `useConvertShape`'s input gains `start?: boolean`, sent as `start: true` only when it is set. A converted
  answer's `result.start`, when present, is `ShapeStartOutcome`.
- `useStartCounts(shapeId, proposalIds, enabled)` is a query keyed `shapeKeys.startCounts(shapeId, sortedIds)`
  over `GET /shapes/:shapeId/start-counts?proposalIds=…`, read through `readJson` with `ShapeStartCountsDto`. It
  is enabled only while the modal is in start mode with at least one id.
  - Task and run events change the counts too. Add `shapeKeys.startCounts`'s prefix to the event map that
    invalidates on `workstream.changed` and `task.changed`; the app's event-to-query map is in `daemon/`. Find it
    there and add no polling.
- `useUndoAccept(shapeId)` is a mutation that posts to `/shapes/:shapeId/accepts/:acceptId/undo`.
  - A 409 or 400 rejects with the daemon's words, through `readJson`'s error.
  - On success it invalidates `shapeKeys.all`. Task, goal and decision events refresh the Board and Factory
    themselves.

### `apps/desktop/src/views/sessions/plan/proposed-pane.tsx`

- The head's Accept `Button` becomes a split control:
  - **Accept** as the button, which opens the modal as today;
  - a chevron `ActionIcon` with `aria-label="More accept actions"` opening a `Menu` that holds **Accept**
    and **Accept and Start**.
  - Disabled as Accept is today.
- `ConvertDialog` takes `start: boolean` and passes it through. Keep one modal component: `converting` becomes
  `'accept' | 'start' | null`.

### `apps/desktop/src/views/sessions/plan/convert-modal.tsx`

- `ConvertModalProps` gains `readonly start: boolean`, `readonly counts: ShapeStartCountsDto | undefined`, and an
  `onConvert` option `start?: boolean`.
- In start mode:
  - the title is "Accept and Start", and the "Nothing starts. Tasks wait on the Board." line becomes the counts
    line, worded so a zero part drops out:
    - "4 start now; 3 wait for a lane, 2 for other tasks";
    - "2 start now";
    - "3 wait for a lane";
    - "Nothing to start" when none of the ticked rows is a task;
  - `stay` lists under it, dimmed: "<title> stays on the Board: <why>";
  - the button reads `Accept and Start n`.
- After a converted answer whose `start.refused` is set, the modal stays open:
  - it shows "Accepted. The start was refused: <words>" in the alert slot;
  - the button becomes **Done**, which closes it;
  - otherwise it closes as today.
- The counts query takes the chosen proposal ids, so a tick change refetches.

### Undo Accept: `apps/desktop/src/views/sessions/plan/plan-panel.tsx` and `undo-modals.tsx`

- The panel's ⋯ `Menu` gets **Undo Accept**, shown when `view.lastAccept !== null`.
- It opens `UndoAcceptModal`, in `undo-modals.tsx` beside the Withdraws:
  - title "Undo Accept";
  - body "Takes back what the Accept of <shortAgo(at)> put on the Board: 1 goal, 2 tasks; withdraws 1 record.", a
    zero part dropped;
  - when `kept > 0`, "<kept> changes to Board tasks stay.";
  - primary **Undo Accept**, danger color, as Remove Draft Goal's is.
- A refusal shows in the modal's alert in the daemon's words, for example "Task Drop the Abandon strip has
  started"; the modal stays open. Success closes it.

## UI calls (yours, cheap to change)

- The split control's look follows Mantine's split button pattern. Take the screenshot in Task 6.
- The counts line uses `role="status"`, so the counts are read when they arrive.

## State-table rows

- Rows ticked, Accept ▾ → Accept and Start | Confirm opens.
- Confirm open | A round lands.
- Accept and Start | The starter refuses at once (the modal half).
- Accept and Start | Nothing ticked is a task.
- `lastAccept` present | ⋯ → Undo Accept.

## Tests

None. The e2e (Task 6) covers it.

## Done when

- Typecheck, ESLint and `vitest related` on the changed files pass.
- A click-through against a dev daemon (`pnpm dev` in a scratch data directory, not the builder's port-1420
  window; run it on another port, or wait for Task 6) shows the menu, the counts and the Undo confirm. Save
  screenshots to the scratch folder.
- `make precheck` is green.
