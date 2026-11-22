# Card 7: screenshots, uploaded by 10db

**Spec:** "Reporter" › "What it is handed" (screenshots as files), "What it may do" (upload files), "Where it runs"
(screenshots are not scanned).
**Track:** B, after card 4 is merged in. Cuttable: without it, the brief says screenshots are not posted.

## Files

- `packages/contracts/src/reporter-tools.ts`: `upload_linear_screen({ screenId: TaskScreenId, uploadUrl: string,
  headers: Record<string, string> })` → `{ assetUrl: string }`.
- `apps/daemon/src/linear/reporter-upload.ts` (new): the handler.
  - The screen must belong to the run's task (`getTaskScreenRow`).
  - `uploadUrl` must be the `uploadRequest.url` of a successful `prepare_attachment_upload` result in this run
    (card 4 keeps those results, per call, apart from every other Linear result). Text from issues and comments
    never counts. The URL is `https:`, and its host is the one that result names, which Linear signs as a
    Google Cloud Storage URL today (`storage.googleapis.com`). Pin that host; another host is refused.
  - The headers are exactly that result's `uploadRequest.headers`, sent verbatim. Any other header is refused.
  - The signed URL lasts 60 s, so the brief has the agent prepare, upload and attach one screenshot at a time.
  - Then `PUT` the file (`picturePath(dataDir, sha256)`) with `fetch`, a 30 s timeout and no redirects, and
    answer the asset URL the result named.
  - Never log the URL's query string.
- `linear/reporter-guard.ts`: allow `mcp__10db__upload_linear_screen` once the workspace is confirmed.
- `linear/reporter-brief.ts`: the screenshot step. For each screenshot, one at a time: call
  `prepare_attachment_upload` for the issue, then `upload_linear_screen`, then `create_attachment_from_upload`.

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
