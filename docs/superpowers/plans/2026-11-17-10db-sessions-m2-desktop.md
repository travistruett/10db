# Sessions M2, desktop track: the panel, the title row, the bar and the drawer

This is Track B of `2026-11-17-10db-sessions-m2.md`. The Brief, the Global constraints, the Interfaces, the
provider-parity table and the state × event table are there, and this plan cites the table's rows by number.

> **For agentic workers:** views and wiring, so one vertical slice in a handful of commits, tested through
> `renderWithDaemon` with MSW fixtures built from Task 1's contracts. The slice meets the real daemon in the main
> plan's Task 14. Commit after every green step, with the value card shown for each newly tested behaviour. Run
> `pnpm --filter @10db/desktop exec vitest related <files> --run --maxWorkers=2`, plus typecheck and lint. Cite
> code by symbol: M1 moves lines.

**Starts after:**
- the main plan's Tasks 1-2;
- M1's merge into the integration branch;
- for B5 only, the coordinator's merge of `main`, which holds #651 (`dd8c1e3b`).

**Builds on M1's Interfaces** (`2026-11-17-10db-app-shell-m1.md`): `TitleRow`, `Panel`, `SurfaceDrawer` and
`RailSection`, as written there.

**Owns:**
- `apps/desktop/src/views/sessions/**`;
- `conversation/composer.tsx`, `conversation/item-entries.ts`, `conversation/folder-wait.tsx`;
- `daemon/chat-queries.ts`, `daemon/do-it-queries.ts` and the new `daemon/chat-work-queries.ts`;
- the New Task form's opener in `views/board/`;
- the `/sessions` route in `router.tsx`.

**Never touches:** `views/inbox/**`, which M3 owns. `OpenTaskLink` and `OpenSessionLink` keep their names and
files.

## Task B1: the panel and the title row

1. **Pure parts, each with a table test.**
   - `views/sessions/panel-order.ts`:
     - projects in the project list's order;
     - within a project, by `tabPosition`;
     - fresh "New session" rows at the top of their project;
     - the flat order that ⌘1-9, ⌘⇧[ ], ⌃Tab and ⌘J walk.

     `Value: protects=keys and the panel agree on order; fails_when=the selected project jumps or fresh rows misplace; why_new=the strip's order was tab order; no_claim=drag`
   - `views/sessions/row-state.ts`: the icon (reading, here, branch, terminal) and the right-hand mark, in spec
     §6.1's order. One row per precedence pair.

     `Value: protects=a row says where a session works and whether it needs you; fails_when=precedence or icon is wrong; why_new=tab marks had other states; no_claim=colour contrast`
2. **`views/sessions/sessions-panel.tsx`** in `Panel section="sessions"`:
   - head: "Sessions", search, New Session;
   - groups with a 14 px project tile;
   - 30 px rows, with a spinner (a static dot under reduced motion) and marks never by colour alone;
   - hover ×;
   - a right-click menu: Rename, Open in Terminal, Make a Board Task…, Archive, Close;
   - drag to reorder through `PATCH tabPosition`;
   - Recently closed (five, `tendb.sessions.closed`) at the foot;
   - whole up to 200 rows, then `@tanstack/react-virtual`;
   - search through `GET /chats/search`, with `keepPreviousData`.
3. **`views/sessions/session-title.tsx`** in `TitleRow`:
   - the title, renamed by a double-click;
   - the ⌄ switcher: open sessions by project, Recently closed, New Session ⌘T;
   - the meta line (B3);
   - the agent and model;
   - the context ring, moved from `session-bar.tsx`;
   - the terminal button;
   - ⋯: today's `TabMenuItems`, plus Make a Board Task….
4. **`sessions-view.tsx`.**
   - It renders the selected chat or fresh tab. The strip and its `HeaderSlot` use are gone.
   - Keys (`judgeSessionKey` in `session-keys.ts`) walk `panelOrder`.
   - ⌘⇧↩ is removed.
   - `?task=` still renders today's task tab until B5.
