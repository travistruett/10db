# A stuck run restarts once by itself, and worktree leftovers are saved and removed

Size: Core (recovery, git worktrees, data loss). Six tasks, built in order 1 → 6, each after its predecessor has
merged. Stage 6 of `docs/superpowers/specs/2026-11-27-what-reaches-the-builder-design.md` (§9; the "Stuck run",
"Merged hand-made worktree" and "Kept worktree…" rows of §3; §5); it builds stages F3 and F4 of
`docs/superpowers/specs/2026-11-27-inbox-cards-that-mean-something-design.md` (§3.2 items 3, 4 and 5).
Status: designed, not built. This pull request holds the plan only.

## Brief

**What changes for the builder.** Three cards stop coming.

- A run that is starting, running or verifying and has shown no activity for 20 minutes is stopped and started
  again from its latest handoff, once, keeping its claims. No card; one row in Activity.
- A second stall of the same step, or a stop that has not finished in 2 minutes, raises the Out of Moves card
  (Spend More Attempts, Change the Task, Drop It). When 10db's own part stalled (the run never started, has no
  lane, its gate ran past its limit, or its stop hung), a defect task is filed in 10db's project first and the
  card names it.
- A hand-made worktree whose pull request merged, that is clean, unlocked, idle for 24 hours and has no process in
  it, is removed. Its branch stays, and an ignored file only it holds (a hand-made `.env`) is saved under
  `~/.10db/kept/` first. The Activity row has an Undo that puts the worktree and those files back.
- A finished 10db worktree that holds files found nowhere else has them copied to `~/.10db/kept/<name>/`, each
  copy checked by size and hash, and is then removed. Files with an identical copy in the project's checkout, and
  files a tool writes again, are not saved.
- Ask Me Next Time on any of these rows brings back today's card for that project.

**What it buys.** 30 Stuck cards, 48 merged-worktree cards and the kept-worktree share of 8 in the spec's 7-day
count. Removing a worktree stops being a one-way door.

**What could go wrong, and how we'd know.**

- A run restarted while it was working. The rule is the Stuck card's own (20 minutes, a growing gate log counts as
  activity), and committed work and the handoff survive a restart. A restart row for a run whose session wrote
  inside those 20 minutes is the bug.
- A restart loop. One restart per step, charged to the run's recovery attempts; more than one restart row for one
  step without a card is the bug.
