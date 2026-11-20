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
    - otherwise read the chat (`getChat`) and call `insertShape(ctx, chat.projectId, { chatId, title, origin })`. The
      `title` is the chat's own when its `titleSource` isn't the default, else `DEFAULT_SHAPE_TITLE`. A later title
      follows through `setChatTitle`, which already patches the chat's plan (`store/chats.ts` around line 217).
    - emit `chat.changed` for the chat (`insertShape` emits `shape.changed`), so the chat lists read `planId` again;
    - answer `{ shapeId, made: true }`.
- `packages/db/src/store/index.ts` already re-exports `shapes.ts`; nothing to add.

### daemon

- **`apps/daemon/src/chat/service.ts`:** `ChatService.showPlan(id)`.
  - `state.write((ctx) => ensurePlanOfChat(ctx, id, ShapeOrigin.App))`, then `dtoOf(id)`.
  - No turn starts and the engine isn't touched.
  - `getChat` refuses an unknown id with `NotFoundError`, as `unarchive` does.
- **`apps/daemon/src/api/services.ts`:** `showChatPlan(id: ChatId): ChatDto` on `ApiServices`, beside
  `unarchiveChat` (line 698).
- **`apps/daemon/src/daemon/chat-services.ts`:** `showChatPlan: (id) => chat.showPlan(id)`, and add it to the picked
  names list (around line 31).
- **`apps/daemon/src/api/app.ts`:** beside `/chats/:chatId/unarchive` (line 835):
  `.post('/chats/:chatId/plan', (c) => c.json(deps.services.showChatPlan(ChatId.parse(c.req.param('chatId')))))`.
  - It is a POST, so `screens/render-access.ts` refuses it to render tokens with no change there.
  - Check the dev-UI token's own route list (`runtime-files/dev-ui-token.ts` and what reads it). If that list names
    every route, add this one as refused, with a reason in the style of its neighbours.
- **Test stubs.** Every `ApiServices` stub the typecheck flags (`test/api-stub.ts`, …) gains `showChatPlan`, throwing
  as their neighbours do.

## Interfaces (implement, exactly)

From the index:

- `planIdOfChat(chatId: ChatId): ShapeId`;
- `ensurePlanOfChat(ctx, chatId, origin): { readonly shapeId: ShapeId; readonly made: boolean }`;
- `ChatService.showPlan(id: ChatId): ChatDto`;
- `ApiServices.showChatPlan(id: ChatId): ChatDto`;
- the route `POST /chats/:chatId/plan`.

## State rows (design)

- **Show Plan's write and a first `propose_plan` both land:** each runs `ensurePlanOfChat` in its own immediate
  transaction, and the second sees the first's row. One plan.
- **Show Plan pressed twice:** `made: false` the second time; 200 with the same `planId`.

## Tests

None new. `packages/db`'s existing tests that insert shapes must stay green. A test that asserts a minted shape id's
shape, rather than its prefix, follows the derived id; report any you change.

## Done when

- `pnpm --filter @10db/db exec vitest related src/store/shapes.ts --run --maxWorkers=2`, plus the daemon tests related
  to the files you touched, are green. Typecheck and lint of `@10db/db` and `@10db/daemon` pass.
- `curl -X POST …/chats/<id>/plan` on a dev daemon answers the chat with its `planId` (paste the output in your
  report).
- Report: the commit SHA(s), and that `planIdOfChat`'s export waits for Task 2 (knip). Don't push.
