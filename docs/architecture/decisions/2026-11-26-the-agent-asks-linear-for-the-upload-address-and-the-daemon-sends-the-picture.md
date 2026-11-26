# The agent asks Linear for the upload address, and the daemon sends the picture

- **Date:** 2026-11-26
- **Amends:** `decisions/2026-11-25-the-daemon-uploads-a-tasks-pictures-to-linear-and-says-why-it-has-none.md`
  (its last point: an account whose Linear sign-in only its agent holds showed no pictures, and "a follow-up
  closes that gap")

## Decision

- **An account whose Linear sign-in only its agent holds shows its pictures too.** 10db has no header to ask
  Linear for an upload address with, so the agent asks, and only asks. For each picture, `report_linear_post`
  answers a `next` of two calls: Linear's `prepare_file_upload` with the file 10db named (`filename`,
  `contentType` `image/png`, `size` in exact bytes), then `report_linear_post` again with the post id alone.
- **10db reads Linear's answer from the session, not from the agent.** Claude Code's PostToolUse hook carries the
  call's result; Codex has no such hook, so its session hands on the whole result of the `mcpToolCall` item that
  ends the call (`codexMcpResult`; the conversation's view of a call keeps only the last 4,096 characters). 10db
  checks the address with `isLinearUploadUrl` and PUTs the bytes at once, with Linear's signed headers unchanged.
  The agent never sees a picture, copies no address, and has no network.
- **One file at a time.** Linear asks that a file be prepared and sent before the next is prepared, and a signed
  address lasts 60 seconds. The call back to 10db waits for the send to finish (a result the session has not
  shown yet gets 20 seconds), then names the next file, or answers the comment 10db built with the markdown of
  each picture that reached Linear.
- **The guard lets out only the named upload.** A `prepare_file_upload` is allowed when its three arguments are
  exactly the ones 10db named for an owed update of this run, once. Any other file, size, type or key, a second
  request for the same file, a snapshot run, and every other upload tool (`prepare_attachment_upload`,
  `create_attachment`, `create_attachment_from_upload`, `upload_linear_picture`) are refused.
- **A picture that fails never holds the comment.** A request Linear refuses, an address Linear did not sign, a
  PUT that fails or expires, a result that never reaches 10db or a file no longer kept leaves that picture and
  the ones after it out; the comment goes out and says how many are in 10db and why.

## Provider parity

| Account                                           | Who asks Linear for the address | Who sends the bytes |
| ------------------------------------------------- | ------------------------------- | ------------------- |
| Any account whose Linear entry carries a header   | 10db (`LinearCommentWriter`)    | 10db                |
| A Claude plan with the claude.ai Linear connector | the agent, with the named file  | 10db                |
| A Claude account with an OAuth Linear entry       | the agent, with the named file  | 10db                |
| A Codex sign-in with `codex mcp login` for Linear | the agent, with the named file  | 10db                |

An API key or Bedrock account has no claude.ai connector, so its Linear is an entry of the builder's: with a
header it takes the first row, with an OAuth sign-in the third.

## Why

Ampsio runs on a Codex sign-in whose Linear entry sends no header, so none of its 101 updates carried a picture
and its comments said the pictures were in 10db. The builder keeps that sign-in; asking for an API key instead
would move how every Codex session on the Mac reaches Linear.

Linear's `prepare_file_upload` exists for this split: the tool signs an address, and the bytes go by HTTP PUT
outside MCP. The earlier agent-driven upload (`upload_linear_picture`) had the agent copy the signed address
back to 10db, a string of over a thousand characters through a model's text; reading the call's result from
the session takes the agent out of that path. The address is still checked before any byte is sent, so a
result that is not Linear's sends nothing.

Not checked against the real Linear: the tool's contract is read from its own description on Ampsio's Codex
sign-in, and the shape Claude Code's hook gives an MCP result in is read tolerantly (text, content blocks or an
object). The first real `ended` comment with pictures is the check.
