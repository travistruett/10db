# Task 4: Show Plan on every session, File as Tasks retired, the row's state dot

**Spec:** §1 (the Talking row's Show Plan); §2 The Plan panel (a row's dot for its state); §7 (the File as Tasks row).
**Track:** B. Read `apps/desktop/AGENTS.md`, `apps/desktop/src/views/sessions/AGENTS.md` and
`apps/desktop/src/views/sessions/plan/AGENTS.md` once, and keep notes. Needs Task 1 on the branch (the route). The
click-through waits for Task 3.

## Files

### Show Plan

- **`apps/desktop/src/daemon/chat-queries.ts`:** add `useShowPlan()` beside `useUnarchiveChat` (line 222). Its
  mutation is `readJson(await client.chats[':chatId'].plan.$post({ param: { chatId } }), ChatDto)`, invalidating
  `chatKeys.all` on settle.
- **`apps/desktop/src/views/sessions/chat-tab.tsx`:**
  - The title row's `plan` prop (line 568) is given for every session, except one whose conversation is `sealed`
    (the `HandedOffLine` case) or whose project was removed (`removed`).
  - `togglePlan` (line 219):
    - with `planId` set, flip `planChoice` as today;
    - with `planId` null, call `showPlan.mutateAsync(chat.id)`, then `planChoice.set(chat.id, true)`. While pending,
      the toggle is `loading`. A failure shows "Couldn't show the Plan: <reason>" in the tab's alert, the one
      `gitError` uses, or a sibling of it, and the toggle stays off.
  - `usePlanOpen(chat.id, chat.planId !== null)` is unchanged: a session opens its panel by default once it has a
    plan, so a plan the agent's `propose_plan` made opens beside the conversation when `chat.changed` brings
    `planId`.
  - `uploads` (line 743) stays only for a session with a plan. A plain session drops pictures as today.
- **`apps/desktop/src/views/sessions/session-title.tsx`** (line 134):
  - the toggle gets a Mantine `Tooltip`, "Close Plan" when open and "Show Plan" when not;
  - its `plan` prop gains an optional `pending: boolean`, drawn as `loading`;
  - the label stays "Plan", with `aria-pressed`.

### File as Tasks retired

- **`chat-tab.tsx`:** remove `FILE_AS_TASKS_MESSAGE` (line 84) and the `onFileAsTasks` action (lines 572-583). In its
  place, give `onTogglePlan: togglePlan` and `planOpen` under the same conditions as the toggle. `ChatTabProps.actions`'
  `Omit` (line 104) names `onTogglePlan` and `planOpen` in place of `onFileAsTasks`, and its comment follows.
- **`apps/desktop/src/views/sessions/session-menu.tsx`:**
  - `SessionActions.onFileAsTasks` goes; add `onTogglePlan` and `planOpen` (index Interfaces);
  - the menu item reads "Close Plan" when `planOpen`, else "Show Plan", where File as Tasks was;
  - the Sessions panel's right-click menu (`sessions-panel.tsx`) gives neither, so it draws neither.
- `git grep -n "FILE_AS_TASKS\|onFileAsTasks\|File as Tasks" -- apps/desktop/src` should come back empty, AGENTS.md
  aside (Task 6 fixes those). The e2e step is Task 5's.

### The row's state dot

- **`apps/desktop/src/views/sessions/plan/proposal-text.ts`:** add `rowDot(row)`. Take the first that holds:
  1. accepted (`isConverted(row)`): "Accepted", `teal`;
  2. `row.mark === 'new'`: "New this round", `blue`;
  3. `row.mark === 'changed'`: "Changed this round", `blue`;
  4. `row.mark === 'moved'`: "Moved to Earlier", `gray`;
  5. pinned (`row.pinned.length > 0`): "Pinned", `yellow`;
  6. otherwise: "Proposed", `gray`.

  The colours are Mantine names. The UI choice is yours to tune from the screenshot.
- **`proposal-row.tsx`:**
  - an 8 px dot before the title (`ColorSwatch` or a `Box` with a radius), its `aria-label` and `Tooltip` the label;
  - keep the trailing mark word and the pin icon. A colour alone says nothing to a reader of the screen, and the
    e2e reads the words;
  - running and done states arrive with slice 3, which extends `rowDot`.

## Interfaces (implement, exactly)

From the index:

- `useShowPlan(): UseMutationResult<ChatDto, Error, ChatId>`;
- `SessionActions.onTogglePlan?: () => void` and `planOpen?: boolean`;
- `rowDot(row: ShapeProposalDto): { readonly label: string; readonly color: string }`.

Called: `POST /chats/:chatId/plan` (Task 1).

## State rows (design)

- **A turn runs × Show Plan:** the panel opens empty, and the turn goes on. The composer isn't locked.
- **Show Plan × the request fails:** the toggle stays off and the tab says why.
- **Show Plan pressed twice quickly:** the second press sees `pending` and does nothing.
- **A plain session × `propose_plan` passes:** `planId` arrives, and the panel opens (no choice was made).
- **The builder closed the panel × a round lands:** it stays closed. The tooltip and ⋯ read "Show Plan".
- **A sealed chat or a removed project:** no toggle, no ⋯ item.

## Tests

None: a user-visible change extends the e2e (Task 5). No rendered-component test.

## Done when

- `pnpm --filter @10db/desktop exec vitest related <files> --run --maxWorkers=2`, typecheck and lint are green.
- **Click-through** (after Task 3 is on the branch), on the real daemon with the fake adapter, in the dev window or
  `pnpm dev` in a browser:
  1. a plain session: send "Make the cards denser"; no panel;
  2. press Plan: the panel opens empty;
  3. drop `notes.md` and send "Thin out the scrollbars": the reply names the file and Heard so far shows;
  4. send "propose it": the rows show, each with its dot;
  5. close the panel and send "propose it again": it stays closed, and ⋯ reads "Show Plan";
  6. a second plain session: send "propose it" with no Show Plan; the panel opens with the rows;
  7. ⋯ has no File as Tasks.

  Put the screenshots in your scratch folder, and name them in your report.
- Report: the SHA(s), the screenshots, and every UI choice you made.
