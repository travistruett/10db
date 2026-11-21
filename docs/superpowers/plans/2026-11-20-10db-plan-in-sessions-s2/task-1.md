# Task 1: a plan's id, ensurePlanOfChat, and Show Plan's route

**Spec:** §1 The session's workflow (the Talking row's Show Plan, and "A session has a Plan as soon as the agent
proposes something or you open the panel"); §8 Data ("a chat has at most one plan").
**Track:** A. Read `packages/db/AGENTS.md` and `apps/daemon/src/chat/AGENTS.md` once, and keep notes in your scratch
folder.

## Files

### db

- **`packages/db/src/store/shapes.ts`:**
  - add `planIdOfChat(chatId)`: `idOfUuid('Shape', idUuid(chatId))` from `@10db/contracts`. A null (never expected:
    every chat id carries a uuid) throws a named `Error` subclass. No `!`, no cast.
  - `insertShape` (line 71): the row's `id` is `planIdOfChat(input.chatId)` in place of `mintId('Shape')`. So
    `insertPlanSession` (New Plan, import, `start_shape`) writes derived ids too. `shapes_chat_unique` still holds one
    plan per chat.
  - add `ensurePlanOfChat(ctx, chatId, origin)`:
    - with `planOfChat(ctx.tx, chatId)` non-null, answer `{ shapeId, made: false }` and write nothing;
    - otherwise read the chat (`getChat`) and call `insertShape(ctx, chat.projectId, { chatId, title, origin })` with
      `title = chat.title === CHAT_DEFAULT_TITLE ? DEFAULT_SHAPE_TITLE : chat.title`. A later title follows through
      `setChatTitle`, which already patches the chat's plan (`store/chats.ts` around line 217).
    - emit `chat.changed` for the chat (`insertShape` emits `shape.changed`), so the chat lists read `planId` again.
      `store/chats.ts`' `changed` is not exported; emit it directly in `shapes.ts`:
      `ctx.emit({ type: EventType.ChatChanged, entityType: 'chat', entityId: chatId, data: { projectId } })`;
    - answer `{ shapeId, made: true }`.
- `packages/db/src/store/index.ts` already re-exports `shapes.ts`; nothing to add.

### daemon

- **`apps/daemon/src/chat/service.ts`:** `ChatService.showPlan(id)`.
  - Refuse first, in this order:
    - an archived chat (`archivedAt !== null`), with `ConflictError(CHAT_ARCHIVED)` (line 104);
    - a sealed one (its conversation's state is `ConversationState.Sealed`), with
      `ConflictError('This session's work moved to a task, so it has no Plan.')`, as an exported constant beside
      `HANDING_OFF` (line 109).
  - Then `state.write((ctx) => ensurePlanOfChat(ctx, id, ShapeOrigin.App))`, then `dtoOf(id)`.
  - No turn starts and the engine isn't touched. A chat in the builder's terminal (taken over) is allowed: the plan
    is made, and the next session after Hand Back starts with it (Task 2).
  - `getChat` refuses an unknown id with `NotFoundError`, as `unarchive` does.
- **`apps/daemon/src/api/services.ts`:** `showChatPlan(id: ChatId): ChatDto` on `ApiServices`, beside
  `unarchiveChat` (line 698).
- **`apps/daemon/src/daemon/chat-services.ts`:** `showChatPlan: (id) => chat.showPlan(id)`, and add it to the picked
  names list (around line 31).
- **`apps/daemon/src/api/app.ts`:** beside `/chats/:chatId/unarchive` (line 835):
  `.post('/chats/:chatId/plan', (c) => c.json(deps.services.showChatPlan(ChatId.parse(c.req.param('chatId')))))`.
  - Both token lists, `screens/render-access.ts` and `screens/dev-ui-access.ts`, are GET-only and refuse every
    other method. So the new POST needs no entry in either; don't add one.
- **Test stubs.** Every `ApiServices` stub the typecheck flags (`test/api-stub.ts`, …) gains `showChatPlan`, throwing
  as their neighbours do.

## Interfaces (implement, exactly)

From the index:

- `planIdOfChat(chatId: ChatId): ShapeId`;
- `ensurePlanOfChat(ctx, chatId, origin): { readonly shapeId: ShapeId; readonly made: boolean }`;
- `ChatService.showPlan(id: ChatId): ChatDto`;
- `ApiServices.showChatPlan(id: ChatId): ChatDto`;
- the route `POST /chats/:chatId/plan` (409 for an archived or sealed chat).

## State rows (design)

- **Show Plan's write and a first `propose_plan` both land:** each runs `ensurePlanOfChat` in its own immediate
  transaction, and the second sees the first's row. One plan.
- **Show Plan pressed twice:** `made: false` the second time; 200 with the same `planId`.
- **Show Plan on an archived or sealed chat:** 409 with the words above; nothing written.
- **Show Plan while the chat is in the builder's terminal:** the plan is made; nothing reaches the terminal.

## Tests

None new. `packages/db`'s existing tests that insert shapes must stay green. A test that asserts a minted shape id's
shape, rather than its prefix, follows the derived id; report any you change.

## Done when

- `pnpm --filter @10db/db exec vitest related src/store/shapes.ts --run --maxWorkers=2`, plus the daemon tests related
  to the files you touched, are green. Typecheck and lint of `@10db/db` and `@10db/daemon` pass.
- `curl -X POST …/chats/<id>/plan` on a dev daemon answers the chat with its `planId` (paste the output in your
  report).
- Report: the commit SHA(s). Task 1 lands and pushes alone: knip ignores exports used in their own file.
