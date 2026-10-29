# A configuration the daemon refuses exits 4, and the supervisor stops

- **Date:** 2026-10-28

## Decision

When the daemon refuses its configuration at startup it prints the reason as one line on stderr and exits
with code 4. That covers an invalid environment (`EnvError` from `loadEnv`, such as a relative
`TENDB_WORKTREE_ROOT`) and a refused worktree root (`WorktreeRootError`: a root that overlaps a registered
checkout, lies at or under the data dir or the lane temp root, or lies under a file). The desktop shell's
supervisor stops on 4 (`EXIT_REFUSED_CONFIG`), as it does on 2 (another daemon holds the data dir) and 3
(schema mismatch), and restarts on any other code.

## Why

Before, an `EnvError` was thrown before `main`'s handler and a `WorktreeRootError` was rethrown, so both
exited 1 with a stack trace and the supervisor restarted into the same refusal every 30 s at most. A restart
can't fix a setting. A code of its own, rather than 3, keeps the schema mismatch's meaning narrow for
anything that later reads it.
