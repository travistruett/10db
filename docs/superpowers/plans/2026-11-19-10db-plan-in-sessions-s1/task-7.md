# Task 7: the Plan view goes; every link opens the session

**Spec:** §7 What goes away, and where the rest goes (every row); §2 Head (Record). **Track:** B. It needs Task 5.
This card also owns removing `proposeUnlocked` and `interrupt` from contracts, daemon and desktop.

## Files

### Routes

`apps/desktop/src/router.tsx`:

- remove `newShapeRoute` and `shapeRoute`, with their pages (lines 167-182);
- move `recordRoute` (line 184) to `/sessions/record/$shapeId`, keeping `validateSearch: recordSearch`.

### Opening a plan's session from anywhere

`useOpenSession` (`views/sessions/open-session.ts:12`) brings back an archived chat before it opens it, the way
`bringBack` does in `sessions-view.tsx` (lines 208-213): unarchive, give it a tab, then navigate. It needs the chat,
so it takes a `ChatDto` or fetches the chat by id. Every retargeted link calls it.

### Retarget each link

Each link opens the session, with `chatId` from `ShapeOfDto.chatId`, either `chatId` on `ProvenanceDto`, or `ChatDto`.

- **The Board:**
  - `views/board/board-view.tsx:478`;
  - `views/board/task-drawer.tsx:44, 149-152`, through `OpenConversation`, which moves from
    `views/shape/open-conversation.tsx` to `views/sessions/plan/` and reads "Open Session";
  - `views/board/goal-line.tsx`;
  - `views/board/plan-context-disclosure.tsx`.
- **Factory:** `views/factory/planned-in.tsx:19` and `goal-detail.tsx` open the session, not the Record (spec §7).
  The Record opens from the panel's ⋯.
- **Knowledge:** in `views/knowledge/provenance-drawer.tsx:103-105`, "Plan session: <title>" opens the session.
- **`views/shape/conversation-link.tsx`:** move it or remove it, as its callers need.

### The rail

Remove the Plan item and `PlanLink` from `apps/desktop/src/shell/rail-items.ts` (line 34) and `shell/rail.tsx`
(lines 98-115). Delete `shell/shape-nav.tsx`.

### Factory's Plan buttons

`views/factory/factory-view.tsx:93` and `live-list.tsx:242` link to `/shape`. They run New Plan instead, through the
same action the Sessions panel's menu uses.

### Measures

`views/shape/plan-measures.tsx` moves to `views/settings/` and shows in `planning-section.tsx`.

### The plan screen's render page

In `src/screens/render-params.ts`, `pathOf` (line 20) gives `ScreenName.Plan` a render-only path,
`/plan-screen/$shapeId`, with `chatId` from the request.

- It draws the conversation's items (`/conversations/:id/items`) and the plan panel (`/shapes/:id`), and reads
  nothing else, so it works under a render token.
- Register it only for the render app (`screens/render-app.tsx`).
- `render-params.test.ts` follows.

### Delete the rest of `views/shape/`

- Delete its tests and the queries only it used: the create, propose and history hooks in
  `daemon/shape-queries.ts`. Keep `useShapeView` and the row mutations. Knip names what is dead.
- `views/shape/record/` moves to `views/sessions/plan/record/`, with its test.
- The notes in `views/shape/AGENTS.md` that still hold move to `views/sessions/plan/AGENTS.md`.
  `views/factory/AGENTS.md` and `views/knowledge/AGENTS.md` lose their `/shape` mentions.

### The contract removals

- Remove `ShapeDto.proposeUnlocked` and `ShapeConvertInput.interrupt` from `packages/contracts/src/shape.ts`, then
  regenerate.
- In the daemon, remove the interim `proposeUnlocked: true` (`toShapeDto` in `packages/db/src/store/shapes.ts`) and
  the ignored `interrupt` (`convert` in `shape/service.ts`).
- In the desktop, remove the uses in `daemon/shape-queries.ts:234-237`, `views/sessions/plan/proposed-pane.tsx:363`
  and the fixtures.

## State rows (design)

**A link to a plan × the session is archived:** the session is brought back, then opened.

## Tests

None new. `record-view.test.tsx` and `render-params.test.ts` move or change with their code. `router.test.tsx`
loses its `/shape` rows.

## Steps

1. Routes, the rail, and `useOpenSession` bringing back an archived chat. Typecheck.
2. Each link, one commit per area: board, factory, knowledge.
3. The render page.
4. Measures to Settings, Record moved, the rest deleted, and the contract removals. Knip clean.
5. Run `pnpm --filter @10db/desktop exec vitest related <changed files> --run --maxWorkers=2`, plus the daemon's and
   contracts' related tests for the removals. Then typecheck, lint and run `pnpm exec knip`.
6. Commit each green step as `feat(desktop): …`, `refactor(desktop): …` or `feat(contracts): …`, naming the paths.
