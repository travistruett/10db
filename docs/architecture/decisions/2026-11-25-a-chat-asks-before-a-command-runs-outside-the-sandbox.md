# A chat asks before a command runs outside the sandbox, and only a chat working Here may

- **Date:** 2026-11-25
- **Amends:** `decisions/2026-11-12-10db-trusts-the-developer-and-contains-the-agent.md` (a chat gets one narrow way
  out of its sandbox, each time the builder's), `decisions/2026-11-12-what-the-builder-allows-runs-as-in-claude-code.md`
  (for a chat; a pass keeps its rule)

## Decision

- A Claude chat that is not Full access has `allowUnsandboxedCommands: true` in its sandbox profile, so Claude Code
  lets a command retry outside the sandbox (`dangerouslyDisableSandbox`). Lanes, passes, Plan's own sessions, the
  gate and MCP servers keep it `false`.
- The chat's PreToolUse hook decides each flagged call. The guard that judges every command judges it first, and
  its deny stands. A call from a subagent is refused: only the chat itself runs outside the sandbox. A call in a
  chat on its own branch is refused, with a pointer to Full access. A call in the background (`run_in_background`,
  `&`, `nohup`, `setsid`) is refused. Anything else asks the builder, even in auto mode.
- The call counts as a change: it needs the place chosen (`Here`) and the chat's turn holding the checkout, and
  the hold is read again at the builder's yes. A lost hold denies with the reason.
- The card shows the exact command and says it runs with the builder's full rights. It offers Allow once, "For this
  command in this chat" (`allow_chat`) and Deny. `allow_chat` allows that exact command again until the chat's
  session restarts; it is never stored as a rule or a decision. No stored rule, carried allowance, project grant or
  judge allows a flagged call.
- The denial a chat reads after No invites another approach and carries the builder's note.
- A Codex chat has no such flag, so its sandbox refuses as before and its instructions say to suggest Full access.
- A chat's permission and question cards do not show in the Inbox while the chat is open in a tab; a chat with no
  open tab keeps them there. Open conversation cards are withdrawn at daemon start.

## Why

- Most walls in an ordinary chat are the sandbox refusing something harmless. A yes or no on the exact command
  keeps the sandbox as the boundary and removes the need to turn Full access on to get anything done.
- Always asking, even in auto mode, because a command outside the sandbox is the one thing the kernel no longer
  contains, so the builder decides each one (`decisions/2026-11-12-10db-trusts-the-developer-and-contains-the-agent.md`).
- The hold and the place are required because an unsandboxed command can write the checkout, which a lane may be
  using; a chat on a branch has a worktree its sandbox keeps it in, and outside the sandbox nothing would.
- Background runs are refused because a command that outlives the turn would outlive the hold. A command that
  detaches itself on purpose (`tmux -d`, `docker run -d`, `launchctl`) can still outlive it, as in a terminal.
- An allowed command's environment is the session's, including Claude Code's own variables in auto mode, as it is
  under Full access and in a terminal. 10db does not scrub it: that environment carries the account's credentials
  on Bedrock and API-key accounts.
- Codex runs with approvals off by decision (`decisions/2026-11-12-codex-is-judged-by-10dbs-judge.md`), so
  there is no escalation request to answer yet; a follow-up task covers it.
- Lanes, passes and Plan keep the hatch shut: nobody is there to answer in a lane, and a pass's rules stand
  (`decisions/2026-11-12-what-the-builder-allows-runs-as-in-claude-code.md`).
