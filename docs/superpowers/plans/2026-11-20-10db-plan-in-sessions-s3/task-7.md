# Task 7: docs and the final migration regeneration

**Spec:** the whole slice, plus the spec's status line.
**Track:** none (docs, and the migration). It runs last, after the reviews converge, with the branch's final
merge of `main`.

## Files

- **`apps/daemon/src/shape/AGENTS.md`:**
  - `undo.ts` holds four functions now. Describe `undoAccept`'s rule:
    - the latest Accept only;
    - the pre-checks (any workstream row, a goal holding a task it didn't make);
    - what it takes back;
    - what stays and counts as `kept`: changes to Board tasks, superseded or replaced records, landing groups
      holding a task with a run;
    - withdrawn records count as taken back.
  - Convert records each Accept (`shape_accepts`, `accept_id`).
  - `start-counts.ts` and `buildStartCounts`.
  - Accept and Start goes through `createShapeServices`'s `startTasks`, and every error after the Accept is
    `refused`.
  - The two new routes.
- **`apps/desktop/src/views/sessions/plan/AGENTS.md`:**
  - Accept ▾, and the start mode of `convert-modal.tsx`;
  - Undo Accept in ⋯, disabled from the cache with its reason;
  - `live-state.ts`'s words, and the live dot in `rowDot`.
- **`apps/desktop/AGENTS.md`:** the New Plan e2e's new steps, and its cleanup of started runs through `POST
  /workstreams/:id/cancel`.
- **`docs/architecture/db-storage.md`:** an entry for `shape_accepts` and the two `accept_id` columns, under the
  Plan stores.
- **A decision record**, `2026-11-20-undo-accept-takes-back-only-the-latest-accept.md`, in the decisions folder,
  in that folder's README format. It covers calls 1-3 and 8 of the index's Brief:
  - latest only;
  - any run blocks Undo;
  - tasks the starter would refuse stay on the Board;
  - records Undo can't take back stay and are counted.

  Cite it in docs only once it exists.
- **The spec's status line:** "slices 1, 2 and 3 are built".

## The final migration regeneration (always)

1. `git fetch origin && git merge origin/main`, the branch's final merge.
   - On a conflict in `packages/db/drizzle/meta/_journal.json` or a snapshot, take `main`'s side with
     `git show origin/main:<path> > <path>`. A subagent may not run `git checkout -- <path>`.
2. **Always delete this branch's migration and generate it again**, whether or not `main` added one:
   - remove this branch's `.sql` file and its snapshot under `packages/db/drizzle/meta/`;
   - restore `meta/_journal.json` from `origin/main` with `git show origin/main:packages/db/drizzle/meta/_journal.json
     > packages/db/drizzle/meta/_journal.json`;
   - run `pnpm --filter @10db/db generate`;
   - diff the new SQL against Task 1's copy (`~/Agents/scratch/10db/2026-11-20/plan-s23/task-1/migration.sql`),
     ignoring the file name. They must match statement for statement. Report the diff.
3. `gh pr list --state open --json number,title,files`: still no other open pull request adding a file under
   `packages/db/drizzle/`.
4. Run the migration tests: `migrations-plans-into-sessions.test.ts`, `migrations-conversations.test.ts` and
   `database.test.ts`.

## Tests

None.

## Done when

- Prettier check and the `tests/repo` docs tests (`architecture-docs` and the AGENTS.md checks) pass.
- The regeneration is done and its SQL diff reported.
- `make precheck` is green, and the push is done.
