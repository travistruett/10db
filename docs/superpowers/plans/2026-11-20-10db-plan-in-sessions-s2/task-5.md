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
   after Show Plan on a warm session".
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
  (`apps/desktop/e2e/AGENTS.md` says how; `--grep` on their titles). Both are green, and you've proved step 4 goes
  red with Task 3's `propose_plan` change reverted locally (don't commit the revert).
- Commit with the Value card, wrapped under 100 characters a line:
  `Value: protects=a plain session grows its plan by Show Plan or by proposing; fails_when=a session can't plan
  or plans unasked; why_new=feature e2e (sessions spec §10 item 2); no_claim=Codex's kernel grant of the folder`.
- Report: the SHA, and the run's command and result.
