# Task 1: the Accept record

**Spec:** §8 Data ("New: an Accept record (which Accept wrote which goal, task and record, for Undo Accept)"); §5
Accept ("Each Accept is recorded with what it wrote").
**Track:** A, core (migrations, data). Read `packages/db/AGENTS.md`, `apps/daemon/src/shape/AGENTS.md` and the
Plan entries of `docs/architecture/db-storage.md` once, and keep notes. Starts first.

## Before you start

`gh pr list --state open --json number,title,files` must show no other open pull request with a file under
`packages/db/drizzle/`. If one exists, stop and report it: only one open pull request adds migrations at a time.

## Interfaces it implements or calls (quoted)

```ts
export function convertProposals(
  ctx: WriteContext,
  shapeId: ShapeId,
  proposalIds: readonly ShapeProposalId[],
  joiningProblem: JoiningProblem = () => null,
  cut?: readonly MilestoneCut[],
): ConvertOutcome;
export function removeDraftGoalOf(ctx: WriteContext, shapeId: ShapeId, goalId: GoalId): void;
export function insertLandingGroup(
  ctx: WriteContext,
  input: {
    readonly projectId: ProjectId;
    readonly title: string;
    readonly taskIds: readonly TaskId[];
    readonly shapeId?: ShapeId;
  },
): LandingGroupDto;
export type ShapeProposalPatch = Partial<
  Pick<
    ShapeProposalRow,
    'state' | 'round' | 'createdRound' | 'pinned' | 'body' | 'taskHashes' | 'sourceMessageIds'
  >
>;
export function patchShapeProposal(
  ctx: WriteContext,
  id: ShapeProposalId,
  patch: ShapeProposalPatch,
): void;
```

The new store functions and the outcome's `acceptId` are quoted in the index's Interfaces, under New.

## Files

### `packages/contracts/src/ids.ts`

Add `ShapeAccept` beside `ShapeLink`, with the prefix `'sac'`, in both the schema map and the prefix map. Export
`ShapeAcceptId` and its type as the others do. Check that no existing prefix is `sac`.

### `packages/db/src/schema.ts`

- **New table `shape_accepts`:**
  - `id` `ShapeAcceptId`, the primary key;
  - `shape_id` → `shapes.id`, not null;
  - `undone_at` text, nullable;
  - `created_at` and `updated_at` as the other tables have them;
  - an index `shape_accepts_shape_idx` on `shape_id`.
  - Doc comment: "An Accept of a plan (spec §5): which proposals it accepted and which landing groups it made, so
    Undo Accept takes back exactly what it wrote."
- **`shape_proposals.accept_id`** → `shape_accepts.id`, nullable: "The Accept that accepted it. Meaningful only on
  a row whose state is accepted: every path that makes a row pending again clears it, and readers filter by state.
  Null for a row accepted before Accepts were recorded."
- **`landing_groups.accept_id`** → `shape_accepts.id`, nullable: "The Accept that made it; null for a group made
  another way."
- Then run `pnpm --filter @10db/db generate` and read the SQL it writes.
  - Expect a `CREATE TABLE`, an index and two `ALTER TABLE … ADD`.
  - If drizzle-kit writes a table rebuild that also adds a column, split it as `packages/db/AGENTS.md` says: one
    migration that adds the column, a second that rebuilds.
  - Never edit the generated SQL.
  - Save a copy of the SQL to your scratch folder (`task-1/migration.sql`): Task 7 regenerates the migration
    after the final merge of `main` and diffs against it.

### `packages/db/src/store/shape-accepts.ts` (new), exported through the package's entry point

```ts
export type ShapeAcceptRow = typeof schema.shapeAccepts.$inferSelect;
export function insertShapeAccept(ctx: WriteContext, shapeId: ShapeId): ShapeAcceptRow;
/** The newest Accept of the plan that is not undone, or undefined. */
export function latestShapeAccept(db: DbReader, shapeId: ShapeId): ShapeAcceptRow | undefined;
export function markShapeAcceptUndone(ctx: WriteContext, id: ShapeAcceptId): void;
/** The proposals an Accept accepted that are still accepted under it. */
export function listAcceptedProposals(db: DbReader, id: ShapeAcceptId): ShapeProposalRow[];
```

- `insertShapeAccept` mints the id through `mintId('ShapeAccept')`.
- "Newest" orders by `created_at` and then `id`, since UUIDv7 ids sort by creation.
- `listAcceptedProposals` takes rows with `accept_id = id` and `state = accepted`.
- None emits an event. The writes that use them emit `shape.changed` already.

### `packages/db/src/store/shape-state.ts`

- `ShapeProposalPatch` adds `'acceptId'` to its `Pick`.

### `packages/db/src/store/landing-groups.ts`

- `insertLandingGroup`'s input gains `readonly acceptId?: ShapeAcceptId`, written as `accept_id`.
- Add both, checking first whether such functions exist and using them if so:

  ```ts
  /** Clears the group's tasks' landing_group_id, then deletes the group. */
  export function deleteLandingGroupOf(ctx: WriteContext, id: LandingGroupId): void;
  /** Takes one task out of its group (landing_group_id null); the group stays. */
  export function leaveLandingGroup(ctx: WriteContext, taskId: TaskId): void;
  ```

  Task 2 calls them.

### `apps/daemon/src/shape/convert.ts`

- In `convertProposals`, after every refusal is checked and right before the first write:
  - when `pending.length > 0`, call `insertShapeAccept(ctx, shapeId)`;
  - set `acceptId` on each pending row in the existing `patchShapeProposal(…, { state: Accepted })` loop;
  - pass `acceptId` to `insertLandingGroup`.
  - A refusal writes nothing, as today, so it leaves no Accept.
- The ok outcome gains `readonly acceptId: ShapeAcceptId | null` (null when `createdNow` is 0). Update
  `ConvertOutcome` and its doc comment.
- A milestone cut's rejected rows get no `acceptId`.

### `apps/daemon/src/shape/undo.ts`

- `removeDraftGoalOf`: the `patchShapeProposal(…, { state: Pending })` also sets `acceptId: null`, so a goal taken
  back by Remove Draft Goal is no longer under its Accept.

### `packages/db/src` migration tests

- Run `migrations-plans-into-sessions.test.ts` and `migrations-conversations.test.ts`. They name their migration
  by tag, and `migrationsBefore` silently takes every migration but the last when a tag is missing. Check that
  each still targets the migration it means, now that a new last migration exists. Fix a hard-coded tag only if
  one was "the latest".
- Run `database.test.ts`.

## State-table rows

- Undo pressed | Remove Draft Goal already took one of its goals (the `acceptId: null` half).
- Undone | Accept again (a new record per Accept).

## Tests

No new test. The migration is additive: a new table and two nullable columns, with no data moved. Convert's
recording is exercised by Task 2's core tests, which accept through `convertProposals`.

## Transitional exports

`latestShapeAccept`, `markShapeAcceptUndone`, `listAcceptedProposals`, `deleteLandingGroupOf` and
`leaveLandingGroup` are used first by
Task 2. Either Task 1 and Task 2 push together, or Task 1 pushes and Task 2 starts at once. Knip reads exports
from a package's entry point as used, so check `make precheck` before the push. If it flags them, say so in the
report and push with Task 2.

## Done when

- The migration is generated and its SQL read.
- In `packages/db`: `vitest related` on the changed store files, plus the three migration test files above,
  passes.
- In `apps/daemon`: `vitest related src/shape/convert.ts src/shape/undo.ts --run --maxWorkers=2` passes.
- `make precheck` is green.
- Report the migration's file name and SQL, and any knip output.
