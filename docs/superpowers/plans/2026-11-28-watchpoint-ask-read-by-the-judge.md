# A watchpoint set to Ask is read by the judge first, and holds the pull request only on a finding

Size: Core (git merges, the shipper, recovery). Four tasks, built in order 1 → 2 → 3 → 4, each after its predecessor
has merged; task 3 is Feature. Stage 9 of `docs/superpowers/specs/2026-11-27-what-reaches-the-builder-design.md`, and
S5 of `docs/superpowers/specs/2026-11-25-watchpoints-design.md`. Status: designed, not built. This pull request holds
the plan only, and no task changes a guardrail file.

## Brief

**What changes for the builder.**

- A watchpoint can be set to Hold. A change that hits one opens its pull request with no auto-merge and raises the
  task's Look card with Merge on it. Nothing merges it until the builder does.
- A hit on a watchpoint set to Ask is read by the judge against the watchpoint's guidance. A clean read is a notice
  in For You and no card. A finding, a doubt or a destructive migration holds the pull request, as Hold does.
- For its first week the read runs in shadow: every Ask hit is today's card, and Settings › Decisions shows how
  often the read agreed with the answer.

**What it buys.** Fewer Look cards (the spec counts 32 a week), and the ones left arrive before the merge, not after.

**What could go wrong, and how we'd know.**

- A held pull request is armed by a later ship, catch-up, merge retry or restart. Every arming site reads one seam,
  and the hold is derived from stored readings and answers; task 2's test drives each.
- A held pull request is left with no card. The seam raises the card again whenever a held task has none.
- The judge reads a bad change as clean. A clean read still forces Review; the shadow week counts clean reads the
  builder sent back, and one of them keeps the read from acting until the builder says so.
- Main's changes hold a pull request. Readings are taken by the runner over a run's own commits only.

**Calls the builder might disagree with.**

1. With no judge ready, and during the shadow week, an Ask hit is today's card and holds nothing.
2. Send Back on a held card closes the pull request, the goal's other tasks in it included, and files a task with
   the note. Fixing into the same pull request is a follow-up.
3. One card per task, as today. A goal's tasks share a pull request, so each card names the tasks waiting.
4. Merge approves the diff it showed, by hash. A later change to those files holds again.
5. "Is this destructive" is asked of every Ask hit, not only of migrations.
6. A Workbench pass's pull request and a landing into a local copy are not held; the card says so. A follow-up.
7. The read acts after 7 days if no clean read was sent back; otherwise one card asks whether to let it.

**Needed from the builder:** nothing.

## Global Constraints

- `.claude/rules/code-style.md` and `.claude/rules/testing.md`. No migration: the hold is derived from stored
  watchpoint readings and answered cards. Contract changes are additive, except `notHold`, which task 3 removes.
- Only a hit in `detail.hits` (a glob or line match) holds. `reads` and `shadow` without a hit never hold, and a
  loudness Hold hit holds with no judge call.
- A reading is taken by the runner (`watchpointReadingAfter`) over the run's own commits. A catch-up takes none.
- `guardrail-hold.ts` is unchanged; the guardrail hold and the watchpoint hold meet only in `heldForBuilder`.
  `turnOnAutoMerge` and `mergeNow` stay delivery's only callers of `gh.prAutoMerge` and `gh.prMerge`.
- Held always means a card is open, a restart included.
- Labels are Title Case; bodies are sentence case. No task changes a guardrail file of this repository.

## Provider parity

The hold, its card and Merge are 10db's own and identical on a Claude plan, Claude through Bedrock or an API key, and
a ChatGPT/Codex plan. The read needs `judge.ready(JudgeDecision.WatchpointRead)`: an account decisions run on, or
stage 12's session judge. With neither, row 3 of `readVerdict` applies (today's card, no hold) and the Decisions row
says the read is not running. Stage 12 closes that gap.

## Interfaces

