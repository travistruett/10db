# The builder installs main's unsigned GitHub build with `make install-app`

- **Date:** 2026-10-29

## Decision

`make install-app [REF=main]` (`scripts/release/install-app.sh`) installs 10db from the `unsigned-dmg` artifact of
`release-dry-run.yml`. It uses the newest successful run for the ref's head commit, else a run of that commit
still queued or in progress, else a run it starts with `gh workflow run`; it waits with a deadline. REF is a
branch or tag; a commit SHA is refused, because GitHub dispatches a workflow only on a branch or tag. Make takes
REF from its command line only, never from the environment.

The install checks the DMG against the artifact's `SHA256SUMS`, then refuses while a process runs from an
executable under `Contents/MacOS` of a `10db.app` bundle or a saved `10db.app.*` beside one (the window,
`tendb-desktop`, and the daemon, `tendb-node` with `daemon.mjs` or `srt.mjs`). It never quits 10db. It takes
the lock `/Applications/.10db-install.lock`, which `make rollback-app` takes too, and checks again for a
running 10db. It backs the database up with `sqlite3 .backup` to `<data dir>-backup-<stamp>/10db.sqlite`,
checks once more, moves `/Applications/10db.app` to `10db.app.prev-<stamp>` with the same stamp, copies the
app from the DMG and clears `com.apple.quarantine` on the installed app only, without following symlinks.
A stamp is the UTC time to the second, `YYYYMMDDTHHMMSSZ`. A failure after the move puts the previous app
back, but only into an empty place, and says where it is when it can't.

`make rollback-app` (`scripts/release/rollback-app.sh`) puts back the newest `10db.app.prev-<stamp>` that holds
`Contents/Info.plist`. It keeps the app it replaces as `10db.app.rolled-back-<stamp>`, with a numeric suffix
when that name is taken. It prints, without running them, the commands that back up the current database
and then `sqlite3 .restore` the backup with the same stamp.

`release.yml` and the signed path in `build-macos.sh` are unchanged.

## Why

There is no Apple Developer account yet, so `release.yml`'s signed build can't run, and versioned releases
don't matter yet. What matters is running an up-to-date app built from main without compiling it on the
builder's Mac. The dry-run workflow already builds the unsigned DMG on a GitHub macOS runner with no secrets.

Consequences of an unsigned build: only the builder installs it, through this command; Gatekeeper refuses a
quarantined copy; and the Keychain may ask again after each update, because the ad-hoc signature changes with
every build. `SHA256SUMS` travels in the same artifact as the DMG, so it catches a corrupt download, not a
forged one; trust rests on gh fetching the builder's own run over GitHub's authenticated API.

UTC stamps sort in time order across time zones and daylight saving. The lock stops two installs, or an
install and a rollback, from moving each other's apps. Turned down: building locally (the point is not to),
and a signed release (needs the Apple account). `TENDB_DATA_DIR` is not read, because the app opened from
Finder never sees the shell's environment.
