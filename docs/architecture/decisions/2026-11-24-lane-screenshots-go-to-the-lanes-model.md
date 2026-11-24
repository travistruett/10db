# A lane's own screenshot goes to that lane's model; every other picture stays on the Mac

- **Date:** 2026-11-24
- **Amends:** `decisions/2026-11-10-task-pictures-come-from-a-pinned-chromium-and-stay-on-the-mac.md`

## Decision

A `lane` screen, taken by a lane's own browser through `browser_screenshot`, is sent to that session's model as
an image block when it fits the account's limits (`mcp/picture-spend.ts`); otherwise the lane gets the file's
path only. Every other picture stays on the Mac, except a design review's and `check_design`'s, which go to the session's model as before, and a PR's, which upload with `prPictures`.
Lane screens are pruned as turn pictures are.

## Why

The lane needs to see what it tested. The setting that says so is the browser itself: a lane that was given a
browser to drive its own app has asked to look at the result. An image block is what any lane's Read of a PNG
already sends, so this lets nothing out that the lane could not already send itself. The Workbench's pictures of
the builder's app keep their reason for staying on the Mac: no session asked for them.
