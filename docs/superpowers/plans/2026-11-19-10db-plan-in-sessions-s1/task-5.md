# Task 5: routes — New Plan, start_shape, import, resume, Accept without the 409

**Spec:** §5 Accept (the first two bullets); §7 What goes away (the `start_shape`, import, Re-plan, `see_screen` and
model rows); §1.1 (the "A turn runs × Accept" row). **Track:** A.

## Files

- `apps/daemon/src/chat/service.ts` `create` (line 294): with `input.plan === true` it writes
  `insertPlanSession(ctx, { projectId, title: null, origin: ShapeOrigin.App, tabPosition, model, effort })` instead of the conversation and chat it writes now. The chat is titled from its first message as
  any chat is; the plan's title follows the chat's (`shapes.title` is set where the chat's is set).
- `apps/daemon/src/api/app.ts`:
  - remove `POST /projects/:projectId/shapes` (line 492) and `POST /shapes/:shapeId/propose` (line 886), with
    their services and schemas;
  - `GET /projects/:projectId/shapes` stays only if something still calls it (knip says).
- `apps/daemon/src/shape/service.ts`:
  - `startFromTerminal` (line 513) creates the session with `insertPlanSession`, `origin: ShapeOrigin.ClaudeCode`
    and `tabPosition` at the end of the strip (`nextTabPosition`, or what `create` uses). Its first notice and
    the builder's summary go into the chat's conversation as today.
  - `convert` (line 804): remove the `turnRuns` branch and `options.interrupt`. Drop `holdStarts` and
    `releaseStarts` around the write: Convert is one write, and a round is another. The "Converted N proposals"
    line stays.
- `packages/contracts/src/shape.ts`: `ShapeConvertInput.interrupt` goes. Regenerate.
- `apps/daemon/src/plan-record/import.ts` (around line 613): an import creates the session with
  `insertPlanSession`, archived = false, `tabPosition` null. It writes each imported proposal with
  `pinned: ['*']`. A re-import by bundle id updates the same plan as today.
- `apps/daemon/src/builder/tools.ts` (line 250): `start_shape` answers the created session's chat id beside the
  shape id, if its result schema has room. Otherwise leave the result alone; the desktop opens the tab from the
  `ChatChanged` event.
- `GET /tasks/:id/shape` and `GET /goals/:id/shape` (the services behind `api/app.ts:945-950`): `ShapeOfDto.chatId`
  comes from `chatOfShape`.
- `POST /shapes/:id/resume` (line 935): unchanged. The note is written into the plan's chat conversation through
  `shapeConversation`. The engine's Re-plan card's Open goes to the session: find the card builder (`grep -rn
  "Re-plan in Shape\|resume" apps/daemon/src/delivery`) and point its target at the chat.
- `apps/daemon/src/screens/screens.ts` and the render request: `ScreenName.Plan` draws the asking session
  (`/sessions?chat=<chatId>&plan=1`). The request carries the chat id beside the shape id, and
  `apps/desktop/src/screens/render-params.ts` `pathOf` (line 20) builds that path. Task 7 makes the desktop honour
  `plan=1`.

## State rows (design)

*A turn runs × Accept:* Convert writes the rows as they stand, in one write, and the turn goes on.

## Tests

None new. Update the tests of Convert's 409 and interrupt: the 409 test changes to "Convert while a turn runs
writes and the turn goes on". Update `startFromTerminal`, import and `ShapeOfDto` tests to the session-backed plan.

## Steps

1. The chat `create` branch and the two route removals.
2. `startFromTerminal`, import and `ShapeOfDto`.
3. Convert without the 409.
4. Resume's card and the screen path.
5. Run `pnpm --filter @10db/daemon exec vitest related src/chat/service.ts src/shape/service.ts src/plan-record/import.ts src/builder/tools.ts src/screens/screens.ts src/api/app.ts --run --maxWorkers=2`,
   then typecheck and lint daemon, contracts and desktop.
6. Commit each step, `feat(daemon): …` for each, naming its paths. Then push the branch and open the draft pull
   request if none exists. Title: `feat: plan becomes part of sessions (slice 1)`.
