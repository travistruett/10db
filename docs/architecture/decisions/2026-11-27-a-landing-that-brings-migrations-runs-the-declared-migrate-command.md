# A landing that brings migrations runs the project's declared migrate command on its dev database

- **Date:** 2026-11-27

## Decision

A project has a migrate command (`projects.migrate_command`, Settings › App Preview › Migrate Command,
for example `pnpm db:migrate`). When a separate copy's landing brings files under the `migrations` hazard's
globs into the base, `migrateAfterLanding` in `delivery/copy-landing-cards.ts` does one of four things:

- **Rule `migrate-after-landing` set to ask:** the old card ("apply them to your dev database").
- **No command:** one card per project, "Tell 10db how <project> migrates", listing the files. The app setting
  `migrate-command-asked:<project>` keeps it to once for the project's life.
- **The command exits 0:** an Activity row with the files and the last 20 lines of output (undo `final`: a
  migration can't be taken back, and it ran on the dev database only).
- **A non-zero exit, the ten-minute limit or a failure to start:** one card for the batch
  (`copy-migrations:<batch>`) with the last 20 lines and the log path (`logs/migrate/` in the data directory).

`delivery/dev-migrate.ts` runs the command through the unslotted gate runner, always in `project.repoPath`
(the builder's own folder) and with no copy id, so it never runs in a copy, a worktree or a scratch checkout.
localhost is allowed, and Docker too when the project allows it or the command is seen to call docker. The
request names no project id, so it never changes the project's Docker switch. Recovery runs it again for a
copy found at `landed`, inside the queued retirement job, so startup never waits on it. A run stopped by
shutdown leaves the copy at `landed` for recovery. No model runs, so every kind of account behaves the same.

## Why

A landing that left migrations unapplied broke the builder's next use of the app, and the card only told them
to run a command they had already named. The command is the builder's setting, so it runs where their dev
server runs, against their dev database. If it reaches a remote database through Docker or its own config,
that is their setup; the setting's help says so. Migrate tools apply only what is pending, so a re-run after
recovery is safe. Asking once rather than at each landing keeps a project that migrates by hand from collecting
a card per landing. Migrating after a pull request merges (worktree delivery) is separate work.
