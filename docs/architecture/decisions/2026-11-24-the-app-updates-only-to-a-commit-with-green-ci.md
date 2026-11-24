# The app updates itself only to a main commit whose CI finished green

- **Date:** 2026-11-24
- **Amends:** `decisions/2026-11-03-app-follows-main-by-itself.md`

## Decision

- `install-app.sh --stage` considers only commits of the ref whose `ci.yml` push run concluded `success`,
  and among them the newest with a finished, live build. A commit whose run is red, cancelled or still
  running is skipped; the build of the newest green commit is the one waited for when none has finished.
- With no green commit among the recent ones and a running commit known, staging ends as "current" (no
  failure card); without one it fails.
- No minimum time between installs: a restart ends the process that would count it, and a stored timestamp
  was not worth it for the saving.

## Why

The app installed main at a commit whose CI was red. The build workflow's own success does not say the commit's
checks passed. Main's runs no longer cancel each other, so every main commit gets a finished run to read.
