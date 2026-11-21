# Task 5: the e2e — a plain session grows a plan

**Spec:** §10 item 2, and its last paragraph ("Every user-visible piece extends `e2e/sessions.spec.ts`").
**Track:** B. Read `apps/desktop/e2e/AGENTS.md` once. Needs Tasks 3 and 4.

## Files

### `apps/desktop/e2e/sessions.spec.ts`

**The chat end-to-end test** (line 90). File as Tasks is gone, so its step (lines 164-166) types the same words and
sends them:

```ts
await sendLine(page, 'File the work we agreed on as tasks on the Board.');
```

The script book's `await_message` (`script-book.json` around line 218, `contains: "File the work we agreed on"`) still
matches. The rest of the step (the task row, its start, the judge's card) is unchanged. Update the header comment
(line 18) to say the builder asks for the tasks in words.

**The New Plan test** (line 582) extends with a section after its reload. Its title gains ", and a plain session grows
a plan by Show Plan or by proposing". Steps:

1. ⌘T opens a fresh tab in the same project. Send "Make the cards denser", and expect the reply "Noted 1 thing.".
   The Plan panel (`complementary`, name "Plan") has count 0.
2. Press the title row's Plan button (`exact: true`). Expect `aria-pressed="true"` and the empty panel's "Talk it
   through, or drop a document.".
3. Set a `notes.md` on `input[type=file]`, then send "Thin out the scrollbars". Expect "I have notes.md." and
   "Heard so far" in the panel. The session was warm before its plan existed, so this is the row "a file dropped
   after Show Plan on a warm session". The fake says "I have" only when the session's own hook allows the Read
   (Task 3), so this checks the folder opened at start.
4. Send "propose it". Expect "Board polish" in the panel, and a row's dot labelled "New this round" (by its
   `aria-label`).
5. Close the panel with Close Plan, then send "propose it again". The panel stays closed, and More session actions
   lists "Show Plan" (`menuitem`). Press Escape.
6. ⌘T again. Send "propose it" as the first message, with no Show Plan. The panel opens with "Board polish".
7. Archive both of these sessions from ⋯ › Archive. A plan session left open folds the Sessions list for the specs
   that follow, which share the daemon in name order.

Use the file's helpers (`sendLine`, `sessionRow`, `expectAccessible` once on the Show Plan panel) rather than new
ones. Assert on what shows and on the daemon's reads (`GET /chats/:id`'s `planId` after step 1 is null: one
`request.get`), never on timing.

### Other specs

Check: `git grep -n "File as Tasks" -- apps/desktop/e2e` comes back empty after your change. Task 3 reports any
"propose" sent in a session that expects no plan; fix any it named.

## Interfaces

None new. It calls the UI of Task 4 and the route of Task 1.

## State rows (design)

Steps 2-6 walk these index rows:

- A turn runs × Show Plan;
- a warm session × a file dropped after Show Plan;
- a plain session × a passing `propose_plan`;
- the builder closed the panel × a round lands.

## Tests

This is the e2e extension the feature owes (`.claude/rules/testing.md`). No new spec file and no unit test.

## Done when

- Run only the New Plan and chat end-to-end tests against the real daemon, through the repo's e2e entry
  (`apps/desktop/e2e/AGENTS.md` says how; `--grep` on their titles). Both are green, and you've proved each check goes
  red where it can go red. Revert each locally, never committed:
  - **Step 6** (the first message's "propose it", no Show Plan): goes red with `ensurePlanOfChat` taken out of
    `propose_plan` (Task 3). Step 4 can't prove this, since Show Plan already made the plan in step 2.
  - **Step 4's "New this round" dot:** goes red with `rowDot` taken out of `proposal-row.tsx` (Task 4).
  - **Step 3's "I have notes.md.":** goes red with `planIdOfChat`'s folder left out of `spec()` (Task 2), since the
    fake's Read is then refused.
- Commit with the Value card, wrapped under 100 characters a line:
  `Value: protects=a plain session grows its plan by Show Plan or by proposing; fails_when=a session can't plan
  or plans unasked; why_new=feature e2e (sessions spec §10 item 2); no_claim=Codex's kernel grant of the folder`.
- Report: the SHA, and the run's command and result.