5. **Delete:**
   - `tab-strip.tsx` and its test;
   - `session-tab.tsx`, `all-tabs-menu.tsx`;
   - `strip-layout.ts` and its test;
   - `narrow-sessions.test.tsx`;
   - whatever in `strip-tabs.ts`, `tab-info.ts` and `tab-state.ts` knip then reports unused.

   Keep `nextNeeding` and its signature, since the rail reads it.
6. **Rendered tests,** extending `sessions-view.test.tsx` and `sessions-keyboard.test.tsx`:
   - groups and order;
   - a running row's spinner;
   - a choosing row's mark;
   - drag;
   - ⌘1, ⌘9 and ⌘J;
   - the switcher;
   - search keeps old rows while it refetches;
   - the DOM stays under 250 rows with 1,000 sessions.

   `Value: protects=sessions are found and switched without tabs; fails_when=a session is unreachable or the list grows the DOM unbounded; why_new=the panel is new; no_claim=the real daemon's order`
7. **Commits:** the pure parts; the panel; the title row and keys; the strip's removal (no card).

## Task B2: the bar

Rows 8, 11, 12, 14 and 19-24.

1. **`views/sessions/work-bar.tsx`**, above the composer in `chat-tab.tsx`:
   - a `bg1` panel with radius 12, `inset 3px 0 0` blue, and 10 × 12 px padding;
   - the agent named from the account's provider;
   - the uncommitted line from `uncommittedInCheckout`;
   - **Here, on `<branch>`** (default) and **On a New Branch** (primary);
   - the holder's dim line, refetched on `FolderHoldChanged`;
   - keys 1 and 2;
   - focus when it appears, unless the composer has text focus;
   - Esc hides it until `work.askedAt` changes;
   - a 409 shows the settled state;
   - the move's error (`refusal`) shows, with Here still offered.
2. **The composer.** While moving, it reads "Moving to `<branch>`…". While choosing, sending works and reads only.
3. **`daemon/chat-work-queries.ts`:**
   - `useChatWork`, refetched on `ChatChanged`, `FolderHoldChanged` and a turn's end, and every 2 minutes while
     shown with a pull request open;
   - `useChooseWork`.
4. **Rendered tests:** each bar state (plain, uncommitted, holder, error), keys 1/2/Esc, Esc then a bumped
   `askedAt`, focus, the 409, and the moving line.
   `Value: protects=the builder can answer the question in place; fails_when=the bar hides for good after Esc or a choice is lost; why_new=no bar existed; no_claim=the daemon's CAS`

## Task B3: the meta line, the git button, Archive and Make a Board Task

Rows 21, 33 and 41-45.

1. **`views/sessions/session-meta.ts`** (pure). The spec's §6.5 words, one row each.
   `Value: protects=the meta line names the place and state in git's words; fails_when=a state shows the wrong words; why_new=the kind line said other things; no_claim=layout`
2. **`views/sessions/git-step-button.tsx`.**
   - It reads `next` and `refusal`.
   - Merge is disabled with "Checks running · 3/9" while checks run.
   - "Waits for the turn to end" shows while the request waits (row 43).
   - **Commit…** opens `commit-modal.tsx`: the message comes from the title, and the files are checked for
     `touched` and unchecked for the rest.
   - Errors show in a notification.
3. **Archive.** It reads `archive-preview`. When anything is listed, a confirm names it and sends the lists. A 409
   shows the confirm again with the new lists.
4. **Make a Board Task…** opens the Board's New Task form, filled with the session's title. Give the form's opener
   `initial` values if it lacks them. The session stays.
5. **Rendered tests:** each button state, Commit's default paths, the archive confirm with, without and after a
   409, and Make a Board Task.
   `Value: protects=the next git step is one click and Archive warns before losing files; fails_when=the wrong step shows or archive skips the confirm; why_new=no git button or archive confirm existed; no_claim=git results`

