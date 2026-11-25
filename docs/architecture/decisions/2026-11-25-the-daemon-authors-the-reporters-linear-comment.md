# The daemon authors the reporter's Linear comment

- **Date:** 2026-11-25

## Decision

The Linear reporter's agent writes only the words of a comment. `report_linear_post` takes a post id and a
`body` (or `nothingToReport: true`); everything else is 10db's:

- **The text.** 10db cleans the body (real line breaks, no typed `\n`), refuses one shorter than
  `MIN_BODY_CHARS`, withholds one that matches a secret pattern (it names the pattern, so the agent invents
  none), and adds the footer (`footerOf`, `reporter-comment.ts`).
- **The write.** When one of the account's `mcp.linear.app` entries carries an `Authorization` header, 10db
  writes the comment itself through that server (`reporter-writer.ts`), and the agent makes no Linear write at
  all. When the account's Linear is a sign-in only its agent holds (a Codex login, a claude.ai connector),
  10db has nothing to present, so the agent carries the call: 10db answers the exact `save_comment`
  arguments, and the guard lets through one `save_comment` with Linear's own id and exactly that text. Any
  other comment write is refused with a reason that names what was wrong.
- **The record.** The row is set to `recorded` before the comment goes to Linear (in `reportPost` for 10db's
  own write, in `verdict` for the agent's), and the row, not a footer read from Linear, is what deduplicates: a
  recorded row is never owed again. The comment's id is added when Linear answers (10db's write) or from the
  closing line of the agent's last message (`<post id>: <comment id>`).
- **At most once.** Only a write 10db knows Linear did not take reopens the row with a try spent: Linear
  answered an error, or the connection failed before the write was sent (`LinearWriteError.refused`). A timeout,
  a connection dropped after the send or an unreadable answer leaves the row recorded with no id and the reason
  on `lastError`, the same as a run that dies after the write. The agent's `<post id>: failed: …` line is kept
  the same way and reopens nothing: the agent can't tell a refusal from a write Linear took without answering.
  So no comment exists without a row, and none is written twice; the cost is that an update whose write
  really failed this way is not retried.
- **Nothing else from the agent.** Status moves, the PR link and picture uploads are no longer the reporter
  agent's: its guard refuses `save_issue`, `prepare_file_upload` and `upload_linear_picture`. The daemon's own
  status and landing work sets them. The agent-driven uploader (`reporter-pictures.ts`) was removed, and the
  landing work starts from it in git history.

## Why

The audit of 2026-11-25 found a comment whose body was "placeholder", a literal `\n`, a comment no row
recorded, refusals that didn't say why, and `withheld` reports with invented patterns that spent tries. Each
came from the agent making the write and then reporting it.

## Per provider

The daemon can't present a Claude connector's or a Codex login's OAuth sign-in, so on those accounts the agent
still makes the one call, but with bytes 10db chose and a guard that refuses any other. Claude and Codex behave
alike: the guard's name prefix and the conversation's own messages work the same on both. A tool-result hook,
which Codex's adapter doesn't wire, would let the id come from the result instead of the message. An account
with a header-authenticated Linear entry is written for by 10db on either provider.

## Not verified

10db's own write has not been run against Linear's live server (no sign-in in the lane); it is tested against an
MCP endpoint that answers `save_comment` as Linear's tool is used elsewhere in the codebase.