```ts
// packages/contracts/src/judge.ts
JudgeDecision.WatchpointRead = 'watchpoint_read'; // floor 0.8

// packages/contracts/src/watchpoint-hit.ts (all additive)
export const WatchpointReadVerdict = {
  Clean: 'clean',
  Finding: 'finding',
  Doubt: 'doubt',
  Destructive: 'destructive',
  Hold: 'hold',
  Unread: 'unread',
} as const;
export const WatchpointRead = z.object({
  key: z.string(),
  verdict: z.enum(WatchpointReadVerdict),
  meets: z.number().min(0).max(1).nullable(), // probability the hunks meet the guidance
  destructive: z.number().min(0).max(1).nullable(),
  acted: z.boolean(), // false: asked in shadow, and nothing acts on it
});
// WatchpointDetail gains `reads: z.array(WatchpointRead).optional()`; WatchpointHit gains `hash: z.string().optional()`
// WatchpointChoice gains `Merge: 'merge'`
// WatchpointCardDetail gains `held: { batchId, prUrl: string | null }` (optional) and, per watchpoint, optional
// `verdict` and `hash`

// apps/daemon/src/watchpoints/read.ts
export function readVerdict(input: {
  readonly loudness: WatchpointLoudness;
  readonly asked: boolean; // false: no judge was ready
  readonly answered: boolean;
  readonly meets: number | null;
  readonly destructive: number | null;
  readonly partial: boolean; // the judge was not shown every hunk
  readonly floor: number;
}): WatchpointReadVerdict | null; // null: not read (Show)
export function readWatchpointHits(
  deps: { judge: Judge; read: QuestionDiffReader }, // the shapes question.ts uses
  hits: readonly WatchpointHit[],
  ids: { projectId: ProjectId; workstreamId: WorkstreamId },
): Promise<WatchpointRead[]>;

// apps/daemon/src/watchpoints/read-agreement.ts
export function watchpointReadAgreement(
  db: DbReader,
  projectId: ProjectId | null, // null: every project
): { firstAskedAt: Date | null; scored: number; agreed: number; cleanButSentBack: number };
export function readActs(input: {
  readonly firstAskedAt: Date | null;
  readonly cleanButSentBack: number;
  readonly allowed: boolean | null; // the builder's answer to the card; null: never asked
  readonly now: Date;
}): { readonly acts: boolean; readonly ask: boolean };

// apps/daemon/src/delivery/watchpoint-hold.ts
export function holdsMerge(verdict: WatchpointReadVerdict): boolean; // finding, doubt, destructive, hold
export function watchpointHoldOf(
  db: DbReader,
  root: BatchDto,
): { held: boolean; waiting: { workstreamId: WorkstreamId; taskTitle: string; labels: string[]; cardOpen: boolean }[] };

// apps/daemon/src/delivery/ship.ts (inside the shipper)
function heldForBuilder(
  batch: BatchDto,
  checkout: string,
  head: string | null,
): Promise<{ guardrail: GuardrailReading; watchpoints: ReturnType<typeof watchpointHoldOf>; held: boolean }>;

// apps/daemon/src/delivery/guardrail-hold-card.ts
export function closeHeldPullRequest(ctx: DeliveryContext, rootId: BatchId, prUrl: string): void; // today's `close`
```

## State table (design, not a test list)

`readVerdict`, first match wins:

| #   | Case                                                  | Verdict       |
| --- | ----------------------------------------------------- | ------------- |
| 1   | loudness Hold                                         | `hold`        |
| 2   | loudness Show                                         | null          |
| 3   | Ask, not asked (no judge ready)                       | `unread`      |
| 4   | no answer (a fallback, a refusal, a timeout)          | `doubt`       |
| 5   | a partial read                                        | `doubt`       |
| 6   | `destructive >= floor`                                | `destructive` |
| 7   | `meets <= 1 - floor`                                  | `finding`     |
| 8   | `meets >= floor` and `destructive <= 1 - floor`       | `clean`       |
| 9   | otherwise                                             | `doubt`       |

