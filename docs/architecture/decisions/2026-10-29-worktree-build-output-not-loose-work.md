# A finished worktree holding only build output is removed: build output is known by name

- **Date:** 2026-10-29
- **Amends:** `decisions/2026-10-28-worktree-keeps-ignored-files.md`

## Decision

When the daemon decides whether a finished batch's worktree, or an orphan the startup sweep finds, holds
loose work, a git-ignored file that is build output does not count. Build output is a fixed list by exact
name (`isBuildOutput` in `apps/daemon/src/delivery/build-output.ts`):

- a file whose name ends in `.tsbuildinfo`, which `tsc` writes for an incremental or `--build` typecheck;
- a file named `.eslintcache`, which `eslint --cache` writes.

What already did not count stays as it was: wholly ignored directories (`dist/`, `target/`, `coverage/`,
`.gate/`, `node_modules/`), which git lists as one entry; files under a directory in the project's
`worktree_seed`; and Finder's `.DS_Store`. A file under a directory with an output's name counts like any
other file, since it reaches the rule only when git did not list that directory as wholly ignored, which
usually means a tracked source directory (`packages/coverage/.env.local` beside a tracked
`packages/coverage/index.ts`).

Names match case for case on purpose. On a case-insensitive volume a `TSCONFIG.TSBUILDINFO` keeps its
worktree rather than being taken for tsc's file: the rule errs toward keeping.

A worktree holding only build output beside what already did not count is removed when its batch closes,
ships or is abandoned clean, and by the sweep. One holding anything else is kept with its card as before.
The git-ignored-files card lists only the files that kept it. The uncommitted-changes card lists every
git-ignored file outside the seed, build output included, because its removal command deletes them all.
Removing a worktree, by retirement or by the sweep, withdraws its open kept-worktree cards, so the cards
of worktrees this change lets go fold away at the next start. Anything not on the list still keeps a
worktree; the list grows only by a later decision.

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
  before, with a card naming it. What it could wrongly remove is a hand-made file named `*.tsbuildinfo` or
  `.eslintcache`, which nobody makes by hand.

Also turned down: counting files under directories named `dist`, `target`, `coverage` or `.gate`. A wholly
ignored one never reaches the rule, so the clause would only ever match a directory git does not ignore as
a whole, and it would remove a hand-made `.env.local` there. A per-project list beside `worktree_seed` was
turned down too: it needs a column, a migration and a Settings field before anyone has asked for a name
beyond these.
