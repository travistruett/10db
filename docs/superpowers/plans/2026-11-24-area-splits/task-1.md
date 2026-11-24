# Task 1: a project patch splits an area and retags its open tasks in the same write

Read the index's Brief and Global Constraints first.

**Files:** `packages/contracts/src/entities.ts` (`AreaSplit`, `ProjectPatch.areaSplits`),
`packages/db/src/store/projects.ts` (`patchProject`), its test file, `packages/db/AGENTS.md` (one line),
`packages/contracts/generated/project-patch.schema.json` (regenerated), and `apps/daemon/src/runner/runner.ts`
(`laneVerdict`).

**Implements:** `AreaSplit` and `ProjectPatch.areaSplits`, quoted in the index's Interfaces.

**Design (every row of the index's state table).** In `patchProject`, when `changes.areaSplits` is set:
1. Refuse `areaSplits` without `areas`, a `from` the current project lacks, and an `into` name the new `areas`
   lack (InvalidError).
2. Refuse while an unreleased claim names `from` (the query `checkClaimedNames` already runs, joined to the
   task's title; ConflictError naming the task). Run it before any write.
3. In the same transaction as the project update, for each open task of the project naming `from`, set its
   `areas` to the list with `from` replaced in place by `into`, deduplicated, and emit `TaskChanged`. Write the
   column directly, not through `patchTask`/`checkAreasCanChange` (Global Constraints).
4. Where the project's `isolate` names `from`, add every `into` name to it in the same write.
5. `areaSplits` is not stored on the project row: strip it from the `.set({...changes})` spread.

**The guard reads live (`runner.ts` `laneVerdict`).** `areas` and `hazards` come from
`getProject(db, row.projectId)` on each call, not the copy `runSession` read at start (a pass keeps
`passAreasOf`). Both providers go through `laneVerdict`.

**Test (core: claims), one, on the real-SQLite rung** in the projects store test: a project with `backend`, an
open task naming `[ui, backend]`, a done task naming `[backend]`, and an open task holding a claim on `backend`
in a second project, which must stay untouched. Patch `areas` to split `backend` into `[backend, methods]` with
`areaSplits`: the open task reads `[ui, backend, methods]` and the done task is unchanged. Then add a held claim
on `backend` in the first project: the same patch is refused and nothing changes. Prove it red first, by
dropping the retag. Value card per `.claude/rules/testing.md`.
