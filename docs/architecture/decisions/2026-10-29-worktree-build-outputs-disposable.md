# A finished worktree holding only build output is removed: build output is known by name

- **Date:** 2026-10-29
- **Amends:** `decisions/2026-10-28-worktree-keeps-ignored-files.md`

## Decision

When the daemon decides whether a finished batch's worktree, or an orphan the startup sweep finds, holds
loose work (`unseededIgnoredFiles` in `apps/daemon/src/delivery/worktree-cleanup.ts`), a git-ignored file
that is tool output does not count, beside Finder's `.DS_Store` and the seeded directories, which already did
not. Tool output is a fixed list by exact name (`apps/daemon/src/delivery/disposable-files.ts`):

- a file whose name ends in `.tsbuildinfo`, which `tsc` writes for an incremental or `--build` typecheck;
- a file named `.eslintcache`, which `eslint --cache` writes;
- a file under a directory named `dist`, `target`, `coverage` or `.gate`, at any depth.

Names match case for case, and a file that is itself named `dist` or `target` is not output. A worktree
holding only such files, and wholly ignored directories, is removed when its batch closes, ships or is
abandoned clean, and by the sweep. One holding anything else is kept with its card as before, and the card
lists only the files that kept it: the build output beside them is left off, since the removal command takes
it and the next build makes it again. Anything not on the list still keeps a worktree, so the list grows only
by a later decision.

## Why

A batch's worktree was kept overnight for one file, `tsconfig.tsbuildinfo`, which the gate's typecheck
wrote. The other kept worktrees held `.gate/`, `apps/*/dist/` and `apps/desktop/src-tauri/{binaries,gen,
resources,target}/`, all wholly ignored directories that already did not count. A kept worktree is a card
for the builder and a disk cost, and every batch of a TypeScript project would raise one.

Two ways to tell the gate's output from loose work were weighed. The reason for keeping a worktree is never
to delete a builder's or a lane's loose work, so each was judged by what it would wrongly remove.

- **Compare against what existed before the gate ran** (snapshot the ignored files before each gate run and
  count only those that were there already). Turned down. A lane's own commits run the pre-commit hook, and
  lanes run `pnpm typecheck` themselves, so `.eslintcache` and `tsconfig.tsbuildinfo` usually exist before
  the first gate: the snapshot keeps the very worktrees this fixes. In the other direction, the lanes of a
  batch share its worktree and keep working while one workstream's gate runs, so a `.env` a lane writes
  during that window looks like the gate's and is removed, the unsafe failure. It also needs a snapshot per
  batch persisted across restarts and gate runs, and an orphan whose batch row is gone has none, so the
  sweep would keep every orphan anyway.
- **A list of known build-output names.** Chosen. It is stateless, so the batch path and the sweep use one
  rule, and it fails safe: output it doesn't know (a `*.log`, another tool's cache) keeps the worktree, as
  before, with a card naming it. What it can wrongly remove is a hand-made file under a directory named
  `dist`, `target`, `coverage` or `.gate` whose ignore rule matches files rather than the directory, or a
  hand-made file named `*.tsbuildinfo` or `.eslintcache`. Nobody makes those by hand, and a directory with
  one of those names is a tool's to rewrite.

Also turned down: a per-project list beside `worktree_seed`, which needs a column, a migration and a Settings
field before anyone has asked for a name beyond these; and counting every file under any ignored directory
whose name looks like output (`build`, `out`, `.next`), which widens what can be removed without evidence
that 10db's gates write there.
