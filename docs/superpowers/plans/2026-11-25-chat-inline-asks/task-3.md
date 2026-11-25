# Task 3: one card for every ask, where you type

Read the index's brief and the "waiting card" state table first. Size: Feature (UI). Starts after task 1's
contracts commit (`PermissionChoice.AllowChat`). The look is the approved mock-up
(https://claude.ai/artifact/CuBGmCsasvkCi8zrgaudU6, boards "A blocked command asks where you type", "A limit asks
the same way", "What stays in the conversation"), drawn with Mantine and the theme, not copied markup.

## Files

- New `apps/desktop/src/conversation/ask-card.tsx`: `AskCard` for a `permission` item. Title (the item's), the
  call in a mono block (`detail.summary`), the body's reason line, then one button per option. Labels: Allow once
  → "Yes", Deny → "No", every other option by the existing `optionLabel` (`views/inbox/permission-labels.ts`),
  with its description as the button's tooltip; `AllowMcpServer` keeps its own label. No option is dropped. Under
  the buttons a one-line input "Or tell Claude what to do instead…": Enter sends Deny with the text as its note.
  - The input takes focus when the card mounts, so a key typed into the composer as it is swapped out lands in the
    input, never on a button. Digits pick an option only while focus is on the card's buttons (Tab or a click).
    Esc in the card sends Deny. No global key handler.
  - `queued > 0` shows "{n} more waiting" on the card.
  - A 409 shows "This card was already answered."
- `apps/desktop/src/conversation/permission-request.tsx`: `permission` items render `AskCard`, oldest first, one
  docked at a time; `question` items keep `InboxCard`. Drop "Also in your Inbox."
- `apps/desktop/src/views/sessions/chat-tab.tsx` (and `views/workbench/page-pane.tsx` if it shows the same cards):
  while a card waits, it takes the composer's place; the turn's Stop stays reachable on the card's row; the
  composer returns when no card waits. Answered cards show as one line in the transcript ("You allowed …" / "You
  said no to …", the note as the builder's message when one was given), from the resolved-items read (~186).
- The Inbox page and its nav badge leave out items whose `detail.conversationId` names a chat open in a tab
  (`useOpenChats`). Filter there, not in `useInbox()`: the needs-you count reads it.

## Tests

Extend `apps/desktop/e2e/sessions.spec.ts` "a chat end to end…" (~90-205) on the judge card it already raises
(the e2e daemon runs no sandbox, so it can't raise a flagged card): the card docks where the composer was, is not on
the Inbox page while the tab is open, and is answered from the card. Update the now-wrong Inbox assertions. No
component test, no test-only code. The flagged card first runs against the real daemon in the Dev-window
click-through below.

## Done

Typecheck, lint, the e2e locally if the Mac can run it (else CI). A Dev-window click-through of a real flagged
call after tasks 1 and 3 are both in, with screenshots of the three states through the `screens` skill.
