# backups

- The copy before migrations (`backupBeforeMigrating`) keeps the newest 5 `10db-pre-migrate-*.sqlite` files
  (`DEFAULTS.preMigrateBackupsKept`), pruning before and after the copy and never the new one. The nightly copy keeps 7.
- A copy is written to `10db-<label>.partial` and renamed once SQLite's backup resolves, so a killed copy leaves only
  a `.partial` (removed before the next copy), never a half-written `.sqlite` that counts as a restore point.
