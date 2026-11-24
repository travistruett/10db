# Task 1: contracts and the journal

**Size inside the plan:** Core (the pin every later card routes on). **Read:** the index's brief and Global
Constraints; spec §2 "Settings and admission", §4 "The copy id" (Value, Stored), §5 "Landing" (Journal), §7
"Dependents".

## Files

- `packages/contracts/src/local-copy.ts` (new): `CopyStep`, `CopyWait`, `CopyId`, `copyIdOf`, `LocalCopyDto`.
  Export through the package entry.
- `packages/contracts/src/entities.ts`: `localCopies`, `copyTeardownCommand` on `ProjectInput` and `ProjectDto`;
  the refine at `:620` accepts `delivery: local` only for task placement (the project default `worktree` stays
  pull-request only); a refine that `copyTeardownCommand` is set when `localCopies` is on.
- `packages/contracts/src/states.ts`: the four `BatchFailure` values.
- `packages/db/src/schema.ts`: the `local_copies` table (columns as `LocalCopyDto`, `batch_id` primary key with a
  cascading foreign key to `batches`, `wait_detail` JSON text read back through zod); the two `projects` columns.
- `packages/db/src/store/local-copies.ts` (new) and its entry export.
- `packages/db/src/store/projects.ts:250`: the same rule as the refine.
- `packages/db/src/store/tasks.ts`: `placementFor` (`:362-374`) and `placementRefusal` (`:1349`) allow a copy for a
  local project with `localCopies` on, after the admission checks below; `dependenciesDone` (`:677`).
- One dev migration (`pnpm --filter @10db/db generate`).

## Interfaces it implements (quoted from the index)

`CopyStep`, `CopyWait`, `CopyId`, `copyIdOf(batchId: BatchId): CopyId`, `LocalCopyDto`; `insertLocalCopy`,
`getLocalCopy`, `isLocalCopy`, `LocalCopyPatch`, `patchLocalCopy`, `resetLocalCopy`, `listOpenLocalCopies`,
`unfinishedCopyOf`, exactly as the index's Interfaces block gives them.

## Behavior

- `copyIdOf`: `createHash('sha256').update(batchId).digest('hex').slice(0, 12)`, parsed through `CopyId`.
- `insertLocalCopy` sets `copyId` from `copyIdOf`, `step: open`, `attempt: 0`, the rest null or empty. Card 4 calls
  it in the CUTTING insert's transaction.
- `resetLocalCopy` throws `ConflictError` at `promoting`.
- **Admission** (a copy placement is refused with its reason as `InvalidError`, or waits, per spec §2):
  the project has a gate command; the task's effective process runs a review (read it where the process cell
  decides the review step); the task's landing is `base`. A second copy task is not refused: placement succeeds,
  and card 4's start keeps it queued while `unfinishedCopyOf` answers a batch.
- `dependenciesDone`: a Done dependency whose latest run's batch `isLocalCopy` and isn't SHIPPED counts as pending.

## State-table rows

`(cut)` → `open` (the row's shape; card 4 writes it).

## Tests

None. The store is plain persistence and the admission checks are guards; the e2e (card 8) runs placement through
the real daemon. `dependenciesDone`'s change is one condition, covered by the e2e's dependency-free path and the
pilot.

## Done when

Typecheck, lint and the related tests of `contracts` and `db` pass; `make precheck` passes; the dev migration is
committed.
