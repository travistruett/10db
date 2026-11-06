# Shape's picture and PDF budget follows the request limit of the account a conversation runs on

- **Date:** 2026-11-05
- **Amends:** `decisions/2026-11-03-plan-sees-the-app-through-screenshots-not-a-browser.md` (its 2000 px, now 3000 px)

## Decision

A Shape conversation's pictures and PDF pages are held to limits worked out from the account its session runs on
(`apps/daemon/src/screens/picture-limits.ts`), not from one fixed 32 MB request. The figures are from the live docs,
checked 2026-11-05:

- A Claude plan or Claude API key: a 128 MB request, so a pool of 84 MiB of pictures (72 MiB inline, 12 MiB for
  `Read`), 7 MiB an image, 18 MiB of images in one message.
- Amazon Bedrock: a 20 MB request, so a pool of 11 MiB (8 MiB inline, 3 MiB for `Read`), 3.5 MiB an image, 6 MiB in one
  message. A gateway, and an account kind 10db can't place, are held to Bedrock's limits: they hide the platform.
- Every platform: 3000 px a side at most for an image sent as a block, the figure the docs give as safe once a
  request holds more than 20 images. It replaces 2000 px. The spec's budget section (§5.4) keeps the table with the doc
  page each figure came from.

A running session keeps the limits of the account it started on. A session that would be resumed on an account whose
pool is smaller than what the session has been sent (every inline image, screen and Read), or on which one sent image is
over the per-image size or pixel cap, is not resumed: it starts from the digest, which carries no picture, and the
builder is told why in a notice. Every refusal and notice about pictures states the request limit of the account it
applies to, never 32 MB.

## Why

32 MB was the figure the budget was first sized from, and it is no platform's limit. It made a Claude plan refuse
pictures it could send (the pool was about a quarter of the request) and would have let a Bedrock conversation build a
request over 20 MB (the old 21 MiB pool is 29 MB as base64).

A resumed session resends every earlier picture, so the account that resumes a conversation is the one whose limit
counts, and a project's account can change between turns when the plan falls back. Re-checking the pictures the session
carries at each start, against the account the start runs on, is the only place that sees both. Starting from the digest
costs the earlier pictures but loses nothing the builder said, as the 70%-of-context rollover already does; the
alternative, resuming and letting the API refuse, would fail every later turn.

A gateway is held to the smaller limit because 10db can't tell what stands behind it, and too small a budget costs
pictures where too large a one costs the conversation.

Not done: the 600-images-a-request limit is not counted (it takes over 560 Read pictures beside the 20 dropped and 12
screens, and the pool is spent first), and nothing was measured against a live fallback (a lane cannot run Claude). The
per-Read charge (1 MiB) is unchanged and still unmeasured: tsk_01a1a578-91d9-7591-beb2-36336144c589 measures it, and
tsk_01a1a581-d811 checks the pixel rule.
