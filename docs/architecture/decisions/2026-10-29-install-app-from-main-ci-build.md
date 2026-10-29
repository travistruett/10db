# The builder installs main's unsigned GitHub build with `make install-app`

- **Date:** 2026-10-29

## Decision

`make install-app [REF=main]` (`scripts/release/install-app.sh`) installs 10db from the `unsigned-dmg` artifact of
`release-dry-run.yml`: the newest successful run for the ref's head commit, or a run it starts with
`gh workflow run` and waits for. It checks the DMG against the artifact's `SHA256SUMS` and refuses while any
process runs from a `10db.app` bundle; it never quits 10db. It then backs the database up with
`sqlite3 .backup` to `<data dir>-backup-<stamp>/10db.sqlite`, moves `/Applications/10db.app` to
`10db.app.prev-<stamp>` (same stamp), copies the app from the DMG and clears `com.apple.quarantine` on the
installed app only. `make rollback-app` (`scripts/release/rollback-app.sh`) puts back the newest
`10db.app.prev-<stamp>`, keeps the app it replaces as `10db.app.rolled-back-<stamp>` and prints the
`sqlite3 .restore` command for the matching backup without running it.

`release.yml` and the signed path in `build-macos.sh` are unchanged.

## Why

There is no Apple Developer account yet, so `release.yml`'s signed build can't run, and versioned releases
don't matter yet. What matters is running an up-to-date app built from main without compiling it on the
builder's Mac. The dry-run workflow already builds the unsigned DMG on a GitHub macOS runner with no secrets.

Consequences of an unsigned build: only the builder installs it, through this command; Gatekeeper refuses a
quarantined copy; and the Keychain may ask again after each update, because the ad-hoc signature changes with
every build. `SHA256SUMS` travels in the same artifact as the DMG, so it catches a corrupt download, not a
forged one; trust rests on gh fetching the builder's own run over GitHub's authenticated API.

Turned down: building locally (the point is not to), and a signed release (needs the Apple account).
`TENDB_DATA_DIR` is not read, because the app opened from Finder never sees the shell's environment.
