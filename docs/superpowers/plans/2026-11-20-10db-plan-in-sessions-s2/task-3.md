# Task 3: Plan's tools in every chat's session

**Spec:** §3 How the agent plans (tools in every session; "A round is one `propose_plan` call"); §1 ("A session has a
Plan as soon as the agent proposes something").
**Track:** A. Read `apps/daemon/src/shape/AGENTS.md` and `apps/daemon/src/mcp/AGENTS.md` (if present) once, and keep
notes. Needs Tasks 1 and 2.

## Files

### `apps/daemon/src/mcp/server.ts`

- `conversationTools(deps, session)` (line 121) loses `shapeId`. For a chat's session (`chatTools` non-null) it
  returns the chat's tools plus `shapeTools`, always. A session with neither a workstream nor a chat stays 401.
- `shapeTools(deps, sessionId, chat)` takes `{ chatId, projectId }`, read the way `chatTools` reads them (the
  conversation's `ownerId` parsed as `ChatId`, its `projectId`). Read the conversation once and share it between
  the two.
- Line 144: `sessionShapeId` is no longer called. Remove it from `packages/db/src/store/sessions.ts` and the db
  exports if nothing else uses it (`git grep -n sessionShapeId`). knip flags it otherwise.
- Update the comment above `createMcpHandler`'s tool choice (line 141).

### `apps/daemon/src/mcp/shape-tools.ts`

- `ShapeToolsFor` takes `{ sessionId, chatId, projectId }` (index Interfaces).
- **The descriptions** (`SHAPE_TOOL_DESCRIPTIONS`) still name the retired Propose press. Fix them:
  - `note_heard`: "Echo what you have heard so far as up to 12 short items (80 characters each), shown at the top of
    the session's Plan. Replaces the previous echo. It proposes nothing, and with no Plan yet it shows nothing."
  - `propose_plan`: drop "Refused until the builder has pressed Propose." and add "The first call that passes starts
    this session's Plan."
  - `attach`, `write_spec`, `report_finding`, `resolve_finding`, `see_screen`: add "Needs the session's Plan."

### `apps/daemon/src/shape/tools.ts`

- `createShapeToolHandlers(deps, chat)` takes `{ chatId, projectId }`. Each handler reads
  `planOfChat(deps.state.db, chat.chatId)` at its call, never at construction.
- `NO_PLAN_YET` (exported, exact words in the index).
- **`propose_plan`**, in its one write:
  - `const { shapeId } = ensurePlanOfChat(ctx, chat.chatId, ShapeOrigin.App)`, then `reconcileDraft`;
  - on a pass, the line as today;
  - on a refusal, throw a named error carrying `result.errors` from inside the write, so a plan this call made rolls
    back with it. Catch it outside and reject with today's `InvalidError` text.
  - A refused call on a session that already had a plan still writes its `propose_plan · refused` line. So in that
    case, write the line and return without throwing, as today. Only a call whose `ensurePlanOfChat` answered
    `made: true` throws.
  - `ceremonies(…)` and `buildSizes(…)` take the resolved `shapeId`.
- **`note_heard`:** no plan means answer `{ heard: 0 }` and write nothing.
- **`similar_tasks`, `find_records`:** read `chat.projectId` (no `getShape`). They write their dimmed line only when
  there is a plan.
- **`attach`, `write_spec`, `report_finding`, `resolve_finding`, `see_screen`:** with no plan,
  `Promise.reject(new InvalidError(NO_PLAN_YET))`; else as today with the resolved id.
- The module comment at line 19 is stale (it lists four tools). Make it say what the file does now.

### `apps/daemon/src/shape/service.ts`

- `toolsFor` (line 373) passes `{ chatId, projectId }` through, and `screens.see` keeps taking the resolved
  `shapeId`.

### The fake

`apps/daemon/src/sessions/fake-plan-script.ts` needs no change. Its `note_heard` now answers in a plain session, and
"propose" makes the plan through the same handler. Check that no e2e sends "propose" in a session that expects no
plan:

```sh
grep -rn "propose" apps/desktop/e2e/*.spec.ts
```

Report what you find.

## Interfaces (implement, exactly)

From the index:

- `ShapeToolsFor` with `{ sessionId: SessionId; chatId: ChatId; projectId: ProjectId }`;
- `createShapeToolHandlers(deps, chat)`;
- `NO_PLAN_YET`.

Called: `ensurePlanOfChat`, `planOfChat` (Task 1).

## State rows (design)

- **A plain session × a passing `propose_plan`:** the plan and its rows land in one write. `chat.changed` (from
  `ensurePlanOfChat`) and `shape.changed` reach the desktop.
- **A plain session × a refused first `propose_plan`:** no plan, no line, no event. The agent gets every error.
- **Show Plan × a first `propose_plan`:** whichever writes second finds the plan.
- **A plain session × `note_heard`:** answered, nothing written.
- **A plain session × a tool that needs rows:** `NO_PLAN_YET`.

## Tests

None new: the e2e (Task 5) runs a plan made by `propose_plan` in a plain session. The existing daemon tests of the
handlers and the MCP server must stay green. Ones that construct `createShapeToolHandlers(deps, shapeId)` or call
`conversationTools` with a shape id follow the new signatures; that is a signature change, not a behaviour change.
List them in your report.

## Done when

- Related tests for the files above are green (`--maxWorkers=2`). The daemon's typecheck and lint pass, and `knip`
  is clean.
- On a dev daemon with the fake adapter (`pnpm dev`):
  1. a plain session's "Make the cards denser" gets "Noted…" and its chat still has `planId: null`;
  2. "propose it" then gives the chat a `planId`, and `GET /shapes/:id` has the rows.

  Paste both reads in your report.
- Report: the SHA(s). The daemon code review starts on Tasks 1-3 once this lands.
