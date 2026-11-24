# Hand-made worktrees live in `<repo>-worktrees.noindex`

- **Date:** 2026-11-24
- **Supersedes:** the marker-file part of `2026-11-17-hand-made-worktrees-are-offered-for-removal-and-kept-out-of-spotlight.md` (its removal card stands)

## Decision

- **Where.** A worktree made by hand, for any repository, goes in `<repo>-worktrees.noindex` beside the checkout:
  `10db-worktrees.noindex` beside `10db`, `agent-os-worktrees.noindex` beside `agent-os`. The older
  `<repo>-worktrees` is still accepted while its worktrees drain: every finder looks in the `.noindex` folder first
  and then the older one, and nothing new is made in the older one. Nothing moves a worktree; each is removed
  after its work merges, and the older folder goes with its last worktree.
- **Spotlight.** Spotlight skips a folder whose name ends in `.noindex`, nested files included, and ignores
  `.metadata_never_index`. Probe on macOS 27.2.1 (26B131): one indexed control folder, one `.noindex` folder and one
  folder holding the marker, each with a uniquely named file, searched with `mdfind` after indexing; the control and
  the marker folder were found, the `.noindex` folder was not. `~/Projects/10db-worktrees` carries the marker and
  135 of its `package.json` files were indexed. So the daemon no longer creates the marker for a hand-made folder:
  the Keep Spotlight Out card is now a notice that Spotlight indexes the folder, shown only for a hand-made folder
  without the `.noindex` suffix that holds worktrees, never for a `.noindex` one. It says to make new worktrees in
  `<repo>-worktrees.noindex` and the old ones leave as their work merges; answering only dismisses it, writing
  no file and running no git call. The markers under `~/.10db` (the lane roots and sandbox temp roots) stay: `.10db`
  is a dot-directory Spotlight does not index here, so they are harmless.
- **Where the folder is named.** Each of these must agree with this file; a change to the rule changes all of them:
  - the daemon's Remove Merged Worktrees and Spotlight cards (`handMadeWorktreeFolders`): both folders,
    with the removal checks unchanged;
  - the Claude git guard's own-worktree exception (`.claude/hooks/git-guard.mjs`, `OWN_WORKTREE_FOLDERS`) and the
    note in `.codex/rules/default.rules`: a worktree directly in either folder;
  - `AGENTS.md` (Git), `README.md` and `apps/desktop/AGENTS.md`;
  - agent-os: the global `instructions/AGENTS.md` ("Where files go"), `skills/coordinating-builds/SKILL.md` and
    `worktree-sweep.sh`, which lists every linked worktree of a repository wherever it lives, so it covers both;
  - agent-os `check.py` (`WORKING_DIRS`) and `settings/required.md` (`permissions.additionalDirectories`): the
    working directories of `agent-os-worktrees.noindex` and the draining `agent-os-worktrees`.
- **The card's key.** The informational card has its own fold key, and an open card under the earlier key (the
  one that offered the marker) is withdrawn at the next look.

## Why

`~/Projects/10db-worktrees` held dozens of worktrees with their own `node_modules`, and Spotlight indexed all of it,
which kept `mds_stores` and `fseventsd` busy. The earlier decision offered a marker file, which this macOS ignores;
a name that Spotlight skips needs no answer and no file. Moving existing worktrees is not worth
the risk to open sessions, so the older folder drains instead.
