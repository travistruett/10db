# Task 4: the title row's Full access switch drives the chat

Read the index's Brief and Global Constraints first.

**Files:** `apps/desktop/src/views/sessions/full-access.tsx`, `session-title.tsx`, `session-menu.tsx` (the
approved mock-up, holding its state in the view), `apps/desktop/src/views/sessions/AGENTS.md`, one e2e spec in
`apps/desktop/e2e`.

**Design.** Replace the mock-up's local state with `chat.fullAccess` and `usePatchChat({ chatId, fullAccess })`.
The menu item and the badge's Turn Off are disabled with "Waits for the Turn to End" while a turn runs, and
hidden on a sealed chat or one in the terminal (the index's state table). A refused patch shows in the title
row's alert, as a failed git step does. Copy: the confirmation's third line becomes "It still asks before a
force push, a production deploy or deleting files it didn't make." and the tooltip's second sentence "It still
asks before anything that can't be undone." (true on every account). A Codex chat's confirmation adds "Your
~/.codex settings don't load yet."

**Test:** extend the chat e2e flow: turn Full access on through ⋯ and the confirmation, see the badge, reload,
still see it; turn it off from the badge.

**Before review, a click-through on the real daemon** (`pnpm dev:window` on this worktree, a real account): in a
Full access chat, a Bash write in another checkout, a call to one of the builder's MCP tools, and an `.env` read
all run; a board task started meanwhile still runs sandboxed. Repeat the start on an API-key account if one is
set up. Report what ran.
