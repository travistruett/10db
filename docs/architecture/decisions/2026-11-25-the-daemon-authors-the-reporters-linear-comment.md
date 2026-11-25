# The daemon authors the reporter's Linear comment

- **Date:** 2026-11-25

## Decision

The Linear reporter's agent writes only the words of a comment. `report_linear_post` takes a post id and a
`body` (or `nothingToReport: true`); everything else about the comment is 10db's:

- **The text.** 10db cleans the body (real line breaks, no typed `\n`), refuses one shorter than
  `MIN_BODY_CHARS`, withholds one that matches a secret pattern (it names the pattern, so the agent invents
  none), and adds the footer (`footerOf`, `reporter-comment.ts`). It answers the exact `save_comment`
  arguments.
- **The write.** The reporter's guard lets through one `save_comment`: Linear's own id as `issueId` and the
  `body` 10db built, once. Any other comment is refused with a reason that names what was wrong (the key
  used instead of the id, an unlisted key, a body 10db didn't build, a comment already written).
- **The record.** The row is set to `recorded` in the same step that lets the write through (`verdict` in
  `reporter.ts`), before Linear gets the comment, and the row, not a footer read from Linear, is what
  deduplicates: a recorded row is never owed again. The comment's id is added to the row from the closing line
  of the agent's last message (`<post id>: <comment id>`, or `<post id>: failed: <Linear's words>`, which
  reopens the row with a try spent). A run that dies after the write leaves a recorded row with no id, never a
  comment with no row and never a second comment.

## Why

The audit of 2026-11-25 found a comment whose body was "placeholder", a literal `\n`, a comment no row
recorded, refusals that didn't say why, and `withheld` reports with invented patterns that spent tries.
Each came from the agent making the write and then reporting it. The daemon can't call the account's Linear
server itself: a claude.ai connector's sign-in lives with the Claude session, and a Codex account's with
Codex. So the agent still carries the call, but it carries bytes 10db chose, and 10db's guard and row decide
whether they go.

## Per provider

The guard and the closing message are the same on Claude and Codex (the guard's name prefix works alike, and
the daemon reads the conversation's own messages), so both behave the same. Neither needs a tool-result hook,
which Codex's adapter doesn't wire; with one, the id could come from the result instead of the message.

## Left for later

Status moves, the PR link and picture uploads still go through the agent's own `save_issue` and upload calls
under the guard's key lists; they move to the daemon with the status and landing tasks.
