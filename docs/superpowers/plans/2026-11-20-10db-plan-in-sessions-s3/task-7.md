# Task 7: docs and the final migration check

**Spec:** the whole slice, plus the spec's status line.
**Track:** none (docs, and the migration's number). It runs last, after the reviews converge and after the
branch's final merge of `main`.

## Files

- **`apps/daemon/src/shape/AGENTS.md`:**
  - `undo.ts` holds four functions now; describe `undoAccept`'s rule (the latest Accept only, what it takes back,
    what stays, the refusals).
  - Convert records each Accept (`shape_accepts`, `accept_id`).
  - `start-counts.ts` and `buildStartCounts`.
  - Accept and Start goes through `createShapeServices`'s `startTasks`.
  - The two new routes.
- **`apps/desktop/src/views/sessions/plan/AGENTS.md`:** Accept ▾, the start mode of `convert-modal.tsx`, Undo
  Accept in ⋯, and `live-state.ts`'s words.
- **`apps/desktop/AGENTS.md`:** the New Plan e2e's new steps and its cleanup of started runs.
- **`docs/architecture/db-storage.md`:** an entry for `shape_accepts` and the two `accept_id` columns, under the
  Plan stores.
- **A decision record**, `2026-11-20-undo-accept-takes-back-only-the-latest-accept.md`, in the decisions folder,
  in that folder's README format. It covers calls 1-3 of the index's Brief: latest only; "started" as Remove
  Draft Goal reads it; tasks waiting outside the start stay on the Board. Cite it in docs only once it exists.
- **The spec's status line:** "slices 1, 2 and 3 are built".

## The final migration check

1. `git fetch origin && git merge origin/main`, the branch's final merge.
2. If `main` added a file under `packages/db/drizzle/` since this branch's Task 1, renumber:
   - delete this branch's generated migration, its snapshot and its `_journal.json` entry, by restoring
     `packages/db/drizzle/` from `origin/main` for those files;
   - run `pnpm --filter @10db/db generate` again;
   - read the SQL: it must match Task 1's.
3. `gh pr list --state open` again: still no other open pull request adding migrations.
4. Run the migration tests: `migrations-plans-into-sessions.test.ts`, `migrations-conversations.test.ts` and
   `database.test.ts`.

## Tests

None.

## Done when

- Prettier check and the `tests/repo` docs tests (`architecture-docs` and the AGENTS.md checks) pass.
- The migration check is done and reported, renumbered or not.
- `make precheck` is green, and the push is done.
