# One answer allows every tool an approved MCP server listed, until its tools or config change

- **Date:** 2026-11-05
- **Supersedes:** the part of `decisions/2026-11-05-plan-runs-commands-and-project-tools-through-the-lane-broker.md`
  that makes a project tool's allowance per tool name only: "Allow always for a project tool is stored per tool
  name, as for a lane" (The lanes' broker, for a conversation) and "Every call to one is carded unless the
  builder allowed that tool always" (the limits that replace the sandbox's). Everything else in that record
  stands, "each call shows in the conversation" included.

## Decision

A permission card for a tool of a project MCP server (`mcp__<server>__<tool>`, a server of the repo's `.mcp.json`
the builder approved, never 10db's own) offers one more choice beside Allow once, Allow for this workstream,
Always allow in this project and Deny: **Always allow every `<server>` tool in this project**
(`PermissionChoice.AllowMcpServer`, `allow_mcp_server`). A lane's card and a Plan conversation's card both offer
it. A Bash, file, network, web or any other card never does, and neither does a card for a tool of a server the
session does not run at an approved config, or for a tool the server did not list.

What the answer stores is bounded in three ways:

- **Only the tools listed then.** The card carries (`detail.mcpToolGrant`) the server, the config hash its
  session runs and the tool names the server listed when the card was raised (the connected servers'
  `mcpServerStatus()` tool lists, plus the init message's). Answering writes one project rule per listed tool
  name, in the same transaction as the answer, and one decision ("Allow every `<server>` tool in this project?").
  A tool the server adds later has no rule and asks again; the next card for it offers the choice again, over
  the longer list.
- **Only at the approved config.** Each rule's pattern is `<config hash>:<server>`. A call matches it only
  while the session runs that server at that same hash (`matchPermissionRule`'s `mcpApproved`, the hash of each
  server 10db passed to the session, `ProjectMcp.configHashes`). The server's approval covers its config and
  hosts, not its tools, so the hash cannot tell that a tool was added; it can tell that the config changed, and
  then every call asks again until the builder approves the new config and answers again. A rule with a pattern
  never matches without that map, so every other caller fails closed.
- **Only this server, this project.** A rule names exact tool names of one server, and is a project rule of the
  project whose card it was; another server's tool of the same name, and another project, ask.

Allowed calls still show: the call is in the session's conversation or transcript as any tool call is, and
nothing about them is hidden. Only the card is skipped. The existing single-tool "Always allow in this project"
is unchanged (a rule with no pattern, for that name, at any config).

## Why

The audit of an `aws-billing` server raised a card for each of its tools (cost-explorer, credits,
cost-optimization, compute-optimizer, session-sql and more). Approving the server already said the builder
trusts its config and the hosts it reaches; answering for each tool one by one added clicks, not safety. The
risk is that "every tool" reads as covering tools the builder never saw, and the config hash does not cover the
server's tool list. Fixing the names at the answer, and tying the rules to the hash, keeps the grant to what was
listed and to what was approved.

Turned down:

- **A rule `mcp__<server>__*`**, as the allow list understands (`mcpEntryMatches`). It covers tools added later
  and survives a config change. Sessions' allow lists are 10db's own and do not carry project servers.
- **Allowing at server approval.** The approval card describes config and hosts. Mixing in a grant for tools
  would ask the builder to allow what the card does not show.
- **A new column for the hash on the rules table.** The pattern already carries a free string for the rules
  that need one; a column is a migration for the same information.