A read stored with `acted: false` (shadow) keeps its verdict for the agreement count, and everything that acts treats
it as `unread`.

`readActs`, first match wins:

| #   | Case                                             | Result                       |
| --- | ------------------------------------------------ | ---------------------------- |
| 1   | `allowed === true`                               | acts                         |
| 2   | `allowed === false`                              | shadow                       |
| 3   | `firstAskedAt === null`, or less than 7 days old | shadow                       |
| 4   | `cleanButSentBack > 0`                           | shadow, and `ask` (one card) |
| 5   | otherwise, with zero scored reads too            | acts                         |

`watchpointHoldOf(db, root)`:

- It reads the workstreams whose commits `ship.ts` merges into the branch of the root and its CI-fix batches. A
  cancelled, removed or left-out workstream does not hold, and its held card is withdrawn in that write.
- For each, the newest watchpoint reading with `skipped === null` that parses. No readable reading: no match, so no
  hold; a later unreadable or skipped reading never releases an earlier one.
- A hit holds when its loudness is Hold, or its `reads` entry has `acted: true` and `holdsMerge(verdict)`.
- A holding hit is released by an answered Look card of that workstream with Merge whose entry for the watchpoint
  carries the hit's `hash`. A hit with no hash is never released by an earlier Merge.

| Moment                                               | What happens                                                                                  |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| A run's reading has a holding hit, landing by PR      | The Look card carries `held` and Merge, Send Back; raised at run time, before the ship        |
| The same, no landing to hold (pass, local copy)      | Today's card (Looks Right, Send Back, no `held`); a Hold hit adds "This landing can't be held yet, so the change may already be merged." |
| `held` at ship (before the push, and step 4b)        | `prDisableAutoMerge` before a push to an open pull request; no `prAutoMerge`, no `prMerge`    |
| `held` in `catchUpSteps`, `retryMerge`, `armApproved` | Not armed, refused                                                                            |
| Held, a waiting workstream with no open card         | `ensureHeldCard` raises it again, with the pull request's URL                                 |
| Merge                                                | The answer is the release; after the write, `armApproved` reads the seam and arms if nothing else holds |
| Merge before the pull request exists                 | Recorded; the ship finds the hit released and arms as it does today                           |
| A later run changes a held file                      | A new hash: held again, the card raised afresh                                                |
| Send Back, held, pull request open                   | Follow-up filed with the note, the URL and the branch; `dropped: true`; then the pull request is closed |
| GitHub refuses the close                             | `dropped: false`; still held; the could-not-close card is open                                |
| Send Back, held, before the pull request exists      | Follow-up filed; the hit stays unreleased; the ship opens the pull request held and raises the card again. A second Send Back files a second follow-up naming the first |
| Send Back, not held                                  | As today                                                                                      |
| The pull request merged or closed                    | The root's open Look cards carrying `held` are withdrawn; others stay                         |
| A catch-up merges main's watched files               | No reading, no hit, no hold                                                                   |
| A restart                                            | Nothing to restore: the next read of the seam derives the same hold and ensures the card      |

## Tracks and tasks

One track; each task is one pull request and a fresh implementer.

1. `task-1.md`: contracts, `readVerdict`, the hit hash, the read in shadow, the agreement count.
2. `task-2.md`: the hold for loudness Hold: `watchpoint-hold.ts`, the seam in `ship.ts`, Merge and Send Back.
3. `task-3.md` (Feature): the card's Merge in the app, Hold offered in Settings, the Decisions row.
4. `task-4.md`: the read acts: `readActs`, clean reads without a card, findings held, the disagreement card.

Criteria: 1 by task 4; 2 by tasks 2 and 4; 3, 4 and 6 by task 2; 5 by tasks 1 and 2.

Follow-ups filed with this plan: the hold for a pass's pull request and a local-copy landing; Send Back that fixes
into the same pull request. Out of scope: letting S3b's watchpoint question act.
