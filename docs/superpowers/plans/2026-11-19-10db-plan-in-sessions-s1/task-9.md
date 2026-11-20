# Task 9: docs, and the migrations after the last main merge

**Spec:** the whole of slice 1, for the docs; §8, for the migrations. **Track:** none. The coordinator, or a fresh
implementer, runs it last.

## Files

- **The decision record** `2026-11-19-plan-becomes-part-of-sessions.md` in `docs/architecture/decisions`,, in the format the folder's README
  gives. It records:
  - the plan points at its chat;
  - the chat's hooks own the conversation, with the plan's parts;
  - the reviewer stamp is bookkeeping;
  - the forward migration keeps plans that fed the Board, and deletes the rest while keeping their sessions;
  - Jev's ShapeReady shadow is retired.

  It names where it supersedes `decisions/2026-11-13-one-explore-engine-runs-sessions-and-plan.md`: one owner, not
  two.
- **`apps/daemon/src/shape/AGENTS.md`**:
  - the first bullet's Plan-owner sentences become `plan-parts.ts` and the chat's hooks;
  - `/mcp` gives a chat with a plan both tool sets;
  - the Propose lines go;
  - the routes line and the import pin read as built.
- **`apps/daemon/src/chat/AGENTS.md`**:
  - `hooks.ts` composes `PlanParts` for a chat with a plan;
  - `judgeChatCall` sends Plan tools to `judgePlanTool`;
  - Archive keeps the plan's folder.
- **`packages/db/AGENTS.md`**, only if a rule changed. None is expected.
- **`docs/architecture/db-storage.md`**:
  - the `shapes` entry names `chat_id`;
  - the `sessions` entry names the relaxed check;
  - the migration entry says what moved and what was deleted.
- **The migrations.** Run `git fetch origin && git merge origin/main`. If `main` added migrations after the branch's
  three:
  1. Copy migration 2's SQL aside.
  2. Delete the branch's three migration files, their `meta/` snapshots and their journal entries.
  3. Regenerate as Task 2 did: nullable first, then the custom migration with the saved SQL put back byte for byte,
     then the final schema.
  4. Update `MIGRATION` in `packages/db/src/migrations-plans-into-sessions.test.ts` to migration 1's new tag.
  5. Re-run that test.

## Steps

1. Write the docs. Commit: `docs: plan is part of sessions`.
2. Merge `main` and, if needed, renumber. Commit: `fix(db): renumber plan migrations after main`.
3. Run `make precheck` and push. Mark the pull request ready once CI is green.
