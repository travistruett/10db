# The Linear reporter is 10db's own errand with its own guard

- **Date:** 2026-11-22

## Decision

A task that carries a Linear issue keeps that issue up to date through a short agent session of its own, the
Reporter conversation owner kind (one conversation per task, a new session per run). It is 10db's errand, not a
chat and not a lane.

- **Its own guard, no judge.** Every call the session makes is answered by `judgeReporterCall`
  (`apps/daemon/src/linear/reporter-guard.ts`), a pure rule. No chat judge, auto mode classifier or Codex
  Auto-review sees it, so the chat judge decision
  (`decisions/2026-11-21-a-conversations-mcp-calls-go-to-its-judge.md`) does not apply to it.
- **The exact allow-list.** The session has `ToolSearch`, 10db's `report_linear_post`, and Linear's tools by
  the server's prefix. Allowed Linear reads: `whoami`, `get_workspace`, `get_team`, `list_teams`, `get_issue`,
  `list_comments`, `list_issue_statuses`, `get_issue_status`, `get_attachment`. Allowed writes, each with an
  exact key list: `save_issue` (`id`, `state`, `links`; the links are one `10db` link to the task's PR),
  `save_comment` (`issueId`, `body`), and the two attachment-upload calls for screenshots. Every other tool, a
  second MCP server, the web, a file or a command is denied.
- **Writes are pinned to the issue by Linear's own id.** There is no workspace check and no binding. Linear
  uses whatever workspace the project's account is signed in to, and every write names the task's Linear issue
  id, which exists in exactly one workspace. A sign-in in another workspace cannot find the issue, so the update
  fails with that reason in the Inbox instead of writing elsewhere. The identifier (`AMP-119`) is refused,
  since team keys repeat across workspaces.
- **A secret-only scan.** Every string a Linear write carries goes through the outbound scan's secret patterns
  (`scanSecrets`) and nothing else: no url, code block or file path pattern. A hit refuses the write and the row
  is shown as withheld with the pattern's name.
- **The brief is the reporter's whole knowledge.** It is handed 10db's recorded facts (the issue's key, Linear
  id and url, the report, verdicts, open findings, evidence, what was skipped or never ran) and numbered rules
  (`reporter-brief.ts`). The wording of a comment is the agent's.

The reporter is invisible: its conversation has no chat tab and is left out of the busy count and the warm
cap. The builder sees its results on the task's Linear tab and in the project's one Inbox card.

## Why

- Its writes leave 10db: a comment is data sent out, and a status is a write to something live. That is a hard
  limit, so the rule is a table over exact tools and keys, which can be tested as a unit, rather than a judge's
  opinion on each call.
- A judge costs a model call per tool call and can be talked round by text the reporter reads from Linear.
  The reporter reads user-written issues and comments, so its only protection must not be a model.
- Pinning by issue id gives the safety a workspace check was meant to give, with no state to keep: Linear
  itself refuses an id from another workspace.
- A scan limited to secrets keeps what a Linear comment should say (urls, code, paths) while holding back
  what must never leave.
- A visible chat per update would bury the builder's own sessions; the Linear tab and one Inbox card show the
  results.
- Turned down: running it in a lane (its sandbox, repository and tools are far wider than a comment needs),
  and letting the chat judge decide (see above).
