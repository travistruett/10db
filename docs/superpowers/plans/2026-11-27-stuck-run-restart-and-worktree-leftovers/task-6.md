# Task 6: an idle merged hand-made worktree is removed, and Undo puts it back

Read the index's Brief and Global Constraints first. Size: Core (git worktrees the builder made). Starts after
tasks 1 and 4 have merged.

**Files:**

- `apps/daemon/src/git/git.ts`: `restoreHandMadeWorktree` and `handMadeWorktreeIdleSince`, beside
  `removeHandMadeWorktree`, both through `handMadeScope`. `apps/daemon/src/git/AGENTS.md`.
- New `apps/daemon/src/delivery/processes-in.ts`: `processesIn(path): Promise<number | null>`, from `lsof -a -d
  cwd -Fn` parsed with zod-checked lines, counting the processes whose working directory is `path` or under it.
  `lsof` exits 1 when nothing matches: exit 0 or 1 is parsed, and exit 1 with empty output is 0 processes, not
  null. Null only when `lsof` can't be started, exits with another code, or prints a line that can't be read. A
  child process 10db doesn't own, so tests inject it.
- `apps/daemon/src/delivery/hand-made-worktrees.ts`: `mergedHandMadeCandidates`, `HAND_MADE_IDLE_MS`,
  `removeIdleMergedHandMade`; the look calls it before it raises the merged card. `hand-made-cards.ts`:
  `handMadeNotices.removedByRule`.
- `apps/daemon/src/inbox/activity-actions.ts` and `apps/daemon/src/daemon/start.ts`: the real
  `UndoMoves.restoreWorktree`, replacing task 1's refusal.
- `apps/daemon/src/git/hand-made-worktrees.test.ts`: extended. `apps/daemon/src/delivery/AGENTS.md`.

**Implements:** `restoreHandMadeWorktree`, `handMadeWorktreeIdleSince`, `mergedHandMadeCandidates`,
`HAND_MADE_IDLE_MS`, `removeIdleMergedHandMade`, `UndoMoves.restoreWorktree`. **Calls:**
`removeHandMadeWorktree`, `handMadeWorktreeIgnoredFiles`, `looseWork`, `onlyHere`, `saveKept` (task 4),
`isRuleAsking`, `post`.

**Two listings, one loop.** Today `mergedHandMadeWorktrees` drops a worktree that holds a loose ignored file (a
hand-made `.env`), because its callers remove without saving. The rule saves first, so it needs those worktrees
too.

- `mergedHandMadeCandidates(ctx, project, signal)` is today's loop without the last check: merged, carried,
  unlocked, clean. Each result carries `loose`: `looseWork` of its `handMadeWorktreeIgnoredFiles`.
- `mergedHandMadeWorktrees` keeps its signature and its meaning: the candidates whose `loose` is empty. The
  ask-mode merged card and `removeMergedHandMade` (the builder's Remove answer) still call it and nothing else,
  so they never list or remove a worktree holding a file only it has. Do not drop that check to make this card's
  test pass: the Remove answer saves nothing.
- Only `removeIdleMergedHandMade` calls `mergedHandMadeCandidates`.

**git.**

- `handMadeWorktreeIdleSince`: the newest mtime among the worktree's admin files (`HEAD`, `index`, `logs/HEAD`
  under its git dir), its root directory and the entries directly in the root (`lstat`, never followed, never
  deeper). The index moves on a stage or commit and a top-level entry on most edits; a deep edit that moves
  neither is caught by "clean", which is checked first.
- `restoreHandMadeWorktree`: `path_exists` when anything is at `path`; `branch_gone` when
  `refs/heads/<branch>` is missing; else `git worktree add <path> <branch>` (no `-b`, no `--force`) and
  `restored`. The scope refuses a path outside the project's hand-made folders.

**`removeIdleMergedHandMade`**, in the project's ship queue, from the look:

- `isRuleAsking(db, project.id, DecisionRule.MergedWorktree)`: nothing; the look raises today's card.
- For each of `mergedHandMadeCandidates` (merged, carried, unlocked, clean; a loose ignored file does not rule
  it out), looked up again inside the job: skip unless `now - idleSince >= HAND_MADE_IDLE_MS` and
  `processesIn(path) === 0`. Null (unknown) skips.
- Its `loose` files go through `onlyHere` against the project's checkout; any left are saved with `saveKept`
  first (`name` the worktree folder's name), and `keptDir` is the folder it answers. With none left `keptDir` is
  null. A failed copy (`KeptCopyError`) skips the worktree: it stays, and nothing is said.
- `removeHandMadeWorktree`; on `removed`, one notice. A worktree skipped here is not offered on the merged card
  while the rule decides: the look raises that card only when the rule is set to ask, and withdraws an open one
  otherwise. A Keep answer the builder gave earlier still holds (`allKept`): those paths are never removed.

**The notice**, one per worktree: key `hand-made-removed:<path>`, `decision: { by: Rule, rule: MergedWorktree,
confidence: null, undo: { state: 'undoable', action: { kind: 'restore_worktree', projectId, path, branch,
keptDir } } }`.

- Line: `Removed the merged worktree <folder name>; its branch is kept`.
- Body: the path, the branch, the pull request's merge, the kept folder when files were saved, and "Undo makes the
  worktree again from its branch."

**The undo.** `restoreWorktree(action)`: the project must still exist and `path` must lie in its hand-made
folders. `restoreHandMadeWorktree`; `path_exists` and `branch_gone` throw `ConflictError` with the reason, and
nothing changes. On `restored`, each file under `keptDir` is copied back to its relative path with its mode,
never over an existing file; the kept folder stays. `perform` is synchronous today: make `undo` await the move
before `markRowUndone`, or run the restore in the project's ship queue and mark the row in its write; pick the
one that keeps a failed restore from marking the row.

**State-table rows:** "A merged hand-made worktree, idle 24 h", "Undo on a hand-made removal".

**Test.** Extend `hand-made-worktrees.test.ts` (a real repository in a temp directory, an injected clock and
`processesIn`): a merged, clean worktree is left at 23 hours and with a process in it, and removed at 24 hours
with none, its branch still there and its hand-made `.env` (ignored, absent from the checkout) under the kept
root; Undo brings back the path on the branch with that file; Undo with something at the path throws
`ConflictError` and changes nothing. With the rule set to ask, the same worktree is not on the merged card and
`removeMergedHandMade` leaves it: `mergedHandMadeWorktrees` still drops a worktree holding a `.env`. Show the idle
case red with `HAND_MADE_IDLE_MS` ignored.

`Value: protects=a hand-made worktree being removed only when merged, clean, idle a day and unused, with its
branch kept, its only-here files saved and a working Undo; fails_when=a worktree in use or touched today is
removed, a branch is deleted, a `.env` goes unsaved by the rule or by the Remove answer, or Undo overwrites what
is at the path; why_new=git worktrees; no_claim=10db's own worktrees or the Spotlight card`.

**Spec:** "3.2" item 4 in the inbox-cards spec; the "Merged hand-made worktree" row of "3. The decision-rights
table" in the what-reaches-the-builder spec;
`decisions/2026-11-17-hand-made-worktrees-are-offered-for-removal-and-kept-out-of-spotlight.md`, which the new
decision file amends.
