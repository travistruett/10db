# Task 6: the Plan panel in a session, New Plan, Accept

**Spec:** §2 The Plan panel (layout; Head without Review ▾ and Accept ▾'s second item; Goals, Loose tasks, Decisions,
Questions for others; Tick per row; Mock-ups' thumbnail and open; Source files listed; Heard so far); §5 (the first
two bullets); §1.1 (the "Builder edits a row × a round changes it" row). **Track:** B. Read
`apps/desktop/AGENTS.md`, `apps/desktop/src/views/sessions/AGENTS.md` and `apps/desktop/src/views/shape/AGENTS.md`
once and keep notes.

## Files

- Move what the panel reuses from `apps/desktop/src/views/shape/` into
  `apps/desktop/src/views/sessions/plan/`, with `git mv` so history follows:
  - `proposed-pane.tsx`, `proposed-list.tsx`, `proposal-row.tsx`, `proposed-groups.ts`;
  - `row-details.tsx`, `row-editor.tsx`, `row-editing.ts`;
  - `summary-line.tsx`, `size-line.ts`, `task-size-line.tsx`, `review-notes.tsx`, `review-lines.ts`;
  - `convert-modal.tsx`, `undo-modals.tsx`, `remove-draft-goal.tsx`;
  - `preview-panel.tsx`, `preview-text.ts`, `heard-so-far.tsx`, `round-announcer.tsx`;
  - `attachments/` (with `attachments.test.tsx`);
  - `screenshot.tsx`, `plan-entries.ts`, `late-outcome.ts`, `proposal-text.ts`.

  Task 7 deletes the rest.
- Create `views/sessions/plan/plan-panel.tsx`: `useShapeView(chat.planId)` and the moved `ProposedPane` with:
  - Convert's labels changed to Accept;
  - Rehearse hidden;
  - the "Proposed" toggle replaced by the panel's own close;
  - Heard so far shown while the plan has no rows;
  - the ⋯ menu with Record (Task 7 gives it a route) and Export.
- `views/sessions/chat-tab.tsx`, the layout:
  - with the panel open, the conversation column keeps ≥ 520 px and the panel takes 420-480 px beside it, when
    the tab's measured width (`useElementSize`, line 161) holds both;
  - otherwise the panel is a `SurfaceDrawer` (`shell/surface-drawer.tsx`) about 560 px wide, with "Close Plan";
  - the Changes drawer and the panel share the side: with both open, the column's head switches Plan | Changes;
  - while the panel is open, the frame's Sessions panel folds to the rail. Find the frame's fold control
    (`shell/shell-layout.ts`, `shell/app-frame.tsx`) and use it, not a new one;
  - open state per chat: keep it as `changesChoice` keeps Changes (`changes-choice.ts`), and open by default for
    a chat with a plan.
- The title row gains a **Plan** toggle (aria-pressed) for a chat with a plan.
- **New Plan:**
  - `views/sessions/sessions-panel.tsx` (line 330): the + becomes a menu with "New Session ⌘T" and "New Plan ⌘⇧N";
  - `session-switcher.tsx` (line 94) gets the same row;
  - `session-keys.ts`: ⌘⇧N gives `{ kind: 'new_plan' }`, and `shell/use-new-session-key.ts` does the same from
    any view;
  - a fresh tab made by New Plan carries `plan: true` (`fresh-tabs.ts`) and shows the panel empty, with Heard so
    far's empty words;
  - its first send, or its first dropped file, creates the chat with `useCreateChat({ …, plan: true })`, then
    sends or uploads. Files upload through the plan's `POST /shapes/:id/files` once `planId` is known.
- The chat transcript maps `shape_event` items with `plan-entries.ts`, as the Plan transcript did, for a chat with
  a plan (`conversation/item-entries.ts:82, 154` says a screen maps its own).
- Row editing while a round lands: the editor keeps the builder's text. When the row's `round` moves on under an
  open editor, it shows "The agent changed this", and Save pins the builder's version (`row-editing.ts`).
- Delete `views/shape/` tests that only covered the Plan screen's own layout (`shape-drawer.test.tsx`). Move the
  assertions of behaviour the panel keeps into the e2e (Task 8), not into new component tests.

## State rows (design)

- *Builder edits a row × a round changes it:* as above.
- *A turn runs × the panel opens:* the panel opens; nothing else happens.

## Tests

`attachments.test.tsx` moves with its renderer, unchanged except for imports. No new component test
(`.claude/rules/testing.md`: a user-visible feature extends an e2e flow).

## Steps

1. The moves (`git mv`) and imports. Typecheck.
2. The panel, the layout and the toggle.
3. New Plan: the menu, ⌘⇧N, the fresh tab, and create-on-first-send/drop.
4. The transcript mapping and the edit-under-round words.
5. Once Task 5 is on the branch, merge the branch and run the daemon on the fake adapter with the dev UI
   (`apps/desktop/AGENTS.md` says how). Then click through: New Plan, a message containing "propose", rows
   appear, pin one, another "propose", Accept. Take screenshots at a 1440 px and a 1100 px window into your
   scratch folder and name them in your report.
6. Run `pnpm --filter @10db/desktop exec vitest related <changed files> --run --maxWorkers=2`, then typecheck and
   lint the desktop.
7. Commit each green step. Messages:
   - `refactor(desktop): plan's panel parts move under sessions`;
   - `feat(desktop): a session shows its plan beside the conversation`;
   - `feat(desktop): new plan opens a session with its plan`.
