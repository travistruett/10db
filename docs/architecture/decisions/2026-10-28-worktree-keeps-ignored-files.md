# A finished worktree holding git-ignored files 10db didn't seed is kept, with a card

- **Date:** 2026-10-28
- **Amends:** `decisions/2026-10-27-worktree-removal-and-sweep.md`

## Decision

Before a `SHIPPED`, `CLOSED` or `ABANDONED` batch's worktree is removed, and before the startup sweep removes
a clean orphan, the daemon lists the worktree's git-ignored files with `git ls-files --others --ignored
--exclude-standard --directory`, through the main checkout's pin and the same checks as `worktreeChanges`.
An entry ending in `/` is a directory the ignore rules match as a whole (`node_modules/`, `dist/`, `target/`,
`.gate/`) and does not count. A file does: a hand-made `.env`, `.claude/settings.local.json`, a
`mise.local.toml`. Files under a directory named in the project's `worktree_seed`, which 10db copied in, do
not count either. When any file is left, the worktree is kept with `worktree_path` set, and a card lists the
files with the same removal command as the other kept-worktree cards (`keptIgnored` for a batch,
`orphanIgnored` for an orphan). Recovery re-runs the removal at each start, and the card folds. An
`ABANDONED` worktree with uncommitted changes still gets the uncommitted-changes card first.

## Why

The worktree-mode spec's residual: removing a clean worktree took its hand-made `.env` with it. Keeping a
worktree for every ignored path would keep every one: the gate and the lanes leave ignored build output in
each worktree. In 10db's own checkout after many gates, the ignored entries outside whole ignored
directories are only hand-made files (`.claude/settings.local.json`), and build output is in ignored
directories. A file is therefore the signal and a matched directory is not.

What this misses: a hand-made file inside a directory the ignore rules match as a whole (`scratch/notes.md`
when `scratch/` is ignored) is still removed. A tool that writes ignored loose files (`*.log`, `.DS_Store`
from Finder, a `*.tsbuildinfo` outside an ignored directory) keeps its worktree until the builder runs the
command on the card. Rejected: keeping a worktree for any ignored entry, which keeps all of them; only
`.env*` files, which misses other local config; snapshotting the ignored files at cut time, which can't tell
the builder's files from a lane's.
