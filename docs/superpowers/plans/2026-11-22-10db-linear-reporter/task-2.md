# Card 2: the reporter's rule, Linear's tool names, the secret-only scan

**Spec:** "Reporter" › "Where it runs" (the three guard paragraphs) and "What it may do"; "Provider parity" (the
guard knows a tool is Linear's by its server).
**Track:** B, first. Pure code: it needs `LinearBinding` and `ExternalLink` (built in part 2) and card 1's
`LinearPostId` only for types. Until card 1 merges, stub the type locally.

## Files

- `apps/daemon/src/linear/reporter-guard.ts` (new): `ReporterRun`, `judgeReporterCall`, `confirmWorkspace`,
  `linearToolPrefixes` and `scanSecrets`, as quoted in the index.
- `apps/daemon/src/stakeholders/outbound-scan.ts`: export `SECRET_PATTERN_NAMES`, every `hold` pattern except
  `url` and `code_block` (`file_path` is a warning and is left out too). `scanSecrets` runs only those, line by
  line, and returns the first pattern name hit, never what matched.

## The rule (`judgeReporterCall`), in order

It is pure: it returns `{ verdict, withheld? }` and mutates nothing. Card 4 applies `withheld`.

1. `mcp__10db__report_linear_workspace` and `mcp__10db__report_linear_post` → allow. Card 7 adds
   `mcp__10db__upload_linear_screen`. Every other `mcp__10db__*` → deny.
2. A tool under none of `run.linearPrefixes`:
   - `ToolSearch` → allow.
   - Everything else → deny: every other `mcp__` tool (a claude.ai connector loads with every other connector),
     `Read`, `Glob`, `Grep`, `Bash`, `Write`, `Edit`, the web tools, `Agent`, `Task` and the rest.
   - The reporter's facts are in its brief, and screenshots go by id through card 7, so it reads no file. That
     keeps it off every protected path without a read judge.
3. **Linear reads, an exact list:** `whoami`, `get_workspace`, `get_team`, `list_teams`, `get_issue`,
   `list_comments`, `list_issue_statuses`, `get_issue_status` and `get_attachment` → allow. Every other Linear
   tool not named in rule 5 → deny (`extract_images` included: it fetches URLs).
4. A Linear write while `!run.workspaceConfirmed` → deny: "Confirm the workspace first: call get_workspace and
   get_team, then report_linear_workspace."
5. **Linear writes.** Each tool has an exact key list; any other key → deny. The issue is named only by
   `run.link.issueId` (Linear's own id, which another workspace doesn't have), never by the `AMP-119` identifier:
   team keys repeat across workspaces.
   - `save_issue`: keys `{id, state, links}`. `id === link.issueId`. `links`, if present, is one entry whose
     `title` is `10db` and whose `url` is `https:`. That entry is the "10db" link attachment; Linear's links are
     append-only, so the brief adds it once, for the PR.
   - `save_comment`: keys `{issueId, body}` with `issueId === link.issueId`, or `{id, body}` with `id` in
     `run.knownCommentIds` (an edit of its own comment).
   - `prepare_attachment_upload`: keys `{issue, filename, contentType, size, title, subtitle}`, `issue ===
     link.issueId`.
   - `create_attachment_from_upload`: keys `{issue, assetUrl, title, subtitle}`, `issue === link.issueId`.
   - Everything else → deny, including `create_attachment` (base64), `prepare_file_upload`, `delete_*`,
     `share_*` and the other `save_*`. The denial names the linked issue's id.
   - **The scan:** every string value anywhere in an allowed write's input goes through `scanSecrets`. A hit →
     deny "Withheld: the text matches <pattern>. Record the update as withheld with report_linear_post.",
     returning `withheld: <pattern>`.
   - An allowed write is `{ decision: 'allow' }`, final, with no judge.

## The workspace check (`confirmWorkspace`)

`confirmWorkspace(run, input) → 'confirmed' | 'not_seen' | 'mismatch'`:
- `mismatch` when `input.workspaceId !== binding.workspaceId` or `input.teamId !== binding.teamId`.
- `not_seen` unless the workspace id appears in a successful result of `whoami` or `get_workspace`, and the team
  id in a successful result of `get_team` or `list_teams`. `run.identityResults` holds only those tools'
  successful result texts; card 4 fills it.
- `confirmed` otherwise.

## Linear's tool names (`linearToolPrefixes`)

- The connector gives `mcp__${mcpToolPrefix(name)}__` for each cached connector whose name matches `/linear/i`
  (`mcp__claude_ai_Linear__` for "claude.ai Linear"). When the connector list is unread (`unchecked`), use
  `mcp__claude_ai_Linear__`.
- Each `mcp.linear.app` entry gives `mcp__${mcpToolPrefix(name)}__` on Claude.
- On Codex, read how `sessions/codex-refused-calls.ts` and `codex-guard.ts` split `mcp__<server>__<tool>`. If
  Codex leaves the name unsanitized, use it as-is. Write what you found in `linear/AGENTS.md`. If a real Codex is
  reachable without signing in (`codex --version` and its config dir), check one name; otherwise say so in your
  report.

## State-table rows

- running / a write before the workspace is confirmed, by identifier, to another issue, with an unlisted key, a
  delete, or any other tool → denied with a reason.
- running / a write's text hits a secret pattern → denied naming the pattern.
- running / `report_linear_workspace` → confirmed, not seen, or mismatch.

## Tests

One table-driven file, `reporter-guard.test.ts`, core (the guard against sending data out). Each row is one call
against one `ReporterRun`:
- before confirmation: a `save_comment` on the linked issue → deny;
- after confirmation:
  - by `issueId` → allow; by the `AMP-119` identifier → deny; on another id → deny;
  - a `save_comment` with an extra key → deny;
  - a `save_issue` with `parentId` → deny; with `{id, state}` → allow; with a `10db` link → allow;
  - `delete_comment` → deny; a Gmail connector tool → deny; `Read` → deny; `ToolSearch` → allow;
    `extract_images` → deny;
  - a body with an `sk-ant-…` key → deny with `withheld: 'anthropic_key'`; a body with a URL and a code fence →
    allow;
  - an edit of a known comment id → allow; of an unknown one → deny.
- `confirmWorkspace`: matching ids seen → confirmed; matching ids never seen → not_seen; another workspace →
  mismatch.

## Done when

The checks in Global Constraints pass. Your report says how Codex names an entry's tools, and on what evidence.
