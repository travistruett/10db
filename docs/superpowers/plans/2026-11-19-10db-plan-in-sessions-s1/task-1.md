# Task 1: contracts — a chat's plan, New Plan's flag, the view's chat

**Spec:** §8 Data (first bullet); §7 (the "Links to a Plan" row). **Track:** A. Additive only, so the branch
typechecks.

## Files

- Modify, in `packages/contracts/src/`:
  - `chat.ts`: `ChatDto.planId`, `ChatCreateInput.plan`;
  - `shape-view.ts`: `ShapeViewDto.chatId`, `ShapeOfDto.chatId`;
  - `protocol.ts`: `PROTOCOL_VERSION` 12 → 13.
- Regenerate with `pnpm --filter @10db/contracts generate`, and commit every changed file under
  `packages/contracts/generated/`.
- Daemon, the least that keeps it compiling:
  - `chat/service.ts` `dtoOf` (around line 232) sets `planId: null`;
  - `shape/view.ts` (line 250) sets `chatId`.

  Task 2 gives `chatId` a real source. Until then, read it from the conversation's chat, or throw
  `NotFoundError` when the conversation has none, because a Plan conversation has no chat before Task 2. Do
  whichever compiles; Task 2 replaces it.
- Desktop: fixtures that build a `ChatDto` or `ShapeViewDto` (`src/test/shape-fixtures.ts`, `src/test/daemon.tsx`,
  and any others the typecheck names) gain the fields.

## Interfaces (implement, exactly)

The index's "Contracts (Task 1)" block: `ChatDto.planId`, `ChatCreateInput.plan`, `ShapeViewDto.chatId`,
`ShapeOfDto.chatId`. Don't remove anything yet.

## Tests

None. The schemas are covered by the contracts' generated-schema comparison (`contracts.test.ts`).

## Steps

1. Edit the schemas and bump `PROTOCOL_VERSION`.
2. Run `pnpm --filter @10db/contracts generate`.
3. Fix the compile in the daemon and the desktop with the minimal values above.
4. Run `pnpm --filter @10db/contracts exec vitest related src/chat.ts src/shape-view.ts src/protocol.ts --run --maxWorkers=2`.
   Then typecheck and lint contracts, daemon and desktop.
5. Commit, naming every path. Message: `feat(contracts): a chat names its plan and new plan asks for one`.
