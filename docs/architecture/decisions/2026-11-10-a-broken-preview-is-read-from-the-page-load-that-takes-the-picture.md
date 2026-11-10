# A broken preview is read from the page load that takes the picture

- **Date:** 2026-11-10
- **Amends:** `decisions/2026-11-10-task-pictures-come-from-a-pinned-chromium-and-stay-on-the-mac.md`

## Decision

10db does not load the builder's app a second time to check the preview. Each capture of a Workbench page
(before, after each Ready turn that changed something, after sign-off) also judges the load of the task's page
route, its viewports and themes taken as one (`pictures/preview-marks.ts`, rule `pictures/preview-rule.ts`):

- **Broken** is a document that failed (a navigation error, a timeout, a status of 500 or more, a landing off
  the app's origin) or a dev server's error overlay, recognised per framework by its element
  (`pictures/overlay.ts`): Next's error dialog `nextjs-portal [data-nextjs-dialog]` (its issue badge alone is
  not broken) and Vite's `vite-error-overlay`. Any other dev server is broken only by a failed document.
- **Blame is pass-wide.** `passes.preview` holds how the pass's last judged load went. A turn's broken load
  after a clean one opens a mark on that page (`pass_preview_marks`, one open per pass and page) and a thread
  notice offered with Send to Agent, never sent (cites
  `decisions/2026-11-10-a-failed-check-a-broken-preview-and-a-review-finding-are-offered-never-sent.md`); the
  queue shows the page at rank 2, "Preview broken: `/settings`". A broken load after a broken or unjudged one
  names no turn: the pass header says so (`preview`, not sendable) until a clean load, unless another page is
  already marked. A load that may be half written (the page works again, or another page holds a shared area)
  or that lands on another page of the app counts for nothing; before and after loads set the preview and
  blame nobody. The marked page's clean turn mends its mark, takes back its unsent offer and logs the minutes
  broken and the task named.
- **The second Move trigger.** A page whose turns break the preview twice running gets Move to a Separate
  Copy once per mark, where the project allows copies (`askMoveToCopy` with a route cause); on a `local`
  project it stays at rank 2. Its Not Now tells the agent nothing.
- While the pass's preview is broken, a working page reads "Working · changing": a half-written page is
  expected.

## Why

Workbench spec §8.2, §8.4, plan calls 20-22, 27-28. The picture's load is already a full page load of the route
on the builder's dev server, signed in; reading the overlay from it costs nothing and cannot disagree with the
picture the builder sees. Next and Vite compile per module, so most breaks stay on their page; a break in
shared code reaches every page, and blaming whoever loaded next would accuse a neighbour, hence the pass-wide
rule that only a turn after a clean load is named. A runtime error that shows only Next's issue badge is not
marked (a compile error, S3, is); the selectors are one table that a Next upgrade may move.
