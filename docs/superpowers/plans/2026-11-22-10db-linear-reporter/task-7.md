# Card 7: screenshots, uploaded by 10db

**Spec:** "Reporter" › "What it is handed" (screenshots as files), "What it may do" (upload files), "Where it runs"
(screenshots are not scanned).
**Track:** B, after card 4 is merged in. Cuttable: without it, the brief says screenshots are not posted.

## Files

- `packages/contracts/src/reporter-tools.ts`: `upload_linear_screen({ screenId: TaskScreenId, uploadUrl: string,
  headers: Record<string, string> })` → `{ assetUrl: string }`.
- `apps/daemon/src/linear/reporter-upload.ts` (new): the handler.
  - The screen must belong to the run's task (`getTaskScreenRow`).
  - `uploadUrl` must be `https:` and must appear, verbatim, in one of the run's `seenResults`, so only a URL
    Linear's `prepare_attachment_upload` or `prepare_file_upload` returned is accepted.
  - The headers are only those that same result named. Read the result text for them, and refuse any other.
  - Then `PUT` the file (`picturePath(dataDir, sha256)`) with `fetch`, a 30 s timeout and no redirects, and
    answer the asset URL the result named.
  - Never log the URL's query string.
- `linear/reporter-guard.ts`: allow `mcp__10db__upload_linear_screen` once the workspace is confirmed.
- `linear/reporter-brief.ts`: the screenshot step. Call `prepare_attachment_upload` for the issue, then
  `upload_linear_screen`, then `create_attachment_from_upload`, or embed the asset URL in the comment as Linear's
  docs say.

## State-table rows

running / an upload to a URL never seen in a result → refused.

## Tests

One case added to card 2's table, if the URL check sits in the pure rule; otherwise one test of the handler with
`fetch` mocked (the network is a boundary). An upload URL that never appeared in a result is refused, and a seen
one is PUT once. Core: sending data out.

## Done when

The checks in Global Constraints pass. Your report says whether the claude.ai connector's
`prepare_attachment_upload` result really carries an upload URL and headers. Read its tool description and schema
from the connector's tool list in your session, without calling it.
