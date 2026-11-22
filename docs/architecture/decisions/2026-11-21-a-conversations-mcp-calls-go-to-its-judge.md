# A chat's or Plan's call to an MCP tool goes to the session's judge, as a lane's does

- **Date:** 2026-11-21
- **Amends:** spec `docs/superpowers/specs/2026-11-02-10db-brainstorm-chat-design.md` §5.2 (a project tool "answers `ask`, so each is carded").
- **Supersedes:** the part of `decisions/2026-11-05-plan-runs-commands-and-project-tools-through-the-lane-broker.md`
  that makes a call to a project MCP tool always answer `ask`. The rest of that record and
  `decisions/2026-11-05-one-answer-allows-every-tool-an-approved-mcp-server-listed.md` stand.

## Decision

`judgeProjectTool` (`shape/confinement.ts`) answers a bare allow for a non-10db `mcp__` tool the session itself
calls (a repo's approved server, the builder's own, a claude.ai connector), when the session's judge is 10db's or
Claude's auto mode. A bare allow is no decision: 10db's judge reads the call with the policy line, or auto mode's
classifier does, as for a lane's. On the rules floor (no judge, or 10db's judge down) the call is `ask`, a card,
as before. A session with no sandbox stays refused, and so does a call from Plan's own `tendb-*` agents (they have no MCP
tools). A chat's other subagent, such as a general-purpose agent, is different: `judgeChatCall` drops the call's
`agentId` (`chat/confinement.ts`), so its MCP call reaches the same judge as the session's, as a lane's
subagents' calls do. No new grant is added.

## Why

Parity with lanes and with Claude Code's auto mode, where MCP calls go to the classifier. After the builder signs
in to an integration such as Linear, its calls should be seamless: reads run, and a risky write is still carded by
the judge. Carding every call one by one asked the builder to answer what the judge already decides for a lane.
