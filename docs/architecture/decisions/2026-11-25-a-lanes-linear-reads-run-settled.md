# A lane's reads of the builder's own Linear run settled

- **Date:** 2026-11-25

## Decision

A lane's call to the builder's own Linear is a settled allow when it is a read, under every judge (Native,
10db's and Rules) and whether or not anyone watches. A call is a read when all of these hold
(`isLaneLinearRead` in `apps/daemon/src/linear/lane-reads.ts`):

- Its tool is on a closed list: `whoami`, `search_documentation`, and the `get_` and `list_` tools Linear's
  server lists (`LANE_LINEAR_READS`). `extract_images` is left out because it fetches URLs, and every tool that
  writes (`save_*`, `create_*`, `delete_*`, `share_issue`, `mark_notification`, `merge_diff` and the rest) is
  left out.
- It goes to the builder's own Linear: the claude.ai Linear connector (`mcp__claude_ai_Linear__`) on a plan
  whose connectors the session loads, or one of the builder's remote servers on `mcp.linear.app`, by the name the
  harness registers it under (`laneLinearPrefixes`). A prefix that another server of the session also holds is
  left out: a project server, one of the builder's stdio servers, or one of their remote servers on another
  host, compared by the tool prefix its registered name makes. A repository's server named `claude_ai_Linear`
  takes the connector's place in the session (`connectorsForSession`), so its calls keep the broker ask.
- Its input is a JSON object, or none, of at most 2,000 characters.
- No string in it matches a secret pattern (`secretIn`, the Linear reporter's scan).

The runner computes the session's prefixes once as it starts (`runner.ts`) and passes `linearRead` to
`judgePreToolUse` (`GuardInput.linearRead`). The guard then skips the broker ask that every other MCP call gets
and answers with a settled allow, so neither a classifier nor a judge nor a card follows. Every other call keeps
today's path: a Linear write, another server's tool, a long input or one that holds a secret goes to the broker
as `web_or_mcp`, and an unattended lane skips it under `sends_data_out`.

Per provider:

- **Claude plan:** the claude.ai Linear connector and the builder's `mcp.linear.app` servers, a plugin's
  server by its `claudeName` (`mcp__plugin_<plugin>_<server>__`).
- **Claude through Bedrock or an API key:** the builder's `mcp.linear.app` servers. These accounts load no
  claude.ai connectors.
- **Codex:** the builder's `mcp.linear.app` servers by 10db's name for them. The Codex hook goes through the same
  `judgePreToolUse` (`sessions/codex-guard.ts`), where an allow lets the call go on. Codex's tool name for a
  remote server, `mcp__<server>__<tool>`, follows `apps/daemon/src/linear/AGENTS.md` and has not been checked
  against a signed-in Codex; if it differs, a read there keeps today's path (skipped unattended) rather than
  running unread.

Chats and Plan sessions are out of scope: they are attended and their MCP calls go to their judge
(`decisions/2026-11-21-a-conversations-mcp-calls-go-to-its-judge.md`). So are Linear servers declared in a
repository's `.mcp.json` and stdio wrappers around Linear.

## Why

Between 2026-11-18 and 25 an unattended lane had 15 Linear reads skipped as sending data out, such as
`get_issue {"id":"AMP-6","includeRelations":true}` and `list_comments {"issueId":"AMP-26"}`. One run then
stopped blocked because it could not compare the issue's current scope. A read of the builder's own issue
tracker, through the connector the builder set up, sends Linear only the ids and filters the lane already holds;
the hard limit is about sending code, files, keys or the conversation out, and the builder's setup comes along
by default (`decisions/2026-11-12-10db-trusts-the-developer-and-contains-the-agent.md`).

A rule settles it, as the read-only Bash line is settled
(`decisions/2026-11-03-a-lane-runs-read-only-commands-without-a-card.md`), rather than handing reads to a judge:
a judge could still skip a read at its floor (one was skipped at 79% against 80%), and the rule is closed and
checkable. The caps bound what a read can carry: a filter that held pasted repository text would be long, and one
that held a key would match a secret pattern. A URL or a short phrase in a filter still passes, which is what a
search of one's own tracker needs.

Turned down: telling the judge the call is a read and leaving the verdict to it (a read could still be skipped,
and Rules has no judge); allowing every call to a Linear server (a write carries repository text out).