- A stop that hangs. The runner stops a run once at a time, whoever asks (the sweep or a card's answer), and a
  stop past its deadline ends in the card.
- A `.env` removed unsaved by the card's Remove answer. Only the rule lists a worktree that holds one, and it
  saves first; the ask-mode card and its answer keep today's listing, which leaves such a worktree out.
- A file lost with a worktree. Nothing is removed until every copy has the same size and SHA-256 as its source; a
  copy that fails leaves the worktree and today's card.
- A worktree removed while in use. Checked again in the job that removes it: lock, changes, 24 hours, `lsof`.

**Calls the builder might disagree with.**

1. Defect-or-card is a rule: a second stall always raises the card. Criterion 2's "unless its diagnosis files a
   10db defect" is met by the card naming the defect, not by silence, because a stuck run holds a lane, its claims
   and maybe a gate slot. The decision file records it.
2. Undo is `final` for the restart (a session can't be un-stopped) and for a removed 10db-made worktree (its files
   are in the kept folder; the worktree is not made again). Only a hand-made removal has an Undo that acts.
3. A restart spends one of the run's recovery attempts, not a budget of its own (spec §5). A run with none left
   gets the card instead.
4. Only active runs restart. A queued run or a batch that is stuck keeps today's Stuck card: a restart moves
   neither.
5. An abandoned batch's uncommitted changes are saved as the changed and untracked files themselves, not as a
   patch. A deleted file leaves nothing to save.
6. `~/.10db/kept/` is never pruned by 10db. A follow-up adds a size line to Settings.
7. Hand-made worktrees are looked at with the existing look, at most every six hours, so "idle 24 hours" can be
   30.
8. "Idle" is read from the worktree's git admin files, its root and its top-level entries, not every file under
   it (#953 §3.2 item 4 says "no file under it"): a walk of each `node_modules` is the load the removal is there to
   end.

**Known limits.** A worktree 10db can't read (`unreadable`), one git won't trust, and the Spotlight card stay as
they are. A second stall leaves the run holding its lane until the card is answered; a follow-up parks it.

**Needed from the builder:** nothing. No guardrail file changes and there is no migration.

## Global Constraints

- `.claude/rules/code-style.md` and `.claude/rules/testing.md`. No migration: state lives in `app_settings`, read
  through zod, written only by the functions below. Contract changes are additive: three `DecisionRule`s, each
  with its `DECISION_RULE_NAMES` entry, and one `UndoAction` kind; `packages/contracts/generated` is regenerated
  by the package's script, never by hand.
- Every stall ends in a notice or a card, a hung stop included.
- One write per move: the requeue, the restart's record and its notice commit together, under the row's fence.
- Nothing is removed before what it alone holds is copied and verified. Kept folders are mode 0700; a saved file
  keeps its mode. A symlink is saved as a link, never followed.
- With `isRuleAsking(db, projectId, rule)` true, today's card is raised, unchanged.
- Hand-made worktrees are touched only through `handMadeScope` (`git.ts`); 10db never deletes a branch here.
- Notice lines and bodies are sentence case; card labels are Title Case.
- The decision is
  `docs/architecture/decisions/2026-11-27-a-stuck-run-restarts-once-and-worktree-leftovers-are-saved-then-removed.md`.

## Provider parity

The rules, records, copies and notices are 10db's own and the same on a Claude plan, Claude through Bedrock or an
API key, and a ChatGPT/Codex plan. A restart stops the lane through `Runner.stop`'s path and starts it with
`continue_from_handoff`, which both adapters serve. Nothing here asks the judge.

## Interfaces

```ts
// packages/contracts/src/activity.ts (additive)
DecisionRule.StuckRun = 'stuck-run'; // 'A stuck run, restarted once from its handoff'
DecisionRule.MergedWorktree = 'merged-worktree'; // 'A merged hand-made worktree, removed with its branch kept'
DecisionRule.WorktreeLeftovers = 'worktree-leftovers'; // 'A finished worktree’s files, saved before it was removed'
// UndoAction gains:
z.strictObject({
  kind: z.literal('restore_worktree'),
  projectId: ProjectId,
  path: z.string().min(1),
  branch: z.string().min(1),
  keptDir: z.string().min(1).nullable(),
});

// apps/daemon/src/stalls/rules.ts
export const StallKind = { Queued: 'queued', Batch: 'batch', Active: 'active' } as const;
// Stall gains `readonly kind: StallKind`.

// apps/daemon/src/stalls/restart-rule.ts (pure)
export const STALL_STOP_DEADLINE_MS = 2 * 60_000;
export const StallFault = {
  NoLane: 'no_lane', // Running or Verifying with no live lane
  GatePastLimit: 'gate_past_limit',
  NeverStarted: 'never_started', // still Starting
  StopHung: 'stop_hung',
} as const;
export const StallMove = { Card: 'card', Restart: 'restart', Wait: 'wait', OutOfMoves: 'out_of_moves' } as const;
export function stallMove(input: {
  readonly asking: boolean; // isRuleAsking(StuckRun)
  readonly kind: StallKind;
  readonly inFlight: boolean; // Runner.isRestarting: a restart of this run has not returned
  readonly restarted: boolean; // a record exists for this run
  readonly stopHung: boolean; // its record has stopHungAt
  readonly recoveryLeft: boolean; // recoveryAttempts < maxRecoveryAttempts
  readonly fault: StallFault | null; // null: the session went silent, which is not 10db's defect
}): { readonly move: StallMove; readonly fileDefect: boolean };

// apps/daemon/src/stalls/restart-record.ts
export const STALL_RESTARTS_KEY = 'stall_restarts';
export const StallRestart = z.object({
  workstreamId: WorkstreamId,
  restartedAt: z.iso.datetime().nullable(), // null: no restart was made (the stop hung, or no attempts were left)
  state: z.enum(WorkstreamState), // the state it stalled in
  stopHungAt: z.iso.datetime().nullable(),
  defectTaskId: TaskId.nullable(),
});
export function readRestart(db: DbReader, id: WorkstreamId): StallRestart | null;
// Replaces the run's record with a fresh one: stopHungAt and defectTaskId null.
export function recordRestart(w: WriteContext, input: { id: WorkstreamId; state: WorkstreamState; at: string }): void;
// markHung and markDefect set their field, and make the record (restartedAt null) when the run has none.
export function markHung(w: WriteContext, input: { id: WorkstreamId; state: WorkstreamState; at: string }): void;
export function markDefect(w: WriteContext, input: { id: WorkstreamId; state: WorkstreamState; taskId: TaskId }): void;
export function clearRestart(w: WriteContext, id: WorkstreamId): void; // the restarted step finished
export function forgetEndedRestarts(w: WriteContext): void; // drops records of terminal runs

// apps/daemon/src/runner/runner.ts
export type StopReason = 'cancelled' | 'paused' | 'shutdown' | 'closed' | 'stalled';
interface Runner {
  // One restart per run at a time: a call while one is in flight answers that one's promise and stops nothing.
  restartStalled(
    id: WorkstreamId,
    opts?: { note?: string; deadlineMs?: number },
  ): Promise<'restarted' | 'stop_hung' | 'not_active'>;
  isRestarting(id: WorkstreamId): boolean; // a restartStalled call for this run has not returned
}

// apps/daemon/src/inbox/out-of-moves-card.ts (stage 4 task 3 made it)
OutOfMovesKind.Stall = 'stall';

// apps/daemon/src/delivery/kept-files.ts
export const KEPT_DIR_MODE = 0o700;
export function keptRoot(): string; // join(homedir(), '.10db', 'kept'), beside DEFAULT_WORKTREE_BASE
export function isRewritten(file: string): boolean; // build-output's table plus next-env.d.ts and .DS_Store
export async function onlyHere(input: {
  readonly worktree: string;
  readonly checkout: string;
  readonly files: readonly string[]; // worktree-relative
}): Promise<string[]>; // those not rewritten and with no identical file at the same path in the checkout
export async function saveKept(input: {
  readonly root: string;
  readonly name: string; // the batch's id, or a slug of the worktree's folder name
  readonly worktree: string;
  readonly files: readonly string[];
  readonly at: Date;
}): Promise<{ readonly dir: string; readonly saved: readonly string[] }>; // throws KeptCopyError; removes nothing

// apps/daemon/src/git/git.ts, beside removeHandMadeWorktree
restoreHandMadeWorktree(repo: string, path: string, branch: string): Promise<'restored' | 'path_exists' | 'branch_gone'>;
handMadeWorktreeIdleSince(repo: string, path: string): Promise<Date>; // newest mtime: admin files, root, top level

// apps/daemon/src/delivery/hand-made-worktrees.ts
export const HAND_MADE_IDLE_MS = 24 * 60 * 60_000;
// Merged, carried, unlocked and clean, with the ignored files that are not build output. Only the rule calls it.
export interface MergedHandMadeCandidate extends MergedHandMade { readonly loose: readonly string[] }
export async function mergedHandMadeCandidates(ctx: DeliveryContext, project: ProjectDto, signal: AbortSignal): Promise<MergedHandMadeCandidate[]>;
// Signature and meaning unchanged: the candidates with no loose file. The merged card and its Remove answer call it.
export async function mergedHandMadeWorktrees(ctx: DeliveryContext, project: ProjectDto, signal: AbortSignal): Promise<MergedHandMade[]>;
export async function removeIdleMergedHandMade(ctx: DeliveryContext, project: ProjectDto, signal: AbortSignal): Promise<string[]>;

// apps/daemon/src/inbox/activity-actions.ts
interface UndoMoves {
  restoreWorktree(action: Extract<UndoAction, { kind: 'restore_worktree' }>): void; // throws ConflictError
}
```

## State table (design, not a test list)

`stallMove` checks in this order; the first row that matches wins.

| #   | Case                                        | Move                                                |
| --- | ------------------------------------------- | --------------------------------------------------- |
| 1   | `asking`, or `kind` is not `active`         | `card` (today's Stuck card)                         |
| 2   | `inFlight`                                  | `wait`                                              |
| 3   | not `restarted`, not `stopHung`, `recoveryLeft` | `restart`                                       |
| 4   | anything else                               | `out_of_moves`; `fileDefect` when `fault` is set    |

| Event                                         | What 10db does                                                                                                                                                                    |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `restart`, the stop ends in time              | The lane stops as `stalled` (its gate aborted) and writes no state itself. One fenced write requeues with `freshAction`, claims kept, `recoveryAttempts + 1`, the record, a notice. |
| `restart`, the deadline passes                | `stop_hung`: one write marks `stopHungAt` and raises the Stall card with fault `StopHung`. A stop that finishes later changes nothing.                                             |
| `restart`, no live lane                       | The fenced write: a row no longer active answers `not_active` (no notice, no charge); else Running → Recovering → Queued, as recovery does.                                        |
| The restarted step finishes                   | `clearRestart`, where the runner resets `recoveryAttempts`. A later step's stall restarts once again.                                                                             |
| `out_of_moves`                                | When `fileDefect`: `fileDefect` with signature `stall:<fault>:<state>`. The Stall card names the defect task, or says the report could not be filed. The run is left as it is.      |
| Stall card: Spend More Attempts               | `restartStalled`, whose write replaces the record. `stop_hung` throws, so the card and the record stay. A sweep during the stop sees `inFlight` and waits.                        |
| Stall card: Change the Task                   | Refused without a note; with one, the same with the note in the next brief.                                                                                                       |
| Stall card: Drop It                           | Cancels the run, as Cancel Run does today.                                                                                                                                        |
| The run moves, or ends                        | The card closes by `stall_cleared`; `forgetEndedRestarts` drops a terminal run's record.                                                                                          |
| The daemon restarts during a stop             | The runner's in-flight set is gone and no record was written: startup recovery requeues the run, and the one restart is not spent.                                                |
| A merged hand-made worktree, idle 24 h        | In the project's ship queue: listed again by `mergedHandMadeCandidates`, no process in it (`lsof`), its loose ignored files that are `onlyHere` saved and verified, then removed. One notice per worktree with Undo `restore_worktree`. Any doubt or a failed copy: left, no card. |
| The merged card and its Remove answer         | List with `mergedHandMadeWorktrees`, as today: a worktree holding a loose ignored file is neither offered nor removed.                                                            |
| Undo on a hand-made removal                   | Path free and branch exists: `git worktree add`, then the kept files copied back with their modes; the kept folder stays. Else `ConflictError`, nothing changed.                   |
| A finished worktree with files only it holds  | `onlyHere` → `saveKept` (verified) → removed as Remove Worktree does. One notice, Undo `final`. Nothing only it holds: removed, no notice beyond today's log.                      |
| A copy fails, or the worktree is `unreadable` | Nothing is removed; today's card.                                                                                                                                                 |

## Tracks and tasks

One track; each task is one pull request and a fresh implementer.

1. `task-1.md`: the rule and the contracts. `stallMove`, `StallKind`, the three rules, `restore_worktree`.
2. `task-2.md`: the restart. `restartStalled` and its in-flight set, the record, the sweep's call, the notice.
3. `task-3.md`: the second stall. The defect, the Stall card and its answers. Needs stage 4 task 3 merged
   (`out-of-moves-card.ts`); if it has not, tasks 4 to 6 are built first.
4. `task-4.md`: saving files. `kept-files.ts`, nothing calls it yet.
5. `task-5.md`: a finished worktree is saved from and removed.
6. `task-6.md`: an idle merged hand-made worktree is removed, with its Undo.

Follow-ups, filed when they are met: a second stall stopping the run and freeing its lane and gate slot (needs a
parked state); the size of `~/.10db/kept/` in Settings; saving from a worktree 10db can't read; the daily ceiling
(spec stage 11) counting restarts.
