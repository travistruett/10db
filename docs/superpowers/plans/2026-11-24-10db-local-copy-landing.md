# Plan: local copy landing (the pilot)

**Size:** Core (git, recovery, sandbox). It moves the builder's base branch and writes their folder, and it adds a
journal that recovery acts on. It gets this index, one card per task and a plan review. Card 8 (Settings, the
placement control, the e2e and docs) is Feature-sized inside it and gets no process of its own.
**Spec:** `docs/superpowers/specs/2026-11-24-10db-local-copy-landing-design.md` (revision 2 plus both round-2
fixes, `71362b9b`). Cards name its sections by number and heading.
**Builds on:** `main` after #813 and 10db-2b's lane-env work land. The coordinator re-checks both before card 1.

## Brief

**What changes for you.**

- In a local-delivery project with **Separate copies** on (Settings › Delivery), a task's placement control offers
  **Separate copy**. That task works in its own branch and folder, and Ampsio's make targets give it its own
  databases through `TENDB_COPY_ID`.
- When review accepts it, 10db merges `build` into the copy, runs the full gate there, and fast-forwards `build`
  and your folder to the gated commit, only when your folder has no edits where it writes. Otherwise it waits with
  one card.
- After landing: a card if the landing brought migrations, the after picture and Slack post as today, then the
  copy's teardown command drops its databases and the copy goes.

**What it buys.** The pilot the brief asked for: work that fails review never reaches `build`, and the numbers that
decide parallel copies, the broker and the presets.

**What could go wrong, and how we'd know.**

- **Your folder is written wrongly.** Only `Git.promoteFastForward` writes it: one lock, fast-forward only, bound to
  T and C (card 2). Its real-repository tests and the classifier's table test (card 2) cover every outcome.
- **A crash leaves a landing half done.** The journal (card 1) and the classifier (card 2) decide; recovery
  (card 6) never writes the folder except the one compare-and-swap of row D.
- **A copy's commands reach your folder's databases.** `TENDB_COPY_ID` comes only from the journal, set last by
  one function in all four command builders (card 3). Its wiring test checks Claude, Codex, MCP and the gate.
- **A copy task starts in your folder.** Start routes by placement and the scheduler checks the pinned batch
  (card 4). The e2e (card 8) runs the whole path through the real daemon.

**Calls you might disagree with.**

1. **The journal row is the pin.** Batches don't record their delivery. A batch is a local copy exactly when it has
   a `local_copies` row, written in the cut's own insert. Cost if wrong: none found; a batch can't gain or lose the
   row later.
2. **One dev migration** adds the `local_copies` table and two project columns, regenerated after the final merge
   of `main` (`packages/db/AGENTS.md`).
3. **Waits recheck on a one-minute timer only.** The spec also names folder-watcher events; the watcher reports
   writes, not HEAD or ref moves, so the timer is the one contract. Cost if wrong: a landing starts up to a minute
   late.
4. **The Ampsio side is filed as an Ampsio task** once this plan's PR is open, not built here. The pilot can't run
   until both are in.
5. **A second copy task is refused at start, not queued** (spec §2 says queued): "Another task is in a separate
   copy (<title>); start this one when that one ships or is abandoned." A queued task with no batch would launch
   in your folder. Cost if wrong: you start the second task again by hand.
6. **A copy task skips the full gate before Done** (`finalCheck`); its step checks still run, and the landing's gate,
   bound to C, is the one. Otherwise Ampsio's 18-minute gate runs twice per task. Cost if wrong: review reads work
   the gate hasn't passed yet; a gate failure at landing goes to today's fix loop.

