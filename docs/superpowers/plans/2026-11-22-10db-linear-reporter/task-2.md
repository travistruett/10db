# Card 2: the reporter's rule, Linear's tool names, the secret-only scan

**Spec:** "Reporter" › "Where it runs" (the three guard paragraphs) and "What it may do"; "Provider parity" (the
guard knows a tool is Linear's by its server).
**Track:** B, first. Pure code: it needs only card 1's `LinearBinding` (already built) and `ExternalLink`
(already built).

## Files

- `apps/daemon/src/linear/reporter-guard.ts` (new): `ReporterRun`, `judgeReporterCall`, `linearToolPrefixes` and
  `scanSecrets`, as quoted in the index.
- `apps/daemon/src/stakeholders/outbound-scan.ts`: export `SECRET_PATTERN_NAMES`, every `hold` pattern except
  `url` and `code_block` (`file_path` is a warning and is left out too). `scanSecrets` runs only those, over each
  text field, line by line, and never returns what matched.

## The rule (`judgeReporterCall`), in order

1. `mcp__10db__report_linear_workspace` and `mcp__10db__report_linear_post` → allow. Card 7 adds
   `mcp__10db__upload_linear_screen`. Every other `mcp__10db__*` → deny.
2. A tool under none of `run.linearPrefixes` → deny if it is any other `mcp__` tool (a claude.ai connector loads
   with every other connector). Allow only `Read`, `Glob`, `Grep` and `ToolSearch`. Everything else is denied:
   Bash, Write, Edit, the web tools, Agent, Task and the rest. The reporter reads and posts; it runs nothing.
3. A Linear read (the name after the prefix starts with `get_`, `list_`, `search_` or `extract_`, or is
   `whoami`) → allow.
4. A Linear write while `!run.workspaceConfirmed` → deny: "Report the workspace first: call get_workspace, then
   report_linear_workspace."
5. Writes, by tool. Every other Linear tool is denied, including `delete_*`, `share_*`, `save_project` and the
   other `save_*` tools:
   - `save_issue`: `id` is `run.link.id` or `run.link.issueId`, and the keys are a subset of `{id, state}`.
   - `save_comment`: either `issueId` is the link's id or issueId and no other parent field is set, or `id` is in
     `run.knownCommentIds` (an edit of its own comment). `parentId` is denied.
   - `create_attachment_from_upload` and `prepare_attachment_upload`: `issue` is the link's id or issueId.
     `create_attachment` (base64) is denied, so screenshots go through card 7.
   - `prepare_file_upload`: allowed. It has no issue, and its URL is used only by card 7.
   - The secret scan runs over every string in `title`, `subtitle`, `description`, `body`, `text`,
     `patch[].new_string`, `links[].title` and `links[].url`. A hit → deny "Withheld: the text matches <pattern>.
     Record the update as withheld with report_linear_post." and adds the name to `run.withheld`.
   - Anything else in the target fields → deny, naming the linked issue.
   - An allowed write is `{ decision: 'allow' }`, final, with no judge.
- `linearToolPrefixes`: the connector gives `mcp__claude_ai_Linear__` (from `mcpToolPrefix('claude.ai Linear')`;
  `daemon/linear-sign-ins.ts` matches connectors by `/linear/i`, so take the connector's real name from the same
  cached list). Each entry gives `mcp__${mcpToolPrefix(name)}__` on Claude. On Codex, read how
  `sessions/codex-refused-calls.ts` and `codex-guard.ts` split `mcp__<server>__<tool>`. If Codex leaves the name
  unsanitized, use it as-is. Write what you found in `linear/AGENTS.md`. If a real Codex is reachable from the
  worktree without signing in (`codex --version` and its config dir), check one name; otherwise say so in your
  report.

## State-table rows

- running / a write before the workspace is confirmed, to another issue, a relation field, a delete, or any
  other `mcp__` tool → denied with a reason.
- running / a write's text hits a secret pattern → denied naming the pattern.

## Tests

One table-driven file, `reporter-guard.test.ts`, core (the guard against sending data out). Each row is one call
against one `ReporterRun`:
- before confirmation: a `save_comment` on the linked issue → deny;
- after it: on the linked issue → allow; on `AMP-2` → deny; by issueId → allow;
- a `save_issue` with `parentId` → deny; with `{id, state}` → allow;
- `delete_comment` → deny; a Gmail connector tool → deny; `Bash` → deny;
- a body with an `sk-ant-…` key → deny naming `anthropic_key`; a body with a URL and a code fence → allow;
- an edit of a known comment id → allow; of an unknown one → deny.

## Done when

The checks in Global Constraints pass. Your report says how Codex names an entry's tools, and on what evidence.
