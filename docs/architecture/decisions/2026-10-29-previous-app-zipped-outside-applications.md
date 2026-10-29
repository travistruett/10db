# The app an install replaces is kept as one zip outside Applications

- **Date:** 2026-10-29
- **Amends:** `decisions/2026-10-29-install-app-from-main-ci-build.md`

## Decision

`make install-app` no longer renames the current app to `/Applications/10db.app.prev-<stamp>`. It zips it with
`ditto -c -k --keepParent` to `10db-previous/10db-<stamp>.zip` beside the data directory
(`~/Library/Application Support/10db-previous/`), using the stamp of that install's database backup. It
removes the app from `/Applications` only once `unzip -tq` passes and the zip lists
`10db.app/Contents/Info.plist`. A failure after that unpacks the zip back into place. Once the new app is
installed, it registers it with `lsregister -f -R`. It then deletes the other zips it made
(`10db-<UTC stamp>.zip`). It keeps the newest 5 `10db-backup-<UTC stamp>` folders, ordered by the stamp in
the name, and never deletes the backup it just made. Zips and backups named by hand are never deleted and
don't count. It warns about any other `/Applications/10db.app.*` copy, which Launch Services may still open.
It refuses a `10db.app` that has no `Contents/Info.plist`.

`make rollback-app` unpacks the newest `10db-<stamp>.zip`, which holds one bundle with a `Contents/Info.plist`
under any name, so a zip made by hand works too. It zips the app it replaces in its place, so a second run
toggles back; the safety backup it prints uses that zip's stamp, so rolling back again finds it. Then it
moves the unpacked bundle to `/Applications/10db.app`, clears its quarantine and registers it, as every
path that puts an app back does. The lock, the running check, the cleanup that ignores a second Ctrl-C and the printed database
restore commands are unchanged.

## Why

Launch Services follows a renamed bundle. After the first real install, the Dock, Launchpad and Spotlight
opened `/Applications/10db.app.prev-<stamp>`, the old copy, which no longer even ended in `.app`. A zip
outside `/Applications` is no bundle, so Launch Services ignores it, and registering the new app points them
back. One zip and five backups bound the space: a copy of the app is about 170 MB, and older copies only
cluttered `/Applications`.
