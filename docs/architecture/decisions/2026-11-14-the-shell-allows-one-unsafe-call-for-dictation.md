# The shell allows one unsafe call, for macOS Dictation

- **Date:** 2026-11-14
- **Supersedes:** the line on relaxing the `unsafe_code` lint in
  `decisions/2026-11-03-plan-sees-the-app-through-screenshots-not-a-browser.md` (its rejected option "Snapshot a
  hidden Tauri webview"); that decision's choice of screenshots stands.

## Decision

`apps/desktop/src-tauri/Cargo.toml` sets `unsafe_code = "deny"` instead of `"forbid"`. Exactly one function,
`send_start_dictation` in `src-tauri/src/dictation.rs`, carries `#[allow(unsafe_code)]`: it sends the
`startDictation:` action down the responder chain with `NSApplication::sendAction_to_from`. Every other `unsafe`
in the shell still fails the build, because `deny` is not lifted anywhere else.

The call runs only in the Tauri window and cannot run in a lane or a test, so it is checked by hand: the mic button
starts macOS Dictation and the spoken text lands in the focused composer.

## Why

- The builder asked for the mic button to do what Edit > Start Dictation does. That action is sent by selector
  through the responder chain, and `objc2-app-kit` exposes `sendAction_to_from` only as an `unsafe fn` because the
  selector is unchecked. No safe API reaches the focused field's dictation: Tauri has no such command, and
  synthesizing fn-fn needs Accessibility permission and is unreliable.
- `forbid` cannot be overridden by a local `allow`, so the lint has to drop to `deny` for the one call to exist.
- The price is one reviewed `unsafe` block in one file, with its safety reasoning beside it. The earlier decision
  turned that price down for a webview snapshot, where the call was avoidable by another route; here it is the
  only route to the requested behaviour.
- Rejected: moving the call into a separate crate with its own lint, which adds a crate and a build step for the
  same one call.