## Task B4: the words, the wait row, and Do It's removal

1. **The four-way held send goes.**
   - `ComposerHeld` and its choice group (Wait for It, Send Reading Only, File as Tasks, Do It in a Separate Copy)
     leave `composer.tsx`. A blocked Here send waits.
   - `FolderWait` reads "A Board task is changing files on `main`. Your message runs once it's done." and offers
     Stop only.
   - Update the composer's and `chat-tab.test.tsx`'s Your-folder tests.

   No card: the behaviour is removed, and the words are a table row.
2. **Do It goes:**
   - `do-it-sheet.tsx`, `do-it-words.ts` and their tests;
   - `daemon/do-it-queries.ts` and `test/do-it-fixtures.ts`;
   - in `chat-tab.tsx`: `doItOff`, the `doIt` state and key, `onDoItSeparately` and `<DoItSheet>`;
   - `session-bar.tsx`;
   - `kind-line.ts` and its test, once unread;
   - the `do_it` rows in `session-keys.test.ts`.

   After this the desktop never sends `folder: 'read_only'`.
3. **These stay:**
   - `HandedOffLine` and `item-entries.ts`'s `handedTo` row, with their Open Task link to `/board?task=`;
   - `when-busy.ts`, `pending-open-line.tsx` and `pending-open-queries.ts`, which the Workbench uses.
4. **A `carry_on` message** renders as a system line in `item-entries.ts`. Add a table row to its test.
5. Run knip on the desktop. Commit the removal, then the words.

## Task B5: Changes in a drawer, and task tabs go

The main plan's Task 14 runs after this.

1. **`views/sessions/changes-drawer.tsx`:**
   - `SurfaceDrawer` around `ChangesPanel` (with #651's fixes), fed by `GET /chats/:chatId/changes`;
   - ⌘⇧D, or the title row's Changes button (shown when anything changed), toggles it;
   - open or closed is kept per session, as #651 keeps it;
   - the conversation column moves left at ≥ 1200 px.
2. **Task tabs go:**
   - `task-tab.tsx`, `copy-tab.tsx`, `pass-tab.tsx`;
   - `task-tabs.ts`, `task-tab-facts.ts`, `task-tab-state.ts`, `task-tab-words.ts`, `task-bar.tsx`;
   - their tests, and `task-tab-flows.test.tsx`;
   - `daemon/task-session-queries.ts`;
   - the task variants in `strip-tabs.ts`, `closed-tabs.ts`, `use-tab-closing.ts` and `sessions-view.tsx`.

   Delete #651's `brief-card.tsx` if nothing else renders it.
3. **Links.** `useOpenTask` goes to `/board?task=`. `/sessions?task=` redirects there (`sessionsSearch` and the
   route).
4. **Tests.** Rewrite `changes-panel.test.tsx` to mount the drawer, and add ⌘⇧D, the remembered state and the
   redirect.
   `Value: protects=Changes opens beside the conversation and old task links land on the Board; fails_when=the drawer loses its state or ?task= dead-ends; why_new=Changes lived in task tabs; no_claim=the diff's contents`
5. **Commits:** the drawer; the removal (no card); the links.

## Task R: remove the old contracts (after Task 13 and B4 have merged, and B5 for the last item)

- From `packages/contracts/src/chat.ts`: `DoItPlace`, `DoItRequest`, `DoItResult`, `BriefRequest`, `BriefSource`,
  `BriefReason`, `DoItBriefDto`, `DoItRefusalDto`, `DoItOfferDto` and `DoItPreviewDto`.
- `FolderWhileHeld.ReadOnly`, and the daemon's reading of it as `wait`.
- `GET /tasks/:taskId/session` and `chat/task-session.ts` (after B5).
- Typecheck every package, run knip, and commit with no card.
