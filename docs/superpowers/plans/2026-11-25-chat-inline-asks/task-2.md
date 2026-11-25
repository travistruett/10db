# Task 2: decision record, notes, Codex follow-up

Read the index's brief and Global Constraints first. Size: Core (docs of a permissions change).

## Files

- New decision `docs/architecture/decisions/2026-11-25-a-chat-asks-before-a-command-runs-outside-the-sandbox.md`
  (format in that folder's README). It says: a Claude chat working Here, whose turn holds the checkout, may run
  one command outside the sandbox after the builder's yes on that exact command; Branch chats and subagents are
  refused; why it always asks, even on auto mode (the sandbox is the boundary,
  `2026-11-12-10db-trusts-the-developer-and-contains-the-agent.md`); a flagged call is a change and needs the hold;
  background is refused; chat-once memory is per session and never a rule; lanes, passes and Plan keep the hatch
  shut (`2026-11-12-what-the-builder-allows-runs-as-in-claude-code.md` still holds for passes); Codex has no hatch
  (`2026-11-12-codex-is-judged-by-10dbs-judge.md`); a chat's cards leave the Inbox while the chat is open in a tab. It amends the first two
  decisions named, in their "Amended by" lines.
- `apps/daemon/src/chat/AGENTS.md`, `apps/daemon/src/inbox/AGENTS.md`, `apps/daemon/src/sandbox/AGENTS.md`: one
  note each where the module's behaviour changed.
- The Codex chat's instructions (find where a Codex chat's developer instructions are built, `sessions/codex-*.ts`
  or `chat/`): one line, "When the sandbox blocks a command you need, say so and tell the builder they can turn on
  Full access for this chat." Not for lanes or passes.
- A 10db board task (skill `10db-task`) in the 10db project: "A Codex chat's blocked command asks, as a Claude
  chat's does", naming the decision and the Codex app-server approval request it would answer.

Tests: none.
