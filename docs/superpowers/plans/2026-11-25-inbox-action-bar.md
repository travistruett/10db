# Inbox: one action bar for every card

**Size: Feature** (desktop only, about seven card components). One implementer builds it end to end, then one code
review that blocks only on bugs, then screenshots for the builder.

## Brief

**What changes for you.**
- Every Inbox card ends in the same bar, fixed to the foot of the pane while the body scrolls.
  - The **left** side holds the ways out: **View Task**, which opens the task drawer over the Inbox, so you never leave
    it. It also holds Open Session, Open on GitHub and Full Diff.
  - The **right** side holds the answers, with one filled primary.
- **Send Back** turns the bar into a composer. A required note box grows up out of the bar, already focused; the
  buttons become Cancel and Send It Back ⌘↵; Esc cancels. The changes stay in view above it, and the draft survives
  switching cards, as it does today.
- The Look card gets the reading width, Title Case ("Looks Right", "Send Back"), the daemon's own summary line, and
  roomier folds: more space between the path, the Agent and Reviewer notes and the hunk.
- Acceptance, Check and Plan get the same bar, so their buttons stop falling below the fold on a long card.

**What it buys.** One pattern instead of four copies. A new card kind can't drift, and the Look card reads like its
neighbours.

**What could go wrong, and how we'd know.**
- *A card loses an action, or answers twice.* Four copies of the answer logic (respond, 409, stale) become one hook.
  The e2e flows that answer cards (`inbox.spec.ts`, `loop.spec.ts`) still pass.
- *The drawer over the Inbox misbehaves* (a Start that closes it, project switching). It reuses `ProjectTaskDrawer`, as
  Factory does.

**Calls you might disagree with.**
- The Look card's kind label becomes "Look", one noun like the other kinds.
- A card with no actions draws no bar. Today it draws an empty strip.

**Needed from you:** nothing. Screenshots come before merge.

## Provider parity

UI only. It is the same on every provider.

## Parts

1. **`CardActions` becomes the one bar** (`views/inbox/card-actions.tsx`). Its props cover what the survey found:
   - `start`: the links on the left;
   - `note`: none, optional (the generic cards' "Add a note (optional)"), or a composer;
   - `secondary`: up to two default buttons;
   - `primary`: label, a ↵ or ⌘↵ hint, color, loading, disabled;
   - `error`: one line, left, `role=alert`.
   With no start, no primary and no secondary, it renders nothing.
2. **`useCardAnswer(item)`**: one hook for respond, 409 and stale, replacing the copies in
   `acceptance-card.tsx`, `check-card.tsx`, `plan-card.tsx` and `watchpoint-card.tsx`.
3. **The Send Back composer** is a bar mode. It shows a labelled `Textarea` ("What Needs to Change", autosize, max 4000,
   autofocus), required, with the draft kept by the Inbox (`sendBackNote`, as now). It has ⌘↵ to send and Esc to cancel.
   It is used by Acceptance, Check, Plan and Look.
4. **View Task opens the drawer in place.** `ProjectTaskDrawer` is rendered by the Inbox view (Factory's pattern,
   `factory-overview.tsx`), driven by a `task` search param on the Inbox route, so the back button and a reload keep it.
   - Every card with a task or workstream target gets View Task in `start`.
   - The generic card's Open Session and OpenTaskLink, and its Open on GitHub, move into `start`. Keep their wording;
     make it Title Case where it isn't.
5. **Move every detail card onto the bar:** generic, Waiting, Acceptance, Check, Plan, Look, and the Slack draft
   preview. Give each the 720px reading width (`classes.content`) and `gap="md"` when unframed, as the generic card has.
   `BatchCardActions` Retry and Abandon move into `secondary` on a failed workstream card.
6. **The Look card** (`watchpoint-card.tsx`, `board/watchpoint-folds.tsx`):
   - Show `item.body` as its summary.
   - Buttons are Send Back and Looks Right. The kind label is "Look".
   - "Open the whole diff" becomes **Full Diff**, a default button in `start` (in the drawer's For You it stays where it
     is, as a default button, not subtle).
   - The loudness badge reads "Ask" or "Show", from a label map.
   - The folds get room: `Stack gap="lg"` between files, a divider between files, `gap="sm"` between the path, the notes
     and the hunk. The note rows are a two-column grid with `xs` row gaps.
   - The For You drawer section shares these folds, so it improves too.
7. **A repo rule:** `tests/repo` gains one check. Every component in `apps/desktop/src/views/inbox/` that renders a
   Mantine `Button` imports `CardActions` or is `card-actions.tsx` itself, and a short allowlist with reasons covers the
   rest (for example, a list row). Name the rule in `views/inbox/AGENTS.md`.
8. **Docs:** `views/inbox/AGENTS.md` (the bar, the composer, View Task) and `DESIGN.md` if it describes card actions.

## Tests

- The repo check in part 7, which is a rule test. Prove it red by importing a stray `Button` into a card.
- Extend `apps/desktop/e2e/inbox.spec.ts` (or the Look card steps in `loop.spec.ts`):
  - View Task opens the drawer over the Inbox;
  - Send Back's composer needs a note, then files the follow-up task;
  - Looks Right closes the card.
  Update the selectors the copy changes break.
- No rendered-component tests.

## Done

- Typecheck, lint, and the related desktop tests pass. The e2e specs you touched pass. `make precheck` exits 0.
- Then the lead takes screenshots (dark and light) through the `screens` skill, runs one review, and opens a PR with
  auto-merge.
