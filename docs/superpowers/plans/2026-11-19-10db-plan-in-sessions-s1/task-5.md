# Task 5: routes — New Plan, start_shape, import, Accept without the 409, the plan screen

**Spec:** §5 Accept (the first two bullets); §7 What goes away (the `start_shape`, import, `see_screen` and model
rows); §1.1 (the Accept and import rows). **Track:** A.

## Files

- **`apps/daemon/src/chat/service.ts` `create`** (line 294). With `input.plan === true` it writes
  `insertPlanSession(ctx, { projectId, title: null, origin: ShapeOrigin.App, tabPosition, model, effort })` instead
  of the conversation and chat it writes now. The chat is titled from its first message, as any chat is.
- **`apps/daemon/src/api/app.ts`.**
  - Remove `POST /projects/:projectId/shapes` (line 492) and `POST /shapes/:shapeId/propose` (line 886), with their
    services (`api/services.ts`, `daemon/shape-services.ts`) and schemas.
  - `GET /projects/:projectId/shapes` stays only if something still calls it; knip says.
- **`apps/daemon/src/shape/service.ts`.**
  - `startFromTerminal` (line 513) creates the session with `insertPlanSession`, `origin: ShapeOrigin.ClaudeCode`,
    and `tabPosition` at the end of the strip, as the desktop's new tab does (read `chats` for the open count). Its
    first notice and the builder's summary go into the chat's conversation, as today.
  - `convert` (line 804) loses the `turnRuns` branch, the `holdStarts`/`releaseStarts` around the write, and the
    `dropQueuedPresses` call. It ignores `options.interrupt`, which Task 7 removes. The "Converted N proposals" line
    stays.
- **`apps/daemon/src/shape/review.ts` `reportFinding`.** A report for a task no longer pending gets the answer the
  rehearsal prompt reads as "the task changed" (`policy.ts`'s rehearsal prompt: "If a call answers that the task
  changed, stop"). It writes no mark. Check whether it does this already, add the case only if it doesn't, and say
  which.
- **`apps/daemon/src/plan-record/import.ts`.**
  - An import into a new plan creates the session with `insertPlanSession` and `tabPosition` null. Recently closed
    holds it, and the import's answer names the chat.
  - A re-import by bundle id updates the plan wherever its chat is, archived included, and leaves the chat as it is.
  - Both write in their own write, so a running turn goes on.
- **`apps/daemon/src/builder/tools.ts`** (line 250). If `start_shape`'s result schema has room, it answers the new
  session's chat id beside the shape id. If not, leave the result alone: the desktop opens the tab from the
  `ChatChanged` event.
- **`GET /tasks/:id/shape` and `GET /goals/:id/shape`** (the services behind `api/app.ts:945-950`):
  `ShapeOfDto.chatId` comes from `chatOfShape`. In `knowledge/provenance.ts` (lines 84-98), both `chatId`s come from
  it too. Provenance reaches the plan through `sessionShapeId`, which Task 2 re-pointed, so nothing else there
  changes.
- **`POST /shapes/:id/resume`** (line 935) is unchanged. No card in the daemon and no desktop query calls it today
  (`grep -rn "resumeShape\|/resume" apps/desktop/src apps/daemon/src`), so retarget nothing.
- **The plan screen.** `apps/daemon/src/screens/screens.ts` puts the asking session's chat id (`chatOfShape`) on
  the `ScreenRenderRequest` for `ScreenName.Plan`.
  - The render token's reads don't widen. The screen draws from `/shapes/:id` and the conversation's
    `/conversations/:id/items`. `screens.mayRead` and `shapeOwnedOrNone` already let those through (Task 4 makes
    the latter "a chat with a plan").
  - Task 7 builds the desktop's render page.
- **Before you open the draft pull request**, check for another open pull request that touches
  `packages/db/drizzle/`: run `gh pr list --state open --json number,title,files`. If one exists, open the draft
  anyway, put the clash in its body, and report it.

## State rows (design)

- **A turn runs × Accept:** Convert writes the rows as they stand, in one write, and the turn goes on.
- **A `tendb-rehearsal` subagent runs × Accept:** nothing is dropped. Its report on the converted task is answered
  "changed", and it stops.
- **An archived session × a re-import:** the plan is updated, and the chat stays archived.
- **A turn runs × a re-import:** both writes land, and import-pinned rows hold against later rounds.

## Tests

None new. Update the existing tests to the session-backed plan:

- the test of Convert's 409 and interrupt becomes "Convert while a turn runs writes, and the turn goes on";
- the `startFromTerminal`, import, `ShapeOfDto` and provenance tests follow the chat.

## Steps

1. The chat `create` branch and the two route removals.
2. `startFromTerminal`, import, `ShapeOfDto` and provenance.
3. Convert without the 409, and `reportFinding`'s case.
4. The plan screen's request.
5. Run
   `pnpm --filter @10db/daemon exec vitest related src/chat/service.ts src/shape/service.ts src/shape/review.ts src/plan-record/import.ts src/builder/tools.ts src/screens/screens.ts src/knowledge/provenance.ts src/api/app.ts --run --maxWorkers=2`,
   then typecheck and lint daemon, contracts and desktop.
6. Commit each step as `feat(daemon): …`, naming its paths. Then run `make precheck` and push. Once the check above
   is done, open the draft pull request `feat: plan becomes part of sessions (slice 1)`.
