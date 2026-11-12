# A ready notification selects its page by its id, with focus as the fallback

- **Date:** 2026-11-09

## Decision

A Workbench pass's Ready item (a `check` card whose detail parses as `PassCheckDetail`) notifies
"<Page> is ready" instead of the generic check notification, with a numeric notification `id` that
`apps/desktop/src/desktop/notify-pass.ts` maps to its project and task. The notification plugin's
`onAction` listener is registered once, when the app shell mounts (`desktop/sync.ts`), and every send waits
for it. A click selects the project, opens `/workbench?task=<task>`, and shows, unminimizes and focuses the
window; the capability allows `core:window:allow-show`, `allow-unminimize` and `allow-set-focus`.

When the window gains focus (the DOM `focus` event on `window`), the pass's workspace asks `focusTarget`:
the page of a ready notification shown in the last 10 seconds and not acted on, else the page that has
waited longest when the shown page waits on nothing; never away from a page with a draft.

## Why

tauri-plugin-notification 2.8 reports a desktop click to `onAction` with action `tap`, but only for a
notification shown while a listener existed, and it carries the notification's `id` back; whether `extra`
round-trips is unconfirmed, so the id is the key. A dev build sends notifications as Terminal
(`com.apple.Terminal`), so the click is unverified there, and macOS may not report a click at all; the
focus rule covers both, because a builder who clicks a notification focuses the window within seconds.
The DOM `focus` event was chosen over the window's `onFocusChanged` so the same rule runs in the Tauri
window and in a browser tab; WKWebView fires it when its window becomes key.
