# The daemon makes a worktree from plain data and pins it at creation, keyed by batch

- **Date:** 2026-10-27
- **Amends:** decisions 129 and 131 for worktree paths

## Decision

The cut makes a worktree with the daemon's pinned git, running nothing from the repository (decision 129): `update-ref` creates the branch at
`origin/<base>` (compare-and-set from nothing), `git worktree add --no-checkout --lock --reason '10db <batch id>'`, a pin of the new
worktree, then `read-tree -m -u` from its HEAD. `GIT_DIR` and `GIT_WORK_TREE` name the main checkout for
`update-ref` and `worktree add`, and the new worktree for `read-tree`. A base tree that selects a filter is
refused before the branch exists. The batch row, with its `worktree_path`, is inserted `CUTTING` before any
git side effect, so recovery knows what to remove.

The pin is written at creation, never on first use: the worktree's git dir, read from its new `.git` gitfile,
must lie under the project's pinned common dir, and its common dir must be the project's, by device and
inode; it copies the main pin's fetch and push URLs. It is stored as `checkout_pin.<batch id>`. The pin store
resolves a real path to a project's checkout first, then to a batch whose `worktree_path` is that path.
`createGit({ worktreeRoot })` refuses (`GitTrustFailure.Unpinned`) any path at or under the root that has no
pin, so a directory someone else put there is refused too. `Git.removeWorktree` deletes the pin; the caller
then clears `worktree_path`.

## Why

It is the plumbing the shared cut already uses, so no repository code runs. The daemon made the worktree, so
there is nothing for the builder to trust; checking the common dir proves it is the project's repository.
Keying by batch keeps the pin across a restart, which a lookup by project would lose. The lock reason is the
marker the sweep looks for and stops `git worktree prune` from dropping the metadata. Rejected: pinning on
first use, as an unknown path is today.
