# An after picture waits for the browser's fetch

- **Date:** 2026-11-26
- **Amends:** `decisions/2026-11-10-task-pictures-come-from-a-pinned-chromium-and-stay-on-the-mac.md`

## Decision

While the pictures browser is being fetched or checked, befores and afters wait in the capture queue and start
once it is ready; only a turn picture is not asked, and a waiting one is dropped when a fetch begins. A capture
that keeps nothing without being stopped logs why, and an after the queue does not take (a refused browser, a
daemon stopping) is logged.

## Why

The earlier record dropped turn and after pictures during a download. Every start-up checks the pinned build,
so the browser is `fetching` for its first seconds, exactly when start-up's catch-up asks the afters a restart
missed. Every one of those asks was dropped, silently. A self-update installs as soon as a local copy's landing
ends its drain, so the restart usually comes seconds after the copy ships and aborts the afters it asked; the
catch-up was the only way they were taken, and it never took one. The builder's project with local copies had
kept no after picture, so none reached Slack or Linear.

An after shows what the task ended as, which is as true once the browser is ready as before. A turn picture
shows one turn and the page's next turn replaces it, so dropping it while the browser is fetched loses nothing.
