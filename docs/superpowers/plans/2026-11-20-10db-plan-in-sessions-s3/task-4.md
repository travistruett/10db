# Task 4: Accept ▾ with Accept and Start, and Undo Accept

**Spec:** §2 The Plan panel ("Head: … Accept ▾"); §5 Accept; §1 (the Accepted state's "Undo Accept while nothing
it wrote started"); §1.1 (the confirm counts).
**Track:** B. Read `apps/desktop/AGENTS.md` and `apps/desktop/src/views/sessions/plan/AGENTS.md` once. Needs Tasks
2 and 3 on the branch (their contracts and routes). Mantine's docs server (MCP `mantine`) has `Menu` and
`Button.Group`.

## Interfaces it implements or calls (quoted)

```ts
// packages/contracts/src/shape-view.ts (Tasks 2-3)
export const ShapeStartCountsDto = z.object({
  now: z.int().min(0),
  forLane: z.int().min(0),
  forOthers: z.int().min(0),
  stay: z.array(z.object({ title: z.string(), why: z.string() })),
});
export const ShapeStartOutcome = z.object({
  started: z.array(TaskId),
  left: z.array(z.object({ taskId: TaskId, title: z.string(), why: z.string() })),
  refused: z.string().nullable(),
});
export const ShapeUndoAcceptResult = z.object({
  goals: z.int().min(0), tasks: z.int().min(0), decisions: z.int().min(0),
  principles: z.int().min(0), questions: z.int().min(0), kept: z.int().min(0),
});
// ShapeAcceptDto: { id, at, goals, tasks, records, kept, taskIds }; ShapeViewDto.lastAccept: ShapeAcceptDto | null
// ShapeConvertInput.start?: boolean; ShapeConvertResult.start?: ShapeStartOutcome

// apps/desktop/src/daemon/shape-queries.ts (this card)
export function useStartCounts(
  shapeId: ShapeId,
  proposalIds: readonly ShapeProposalId[],
  enabled: boolean,
): UseQueryResult<ShapeStartCountsDto>;
export function useUndoAccept(
  shapeId: ShapeId,
): UseMutationResult<ShapeUndoAcceptResult, Error, ShapeAcceptId>;
export function useConvertShape(shapeId: ShapeId); // input gains `start?: boolean`

// apps/desktop/src/daemon/events.ts
export const INVALIDATIONS: Readonly<Record<string, readonly QueryKey[]>>;
// apps/desktop/src/daemon/queries.ts
export function useTasks(projectId: ProjectId | null);
```

## Files

### `apps/desktop/src/daemon/shape-queries.ts`

- `useConvertShape`'s input gains `start?: boolean`, sent as `start: true` only when it is set. A converted
  answer's `result.start`, when present, is `ShapeStartOutcome`.
- `useStartCounts(shapeId, proposalIds, enabled)` is a query keyed `shapeKeys.startCounts(shapeId, sortedIds)`
  over `GET /shapes/:shapeId/start-counts?proposalIds=…`, read through `readJson` with `ShapeStartCountsDto`. It
  is enabled only while the modal is in start mode with at least one id.
- `useUndoAccept(shapeId)` is a mutation that posts to `/shapes/:shapeId/accepts/:acceptId/undo`.
  - A 409 or 400 rejects with the daemon's words, through `readJson`'s error.
  - Settled either way, it invalidates `shapeKeys.all`, so a 400 "Undo the later Accept first" refetches the new
    `lastAccept`. Task, goal and decision events refresh the Board and Factory themselves.

### `apps/desktop/src/daemon/events.ts`

`INVALIDATIONS`: add `shapeKeys.startCountsAll` (the prefix of `shapeKeys.startCounts`) to the `task` and
`workstream` entries, so the counts follow lanes freeing up. No polling.

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
    line, `role="status"`, worded so a zero part drops out:
    - "4 start now; 3 wait for a lane, 2 for other tasks";
    - "2 start now";
    - "3 wait for a lane";
  - when `now + forLane + forOthers` is 0, the line reads "Nothing to start" and **the button reads "Accept n"**,
    sending no `start`;
  - otherwise the button reads **"Accept and Start n"**, with n the number of chosen rows, as for "Accept n";
  - `stay` lists under the line, dimmed: "<title> stays on the Board: <why>".
- After a converted answer in start mode:
  - with `start.refused` set: the modal stays open, shows "Accepted. The start was refused: <words>" in the
    alert slot, and the button becomes **Done**, which closes it;
  - with nothing started and nothing left (Convert made nothing new): the modal shows "Nothing new to start" and
    the button becomes **Done**;
  - otherwise it closes as today.
- The counts query takes the chosen proposal ids, so a tick change refetches.

### Undo Accept: `apps/desktop/src/views/sessions/plan/plan-panel.tsx` and `undo-modals.tsx`

- The panel's ⋯ `Menu` gets **Undo Accept**, shown when `view.lastAccept !== null`.
  - **Disabled with its reason** when any of `lastAccept.taskIds` has a run in the app's cache. A run means
    `task.workstreamId !== null` in `useTasks(projectId)`, which task and run events keep fresh.
  - The reason shows as the item's description or tooltip: "<title> has started". The daemon still refuses on
    its own, so the cache is only a hint.
- The item opens `UndoAcceptModal`, in `undo-modals.tsx` beside the Withdraws:
  - title "Undo Accept";
  - body "Takes back what the Accept of <shortAgo(at)> put on the Board: 1 goal, 2 tasks; withdraws 1 record.", a
    zero part dropped;
  - when `kept > 0`, "<kept> changes to Board tasks stay.";
  - primary **Undo Accept**, danger color, as Remove Draft Goal's is.
- A refusal shows in the modal's alert in the daemon's words, for example "Drop the Abandon strip has started;
  cancel its run on the Board first"; the modal stays open. Success closes it.

## UI calls (yours, cheap to change)

- The split control's look follows Mantine's split button pattern. Take the screenshot in Task 6.

## State-table rows

- Rows ticked, Accept ▾ → Accept and Start | Confirm opens.
- Confirm open | A round lands.
- Confirm open | Nothing ticked would start.
- Accept and Start | Convert made nothing new.
- Accept and Start | The starter throws a DomainError at once (the modal half).
- `lastAccept` present, none of its tasks has a run.
- `lastAccept` present, one of its tasks has a run.
- Undo pressed | Not the latest (the modal half).

## Tests

None. The e2e (Task 6) covers it.

## Done when

- Typecheck, ESLint and `vitest related` on the changed files pass.
- A click-through against a dev daemon (`pnpm dev` in a scratch data directory, not the builder's port-1420
  window; run it on another port, or wait for Task 6) shows the menu, the counts and the Undo confirm. Save
  screenshots to the scratch folder.
- `make precheck` is green.
