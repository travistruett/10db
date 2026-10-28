# A new worktree is seeded by cloning ignored directories, running nothing

- **Date:** 2026-10-27

## Decision

After the checkout, the cut copies the main checkout's git-ignored directories whose last component is in
`projects.worktree_seed` (directory names, default `["node_modules"]`; no `/`, not `.`, `..` or `.git`,
checked when saved). They are found with `git ls-files --others --ignored --exclude-standard --directory`.
The copy walks by `lstat`: directories are made, regular files cloned copy-on-write, links copied as links and
never followed, anything else skipped. Sixteen file clones run at once and the job's abort signal stops it. An
ignored directory whose parent is not in the new worktree is skipped and logged. An unreadable entry fails
the seed, which refuses the cut and removes the worktree and branch. Nothing from the repository runs, and
Cargo's `target` is not seeded unless the project adds it.

## Why

Measured: a clone is complete (`pnpm install --frozen-lockfile --offline` reports the lockfile up to date) and
costs no disk until written, while an install can't run in a lane and mustn't run on the host. In worktree
mode no lane writes the main checkout, so the clone is the builder's own install. `target` costs seconds to
clone for a saving a lane may not see, since a lane's `CARGO_HOME` is its own (decision 126). Rejected: a setup
command run on the host, and `pnpm install` per worktree.
