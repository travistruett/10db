# Task 1: the stall rule and the contracts

Read the index's Brief and Global Constraints first. Size: Core (recovery; a pure rule table). Nothing calls the
rule yet, so nothing changes for the builder.

**Files:**

- New `apps/daemon/src/stalls/restart-rule.ts`: `STALL_STOP_DEADLINE_MS`, `StallFault`, `StallMove`, `stallMove`.
- `apps/daemon/src/stalls/rules.ts`: `StallKind`, and `kind` on `Stall` (`queued` for a queued run's stall,
  `batch` for both batch stalls, `active` for the last loop's). `kind` is not part of `fingerprint`.
- New `apps/daemon/src/stalls/restart-rule.test.ts`.
- `packages/contracts/src/activity.ts`: `DecisionRule.StuckRun`, `.MergedWorktree`, `.WorktreeLeftovers` with
  their `DECISION_RULE_NAMES`; the `restore_worktree` member of `UndoAction`.
- `packages/contracts/generated/`: regenerated with the package's script (see `packages/contracts/AGENTS.md`).
- `apps/daemon/src/inbox/activity-actions.ts`: `UndoMoves.restoreWorktree` and its `perform` case, so the switch
  stays exhaustive. `apps/daemon/src/daemon/start.ts`: wire it to throw `ConflictError('This worktree can’t be put
  back yet')` until task 6 replaces it. No notice carries the action before task 6.
- `apps/daemon/src/stalls/AGENTS.md`: one line on the rule.

**Implements** (index, Interfaces), exactly: the `activity.ts` block, `StallKind`, the `restart-rule.ts` block.

**State-table rows:** the four rows of `stallMove`. `fileDefect` is true only on row 4 with `fault` set.

**Watchpoint.** `packages/contracts/**` is one the builder reads: the commit's note says each change is additive
(three enum values, one union member) and that nothing reads `restore_worktree` yet.

**Test.** `restart-rule.test.ts`, one table over the four rows, each input chosen so that only its row can match:
asking or a queued kind → `card`; in flight → `wait`; fresh with attempts left → `restart`; restarted, hung, or
no attempts left → `out_of_moves`, with `fileDefect` following `fault`. Show it red first with rows 2 and 3
swapped.

`Value: protects=the order in which a stalled run is carded, waited on, restarted or sent up; fails_when=a run is
restarted twice, restarted while a restart is in flight, or restarted when the rule is set to ask;
why_new=recovery (a pure rule table); no_claim=that the sweep calls it or that a restart works`.

**Spec:** "9. Stages" row 6 and the "Stuck run" row of "3. The decision-rights table" in the
what-reaches-the-builder spec; "3.2 What 10db does instead of asking" item 5 in the inbox-cards spec.
