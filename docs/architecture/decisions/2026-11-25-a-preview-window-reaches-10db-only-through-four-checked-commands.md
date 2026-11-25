# A Preview window reaches 10db only through four checked commands that fill a draft

- **Date:** 2026-11-25

## Decision

- A project's Preview window (`preview-<project id>`, `apps/desktop/src-tauri/src/preview.rs`) loads the
  project's app with the picker (`apps/desktop/src/picker/`) as its initialization script, in the page's own
  JavaScript world. It holds no UI, dev-UI or render token.
- The app has an ACL manifest (`src-tauri/build.rs`), so every app command is checked. The main window's
  capability (`capabilities/default.json`, windows `["main"]`) names each command it calls.
- Opening a preview adds a runtime capability for that window's label and the app's exact origin
  (`<origin>/*`) allowing exactly `preview_target`, `add_pick`, `remove_pick` and `show_composer`
  (`PREVIEW_PERMISSIONS`), and no plugin or core permission. A Rust test holds the main capability's shape.
- Each command checks the calling window's label and its page's origin again. `add_pick` caps the payload at
  64 KB, parses it with every field capped (`pick_rules.rs`), drops a source path outside the project,
  rate-limits two a second and thirty a minute, and takes the target page from the shell's own record, fixed
  per pick id. It then emits `preview-pick` to the main window alone.
- The main window parses it again (`PickArrived`) and only adds it to that page's draft as a chip. Nothing from
  the page sends, answers, approves or starts anything. `show_composer` works only while the preview is
  focused, at most once a second, and the main window then focuses the page's picks, not its input.
- The crop is the shell's `WKWebView takeSnapshot` of the pick's box (`snapshot.rs`), not a script in the page.

## Why

- The page runs code an agent wrote, so anything the picker can do, the page can forge. The limit is set by
  consequence ("Trust the developer, contain the agent"). The worst a forged pick can do is put a chip in a
  draft the builder sees and sends, or doesn't.
- No localhost port is opened: tools that take picks over an open port (Agentation, ui-annotate) let any web
  page post to them.
- Without the manifest, a remote origin was already refused app commands. What the manifest adds is cover for
  a frame Tauri counts as local (`tauri://`, the dev shell's `devUrl`) reaching `daemon_connection`, which
  returns the UI token. A runtime capability on the exact origin is narrower than a loopback wildcard.
- Picks never count toward Stop and Redo: a pick landing as the builder clicks Stop would otherwise restart the
  turn with the page's words in it.
- The spec is `docs/superpowers/specs/2026-11-25-10db-pick-on-page-design.md` §5.
