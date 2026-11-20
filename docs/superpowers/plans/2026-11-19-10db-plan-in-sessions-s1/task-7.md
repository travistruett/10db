# Task 7: the Plan view goes; every link opens the session

**Spec:** §7 What goes away, and where the rest goes (every row); §2 Head (Record). **Track:** B. It needs Task 5.

## Files

- `apps/desktop/src/router.tsx`:
  - remove `newShapeRoute`, `shapeRoute` and their pages (lines 167-182);
  - move `recordRoute` (line 184) to `/sessions/record/$shapeId`, with the same `validateSearch: recordSearch`;
  - `/sessions` search accepts `plan` (`sessions-search.ts`: `plan: '1'` opens the panel), for the screen path
    from Task 5.
- `apps/desktop/src/shell/rail-items.ts` (line 34) and `shell/rail.tsx` (lines 98-115): remove the Plan item and
  `PlanLink`. Delete `shell/shape-nav.tsx`.
- Retarget each link to `useOpenSession()(chatId)` (`views/sessions/open-session.ts:12`), with `chatId` from
  `ShapeOfDto.chatId` or `ChatDto`:
  - `views/board/board-view.tsx:478`;
  - `views/board/task-drawer.tsx:44, 149-152`;
  - `views/shape/open-conversation.tsx`, moved to `views/sessions/plan/` and showing "Open Session";
  - `views/board/goal-line.tsx`;
  - `views/board/plan-context-disclosure.tsx`;
  - `views/factory/planned-in.tsx:19` and `goal-detail.tsx`: the Record route;
  - `views/knowledge/provenance-drawer.tsx`;
  - `views/shape/conversation-link.tsx`, moved or removed as its callers need.
- `views/factory/factory-view.tsx:93` and `live-list.tsx:242`: the "Plan" buttons that link to `/shape` run New
  Plan instead, through the same action the Sessions panel's menu uses.
- `views/shape/plan-measures.tsx` moves to `views/settings/` and shows in `planning-section.tsx`.
- Delete the rest of `views/shape/` and its tests, and the queries only it used (`daemon/shape-queries.ts` hooks
  for create, propose, history; keep `useShapeView` and the row mutations). Knip names what's dead.
  `views/shape/record/` moves to `views/sessions/plan/record/` with its test.
- `src/screens/render-params.ts` and its test: the `Plan` path is `/sessions?chat=<chatId>&plan=1`.
- `views/shape/AGENTS.md`: its notes that still hold move to `views/sessions/plan/AGENTS.md`; the file goes.
  `views/factory/AGENTS.md` and `views/knowledge/AGENTS.md` lose their `/shape` mentions.

## Tests

None new. `record-view.test.tsx` and `render-params.test.ts` move or change with their code. `router.test.tsx`
loses its `/shape` rows and gains none.

## Steps

1. Routes and the rail; typecheck.
2. Each link, one commit per area (board, factory, knowledge).
3. Measures to Settings, Record moved, the rest deleted; knip clean.
4. Run `pnpm --filter @10db/desktop exec vitest related <changed files> --run --maxWorkers=2`, typecheck, lint and
   `pnpm exec knip`.
5. Commit each green step, `feat(desktop): …` / `refactor(desktop): …`, naming paths.
