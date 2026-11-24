# Hand-made worktrees live in `<repo>-worktrees.noindex`

- **Date:** 2026-11-24
- **Amends:** `2026-11-17-hand-made-worktrees-are-offered-for-removal-and-kept-out-of-spotlight.md`

## Decision

- **Where.** A worktree made by hand, for any repository, goes in `<repo>-worktrees.noindex` beside the checkout:
  `10db-worktrees.noindex` beside `10db`, `agent-os-worktrees.noindex` beside `agent-os`. The older
  `<repo>-worktrees` is still accepted while its worktrees drain: every finder looks in the `.noindex` folder first
  and then the older one, and nothing new is made in the older one. Nothing moves a worktree; each is removed
  after its work merges, and the older folder goes with its last worktree.
- **Spotlight.** Spotlight skips a folder whose name ends in `.noindex`, so such a folder needs no
  `.metadata_never_index` file. The daemon raises Keep Spotlight Out only for a folder without that suffix, which
  is the older one.
- **Who looks.** All of these agree with this file and cite it:
  - the daemon's Remove Merged Worktrees and Keep Spotlight Out cards (`handMadeWorktreeFolders`): both folders,
    with the removal checks unchanged;
  - the Claude git guard's own-worktree exception (`.claude/hooks/git-guard.mjs`, `OWN_WORKTREE_FOLDERS`) and the
    note in `.codex/rules/default.rules`: a worktree directly in either folder;
  - `AGENTS.md` (Git), `README.md` and `apps/desktop/AGENTS.md`;
  - agent-os: the global `instructions/AGENTS.md` ("Where files go"), `skills/coordinating-builds/SKILL.md` and
    `worktree-sweep.sh`, which lists every linked worktree of a repository wherever it lives, so it covers both.

## Why

`~/Projects/10db-worktrees` held dozens of worktrees with their own `node_modules`, and Spotlight indexed all of it,
which kept `mds_stores` and `fseventsd` busy. The earlier decision offered a marker file, which the builder has to
accept per folder; a name that Spotlight skips needs no answer and no file. Moving existing worktrees is not worth
the risk to open sessions, so the older folder drains instead.