**Deviations from the spec**, all recorded here so review doesn't reopen them: calls 3, 5 and 6; `CopyWait` has no
`conflict` (a conflict returns the batch to OPEN with today's merge-fix notice, spec §5 step 2); card 2's race test
holds a ref lock instead of injecting a commit (the daemon runs git with no hooks), and the hand-commit case is
the classifier's row G.

**What is needed from you.** Nothing.

---

## Global Constraints

- Read `AGENTS.md`, `.claude/rules/code-style.md`, `.claude/rules/testing.md` and the `AGENTS.md` of every directory
  you touch, once each. Keep notes in your scratch folder.
- **Integration branch** `feat/local-copy-landing`, a draft PR from the first push. Each card runs in its own
  worktree `~/Projects/10db-worktrees.noindex/local-copy-<n>`, branched from the integration branch, and the
  coordinator merges it in.
- **The repo typechecks after every card.** Where a later card owns a caller, the earlier card bridges it with the
  smallest shim marked `// TODO(local-copy)`. None may remain when the PR leaves draft.
- **Migrations are forward-only** (`packages/db/AGENTS.md`). Card 1 generates one dev migration so the branch's
  tests run. At each merge of `main`, if `main` added a migration, the coordinator deletes the dev migration (its
  `.sql`, its `drizzle/meta` snapshot and its `_journal.json` entry), takes `main`'s files, runs
  `pnpm --filter @10db/db generate`, and commits the result in the merge. After the final merge of `main` it
  regenerates once more. Only one open PR adds migrations at a time.
- **The journal row is the pin.** `isLocalCopy` is true exactly when the batch has a `local_copies` row, written in
  the CUTTING insert (`delivery/start.ts:578-591`). Every path this plan changes routes on it, never on the
  project's current `delivery` or `localCopies`.
- **Live at promoting.** A journal at `step: promoting` with `wait: null` may have written your folder. While it
  is, `resetLocalCopy` is a no-op, any failure of the batch (the ship catch-all `ship.ts:1296`, `failWith`,
  recovery's `recover.ts:219-227`) is `interrupted_landing` with the journal kept, Abandon is refused, and a new run
  of the task (a builder message, a fix) is refused with "a landing is settling in your folder". A promoting
  journal with a wait set had an outcome that wrote nothing, so none of this applies to it.
- **Your folder is written only by `promoteFastForward` and `finishPromotion`** (card 2). No other card runs
  `read-tree`, `checkout`, `reset`, `update-ref` or `mergeIntoBranch` on the project's checkout for a local copy.
  Neither function is called from inside another `withRepoLock` on the same checkout.
- **A step's journal write comes before its act, and its outcome before the next step's intent** (spec §5).
- **`TENDB_COPY_ID` is set only by `withCopyId`**, from the journal, last (spec §4).
- **Nothing waits on the builder in a loop.** Every wait is a journal `wait`, one card (keyed by batch and wait
  kind, so it is raised once), and a recheck on a minute timer or a watcher event.
- Tests: only those named on a card, each proven red first, each with a value card in its commit. No rendered
  component tests, no test-only exports or branches.
- While working, run `pnpm exec vitest related <files> --maxWorkers=2` in the package, plus typecheck and lint of
  the packages changed. Before you hand back, run `make precheck`. Never the full suite, never `make check-changed`
  (this is an integration branch).
- Commit after every green step, naming paths. Scopes: `daemon`, `desktop`, `contracts`, `db`, `docs`.
- Use the injected `Clock`. Git runs through `Git` (`git/git.ts`) only.
- **Peer ownership.** Before cards 7 and 8 start, the coordinator asks the live sessions (ListAgents) whether anyone
  holds `pictures/pictures.ts`, `apps/desktop/src/views/settings/**` or the task placement control, and waits for
  or clears them.

## Provider parity

The copy, its id, the gate, the landing and recovery are the daemon's, so they behave the same on every account
(spec §10). Only how the id reaches a command differs, and one function sets it for all of them:

| Account                                 | How the lane's commands get `TENDB_COPY_ID`                                         | Card |
| --------------------------------------- | ----------------------------------------------------------------------------------- | ---- |
| Claude plan, Anthropic API key, Bedrock | the env file the sandboxed shell sources; on `ALLOWED_NAMES`, so not a profile deny | 3    |
| ChatGPT/Codex plan, OpenAI API key      | `shellEnv` → `shell_environment_policy.set`                                         | 3    |
| Any (gate, teardown, MCP servers)       | `gate-sandbox.ts` and `mcp-sandbox.ts` command env                                  | 3    |

The pilot's acceptance runs one task on a Claude plan lane and one on a Codex lane (spec §10). API-key and
Bedrock lanes need no different code; they are checked before any preset ships.

## Interfaces

Signatures are exact; cards quote them.

```ts
// packages/contracts/src/local-copy.ts (card 1)
export const CopyStep = {
  Open: 'open', Merging: 'merging', Gating: 'gating', Gated: 'gated',
  Promoting: 'promoting', Landed: 'landed', Retiring: 'retiring', Retired: 'retired',
} as const;
export type CopyStep = (typeof CopyStep)[keyof typeof CopyStep];
export const CopyWait = {
  FolderOffBase: 'folder_off_base', EditsInTheWay: 'edits_in_the_way', IndexLocked: 'index_locked',
  BaseMoving: 'base_moving',
} as const;
export type CopyWait = (typeof CopyWait)[keyof typeof CopyWait];
export const CopyId = z.string().regex(/^[0-9a-f]{12}$/).brand<'CopyId'>();
export type CopyId = z.infer<typeof CopyId>;
export interface LocalCopyDto {
  readonly batchId: BatchId;
  readonly copyId: CopyId;
  readonly step: CopyStep;
  readonly baseTip: string | null;
  readonly candidate: string | null;
  readonly attempt: number;
  readonly wait: CopyWait | null;
  readonly waitDetail: readonly string[];
  readonly retryAt: string | null;
  readonly teardownCommand: string;
  readonly teardownSha: string | null; // set at the OPEN write
  readonly updatedAt: string;
}
// ProjectInput / ProjectDto gain:
//   localCopies: boolean (default false)
//   copyTeardownCommand: string | null (default null; required when localCopies is true)
// BatchFailure gains: InterruptedLanding: 'interrupted_landing', LockfileInCopy: 'lockfile_in_copy',
//   GateChangedCopy: 'gate_changed_copy', GitFilters: 'git_filters'

// packages/db/src/store/local-copies.ts (card 1)
/** The first 12 hex digits of the SHA-256 of the batch id (node:crypto, so it lives in db, not contracts). */
export function copyIdOf(batchId: BatchId): CopyId;
export function insertLocalCopy(
  w: WriteContext,
  row: { batchId: BatchId; teardownCommand: string },
): LocalCopyDto;
export function getLocalCopy(db: DbReader, batchId: BatchId): LocalCopyDto | null;
export function isLocalCopy(db: DbReader, batchId: BatchId): boolean;
export type LocalCopyPatch = Partial<
  Pick<
    LocalCopyDto,
    'step' | 'baseTip' | 'candidate' | 'attempt' | 'wait' | 'waitDetail' | 'retryAt' | 'teardownSha'
  >
>;
export function patchLocalCopy(w: WriteContext, batchId: BatchId, patch: LocalCopyPatch): LocalCopyDto;
/** step open, candidate and wait cleared, attempt 0; a no-op while live at promoting (Global Constraints). */
export function resetLocalCopy(w: WriteContext, batchId: BatchId): LocalCopyDto;
/** step promoting and wait null. */
export function isLivePromoting(copy: LocalCopyDto): boolean;
export function listOpenLocalCopies(db: DbReader): LocalCopyDto[]; // step not 'retired'
/** The project's copy batch in CUTTING, OPEN, SHIPPING or FAILED, if any. */
export function unfinishedCopyOf(db: DbReader, projectId: ProjectId): BatchDto | null;

// apps/daemon/src/git/git.ts (card 2), on the Git interface
export type Promotion =
  | { readonly kind: 'promoted' }
  | { readonly kind: 'base_moved'; readonly now: string | null }
  | { readonly kind: 'off_base'; readonly head: string | null }
  | { readonly kind: 'in_the_way'; readonly changed: string[]; readonly kept: string[] }
  | { readonly kind: 'index_locked' }
  | { readonly kind: 'filters'; readonly paths: string[] }
  | { readonly kind: 'unclear'; readonly reason: string };
export interface PromotionInput {
  readonly repo: string;
  readonly branch: string;
  readonly expected: string; // T
  readonly candidate: string; // C
}
promoteFastForward(input: PromotionInput): Promise<Promotion>;
export type FolderRead =
  | { readonly row: 'A'; readonly head: string | null }
  | { readonly row: 'B' }
  | { readonly row: 'C' }
  | { readonly row: 'D' }
  | { readonly row: 'E'; readonly now: string }
  | { readonly row: 'F'; readonly paths: string[] }
  | { readonly row: 'G'; readonly paths: string[]; readonly ref: string | null };
classifyFolder(input: PromotionInput): Promise<FolderRead>;
/** Row D's compare-and-swap T → C, under the repo lock; writes no file. */
finishPromotion(input: PromotionInput): Promise<'promoted' | 'raced'>;

// apps/daemon/src/sandbox/command-env.ts (card 3)
export const COPY_ID_VARIABLE = 'TENDB_COPY_ID';
/** `env` without TENDB_COPY_ID, then with it set to `copyId` when one is given. Applied last. */
export function withCopyId(
  env: Readonly<Record<string, string>>,
  copyId: CopyId | null,
): Record<string, string>;
// LaneSessionInput (lane-sandbox.ts:156), TakeoverSandboxInput (:223), GateRunInput (gate-sandbox.ts:58) and
// McpSandboxInput gain: readonly copyId: CopyId | null

// apps/daemon/src/delivery/copy-id.ts (card 3)
export class CopyJournalMissingError extends Error { override readonly name = 'CopyJournalMissingError'; }
/** The copy id for commands run for `batchId`: null for a batch that isn't a local copy. */
export function copyIdForBatch(db: DbReader, batchId: BatchId | null): CopyId | null;

// apps/daemon/src/delivery/copy-landing.ts (card 5)
export interface CopyLanding {
  /** Runs or resumes the landing from the journal's step; the ship job calls it for a local copy. */
  land(batchId: BatchId, signal: AbortSignal): Promise<void>;
  /** Rechecks every waiting landing whose wait a watcher event or the minute timer may have ended. */
  recheck(projectId: ProjectId): void;
}
export function createCopyLanding(deps: CopyLandingDeps): CopyLanding;

// apps/daemon/src/delivery/copy-retire.ts (card 6)
/** Runs the pinned teardown from `teardown_sha`, then the worktree, branch and teardown ref go. */
export function retireCopy(ctx: DeliveryContext, batchId: BatchId, signal: AbortSignal): Promise<'retired' | 'failed'>;
export function teardownRef(batchId: BatchId): string; // refs/10db/copies/<batch id>/teardown
```

## State table (design, not a test list)

The journal's step × what happens. "Reset" is `resetLocalCopy`.

| Step                                | Event                                              | Next                                                                                                                                                             | Card |
| ----------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| (cut)                               | CUTTING insert                                     | `open`                                                                                                                                                           | 4    |
| `open`                              | review accepted, nothing in hand, batch → SHIPPING | preconditions, then `merging`                                                                                                                                    | 5    |
| `open`                              | diff touches a `deps` hazard path                  | batch FAILED (`lockfile_in_copy`), reset                                                                                                                         | 5    |
| `merging`                           | copy head contains T                               | `gating` with T, C                                                                                                                                               | 5    |
| `merging`                           | merge clean or 10db-settled                        | `gating` with T, C = merge                                                                                                                                       | 5    |
| `merging`                           | conflict                                           | merge fix as `sendToMerge`; batch → OPEN; reset                                                                                                                  | 5    |
| `gating`                            | gate passes, head is C and clean before and after  | `gated`                                                                                                                                                          | 5    |
| `gating`                            | head or tree changed across the gate               | FAILED (`gate_changed_copy`), reset                                                                                                                              | 5    |
| `gating`                            | gate fails                                         | today's gate-failure card and fix loop, reset                                                                                                                    | 5    |
| `gated`, `gating`, `promoting`      | entered and copy head isn't C                      | `merging`                                                                                                                                                        | 5    |
| `promoting`                         | `promoted`                                         | `landed` (one transaction with SHIPPED)                                                                                                                          | 5    |
| `promoting`                         | `base_moved`, attempt ≤ 3                          | `merging`, attempt + 1                                                                                                                                           | 5    |
| `promoting`                         | `base_moved`, fourth time                          | `wait: base_moving`, `retry_at` = last base change + 10 min                                                                                                      | 5    |
| `promoting`                         | `off_base`                                         | `wait: folder_off_base`                                                                                                                                          | 5    |
| `promoting`                         | `in_the_way`                                       | `wait: edits_in_the_way`                                                                                                                                         | 5    |
| `promoting`                         | `index_locked`                                     | `wait: index_locked`, every 30 s; card after 10 min                                                                                                              | 5    |
| `promoting`                         | `filters`                                          | FAILED (`git_filters`), reset                                                                                                                                    | 5    |
| `promoting`                         | `unclear`, or recovery                             | classifier row → A wait / B `landed` / C retry / D `finishPromotion` / E `merging` / F `wait: edits_in_the_way` / G FAILED (`interrupted_landing`), journal kept | 5, 6 |
| `promoting` (FAILED, row G)         | Retry                                              | SHIPPING, resume at `promoting` → classifier                                                                                                                     | 5    |
| `promoting`, live                   | Abandon, a new run of the task, or any failure     | Abandon and the run refused; a failure is `interrupted_landing`, journal kept                                                                                    | 5    |
| `gated`                             | entered with C equal to the copy's head (a resume) | skip the gate: the only skip                                                                                                                                     | 5    |
| any step, SHIPPING                  | stop or shutdown signal                            | the job returns, the batch stays SHIPPING, recovery resumes at the step; `promoteFastForward` once called runs to its end                                        | 5    |
| any wait                            | minute timer, ships not held (`holdShips`)         | one ship job for the batch, unless one is queued or running                                                                                                      | 5    |
| any wait                            | the job ends with a wait set                       | the job returns; the batch stays SHIPPING; nothing holds the ship queue                                                                                          | 5    |
| any wait (not live)                 | Abandon                                            | allowed: batch ABANDONED, `retiring`                                                                                                                             | 5, 6 |
| any wait (not live)                 | a new run of the task                              | batch → OPEN, reset                                                                                                                                              | 5    |
| FAILED, row G                       | a new run of the task                              | refused until Retry settles it                                                                                                                                   | 5    |
| `landed`                            | —                                                  | migrations card if T..C touches a `migrations` path; `retiring`                                                                                                  | 5    |
| `retiring`                          | teardown exits 0                                   | worktree, branch, ref go; `retired`                                                                                                                              | 6    |
| `retiring`                          | teardown fails                                     | card with log and Retry; stays `retiring`                                                                                                                        | 6    |
| `open` (ABANDONED)                  | Abandon                                            | `retiring`                                                                                                                                                       | 6    |
| `open` (CLOSED)                     | ship step 1 finds no commits                       | `retiring`                                                                                                                                                       | 6    |
| `open` (CUTTING refused or deleted) | the cut fails before OPEN                          | row deleted with the batch; no ref, no teardown (no lane ran)                                                                                                    | 4    |
| any                                 | daemon restart                                     | spec §8's step table                                                                                                                                             | 6    |

## Tracks

```
1 ──┬── 3 ──┐
    ├── 4 ──┼── 5 ── 6
2 ──┘       │
1 ── 7      └── 8 (after 4; its e2e after 6)
```

Cards 1 and 2 run in parallel. Then 3, 4 and 7. Card 5 needs 2, 3 and 4; card 6 needs 5. Card 8's settings and
placement parts can start after 4, and its e2e lands after 6.

## Tasks

1. **Contracts and the journal.** The two project fields and their rules, admission (gate, review, base landing,
   one copy), `CopyStep`, `CopyWait`, `CopyId`, the `local_copies` table and store, `dependenciesDone`, the dev
   migration. → `2026-11-24-10db-local-copy-landing/task-1.md`
2. **Promotion in git.** `promoteFastForward`, `classifyFolder`, `finishPromotion`, and their two tests.
   → `task-2.md`
3. **The copy id in every command.** `withCopyId`, the allowlist, the four builders, `copyIdForBatch`, the runner
   and gate callers, and the wiring test. → `task-3.md`
4. **Start and cut.** Start routing by placement, the scheduler's checks, the local cut (no origin), the journal
   row and teardown pin in the CUTTING insert, `cuttableAgain`'s local base. → `task-4.md`
5. **The landing.** `createCopyLanding` in the ship job: preconditions, merging on the local base, the gate bound to
   C, the promotion outcome table, waits and their rechecks, the reset rule, Retry and Abandon, the landed write and
   the migrations card. → `task-5.md`
6. **Retirement and recovery.** `retireCopy` with the pinned teardown, and `recover.ts`'s routing for local
   copies per spec §8. → `task-6.md`
7. **Pictures.** `takesPictures` for copy tasks, the after on a landing's SHIPPED, the start-up catch-up.
   → `task-7.md`
8. **Settings, placement, e2e and docs.** The Settings › Delivery switch and command field, Separate copy in the
   placement control, the `loop.spec.ts` extension, `AGENTS.md` notes and the five decision records.
   → `task-8.md`

## After the plan

- The coordinator files the Ampsio task (spec §9) with the `10db-task` skill once the PR is open.
- Acceptance: with both merged, one backend Ampsio task in a copy on a Claude plan lane and one on a Codex lane,
  measured by the spec §13 script.
