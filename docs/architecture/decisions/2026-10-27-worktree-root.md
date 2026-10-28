# Worktrees live in a root the daemon owns, keyed by data dir

- **Date:** 2026-10-27

## Decision

A worktree is at `<base>/<8 hex of the sha256 of the data dir's real path>/<project slug>-<last 6 hex of the
project id>/<branch leaf>`. `<base>` is `~/.10db/worktrees`, or the absolute `TENDB_WORKTREE_ROOT`; the hashed
level is always appended, so a development daemon and the app (different data dirs) never share worktrees.
The root is resolved to a real path and nothing is created there until the first worktree cut.

The root is refused, at start and in a project's registration, when it overlaps a registered checkout in
either direction, or lies at or under the data dir or the lane temp root: `startDaemon` throws
`WorktreeRootError` and `createProject` answers 400 for a checkout that contains the root or lies inside it.
A checkout already registered under the root is refused at registration only, not at a later start.

## Why

Inside the checkout, a worktree would be writable by the main checkout's lanes and gates, and every repo tool
(tsc, vitest, eslint, the watcher) would see it. Under the data dir it would sit inside a protected path. A
hidden directory in the home directory is Codex's choice and easy to open in an editor. The hash keeps one
daemon's sweep (`decisions/2026-10-27-worktree-removal-and-sweep.md`) off another's worktrees. Rejected:
`.claude/worktrees` in the repository, and a root under the data dir.
