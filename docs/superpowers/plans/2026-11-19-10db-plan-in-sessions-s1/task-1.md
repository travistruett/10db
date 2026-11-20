# Task 1: contracts — a chat's plan, New Plan's flag, the chat ids

**Spec:** §8 Data (the first bullet); §7 (the "Links to a Plan" and `see_screen` rows). **Track:** A. Additive only,
so the branch typechecks.

## Files

- Modify, in `packages/contracts/src/`:
  - `chat.ts`: `ChatDto.planId`, `ChatCreateInput.plan`;
  - `shape-view.ts`: `ShapeViewDto.chatId` (line 171), `ShapeOfDto.chatId` (line 294);
  - `knowledge.ts`: `ProvenanceDto.session.chatId` and `ProvenanceDto.conversation.chatId` (around lines 290-310);
  - `shape-screens.ts`: `ScreenRenderRequest.chatId` (line 79);
  - `protocol.ts`: `PROTOCOL_VERSION` 12 → 13.
- Regenerate with `pnpm --filter @10db/contracts generate`, and commit every changed file under
  `packages/contracts/generated/`.
- **The daemon**, the least that keeps it compiling (Task 2 gives each a real source):

  | Where | Set |
  | --- | --- |
  | `chat/service.ts` `dtoOf` (line 232) | `planId: null` |
  | `shape/view.ts` (line 250) | `chatId` from the conversation's chat (`chatOfConversation`), else a `NotFoundError` |
  | `knowledge/provenance.ts` | `chatId: null` in both places |
- **The desktop:** fixtures that build these DTOs (`src/test/shape-fixtures.ts`, `src/test/daemon.tsx`, and any
  others the typecheck names) gain the fields.

## Interfaces (implement, exactly)

The index's Contracts block, the lines marked "Task 1". Remove nothing.

## Tests

None. The generated-schema comparison (`contracts.test.ts`) covers the schemas.

## Steps

1. Edit the schemas and bump `PROTOCOL_VERSION`.
2. Run `pnpm --filter @10db/contracts generate`.
3. Fix the compile in the daemon and the desktop.
4. Run
   `pnpm --filter @10db/contracts exec vitest related src/chat.ts src/shape-view.ts src/knowledge.ts src/shape-screens.ts src/protocol.ts --run --maxWorkers=2`,
   then typecheck and lint contracts, daemon and desktop.
5. Commit, naming every path: `feat(contracts): a chat names its plan and new plan asks for one`.
