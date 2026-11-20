# Task 6: the Plan panel in a session, New Plan, Accept

**Spec:** §2 The Plan panel:

- the layout;
- the Head, without Review ▾ or the second item of Accept ▾;
- Goals, Loose tasks, Decisions and Questions for others;
- Tick per row;
- Mock-ups' thumbnail and open;
- Source files listed;
- Heard so far.

Also §5 (the first two bullets), and the §1.1 rows for an edit under a round and for the New Plan tab.

**Track:** B. It starts once Task 2 is on the branch. Read `apps/desktop/AGENTS.md`,
`apps/desktop/src/views/sessions/AGENTS.md` and `apps/desktop/src/views/shape/AGENTS.md` once, and keep notes.

## Files

- **Move what the panel reuses** from `apps/desktop/src/views/shape/` into `apps/desktop/src/views/sessions/plan/`,
  with `git mv` so history follows. Task 7 deletes the rest.
  - The rows: `proposed-pane.tsx`, `proposed-list.tsx`, `proposal-row.tsx`, `proposed-groups.ts`,
    `row-details.tsx`, `row-editor.tsx`, `row-editing.ts`.
  - The summaries: `summary-line.tsx`, `size-line.ts`, `task-size-line.tsx`, `review-notes.tsx`, `review-lines.ts`.
  - The modals: `convert-modal.tsx`, `undo-modals.tsx`, `remove-draft-goal.tsx`.
  - The rest: `preview-panel.tsx`, `preview-text.ts`, `heard-so-far.tsx`, `round-announcer.tsx`, `attachments/`
    (with `attachments.test.tsx`), `screenshot.tsx`, `plan-entries.ts`, `late-outcome.ts`, `proposal-text.ts`.
- **Create `views/sessions/plan/plan-panel.tsx`.** It wraps `useShapeView(chat.planId)` and the moved
  `ProposedPane`, with these changes:
  - Convert's labels are Accept's (index, Copy);
  - Rehearse is hidden;
  - the "Proposed" toggle is replaced by the panel's own close;
  - Heard so far shows while the plan has no rows;
  - a ⋯ menu holds Record (Task 7 gives it a route) and Export.
- **The Accept modal (`convert-modal.tsx`, moved).** Remove the "still answering" branch (line 212), Convert Anyway
  (line 183), and the `interrupt` it sends (lines 61, 138-146). Keep the cut list, the warnings and the errors.
  Task 7 removes the contract field itself.
- **The layout (`views/sessions/chat-tab.tsx`).**
  - When the tab's measured width (`useElementSize`, line 161) holds both, the panel sits beside the conversation.
    The conversation keeps at least 520 px, and the panel takes 420-480 px.
  - When it doesn't, the panel is a `SurfaceDrawer` (`shell/surface-drawer.tsx`) about 560 px wide, closed by
    "Close Plan".
  - With both Changes and the panel open, the side column's head switches between Plan and Changes.
  - While the panel is open, the frame's Sessions panel folds to the rail. Use the frame's own fold
    (`shell/shell-layout.ts`, `shell/app-frame.tsx`); don't add one.
  - Each chat keeps its open state the way `changes-choice.ts` keeps Changes'. A chat with a plan opens it by
    default.
- **The title row** gains a **Plan** toggle (aria-pressed) for a chat with a plan.
- **New Plan.**
  - In `views/sessions/sessions-panel.tsx` (line 330), the + becomes a menu: "New Session ⌘T" and "New Plan ⌘⇧N".
  - `session-switcher.tsx` (line 94) gets the same row.
  - In `session-keys.ts` (line 36), ⌘⇧N gives `{ kind: 'new_plan' }`. `shell/use-new-session-key.ts` handles it
    from any view.
  - A fresh tab made by New Plan carries `plan: true` (`fresh-tabs.ts`). It shows the panel empty, with Heard so
    far's empty words.
- **A New Plan tab's create** (`fresh-tab.tsx`, and `chatMade` in `sessions-view.tsx` at line 200).
  - The first send, or the first dropped file, calls `useCreateChat({ …, plan: true })`, then sends or uploads.
    Files go through `POST /shapes/:id/files` once `planId` is known.
  - Only one create is in flight per fresh tab. A second send or drop waits for it, then goes in order.
  - A tab closed mid-create lets the create finish, then closes the chat (`patch tabPosition: null`), so Recently
    closed holds it.
  - A failed create leaves the tab fresh, keeps its draft and files, shows the error and offers Try Again.
- **The transcript.** For a chat with a plan, it maps `shape_event` items with `plan-entries.ts`, as Plan's
  transcript did (`conversation/item-entries.ts:82, 154`: a screen maps its own).
- **A row edited while a round lands** (`row-editing.ts`). The editor keeps the builder's text. When the row's
  `round` moves on under an open editor, it shows "The agent changed this", and Save pins the builder's version.
- **Delete** the `views/shape/` tests that cover only the Plan screen's own layout (`shape-drawer.test.tsx`).
  Behaviour the panel keeps goes into the e2e (Task 8), not into new component tests.

## State rows (design)

- **Builder edits a row × a round changes it:** as above.
- **A turn runs × the panel opens:** the panel opens, and nothing else happens.
- **A New Plan tab mid-create × a second send or drop, a close, or a failure:** as above.

## Tests

`attachments.test.tsx` moves with its renderer, unchanged except for imports. No new component test
(`.claude/rules/testing.md`).

## Steps

1. Make the moves (`git mv`) and fix the imports. Typecheck.
2. The panel, the layout and the toggle.
3. New Plan: the menu, ⌘⇧N, the fresh tab and its create.
4. The Accept modal, the transcript mapping, and "The agent changed this".
5. Once Task 5 is on the branch, merge it and run the click-through. This is where the daemon and desktop first run
   together (index, Tracks).
   - Run the daemon on the fake adapter with the dev UI (`apps/desktop/AGENTS.md` says how).
   - Click through: New Plan; drop a `.vtt` and send a message (Heard so far shows, and the reply names the file);
     send "propose it" (rows appear); pin a row; send "propose" again; Accept.
   - Take screenshots at a 1440 px and a 1100 px window into your scratch folder, and name them in your report.
6. Run `pnpm --filter @10db/desktop exec vitest related <changed files> --run --maxWorkers=2`, then typecheck and
   lint the desktop.
7. Commit each green step:
   - `refactor(desktop): plan's panel parts move under sessions`;
   - `feat(desktop): a session shows its plan beside the conversation`;
   - `feat(desktop): new plan opens a session with its plan`.
