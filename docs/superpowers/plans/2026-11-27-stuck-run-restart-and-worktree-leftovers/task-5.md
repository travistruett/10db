# Task 5: a finished worktree's leftovers are saved, then it is removed

Read the index's Brief and Global Constraints first. Size: Core (data loss, git worktrees). Starts after task 4
has merged (and task 1, for `DecisionRule.WorktreeLeftovers`).

**Files:**

- `apps/daemon/src/delivery/worktree-cleanup.ts`: `retire` saves and removes where it raises `keptDirty` and
  `keptIgnored` today.
- `apps/daemon/src/delivery/worktree-sweep.ts`: the orphan and chat-worktree paths that raise `orphanKept` (with
  readable changes) and `orphanIgnored` do the same.
- `apps/daemon/src/delivery/notices.ts`: `worktreeNotices.savedAndRemoved`.
- `apps/daemon/src/delivery/context.ts`: `DeliveryContext.keptRoot` (default `keptRoot()`), and the same on
  `SweepDeps`, so a test names a temp directory. `apps/daemon/src/daemon/start.ts` passes it.
- `apps/daemon/src/delivery/worktree-ship.test.ts`: extended. `apps/daemon/src/delivery/AGENTS.md`.

**Calls**, exactly: `onlyHere`, `saveKept`, `KeptCopyError` (task 4); `isRuleAsking`, `post`, `raise`,
`removeWorktreeAndSettle`, `unseededIgnoredFiles`, `changedPaths`.

**One helper**, `saveLeftovers(ctx, project, { name, path, changed, ignored })`, used by both files:

- `asking` (`isRuleAsking(db, project.id, DecisionRule.WorktreeLeftovers)`): answers `'ask'`; the caller raises
  today's card.
- The candidates are the unseeded ignored files and, for an abandoned batch or an orphan, the changed paths that
  still exist as files (`changedPaths` lists modified, added and untracked; a deleted one has nothing to save).
- `onlyHere` against the project's checkout, then `saveKept` when any is left. `name` is the batch's id for a
  batch's worktree and the worktree folder's name for an orphan.
- `KeptCopyError`, or any other error from the copy: logged, answers `'ask'`. Nothing was removed.
- Answers `{ dir, saved }` (`dir` null when nothing needed saving).

**The callers.** After a save, or with nothing to save, the worktree is removed on the path Remove Worktree takes
today (`removeWorktreeAndSettle` for a batch; `git.removeWorktree` and the pin's cleanup for an orphan), which
already withdraws the kept cards. `unreadable` (ignored is null) and `untrusted` are not touched: today's card and
log line. The `discard` path of the builder's own answer is unchanged.

**The notice**, only when something was saved: `tier: CardTier.Notice`, the project's, key
`worktree-saved:<path>`, `decision: { by: Rule, rule: WorktreeLeftovers, confidence: null, undo: { state: 'final',
reason: 'The files are in the kept folder; the worktree is not made again.' } }`.

- Line: `Saved <n> file(s) from a finished worktree and removed it`.
- Body: the worktree's path, the kept folder, the files (`listPaths`, cut as cards cut it), and that files with an
  identical copy in the checkout were not saved.

**State-table rows:** "A finished worktree with files only it holds", "A copy fails, or the worktree is
`unreadable`".

**Test.** Extend the kept-worktree case of `worktree-ship.test.ts` (a real git repository in a temp directory,
`createDeliveryHarness`): a shipped batch's worktree holding a hand-made `.env`, an ignored file identical to the
checkout's, and a `.tsbuildinfo` is removed; `.env` is under the temp kept root with its content and mode, the
other two are not; one notice with rule `worktree-leftovers` and no Inbox item exist. With the kept root made
unwritable the worktree stays and the `keptIgnored` card is raised. With the rule set to ask, the card is raised
and nothing is copied. Show the first red with `saveLeftovers` answering `'ask'` always.

`Value: protects=a finished worktree being removed only after its only-here files are saved and verified;
fails_when=a worktree is removed with an unsaved file, kept when it holds nothing of its own, or a failed copy
removes it; why_new=git worktrees and data loss; no_claim=hand-made worktrees or unreadable ones`.

**Spec:** "3.2" item 3 in the inbox-cards spec; the "Kept worktree…" row of "3. The decision-rights table" in the
what-reaches-the-builder spec.
