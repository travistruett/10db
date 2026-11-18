# A session on a new branch is the same conversation in its own worktree

- **Date:** 2026-11-17
- **Supersedes:** `decisions/2026-11-16-do-it-hands-a-chat-to-a-task-or-a-pass-of-one.md`

## Decision

On a New Branch records `moving` with the branch and the worktree's path, cuts a worktree at the checkout's `HEAD`
(idempotent by path; only `git/` makes and removes worktrees), closes the warm session and starts it again with the
same provider session id, the worktree as its working directory and a sandbox rooted there, then records `branch`.
The conversation, its history and its mentions carry over; its first prompt in the worktree names the worktree, the
branch and the base and says the checkout is off limits. `chatRoot(chat, project)` is the only place `chat/` picks a
path. A chat worktree is owned by its chat: the sweep, the lock (reason `cht_`) and Archive know it, Archive on a
dirty worktree asks first and lists what it deletes, and Reopen cuts the worktree again on the same branch. A branch
holds nothing of the builder's checkout, so a branch's terminal takes no folder hold. Do It, task tabs, the pass of
one, Sign Off and Close Pass are gone from Sessions; an old sealed chat still opens read-only, with a link to its
task on the Board.

## Why

Handing a conversation to a task threw the conversation away and made the builder fill a sheet. The same session in
its own worktree keeps what it knows and is a branch the builder can commit, open as a pull request and merge from
the title row. Turned down: a new session per branch (loses the conversation); moving the checkout's branch
(takes the folder from the builder).
