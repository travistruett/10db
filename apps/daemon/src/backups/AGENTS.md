# backups

- The copy before migrations (`backupBeforeMigrating`) keeps the newest 5 `10db-pre-migrate-*.sqlite` files
  (`DEFAULTS.preMigrateBackupsKept`), pruning before and after the copy and never the new one. The nightly copy keeps 7.
- A copy is written to `10db-<label>.partial` and renamed once SQLite's backup resolves, so a killed copy leaves only
  a `.partial` (removed before the next copy), never a half-written `.sqlite` that counts as a restore point.
- The nightly run, after the copy and the old-copy cleanup, prunes session events (`session.context` and
  `session.activity` of tasks done or cancelled more than 14 days ago) in batches, so a failed copy deletes nothing.
  A copy keeps the freed pages (SQLite's backup copies every page), so the copies stop growing but do not shrink.
