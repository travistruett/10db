# 10db Worktree Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In a `pull_request` project with `workspace_mode = worktree`, every started task (or dependency-linked group) gets its own git worktree on its own branch cut from a fresh `origin/<base>`, its lanes and gate run there in parallel with other tasks' lanes, and it ships alone as one pull request; the main checkout is never switched, staged or written, and a crash at any point recovers without a wrong commit, a different push, a second PR or a leaked worktree.

**Architecture:**

- **Data.** `projects` gains `workspace_mode` and `worktree_seed`; `batches` gains `worktree_path`, and the one-unfinished-batch index covers shared batches only; `claims` gains `scope` and its active-claim index moves to `(scope, kind, name)`. Forward-only migrations from v0.1.0.
- **Git.** `git/` gains worktree plumbing (`addWorktree`, `removeWorktree`, `listWorktrees`, `pruneWorktrees`, `deleteBranchIfAt`, `ignoredDirectories`), each under the existing pin env. A worktree is pinned at creation (by batch, `checkout_pin.<batchId>`); any path under the worktree root without a pin is refused.
- **Delivery.** One function, `checkoutOf`, says where a workstream works. The worktree cut, the dependency grouping, the seed copy, the worktree-aware launch rule, ship, cleanup, Retry repair, Abandon, the sweep and recovery live in `delivery/`, in files named for what they do. Worktree projects get two job queues (cut, ship).
- **Integration.** The runner, MCP tools, workstream recovery, the scheduler and the watcher read the checkout from `checkoutOf`; the lane, gate and MCP sandboxes get the worktree as the project checkout and every live worktree in `checkouts`. No sandbox rule changes.
- **API and UI.** `POST /projects/:id/batches` answers `BatchDto[]` and takes `batchId` for fix tasks; `GET /projects` carries `openBatches`. The project forms gain the mode and the seed; the board shows one strip per open batch with its worktree path and an "Add a fix task" action.

**Tech Stack:** As in the batch delivery and lane sandbox plans. No new dependencies: `node:fs` (`copyFile` with `COPYFILE_FICLONE`, `lstat`, `readlink`, `symlink`), `node:crypto` (`sha256`), git and gh through `git/` and `github/`.

**Spec:** `docs/superpowers/specs/2026-10-27-10db-worktree-mode-design.md` (reviewed once; its decisions W1–W14 are fixed). It extends `docs/superpowers/specs/2026-10-21-10db-batch-delivery-design.md` and keeps `docs/superpowers/specs/2026-10-25-10db-lane-sandbox-design.md` unchanged. Coverage: §3 decisions (every task), §4 data (Task 1), §5 lifecycle (Tasks 5, 6, 7), §6 seed (Task 3), §7 recovery (Task 8), §8 components (Tasks 2–10), §9 security (Tasks 2, 3, 4), §10 testing (every task; manual acceptance is Task 12), §11 (Task 11).

**Plan series:** … `12-lane-sandbox`, `13-accounts-settings`, **`14-worktree-mode` (this file)**.

This plan was written against `feat/worktree-mode` at `1a41a03` (`main` at `6913519`, v0.1.0, plus the spec). Where a file, signature or anchor it names doesn't match the code, trust the code, adapt the step and say so in the task's report.

## Decisions made in the plan

The spec leaves these open, or the code disagrees with it in a way that changes behavior; the plan decides them. Task 11 records the lasting ones.

1. **Three migrations, not one.** SQLite can't add a `NOT NULL` column without a default, and the new `(scope, kind, name)` unique index must be created only after `scope` is backfilled, or two projects' active claims on the same hazard name (both hold `docker`, say) collide. So: `0002_worktree_mode` (generated: the project and batch columns, the batch index, `claims.scope text NOT NULL DEFAULT ''`), `0003_claims_scope` (`--custom`: `UPDATE claims SET scope = project_id`), `0004_claims_scope_index` (generated: the index swap). The `''` default exists only so the column can be added; `acquireClaims` always writes `scope`.
2. **`PROTOCOL_VERSION` goes from 3 to 4.** `POST /projects/:id/batches` answering an array instead of an object is a narrowing change (`packages/contracts/AGENTS.md`). The desktop and the daemon ship together, so the version-mismatch screen covers a stale UI.
3. **Workstreams are inserted at start, not at `OPEN`.** Spec §5 says both ("Start": inserted `CUTTING` with the workstreams `QUEUED`; "Cut": the `OPEN` transaction "inserts the workstreams"). The Start paragraph gives the reason (a second start of the same task is refused while its cut runs), so the `OPEN` transaction only sets `branch`, `base_sha`, `repo` and the state.
4. **A refused or interrupted cut detaches its workstreams.** `workstreams.batch_id` references `batches.id`, so deleting a `CUTTING` row that `QUEUED` workstreams point at fails. `deleteCuttingBatch` cancels every workstream of the row (fence `null`, reason the delete's reason) and sets its `batch_id` to null, then deletes the row, in one transaction. In shared mode there are none, so its behavior is unchanged.
5. **Push runs in the main checkout; everything else runs in the worktree.** Refs and config are shared, and the main checkout's pin is the one origin the builder trusted, so `git.push(project.repoPath, branch)` is unchanged. Step 0's branch and clean check, the commit count, the gate, `head` for the PR's CI link and the PR template read the worktree.
6. **Worktree pins.** A worktree's pin copies the main pin's `fetchUrl` and `pushUrl`. The database pin store resolves a real path to a project's checkout first, then to a batch whose `worktree_path` is that path, and keys the latter `checkout_pin.<batchId>`. `createGit({ worktreeRoot })` refuses (`GitTrustFailure.Unpinned`) any path at or under the worktree root that has no pin, which covers "a batch worktree with no stored pin" and also anything else someone put there. `Git.removeWorktree` deletes the pin (`pins.delete`) itself; the caller then clears `worktree_path` (W14), so a repeated removal still finds the batch.
7. **The kept-worktree card says `git worktree remove --force --force <path>`.** The worktree is locked, and git removes a locked worktree only with `--force` twice; the spec's single `--force` would fail.
8. **Retry never deletes a builder's changes.** Spec §5 removes "anything else at the path". When the path holds a worktree on another branch (or detached) that has uncommitted changes, ship and reopen refuse instead, with a card naming the path, as W12 asks for Abandon. A clean one, a half-made one (no `index`) or a missing one is replaced as the spec says.
9. **Seed walk details.** An ignored directory whose parent directory is not in the new worktree (the base tree lacks it) is skipped and logged, never created. Within the walk, at most 16 file clones run at once. An unreadable entry fails the seed, which refuses the cut and removes the worktree and branch.
10. **`TENDB_WORKTREE_ROOT` replaces `~/.10db/worktrees`;** the data-dir hash level is always appended. `DaemonOptions.worktreeRoot` is optional (default `~/.10db/worktrees`), and the daemon creates nothing there until the first worktree cut, so existing `startDaemon` callers stay unchanged. Every test that uses worktree mode passes a temp dir.
11. **The root is refused at project creation too.** A project registered after start at a path that contains the root would make the next start refuse; `createProject` refuses such a checkout with 400, and `startDaemon` still refuses at start.
12. **The sweep runs for every `pull_request` project,** not only worktree-mode ones: a project switched back to shared can still hold orphans. It touches only entries under this daemon's hashed level locked with a `10db bat_…` reason.
13. **Startup with a missing worktree.** `OPEN` and `SHIPPING` worktree batches whose worktree is missing, unpinned or off the branch fail with a card naming the path. A `FAILED` one stays as it is with no new card: its card already offers Retry, which rebuilds the worktree.
14. **One reopen path for a `FAILED` worktree batch.** The strip's Retry with unfinished work, a fix-task join and a workstream Retry all reopen through `reopenWorktreeBatch` (a cut-queue job: make the worktree whole, then `FAILED → OPEN`). `retryWorkstream` leaves a `FAILED` worktree batch `FAILED` and re-queues only the workstream; the composition root then asks delivery to reopen. Until the reopen lands the work waits (the launch rule needs `OPEN`).
15. **A set start is validated all at once.** Every group's request-time checks pass before any group is inserted; then each group is inserted in its own transaction and cut in its own job.
16. **Claims scope API.** `acquireClaims` takes an optional `areaScope: BatchId`; areas are scoped to it when given, to the project otherwise; hazards always to the project. Existing callers pass nothing and behave as today.
17. **The launch rule reads a worktree only for an `OPEN` batch with `branch` and `base_sha` set.** Work in a `CUTTING` batch waits without reading anything. A missing worktree is its own folded card (`worktreeCards.missing`, outcome `waits`); an unpinned one raises only the trust card (the git refusal) and waits; one on another branch raises today's wrong-branch card with the worktree's path.
18. **Stray cards fold per checkout.** In worktree mode the watcher's fold keys take the batch id instead of the project id, and the card body leads with the worktree path, so two worktrees writing the same relative path raise two cards.
19. **In shared mode `batchId`,** when given, must name the project's unfinished batch, else 409; without it a start joins as today.
20. **The sheet in worktree mode** has its own kind (`worktrees`, "Start N tasks in worktrees"); the title field is hidden and the request sends the first task's title (each batch is titled per W3 anyway).
21. **`ProjectViewDto.openBatches` defaults to `[]`** so an answer without it still parses, like `currentBatch`.
22. **A removal git refuses is not retried forever.** If `removeWorktree` finds a directory at the batch's path that git doesn't list (`WorktreeNotOursError`), delivery leaves it, raises `worktreeCards.leftBehind` naming it, and clears `worktree_path` (W14), so the daemon stops treating it as live. An empty one is removed with `rmdir` (recovery of a `CUTTING` row, spec §7).

## Global Constraints

Everything in the batch delivery and lane sandbox plans' Global Constraints still applies. On top of that:

- **Branch:** `feat/worktree-mode` in the worktree `/Users/travistruett/Projects/10db-worktree-mode`. Open one PR to `main` at the end; its title is a Conventional Commit (`feat(daemon): run each task in its own worktree and pull request`).
- **Commits:** one per task, one command that names its paths: `git add <paths> && git commit -m '<type>(<scope>): <subject>' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_018BmFCKUAT9ouhdy3mHWbVt'`. Single quotes. Scopes from `commitlint.config.js`. Run `pnpm format` first. A failing hook leaves the paths staged: fix and rerun the same line. Never `--no-verify`, `LEFTHOOK=0` or `core.hooksPath`.
- **Migrations are forward-only** (`packages/db/AGENTS.md`): `pnpm --filter @10db/db generate` (and `pnpm --filter @10db/db exec drizzle-kit generate --custom --name claims_scope` once); never edit or regenerate a committed migration. After any contracts change, `pnpm --filter @10db/contracts generate`. `make gate` fails on drift in either.
- **Shared mode is untouched.** These suites pass unchanged unless a task names the forced edit: `apps/daemon/src/delivery/{start,ship,recover,jobs,launch-rule,batch-card}.test.ts`, `apps/daemon/src/scheduler/scheduler.test.ts`, `apps/daemon/src/runner/runner.test.ts`, `apps/daemon/src/watcher/watcher.test.ts`, `apps/daemon/src/recovery/recover.test.ts`, `apps/daemon/src/git/{git,trust}.test.ts`, `apps/daemon/src/sandbox/*.test.ts`, `apps/daemon/test/batch-delivery.test.ts` (forced: it reads the batch answer as an array, Task 9), `packages/db/src/store/*.test.ts`. The only forced edits are the array answer and the protocol constant.
- **Tests** (`.claude/rules/testing.md`): red first, with the expected failure noted; real git in temp repos with a bare `origin` (`createTempRepoWithOrigin` in `apps/daemon/test/fixtures.ts`, which already sets `maintenance.auto=false`, `gc.auto=0`, `receive.autogc=false`); every git call in test code passes `isolatedGitEnv()`; `gh` is `FakeGh` (`apps/daemon/test/fake-gh.ts`); sessions are `FakeAdapter` (`apps/daemon/src/sessions/fake-adapter.ts`); a sandboxed daemon in tests uses `FAKE_SRT` (`apps/daemon/test/fixtures.ts`); Seatbelt tests skip with `SANDBOXED`. Table-driven for cut refusals, recovery points, removal safety, the sweep, the launch rule and seed entries. No sleeps: `jobs.idle()`, `scheduler.idle()`, `waitFor`/`waitForAsync`.
- **Worktree tests use a temp worktree root,** never `~/.10db`: `tempDir('worktrees')` passed as `worktreeRoot` to `createGit`, the delivery harness and `startDaemon`.
- **Code style:** `as const` objects (`WorkspaceMode`, `JobQueue`), typed errors with a `name` (`WorktreeRootError`, `WorktreeNotOursError`), no `as`/`!`/`any` outside a validated boundary, exhaustive switches over `GitTrustFailure`, `BatchState` and `WorkspaceMode`, comments timeless and without decision numbers, no grab-bag modules.
- **Module order** (`apps/daemon/AGENTS.md`): `git` knows nothing of batches; `delivery` may import `git`, `github`, `team`, `inbox`; `scheduler`, `watcher`, `runner`, `mcp`, `recovery` import `checkoutOf` from `delivery`'s index; `daemon/` wires.
- **Every daemon git call goes through `git()` in `git.ts`** (no attributes, `DAEMON_GIT_CONFIG`, pinned env). No hook, filter or fsmonitor runs; nothing from the repository runs on the host to prepare a worktree.
- **Done** is `make gate` printing `GATE PASS`.

## Review Focus

1. **The main checkout is written while worktree work runs.** The builder keeps editing, switching and committing in the main checkout; a cut, a lane, a gate, a ship and a removal must leave its HEAD, index, branch and files exactly as they were, dirty or not.
   - Tests: Task 5 (`leaves a dirty main checkout on another branch exactly as it was`), Task 7 (`ships ... and leaves the main checkout untouched`), Task 9 (the end-to-end test compares HEAD, `git ls-files -s`, `git status --porcelain` and file bytes before and after).
2. **The daemon deletes a directory it didn't make.** A worktree the builder made by hand, one under another data dir's level, a link, an unlisted directory at a batch's path, a path outside the root.
   - Tests: Task 2 (`removeWorktree` refusal table), Task 8 (sweep table: unlocked, foreign lock reason, outside the root, another level).
3. **A crash between any two steps leaks a worktree or ships twice.** Kill after the `CUTTING` insert, `update-ref`, `worktree add`, `read-tree`, the seed, the gate, the push, `gh pr create`, `SHIPPED`, the removal.
   - Tests: Task 8 (one row per point: one PR, origin at the same SHA, `git worktree list` holds only live batches).
4. **A lane reaches the main checkout, a sibling worktree or git state.** A worktree lane writes `../main/x`, `<sibling>/x`, its `.git` gitfile, its own git dir or the common dir.
   - Tests: Task 4 (profile assertions on real worktrees; one Seatbelt probe).
5. **Uncommitted work in a worktree is thrown away.** Abandon of a dirty worktree; Retry when the builder switched the worktree to another branch and edited it.
   - Tests: Task 7 (`keeps a dirty worktree on Abandon and names it`, `refuses Retry over a worktree on another branch with changes`).

---

## File Structure

| Path                                                                  | Change                                                                                                               |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts/src/states.ts`                                    | `WorkspaceMode`                                                                                                      |
| `packages/contracts/src/entities.ts`                                  | `WorktreeSeedName`, project input/DTO/patch fields, the worktree-needs-PR rule                                       |
| `packages/contracts/src/batches.ts`                                   | `BatchDto.worktreePath`, `BatchStartInput.batchId`, `BatchStartResult`, `ProjectViewDto.openBatches`                 |
| `packages/contracts/src/protocol.ts`, `json-schema.ts`, `generated/`  | version 4; register `BatchStartResult`; regenerate                                                                    |
| `packages/db/src/schema.ts`, `drizzle/0002…0004`                      | columns, indexes, migrations                                                                                         |
| `packages/db/src/store/batches.ts`                                    | shared-only `findUnfinishedBatch`; `listUnfinishedBatches`, `listLiveWorktrees`, `findBatchByWorktreePath`, `clearWorktreePath`; `insertBatch` options; `deleteCuttingBatch` detaches |
| `packages/db/src/store/claims.ts`                                     | `scope`, `areaScope`                                                                                                 |
| `packages/db/src/store/projects.ts`                                   | mode and seed on insert and patch, the patch rules, `openBatches`                                                    |
| `apps/daemon/src/git/git.ts`, `worktree-list.ts` (new), `trust-error.ts`, `trust-card.ts`, `index.ts` | worktree plumbing, porcelain parser, `Unpinned`                                     |
| `apps/daemon/src/daemon/checkout-pins.ts`                             | pins by batch; `projectAt` resolves worktrees                                                                        |
| `apps/daemon/src/daemon/worktree-root.ts` (new)                       | the hashed root and its refusal                                                                                      |
| `apps/daemon/src/env.ts`, `.env.example`, `daemon/options-from-env.ts`, `daemon/start.ts`, `daemon/services.ts` | `TENDB_WORKTREE_ROOT`, wiring, creation refusal                                     |
| `apps/daemon/src/delivery/checkout.ts` (new)                          | `checkoutOf`, `batchCheckout`, `allCheckouts`                                                                        |
| `apps/daemon/src/delivery/worktree-seed.ts` (new)                     | `seedDirs`, `seedWorktree`                                                                                           |
| `apps/daemon/src/delivery/grouping.ts` (new)                          | W3 grouping                                                                                                          |
| `apps/daemon/src/delivery/worktree-path.ts` (new)                     | where a batch's worktree lives                                                                                       |
| `apps/daemon/src/delivery/worktree-cut.ts` (new)                      | the worktree cut                                                                                                     |
| `apps/daemon/src/delivery/worktree-repair.ts` (new)                   | `ensureWorktreeWhole`, `reopenWorktreeBatch`                                                                         |
| `apps/daemon/src/delivery/worktree-cleanup.ts` (new)                  | `retireWorktree`, `abandonWorktree`                                                                                  |
| `apps/daemon/src/delivery/worktree-sweep.ts` (new)                    | the startup sweep                                                                                                    |
| `apps/daemon/src/delivery/{start,ship,recover,cards,context,jobs,launch-rule,branch-name,index}.ts` | dispatch by mode, queues, cards                                                     |
| `apps/daemon/src/runner/runner.ts`, `mcp/tools.ts`, `recovery/recover.ts` | the checkout from `checkoutOf`                                                                                   |
| `apps/daemon/src/scheduler/scheduler.ts`                              | launch rule per batch, scoped claims                                                                                 |
| `apps/daemon/src/watcher/watcher.ts`, `strays.ts`                     | one watch per live checkout, holders by scope                                                                        |
| `apps/daemon/src/team/steps.ts`                                       | `retryWorkstream` leaves a `FAILED` worktree batch for delivery to reopen                                             |
| `apps/daemon/src/api/{services,app}.ts`                               | array answer                                                                                                          |
| `apps/daemon/test/delivery-harness.ts`, `test/worktree-delivery.test.ts` (new) | worktree harness options; end-to-end test                                                                   |
| `apps/desktop/src/views/board/…`, `views/settings/…`, `src/test/fixtures.ts` | forms, strips, sheet mode, "Add a fix task"                                                                   |
| `docs/…`                                                              | architecture, security, open items, decisions                                                                        |

---

### Task 1: Contracts and database

**Files:**

- Modify: `packages/contracts/src/states.ts`, `packages/contracts/src/entities.ts`, `packages/contracts/src/batches.ts`, `packages/contracts/src/protocol.ts`, `packages/contracts/src/json-schema.ts`, `packages/contracts/src/index.ts`, `packages/contracts/generated/*` (regenerated)
- Modify: `packages/db/src/schema.ts`, `packages/db/src/store/batches.ts`, `packages/db/src/store/claims.ts`, `packages/db/src/store/projects.ts`, `packages/db/src/index.ts`
- Create: `packages/db/drizzle/0002_worktree_mode.sql`, `0003_claims_scope.sql`, `0004_claims_scope_index.sql` and their snapshots (generated)
- Test: `packages/contracts/src/batches.test.ts`, `packages/contracts/src/contracts.test.ts`, `packages/db/src/store/batches.test.ts`, `packages/db/src/store/execution.test.ts`, `packages/db/src/store/projects-tasks.test.ts`, `packages/db/src/database.test.ts`

**Interfaces:**

- Produces (contracts):
  ```ts
  export const WorkspaceMode = { Shared: 'shared', Worktree: 'worktree' } as const;
  export type WorkspaceMode = ValueOf<typeof WorkspaceMode>;
  /** One directory name: no `/`, not `.`, `..` or `.git`, no NUL, 1–255 chars. */
  export const WorktreeSeedName: z.ZodString-refined;
  export const DEFAULT_WORKTREE_SEED = ['node_modules'] as const;
  // ProjectInput: workspaceMode: z.enum(WorkspaceMode).default('shared'),
  //               worktreeSeed: z.array(WorktreeSeedName).max(32).default([...DEFAULT_WORKTREE_SEED])
  //   + refine: workspaceMode !== worktree || delivery === pull_request,
  //     message 'A worktree per task needs pull request delivery', path ['workspaceMode']
  // ProjectDto: workspaceMode: z.enum(WorkspaceMode), worktreeSeed: z.array(z.string())
  // ProjectPatch: workspaceMode, worktreeSeed (same schemas as input, partial)
  // BatchDto: worktreePath: z.string().nullable()   // the real path; null in shared mode and once removed
  // BatchStartInput: batchId: BatchId.optional()     // add the tasks to this OPEN or FAILED batch
  export const BatchStartResult = z.array(BatchDto);   // POST /projects/:id/batches, 202
  // ProjectViewDto: openBatches: z.array(BatchDto).default([])   // unfinished, newest first
  export const PROTOCOL_VERSION = 4 as const;
  ```
- Produces (db):
  ```ts
  insertBatch(ctx, input: { projectId; title; baseBranch; id?: BatchId; worktreePath?: string }): BatchDto
  findUnfinishedBatch(db, projectId): BatchDto | undefined        // shared batches only (worktree_path IS NULL and never set)
  listUnfinishedBatches(db, projectId): BatchDto[]               // every mode, newest first
  currentBatch(db, projectId): BatchDto | null                   // newest unfinished, else latest
  listLiveWorktrees(db): BatchDto[]                              // worktree_path IS NOT NULL, any state
  findBatchByWorktreePath(db, path: string): BatchDto | undefined
  clearWorktreePath(ctx, id: BatchId): BatchDto                  // emits batch.updated { changed: ['worktreePath'] }
  deleteCuttingBatch(ctx, id, reason): void                      // also cancels and detaches its workstreams
  acquireClaims(ctx, { projectId; workstreamId; requests; leaseExpiresAt; areaScope?: BatchId }): AcquireResult
  ```

An unfinished worktree batch always has its path set: it is written in the `CUTTING` insert, and W14 clears it only after `SHIPPED`, `CLOSED` or `ABANDONED`. So "unfinished and `worktree_path IS NULL`" is exactly "unfinished shared batch", for both the partial index and `findUnfinishedBatch`.

- [ ] **Step 1: Write the failing contract tests**

`packages/contracts/src/batches.test.ts`, table `WorktreeSeedName`:

| name                        | value              | ok    |
| --------------------------- | ------------------ | ----- |
| `a plain directory name`    | `'node_modules'`   | true  |
| `cargo's target`            | `'target'`         | true  |
| `a dotted name`             | `'.venv'`          | true  |
| `a path`                    | `'apps/x'`         | false |
| `the current directory`     | `'.'`              | false |
| `the parent directory`      | `'..'`             | false |
| `git's own directory`       | `'.git'`           | false |
| `empty`                     | `''`               | false |
| `a NUL`                     | `'a\0b'`           | false |

Plus: `ProjectInput refuses worktree mode with local delivery` (error path `['workspaceMode']`), `ProjectInput defaults to shared and seeds node_modules`, `BatchStartInput takes a batchId`, `ProjectViewDto without openBatches reads as none` (parses to `[]`), `BatchStartResult is an array of batches`. In `contracts.test.ts`, the existing protocol assertion moves to 4 (forced edit).

- [ ] **Step 2: Run them; expect failures for the missing exports and fields**

Run: `pnpm --filter @10db/contracts test`
Expected: FAIL (`WorktreeSeedName` is not exported; `workspaceMode` is stripped).

- [ ] **Step 3: Implement the contracts, then regenerate**

Run: `pnpm --filter @10db/contracts generate` — commits `generated/` changes in Step 9.

- [ ] **Step 4: Write the failing db tests**

`packages/db/src/store/batches.test.ts`, new `describe('worktree batches')`:

- `a project holds one unfinished shared batch and any number of worktree batches` — on a project with `workspaceMode: 'worktree'`, two `insertBatch` with `worktreePath` both succeed; on a shared project a second unfinished batch still throws `ConflictError`.
- `the unique index refuses a second unfinished shared batch but not a worktree one` — raw inserts through `store.db.$client` (as the existing index rows do).
- `findUnfinishedBatch ignores worktree batches, open or shipped`.
- `listUnfinishedBatches answers every unfinished batch, newest first`.
- `currentBatch is the newest unfinished batch, else the latest` — rows: one shared unfinished; three worktree unfinished; none unfinished, two finished.
- `listLiveWorktrees keeps an ABANDONED batch whose path is set and drops a cleared one`.
- `findBatchByWorktreePath matches the stored path exactly`.
- `clearWorktreePath clears the path and emits batch.updated`.
- `deleteCuttingBatch cancels and detaches the workstreams of a cutting batch` — insert a worktree batch and two `QUEUED` workstreams with its `batchId`; after delete: row gone, both `CANCELLED` with `batchId === null`, one `workstream.changed` each, and `insertWorkstream` for the same task succeeds.

`packages/db/src/store/execution.test.ts`, table `claims by scope`:

| name                                                     | first                         | second                         | ok    |
| -------------------------------------------------------- | ----------------------------- | ------------------------------ | ----- |
| `the same area in two batches of one project`            | area `ui`, `areaScope: b1`    | area `ui`, `areaScope: b2`     | true  |
| `the same area in one batch`                             | area `ui`, `areaScope: b1`    | area `ui`, `areaScope: b1`     | false |
| `the same hazard in two batches`                         | hazard `docker`, `b1`         | hazard `docker`, `b2`          | false |
| `the same area with no scope (shared mode, as today)`    | area `ui`                     | area `ui`                      | false |
| `the same area in two projects`                          | area `ui`, project A          | area `ui`, project B           | true  |

`packages/db/src/store/projects-tasks.test.ts`:

- `patchProject refuses worktree mode with local delivery` (`InvalidError`), checked against the merged values both ways (`{ workspaceMode: 'worktree' }` on a local project; `{ delivery: 'local' }` on a worktree project).
- `patchProject refuses a workspace mode change while the project has an unfinished batch` (`ConflictError`, message names the batch).
- `insertProject stores the mode and the seed`.

`packages/db/src/database.test.ts`, `describe('migrating a v0.1.0 database')`: build the old database by copying `drizzle/` to a temp dir and trimming `meta/_journal.json` to its first two entries (and removing the newer SQL files), migrate a temp database with that dir, seed through raw SQL (two projects, an active `hazard docker` claim in each, an unfinished batch in one), then `migrateDatabase` with the real dir. Rows:

- `every claim's scope is its project`
- `two projects' active claims on the same hazard both survive`
- `projects default to shared mode with node_modules seeded`
- `the old unfinished batch reads as shared, with no worktree path`

- [ ] **Step 5: Run them; expect failures**

Run: `pnpm --filter @10db/db test`
Expected: FAIL (`worktreePath` unknown to `insertBatch`; `areaScope` ignored, first claims row conflicts).

- [ ] **Step 6: Schema and migrations, in three generations**

1. `schema.ts`: `projects.workspaceMode` (`text('workspace_mode').$type<WorkspaceMode>().notNull().default('shared')`), `projects.worktreeSeed` (`text('worktree_seed', { mode: 'json' }).$type<string[]>().notNull().default(sql\`'["node_modules"]'\`)`), `batches.worktreePath` (`text('worktree_path')`), `batches_one_unfinished` gains `AND worktree_path IS NULL` in its `where`, `claims.scope` (`text('scope').$type<ProjectId | BatchId>().notNull().default('')`, with a comment that the default only lets SQLite add the column). Keep `claims_active_unique` on `(project_id, kind, name)` for now. Run `pnpm --filter @10db/db exec drizzle-kit generate --name worktree_mode`.
2. Run `pnpm --filter @10db/db exec drizzle-kit generate --custom --name claims_scope` and write its whole body:
   ```sql
   UPDATE `claims` SET `scope` = `project_id`;
   ```
3. Move `claims_active_unique` to `.on(t.scope, t.kind, t.name)`; run `pnpm --filter @10db/db exec drizzle-kit generate --name claims_scope_index`. Read the SQL: it must be a `DROP INDEX` and a `CREATE UNIQUE INDEX … WHERE released_at IS NULL`, nothing else. Then `pnpm --filter @10db/db drift` is clean.

- [ ] **Step 7: Stores**

- `insertBatch`: when `worktreePath` is absent, keep today's `findUnfinishedBatch` refusal; when present, skip it (the index allows it). `id` defaults to `mintId('Batch')`.
- `findUnfinishedBatch`: add `isNull(schema.batches.worktreePath)`.
- `deleteCuttingBatch`: before the delete, for each `listWorkstreams(ctx.tx, { batchId: id })` not terminal, `transitionWorkstream(ctx, ws.id, { to: Cancelled, fence: null, reason })`; then `update workstreams set batch_id = null where batch_id = id`. Workstreams' store owns that update (`detachFromBatch(ctx, batchId)` in `workstreams.ts`), so `batches.ts` imports it.
- `acquireClaims`: `scopeOf(request) = request.kind === ClaimKind.Area ? (input.areaScope ?? input.projectId) : input.projectId`; `activeHolder` filters by `scope` instead of `projectId`; the insert writes `scope`.
- `projects.ts`: insert writes both fields; `patchProject` applies the rules above (mode change: refuse when `listUnfinishedBatches(ctx.tx, id).length > 0`; worktree requires `pull_request` on the merged values); `listProjectViews` adds `openBatches: listUnfinishedBatches(db, p.id)`.
- `toBatchDto` maps `worktreePath`. Export the new functions from `packages/db/src/index.ts`.

- [ ] **Step 8: Run the db and contracts suites and typecheck**

Run: `pnpm --filter @10db/contracts test && pnpm --filter @10db/db test && pnpm -r typecheck`
Expected: PASS. The daemon typechecks once `seedProject` and `ProjectDto` consumers compile; `apps/daemon` code that builds `ProjectDto` literals in tests (fixtures) gains the two fields.

- [ ] **Step 9: Commit**

```bash
git add packages/contracts/src packages/contracts/generated packages/db/src packages/db/drizzle apps/daemon/test apps/desktop/src/test && git commit -m 'feat(db): store workspace mode, worktree paths and claim scopes' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_018BmFCKUAT9ouhdy3mHWbVt'
```

---

### Task 2: Worktree plumbing in `git/`, and pins by batch

**Files:**

- Create: `apps/daemon/src/git/worktree-list.ts`, `apps/daemon/src/git/worktree-list.test.ts`
- Modify: `apps/daemon/src/git/git.ts`, `apps/daemon/src/git/trust-error.ts`, `apps/daemon/src/git/trust-card.ts`, `apps/daemon/src/git/index.ts`
- Modify: `apps/daemon/src/daemon/checkout-pins.ts`
- Test: `apps/daemon/src/git/worktrees.test.ts` (new, real git), `apps/daemon/src/git/trust-card.test.ts`, `apps/daemon/src/daemon/checkout-pins.test.ts` (new)

**Interfaces:**

- Consumes: `findBatchByWorktreePath`, `getProject` (Task 1).
- Produces:
  ```ts
  // git/worktree-list.ts
  export interface WorktreeEntry {
    readonly path: string;            // as git recorded it
    readonly head: string | null;
    readonly branch: string | null;   // without refs/heads/
    readonly locked: string | null;   // the reason; '' when locked with none; null when unlocked
    readonly prunable: boolean;
    readonly bare: boolean;
  }
  export function parseWorktreeList(porcelainZ: string): WorktreeEntry[];
  export const WORKTREE_LOCK_PREFIX = '10db ';
  /** The batch id a 10db lock reason names, or null. */
  export function lockedBatchId(entry: WorktreeEntry): string | null; // /^10db (bat_[0-9a-f-]+)$/

  // git/git.ts — Git gains:
  addWorktree(input: {
    repo: string; path: string; branch: string;
    /** Create `branch` here (CAS from nothing); null when it already exists (a Retry). */
    startPoint: string | null;
    lockReason: string;
  }): Promise<string>; // the worktree's HEAD sha
  /** Removes a 10db worktree of `repo` at `path` and its pin; 'absent' when git lists none and nothing is there. */
  removeWorktree(repo: string, path: string): Promise<'removed' | 'absent'>;
  listWorktrees(repo: string): Promise<WorktreeEntry[]>;
  pruneWorktrees(repo: string): Promise<void>;
  /** `update-ref -d refs/heads/<branch> <sha>`: true when deleted, false when missing or moved. */
  deleteBranchIfAt(repo: string, branch: string, sha: string): Promise<boolean>;
  /** `ls-files -z --others --ignored --exclude-standard --directory`, directories only, without the trailing `/`. */
  ignoredDirectories(repo: string): Promise<string[]>;
  // GitOptions gains: worktreeRoot?: string
  export class WorktreeNotOursError extends Error { override readonly name = 'WorktreeNotOursError'; readonly path: string; }
  // GitTrustFailure gains Unpinned: 'unpinned', detail { kind: 'unpinned' }
  ```
- `daemon/checkout-pins.ts`: `projectAt(db, real)` checks projects' checkouts, then `findBatchByWorktreePath(db, real)` → its project. `createProjectPinStore` keys a worktree's pin `checkout_pin.<batchId>` (`worktreePinKey(id)`, exported for tests).

- [ ] **Step 1: Write the failing parser test**

`git/worktree-list.test.ts`, one row per record shape, input written with `\0` separators as `git worktree list --porcelain -z` prints them (fields end in NUL, a record ends in an extra NUL):

| name                         | record fields                                                                       | expected                              |
| ---------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------- |
| `the main checkout`          | `worktree /r`, `HEAD <sha>`, `branch refs/heads/main`                                | branch `main`, locked null            |
| `a 10db worktree`            | `worktree /w/a`, `HEAD <sha>`, `branch refs/heads/10db/a-1`, `locked 10db bat_x`    | locked `10db bat_x`, `lockedBatchId` `bat_x` |
| `locked with no reason`      | `…`, `locked`                                                                        | locked `''`, `lockedBatchId` null      |
| `a reason holding a newline` | `locked 10db bat_x\nmore`                                                           | whole reason kept; `lockedBatchId` null |
| `detached`                   | `HEAD <sha>`, `detached`                                                            | branch null                           |
| `bare`                       | `worktree /r.git`, `bare`                                                           | bare true                             |
| `prunable`                   | `prunable gitdir file points to non-existent location`                              | prunable true                         |
| `someone else's lock`        | `locked by me`                                                                      | `lockedBatchId` null                  |

- [ ] **Step 2: Write the failing git tests**

`git/worktrees.test.ts` uses `createTempRepoWithOrigin`, a `tempDir('worktrees')` root and `createGit({ worktreeRoot: root.path, onRefused })`. After each row it asserts the main checkout's `rev-parse HEAD`, `symbolic-ref HEAD` and `ls-files -s` are unchanged.

- `addWorktree makes the branch at the start point and a locked worktree on it` — `listWorktrees` has the entry with `locked === '10db bat_test'`; `git.currentBranch(path)` is the branch; `README.md` is in the worktree; the git dir has an `index`.
- `addWorktree from an existing branch` (`startPoint: null`).
- `addWorktree refuses a branch that already exists and makes nothing` (`InvalidError`; no entry; no directory).
- `addWorktree refuses a path that exists`.
- `the worktree's pin is recorded at creation` — a second `createGit` sharing the same `memoryPinStore` reads it; `git.gitDirs(path).commonDir` equals the main checkout's.
- `git refuses a path under the worktree root that has no pin` — a worktree made by test git under the root: `currentBranch` rejects with `GitTrustError` whose `detail.kind === 'unpinned'`, and `onRefused` heard it.
- `a swapped gitfile is refused as moved` — rewrite `<path>/.git` to point at another worktree's git dir: `GitTrustFailure.Moved`.
- `removeWorktree` table:

| name                                            | setup                                                      | expected                             |
| ----------------------------------------------- | ---------------------------------------------------------- | ------------------------------------ |
| `a listed 10db worktree`                        | `addWorktree`                                              | `'removed'`; unlisted; dir gone; pin gone |
| `a locked entry whose directory is gone`        | `addWorktree`, then `rm -rf` the dir                       | `'removed'`; unlisted                |
| `a path git doesn't list and that is gone`      | nothing                                                    | `'absent'`                           |
| `a directory git doesn't list`                  | `mkdir` under the root                                     | `WorktreeNotOursError`; dir kept     |
| `a path outside the root`                       | a worktree made by test git in another temp dir            | `WorktreeNotOursError`; still listed |
| `a link to a worktree`                          | `addWorktree`, then a symlink under the root pointing at it, removed by the link's path | `WorktreeNotOursError`; worktree kept |
| `with no worktree root configured`              | `createGit()` without `worktreeRoot`                        | `WorktreeNotOursError`               |

- `deleteBranchIfAt deletes a branch at that sha and keeps one that moved`.
- `ignoredDirectories lists top-level and nested ignored directories` — `.gitignore` with `node_modules/`, dirs `node_modules/` and `apps/web/node_modules/` (with `apps/web/x` tracked): answers `['apps/web/node_modules', 'node_modules']` sorted.
- `pruneWorktrees drops an unlocked entry whose directory is gone and keeps a locked one`.

`trust-card.test.ts`: `an unpinned worktree's card offers no Trust and says how to remove it`.

`daemon/checkout-pins.test.ts` (real store via `createTestStore`):

- `a worktree's pin is stored under checkout_pin.<batchId>` (`getAppSetting`).
- `projectAt resolves a live worktree path to its project`.
- `a cleared worktree path resolves to no project and no pin`.
- `a project's own checkout keeps checkout_pin.<projectId>` (unchanged behavior).

- [ ] **Step 3: Run them; expect failures**

Run: `pnpm --filter @10db/daemon exec vitest run src/git src/daemon/checkout-pins.test.ts`
Expected: FAIL (`addWorktree is not a function`; `parseWorktreeList` missing).

- [ ] **Step 4: Implement the parser, `Unpinned` and its card**

`trust-error.ts`: `Unpinned: 'unpinned'`, detail `{ readonly kind: typeof GitTrustFailure.Unpinned }`, describe: `10db won't run git in ${repo}: it lies under 10db's worktree root, but 10db made no worktree there`. `trust-card.ts`: no candidate; body says 10db runs git under its root only in worktrees it made, and if it is not the builder's, `git worktree remove --force --force <path>` removes it. Add the arm to every exhaustive switch over `GitTrustFailure`.

- [ ] **Step 5: Implement `pinned()`'s refusal and the worktree methods**

In `pinned()`, before pinning on first use: `if (!pin && opts.worktreeRoot && surelyInside(real, opts.worktreeRoot)) throw refusal(real, { kind: GitTrustFailure.Unpinned });`. `surelyInside` answers false when the root doesn't exist yet, which is right: no worktree can be under it then.

`addWorktree`, the subtle part (runs under the main checkout's repo lock):

```ts
async function addWorktree(input: AddWorktreeInput): Promise<string> {
  const root = opts.worktreeRoot;
  if (!root) throw new InvalidError('No worktree root is configured');
  return withRepoLock(realpathSync(input.repo), async () => {
    const main = await pinned(input.repo);
    if (existsAsEntry(input.path)) throw new InvalidError(`${input.path} already exists`);
    mkdirSync(dirname(input.path), { recursive: true, mode: 0o700 });
    const target = join(realpathSync(dirname(input.path)), basename(input.path));
    if (!surelyInside(dirname(target), root))
      throw new InvalidError(`${target} is not under 10db's worktree root`);
    const ref = `refs/heads/${input.branch}`;
    let made: string | null = null;
    if (input.startPoint !== null) {
      const sha = await revParse(main, `${input.startPoint}^{commit}`);
      if (sha === null) throw new InvalidError(`${input.startPoint} names no commit`);
      try {
        await git(main, ['update-ref', '--no-deref', ref, sha, '0'.repeat(sha.length)]);
      } catch (error) {
        if (!(error instanceof GitError)) throw error;
        throw new InvalidError(`A branch named ${input.branch} already exists, or the name is not valid`);
      }
      made = sha;
    } else if ((await revParse(main, `${ref}^{commit}`)) === null) {
      throw new InvalidError(`Branch ${input.branch} does not exist`);
    }
    try {
      // --no-checkout: no file is written and no post-checkout hook runs; read-tree below fills it.
      await git(main, ['worktree', 'add', '--no-checkout', '--lock', '--reason', input.lockReason, '--', target, input.branch]);
      const gitDir = readGitfile(target); // lstat: a regular file; /^gitdir: (\/[^\n]+)\n?$/; realpathSync
      if (!surelyInside(gitDir, join(main.dirs.commonDir, 'worktrees')))
        throw new InvalidError(`git put ${target}'s git dir at ${gitDir}, outside the repository's worktrees`);
      const commonDir = realpathSync(
        (await runGit(target, ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
          bin, env: { GIT_DIR: gitDir, GIT_WORK_TREE: target }, config: [...NO_ATTRIBUTES],
        })).trim(),
      );
      const dirs = { gitDir, commonDir };
      if (checkoutIdentity({ gitDir: commonDir, commonDir }) !== checkoutIdentity({ gitDir: main.dirs.commonDir, commonDir: main.dirs.commonDir }))
        throw new InvalidError(`${target} does not share ${input.repo}'s repository`);
      const pin: CheckoutPin = { ...dirs, id: checkoutIdentity(dirs), fetchUrl: main.pin.fetchUrl, pushUrl: main.pin.pushUrl };
      pins.set(target, pin);
      const wt: Pinned = { real: target, dirs, pin, env: { GIT_DIR: gitDir, GIT_WORK_TREE: target } };
      await git(wt, ['read-tree', '-m', '-u', 'HEAD']);
      const head = await revParse(wt, 'HEAD^{commit}');
      if (head === null) throw new InvalidError(`${target} has no HEAD commit`);
      return head;
    } catch (error) {
      // Leave nothing behind: the entry, its directory, its pin and a branch this call made.
      await git(main, ['worktree', 'remove', '--force', '--force', '--', target]).catch(() => undefined);
      pins.delete(target);
      if (made !== null) await git(main, ['update-ref', '-d', ref, made]).catch(() => undefined);
      throw error;
    }
  });
}
```

The `runGit` call for the common dir runs before the worktree is pinned (the one call that can't go through a `Pinned` site); it still takes `bin`, the empty-attribute config and an env naming the git dir it just read. Add `GIT_ATTR_SOURCE` via `emptyTree(main)`, which is the same object store.

`removeWorktree(repo, path)` checks, in order, then removes:

1. `opts.worktreeRoot` is set, and `path` (resolved: real path of its parent plus its leaf) is under it by `surelyInside`; else `WorktreeNotOursError`.
2. If something is at `path`: `lstat` must be a directory, not a link; else `WorktreeNotOursError`.
3. `listWorktrees(repo)` lists an entry whose path is `samePath` to it (compare real paths when the directory exists, resolved strings otherwise). Not listed: gone → `pins.delete(path)` and `'absent'`; present → `WorktreeNotOursError`.
4. `git(main, ['worktree', 'remove', '--force', '--force', '--', path])`, then `pins.delete(path)`, `'removed'`.

`listWorktrees` runs `worktree list --porcelain -z` under the main pin. `pruneWorktrees` runs `worktree prune`. `deleteBranchIfAt` runs `update-ref -d <ref> <sha>` and answers false on `GitError`. `ignoredDirectories` keeps entries ending in `/` and strips it.

- [ ] **Step 6: Pins by batch**

`createProjectPinStore`: `get/set/delete(real)` → `projectAt`-style lookup: a project whose checkout's real path is `real` uses `checkout_pin.<projectId>`; else a batch from `findBatchByWorktreePath(db, real)` uses `worktreePinKey(batch.id)`; else `fallback`. `projectAt` returns the batch's project in the second case, so `createGitRefusalHandler` raises worktree refusals on the right project with no change of its own.

- [ ] **Step 7: Run the git suites, existing and new**

Run: `pnpm --filter @10db/daemon exec vitest run src/git src/daemon`
Expected: PASS; `git.test.ts`, `trust.test.ts` and `git-refusal.test.ts` unchanged.

- [ ] **Step 8: Commit**

```bash
git add apps/daemon/src/git apps/daemon/src/daemon/checkout-pins.ts apps/daemon/src/daemon/checkout-pins.test.ts && git commit -m 'feat(daemon): make, list and remove pinned worktrees with the daemon git' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_018BmFCKUAT9ouhdy3mHWbVt'
```

---

### Task 3: The worktree root and the seed copy

**Files:**

- Create: `apps/daemon/src/daemon/worktree-root.ts`, `apps/daemon/src/daemon/worktree-root.test.ts`
- Create: `apps/daemon/src/delivery/worktree-seed.ts`, `apps/daemon/src/delivery/worktree-seed.test.ts`
- Modify: `apps/daemon/src/env.ts`, `apps/daemon/src/env.test.ts`, `apps/daemon/.env.example`, `apps/daemon/src/daemon/options-from-env.ts`, `apps/daemon/src/daemon/options-from-env.test.ts`, `apps/daemon/src/daemon/start.ts`, `apps/daemon/src/daemon/services.ts`, `apps/daemon/src/main.ts`
- Test: `apps/daemon/src/daemon/start.test.ts` (one new row)

**Interfaces:**

- Produces:
  ```ts
  // daemon/worktree-root.ts
  export const DEFAULT_WORKTREE_BASE: string; // join(homedir(), '.10db', 'worktrees')
  /** `<base>/<first 8 hex of sha256 of the data dir's real path>`. */
  export function worktreeRootFor(base: string, dataDir: string): string;
  export class WorktreeRootError extends Error { override readonly name = 'WorktreeRootError'; }
  /** Refuses a root at or under a checkout, the data dir or the lane temp root, by real path even before it exists. */
  export function assertWorktreeRootAllowed(root: string, forbidden: {
    readonly checkouts: readonly string[]; readonly dataDir: string; readonly tempRoot: string | null;
  }): void;
  // DaemonOptions gains: worktreeRoot?: string   (the base; the hash level is appended)
  // DaemonEnv gains: TENDB_WORKTREE_ROOT: z.string().startsWith('/').optional()

  // delivery/worktree-seed.ts
  /** Ignored directories (from `ignoredDirectories`) whose last component is a seed name, none inside another. */
  export function seedDirs(ignored: readonly string[], names: readonly string[]): string[];
  export interface SeedResult { readonly files: number; readonly links: number; readonly skipped: readonly string[] }
  export async function seedWorktree(input: {
    readonly from: string; readonly to: string; readonly dirs: readonly string[]; readonly signal: AbortSignal;
  }): Promise<SeedResult>; // rejects with the signal's reason when aborted
  ```
- `startDaemon` computes `worktreeRoot = worktreeRootFor(opts.worktreeRoot ?? DEFAULT_WORKTREE_BASE, opts.dataDir)` after the database opens, calls `assertWorktreeRootAllowed` with every project's checkout, the data dir and the sandbox temp root, and passes it to `createGit` as `worktreeRoot` and inside `laneRoots`. It keeps it for Task 5's `DeliveryContext.worktreeRoot`. `createProject` (services) refuses a checkout the root lies at or under (`InvalidError`, 400).

- [ ] **Step 1: Write the failing root tests**

`daemon/worktree-root.test.ts` (temp dirs only):

| name                                              | root                                         | ok    |
| ------------------------------------------------- | -------------------------------------------- | ----- |
| `a root outside everything`                       | `<tmp>/wt/<hash>`                            | true  |
| `inside a registered checkout`                    | `<repo>/.wt/<hash>`                          | false |
| `the data dir itself`                             | `<data>`                                     | false |
| `under the data dir`                              | `<data>/wt`                                  | false |
| `under the lane temp root`                        | `<tmpRoot>/wt`                               | false |
| `reached through a link into a checkout`          | `<tmp>/link-to-repo/wt` (link → repo)        | false |
| `not created yet, under a checkout`               | `<repo>/a/b/c` (none exist)                   | false |

Plus `hashes the data dir's real path`: two data dirs give two levels; a link to a data dir gives the same level as the dir.

`env.test.ts`: `TENDB_WORKTREE_ROOT must be absolute`. `options-from-env.test.ts`: `passes TENDB_WORKTREE_ROOT as worktreeRoot`. `start.test.ts`: `refuses to start when the worktree root lies inside a registered checkout` (seed a project, pass `worktreeRoot` inside its checkout; `startDaemon` rejects with `WorktreeRootError`).

- [ ] **Step 2: Write the failing seed tests**

`seedDirs` table:

| name                                   | ignored                                              | names               | expected                          |
| -------------------------------------- | ---------------------------------------------------- | ------------------- | --------------------------------- |
| `top level`                            | `['node_modules', 'dist']`                           | `['node_modules']`  | `['node_modules']`                |
| `nested in a tracked directory`        | `['apps/web/node_modules']`                          | `['node_modules']`  | `['apps/web/node_modules']`       |
| `matches the last component only`      | `['node_modules-old', 'x/node_modules/y']`           | `['node_modules']`  | `[]`                              |
| `drops one inside another chosen dir`  | `['node_modules', 'node_modules/.pnpm/node_modules']` | `['node_modules']` | `['node_modules']`                |
| `several names`                        | `['node_modules', 'target']`                         | `['node_modules', 'target']` | both                      |

`seedWorktree` rows, each on a temp `from` and `to` (with the parent dirs `to` has):

- `clones regular files with their bytes and mode` (a `0o755` file stays executable).
- `makes directories with their mode`.
- `copies a link as a link and never follows it` — an absolute link to `/etc`, a relative link, a dangling link; `readlinkSync` matches, `lstat` is a link, nothing under `/etc` was read (assert the target dir in `to` doesn't exist).
- `skips a FIFO and a socket` (`mkfifo` via `execFileSync('mkfifo')`; a socket via `net.createServer().listen(path)`), listed in `skipped`.
- `skips a seed dir whose parent is not in the worktree`.
- `refuses a destination that already exists` (`EEXIST`).
- `stops when the signal aborts` — abort after the first file via a wrapping `AbortController` driven from a test hook is fragile; instead abort before the call and assert it rejects with the signal's reason and wrote nothing.

- [ ] **Step 3: Run them; expect failures**

Run: `pnpm --filter @10db/daemon exec vitest run src/daemon/worktree-root.test.ts src/delivery/worktree-seed.test.ts src/env.test.ts src/daemon/options-from-env.test.ts`
Expected: FAIL (modules missing).

- [ ] **Step 4: Implement the root**

`assertWorktreeRootAllowed`: real path of the nearest existing ancestor of `root` joined with the rest; compare it, folded with `foldPathCase`, against the real path of each forbidden path (equal or under). Error message names which kind of place (a checkout, the data dir, the temp root) and both paths. Wire into `env.ts`, `.env.example` (comment: "Where 10db makes worktrees for worktree-mode projects; default ~/.10db/worktrees. A level named after the data dir is added under it."), `options-from-env.ts`, `startDaemon`, `services.createProject`.

- [ ] **Step 5: Implement the seed walk**

```ts
const CLONE_CONCURRENCY = 16;

export async function seedWorktree(input: SeedInput): Promise<SeedResult> {
  const result = { files: 0, links: 0, skipped: [] as string[] };
  const clones = new Set<Promise<void>>();
  const throwIfAborted = (): void => input.signal.throwIfAborted();

  async function clone(src: string, dst: string): Promise<void> {
    while (clones.size >= CLONE_CONCURRENCY) await Promise.race(clones);
    const job = copyFile(src, dst, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE).then(() => {
      result.files += 1;
    });
    clones.add(job);
    void job.finally(() => clones.delete(job)).catch(() => undefined);
  }

  async function walk(src: string, dst: string): Promise<void> {
    throwIfAborted();
    const st = await lstat(src);
    if (st.isSymbolicLink()) {
      await symlink(await readlink(src), dst); // as a link, never followed
      result.links += 1;
    } else if (st.isDirectory()) {
      await mkdir(dst, { mode: st.mode & 0o7777 });
      for (const name of await readdir(src)) await walk(join(src, name), join(dst, name));
    } else if (st.isFile()) {
      await clone(src, dst);
    } else {
      result.skipped.push(src); // FIFOs, sockets, devices
    }
  }

  for (const dir of input.dirs) {
    const parent = dirname(join(input.to, dir));
    if (!(await isPlainDirectoryAsync(parent))) {
      result.skipped.push(dir);
      continue;
    }
    await walk(join(input.from, dir), join(input.to, dir));
  }
  await Promise.all(clones);
  throwIfAborted();
  return result;
}
```

The first rejected clone rejects `Promise.all` (or a later `race`), which rejects the seed. `isPlainDirectoryAsync` is `lstat(...).isDirectory()` (a link parent counts as missing). Directory recursion is sequential; only file clones overlap.

- [ ] **Step 6: Run the suites**

Run: `pnpm --filter @10db/daemon exec vitest run src/daemon src/delivery/worktree-seed.test.ts src/env.test.ts`
Expected: PASS; `start.test.ts`'s existing rows unchanged.

- [ ] **Step 7: Commit**

```bash
git add apps/daemon/src/daemon apps/daemon/src/delivery/worktree-seed.ts apps/daemon/src/delivery/worktree-seed.test.ts apps/daemon/src/env.ts apps/daemon/src/env.test.ts apps/daemon/.env.example apps/daemon/src/main.ts && git commit -m 'feat(daemon): add the worktree root and the seed copy' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_018BmFCKUAT9ouhdy3mHWbVt'
```

---

### Task 4: `checkoutOf`, and every workstream consumer and sandbox on it

**Files:**

- Create: `apps/daemon/src/delivery/checkout.ts`, `apps/daemon/src/delivery/checkout.test.ts`
- Modify: `apps/daemon/src/delivery/index.ts`, `apps/daemon/src/runner/runner.ts`, `apps/daemon/src/mcp/tools.ts`, `apps/daemon/src/recovery/recover.ts`, `apps/daemon/src/delivery/ship.ts` (only the gate's `checkouts` list)
- Test: `apps/daemon/src/runner/runner.test.ts` (new rows), `apps/daemon/src/mcp/tools.test.ts` (or the file holding the commit tool's tests), `apps/daemon/src/recovery/recover.test.ts` (new row), `apps/daemon/src/sandbox/lane-sandbox.test.ts` (new row), `apps/daemon/test/gate-sandbox.seatbelt.test.ts` (new probe)

**Interfaces:**

- Produces:
  ```ts
  // delivery/checkout.ts
  /** Where a workstream works (W7): its batch's worktree when it has one, else the project's checkout. */
  export function checkoutOf(db: DbReader, ws: { readonly projectId: ProjectId; readonly batchId: BatchId | null }): string;
  export function batchCheckout(db: DbReader, batch: BatchDto): string;
  /** Every registered checkout and every live worktree (W8, W14): what every sandbox denies writes to. */
  export function allCheckouts(db: DbReader): string[];
  /** The project as the sandboxes and the gate see it from a checkout: only `repoPath` differs. */
  export function projectAtCheckout<P extends { readonly repoPath: string }>(project: P, checkout: string): P;
  ```

Replace `project.repoPath` with the workstream's checkout in: `runner.ts` (the `readRepoMcp` call in `readProjectMcp`, which takes the checkout as a parameter; `currentBranch`/`head` before the first session; `laneSandbox.forSession({ project: projectAtCheckout(project, checkout), checkouts: allCheckouts(db) })`; `cwd`; `allowedToolsFor(..., { sandboxed: { checkout } })`; `judgeToolUse({ repoPath: checkout })`; `claimedChanges`; the gate's `project` and `checkouts`; `head`/`commitsSince` for evidence), `mcp/tools.ts` (`commit`'s judge and `repo`; `write_handoff`'s `head`, `changedFilesSince`, `commitsSince`), `recovery/recover.ts` (`head`, `changedPaths`). `ship.ts`'s `runGate` passes `checkouts: allCheckouts(db)` now; its checkout changes in Task 7. MCP approvals keep reading the main checkout's `.mcp.json` in `daemon/services.ts` (unchanged).

- [ ] **Step 1: Write the failing tests**

- `delivery/checkout.test.ts`: `no batch → the project's checkout`, `a shared batch → the project's checkout`, `a worktree batch → its worktree`, `a worktree batch after removal → the project's checkout`, `allCheckouts lists every project and every live worktree, not a cleared one`.
- `runner.test.ts`, `describe('in a worktree batch')` (seed a worktree-mode project, a real worktree from `createTempRepoWithOrigin` + test git `worktree add`, a batch with `worktreePath`, its pin set through the test's `git.addWorktree` so `pinned()` accepts it): `the session runs in the worktree` (FakeAdapter's recorded `spec.cwd`), `the lane sandbox gets the worktree as the checkout and every checkout in checkouts` (a recording `LaneSandbox` stub), `the gate runs in the worktree` (`gate.run` stub records `project.repoPath`), `a write outside the worktree is denied` (preToolUse with a `file_path` in the main checkout → deny).
- MCP tools: `commit in a worktree batch commits on its branch in the worktree and leaves the main checkout alone`; `write_handoff reads changes from the worktree`.
- `recovery/recover.test.ts`: `reads head and changes from the worktree of a worktree batch`.
- `lane-sandbox.test.ts`: `a worktree batch's profile denies the main checkout, a sibling worktree, its git dir, its gitfile and the common dir, and reads the common dir` — real repo, two worktrees under a temp root; `forSession({ project: projectAtCheckout(p, wtA), checkouts: [main, wtA, wtB] })`; assert `denyWrite` holds `main`, `wtB`, `<wtA>/.git`, `<common>/worktrees/<a>`, `<common>`; `allowWrite` holds `wtA` and not `main`; reads include `<common>`.
- `gate-sandbox.seatbelt.test.ts`: `a gate in a worktree can't write the main checkout or a sibling worktree` (skips when `SANDBOXED` or not macOS, as the file's other rows do).

- [ ] **Step 2: Run them; expect failures**

Run: `pnpm --filter @10db/daemon exec vitest run src/delivery/checkout.test.ts src/runner src/mcp src/recovery src/sandbox/lane-sandbox.test.ts`
Expected: FAIL (`checkoutOf` missing; cwd is the main checkout).

- [ ] **Step 3: Implement `checkout.ts` and thread it through**

`checkoutOf` reads `getBatch` only when `batchId` is set. Each consumer computes the checkout once per operation (per session, per verify, per tool call) from the row it already read.

- [ ] **Step 4: Run every daemon suite**

Run: `pnpm --filter @10db/daemon test`
Expected: PASS; runner, mcp, recovery and sandbox suites' existing rows unchanged.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/delivery/checkout.ts apps/daemon/src/delivery/checkout.test.ts apps/daemon/src/delivery/index.ts apps/daemon/src/delivery/ship.ts apps/daemon/src/runner apps/daemon/src/mcp apps/daemon/src/recovery apps/daemon/src/sandbox/lane-sandbox.test.ts apps/daemon/test/gate-sandbox.seatbelt.test.ts && git commit -m 'feat(daemon): run each workstream in its batch checkout' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_018BmFCKUAT9ouhdy3mHWbVt'
```

---

### Task 5: Starting and cutting in worktree mode

**Files:**

- Create: `apps/daemon/src/delivery/grouping.ts`, `grouping.test.ts`, `worktree-path.ts`, `worktree-path.test.ts`, `worktree-cut.ts`, `worktree-start.test.ts`
- Modify: `apps/daemon/src/delivery/start.ts`, `jobs.ts`, `jobs.test.ts` (new rows only), `cards.ts`, `context.ts`, `branch-name.ts`, `index.ts`, `apps/daemon/src/daemon/start.ts` (`worktreeRoot` into the delivery context)
- Modify: `apps/daemon/test/delivery-harness.ts` (options `workspaceMode`, a temp worktree root, `createGit({ worktreeRoot })`)

**Interfaces:**

- Consumes: Task 1 stores, Task 2 `Git` methods, Task 3 `seedDirs`/`seedWorktree`, Task 4 `checkoutOf`.
- Produces:
  ```ts
  // delivery/grouping.ts
  export interface TaskGroup { readonly title: string; readonly tasks: readonly TaskDto[] }
  /** W3: tasks linked by a dependency inside the set share a group; set order kept; titled after the
   *  first task in set order with no dependency inside the set. */
  export function groupByDependency(tasks: readonly TaskDto[]): TaskGroup[];

  // delivery/branch-name.ts: export function slugOf(text: string, fallback: string): string  (batchBranchName uses it)

  // delivery/worktree-path.ts
  /** `<root>/<project slug>-<last 6 hex of the project id>/<branch leaf>` (W4). */
  export function worktreePathFor(root: string, project: Pick<ProjectDto, 'id' | 'name'>, branch: string): string;

  // delivery/jobs.ts
  export const JobQueue = { Cut: 'cut', Ship: 'ship' } as const;
  export type JobQueue = (typeof JobQueue)[keyof typeof JobQueue];
  /** W13: worktree projects get a cut queue and a ship queue; shared projects keep one. */
  export function jobKey(project: Pick<ProjectDto, 'id' | 'workspaceMode'>, queue: JobQueue): string;

  // delivery/context.ts: DeliveryContext gains `readonly worktreeRoot: string` (the hashed level)

  // delivery/start.ts
  export interface BatchStarter {
    startBatch(projectId: ProjectId, input: BatchStartInput): BatchDto[];
    startTask(taskId: TaskId): BatchDto;
  }

  // delivery/worktree-cut.ts
  export async function cutWorktree(ctx: DeliveryContext, batchId: BatchId, plans: Plans, signal: AbortSignal): Promise<void>;
  export const worktreeLockReason = (id: BatchId): string => `10db ${id}`;

  // delivery/cards.ts
  export const worktreeCards: {
    pathExists(batch: BatchDto, path: string): Card;
    seedFailed(batch: BatchDto, error: unknown): Card;
    missing(batch: BatchDto, path: string, outcome: 'waits' | 'failed'): Card;    // Task 6 and 8 use it
    keptDirty(batch: BatchDto, path: string, paths: readonly string[]): Card;     // Task 7
    leftBehind(batch: BatchDto, path: string): Card;                              // Tasks 7 and 8
    notWhole(batch: BatchDto, path: string, found: string | null, paths: readonly string[]): Card; // Task 7
  };
  ```

**Start in worktree mode** (`startBatch` dispatches on `project.workspaceMode`; the shared path is today's code with `jobKey(project, Cut)` and `jobKey(project, Ship)`, plus decision 19's `batchId` check):

1. Request checks, all before any write (decision 15): `checkStartable` per task (today's); `input.batchId` given → join path below; else `groupByDependency(tasks)`, and per group `unfinishedDependencies(db, group.tasks, new Set(group ids))` (card + 409, as today). Plans resolved per task (`planForStart`).
2. Per group, one `ctx.state.write`: `id = mintId('Batch')`, `branch = batchBranchName(group.title, id)`, `insertBatch({ id, projectId, title: group.title, baseBranch, worktreePath: worktreePathFor(realRoot, project, branch) })`, then `insertPlannedWorkstream(w, task.id, plan, id)` for each task. `realRoot` is `ctx.worktreeRoot` made with `mkdirSync(..., { recursive: true, mode: 0o700 })` and read back with `realpathSync` once per start.
3. Per group, `ctx.jobs.run(jobKey(project, Cut), (signal) => cutWorktree(ctx, id, plans, signal))`. Answer the inserted rows in group order.
4. `startTask` in worktree mode makes a batch of one and answers it; it never joins.
5. **Join** (`batchId` given): the batch must belong to the project and be `OPEN` (Task 7 adds `FAILED`); else `ConflictError`. Unfinished dependencies are checked against the batch's tasks plus these. The job runs in the cut queue: `currentBranch(worktree) === batch.branch` (else `wrongBranchCard(batch, current, worktree, 'not_joined')`), unmerged dependencies, then the existing join transaction.

**Cut** (`cutWorktree`), checks in order; each refusal runs `refuse(card)`:

```ts
const refuse = async (card: Card): Promise<void> => {
  if (made.worktree) await ctx.git.removeWorktree(project.repoPath, path).catch(log);
  if (made.branch && made.base) await ctx.git.deleteBranchIfAt(project.repoPath, branch, made.base).catch(log);
  ctx.state.write((w) => deleteCuttingBatch(w, batchId, card.title)); // cancels and detaches its workstreams
  raise(ctx.inbox, project.id, forTasks(card, plans.keys()));
};
```

1. `remoteUrl(main, 'origin') === null` → `startCards.noOrigin`.
2. `githubRepoOf(await pinnedPushUrl(main))` null → `startCards.repoUnknown` (a changed origin throws `GitTrustError` first; the catch-all refuses with `notStarted`, and the trust card is raised by `onRefused`).
3. `fetch(main, base)` → `startCards.fetchFailed`.
4. `gh.authStatus` → `startCards.ghUnavailable`.
5. `unmergedDependencies` → `startCards.unmergedDependencies`.
6. `filtersIn(main, 'refs/remotes/origin/<base>')` non-empty → `startCards.usesFilters`.
7. `existsAsEntry(path)` → `worktreeCards.pathExists`.
8. `addWorktree({ repo: main, path, branch, startPoint: 'refs/remotes/origin/<base>', lockReason: worktreeLockReason(id) })` → `baseSha`; `made.worktree = made.branch = true; made.base = baseSha`. A throw here has already cleaned up after itself (Task 2), so `refuse(startCards.notStarted(error))` with `made` still false.
9. `seedWorktree({ from: main, to: path, dirs: seedDirs(await git.ignoredDirectories(main), project.worktreeSeed), signal })` → on a non-abort error `worktreeCards.seedFailed`. Log the result (`files`, `links`, `skipped`).
10. One write: `patchBatch({ branch, baseSha, repo })`, `transitionBatch(OPEN, 'worktree cut')`. Then `ctx.onWorkQueued()`.

Shutdown (`signal.aborted`) at any point returns without refusing: the `CUTTING` row stays for recovery (Task 8), as in shared mode. Not checked in worktree mode: lanes running, the main checkout's branch or cleanliness.

- [ ] **Step 1: Write the failing pure tests**

`grouping.test.ts`:

| name                                           | set (deps)                              | groups (titles)                      |
| ---------------------------------------------- | --------------------------------------- | ------------------------------------ |
| `independent tasks`                            | A, B, C                                 | `[A] [B] [C]`                        |
| `a chain and an independent task`              | A, B→A, C                               | `[A,B] (A)`, `[C] (C)`               |
| `a chain given dependent first`                | B→A, A                                  | `[B,A] (A)`                          |
| `linked through a third task`                  | A, B, C→A, C→B                          | `[A,B,C] (A)`                        |
| `a dependency outside the set doesn't link`    | A→X, B→X (X not in the set)             | `[A] (A)`, `[B] (B)`                 |

`worktree-path.test.ts`: `names the project slug, the id's last 6 hex and the branch leaf`, `an empty slug falls back to project`. `jobs.test.ts`: `a cut queue job runs while the same project's ship queue job waits` (one job in `p:ship` awaiting a deferred promise; a `p:cut` job completes first), `jobKey keeps one queue in shared mode`.

- [ ] **Step 2: Write the failing start tests**

`delivery/worktree-start.test.ts` on `createDeliveryHarness({ workspaceMode: 'worktree' })`:

- `three task starts make three CUTTING batches with their workstreams queued, then three worktrees and branches` — after `jobs.idle()`: three `OPEN` batches, `git worktree list` holds three `10db bat_…`-locked entries under the root, three `refs/heads/10db/*`, each worktree on its branch with `README.md`, every workstream `QUEUED` with its batch.
- `a second start of a task whose cut is in flight is refused as already running` (start, then start again before `jobs.idle()`: `ConflictError`).
- `a set with a chain and an independent task makes two batches, titled after the chain's first task`.
- `starts while another batch of the project is cutting or shipping`.
- `leaves a dirty main checkout on another branch exactly as it was` — before: `git switch -c mine`, an uncommitted edit and an untracked file; after three cuts: same branch, `rev-parse HEAD`, `ls-files -s`, `status --porcelain`, file bytes.
- `seeds node_modules by clone and seeds nothing else` — an ignored `node_modules/pkg/index.js` and an ignored `dist/` in the main checkout; the worktree has the first, not the second.
- Refusal table, each row asserting: the card's title, the batch row gone, the task's workstream `CANCELLED` with `batchId` null, `startTask` for the same task succeeds afterwards (then is left to cut or not), `git worktree list` holds only the main checkout, nothing at the path, and no `refs/heads/10db/*` left:

| name                                   | setup                                                           | card                               |
| -------------------------------------- | --------------------------------------------------------------- | ---------------------------------- |
| `no origin`                            | `git remote remove origin` after the pin                        | `has no remote named origin`       |
| `origin is not GitHub`                 | project pinned with a non-GitHub origin                         | `is not a github.com repository`   |
| `the base branch is missing on origin` | project `baseBranch: 'nope'`                                    | `git fetch origin nope failed`     |
| `gh is signed out`                     | `gh.fail('authStatus', signed_out)`                             | `gh is signed out`                 |
| `gh is not installed`                  | `gh.fail('authStatus', not_installed)`                          | `gh is not installed`              |
| `a dependency is not merged`           | a dependency done in a `SHIPPED` batch whose PR is open         | `depend on code that is not on the base branch` |
| `the base tree uses filters`           | a `.gitattributes` with `filter=lfs` pushed to origin's main    | `uses git filters`                 |
| `the worktree path exists`             | `mkdir` the computed path before the job runs                   | `already exists` (`worktreeCards.pathExists`), the directory kept |
| `the seed can't be read`               | an ignored `node_modules/locked` with mode `000`                | `seedFailed`; the branch made by the cut is deleted too |

- `a shutdown mid-cut leaves the CUTTING row for recovery` (the fetch hangs through `test/hanging-ssh.ts` in the harness's `networkEnv`, as the shared suite's shutdown rows do; `jobs.stop()`; the row is still `CUTTING` and nothing is listed).
- `a fix task with batchId joins an OPEN worktree batch` (workstream gets the batch; no new batch; no new worktree).
- `a fix task with batchId naming a FAILED worktree batch answers 409 until reopening exists` — delete this row in Task 7.
- Shared: `start.test.ts` unchanged; add one row there only if decision 19 needs it: `a batchId that is not the unfinished batch is refused`.

- [ ] **Step 3: Run them; expect failures**

Run: `pnpm --filter @10db/daemon exec vitest run src/delivery`
Expected: FAIL (no grouping; `startBatch` answers an object).

- [ ] **Step 4: Implement grouping, path, queues, cards, the start dispatch and `cutWorktree`**

`groupByDependency` is union-find over `dependsOn` restricted to the set's ids, emitting groups in the order of their first member, members in set order. `startBatch` answers `BatchDto[]` in both modes (shared: `[batch]`). `ApiServices` changes in Task 9; until then `daemon/services.ts`'s `startBatch` answers the first batch and throws `InvalidError` when there is none, so this task leaves the HTTP answer as it is.

- [ ] **Step 5: Run the delivery suites**

Run: `pnpm --filter @10db/daemon exec vitest run src/delivery test/batch-delivery.test.ts`
Expected: PASS; `start.test.ts`, `ship.test.ts`, `recover.test.ts`, `jobs.test.ts`' old rows unchanged.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/delivery apps/daemon/src/daemon/start.ts apps/daemon/src/daemon/services.ts apps/daemon/test/delivery-harness.ts && git commit -m 'feat(daemon): cut one worktree and branch per task in worktree mode' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_018BmFCKUAT9ouhdy3mHWbVt'
```

---

### Task 6: Launching per batch, scoped claims and one watch per checkout

**Files:**

- Modify: `apps/daemon/src/scheduler/scheduler.ts`, `apps/daemon/src/delivery/launch-rule.ts`, `apps/daemon/src/delivery/index.ts`, `apps/daemon/src/watcher/watcher.ts`, `apps/daemon/src/watcher/strays.ts`, `apps/daemon/src/daemon/start.ts`
- Test: `apps/daemon/src/scheduler/scheduler.test.ts` (new `describe`), `apps/daemon/src/watcher/watcher.test.ts` (new `describe`)

**Interfaces:**

- Consumes: `checkoutOf`, `batchCheckout` (Task 4), `worktreeCards.missing` (Task 5), `acquireClaims({ areaScope })` (Task 1).
- Produces:
  ```ts
  // delivery/launch-rule.ts
  export function flagWorktreeMissing(inbox: InboxService, batch: BatchDto, path: string): void;
  // SchedulerOptions gains:
  readonly onWorktreeMissing: (batch: BatchDto, path: string) => void;
  // onWrongBranch's third argument is the checkout (the worktree in worktree mode)
  // strays.ts: strayFoldKey(scope: string, rel), bulkFoldKey(scope), foreignBulkFoldKey(scope) take a string scope
  ```

**Scheduler.** `branchSnapshot` becomes a snapshot keyed by checkout path: for each `QUEUED` workstream of a `pull_request` project, if its batch is a worktree batch, read it only when the batch is `OPEN` with `branch` and `baseSha` set (decision 17); a path `lstat` can't find goes into a `missing` set; otherwise `currentBranch(path)` as today (a `GitTrustError` leaves no entry). Shared batches read `project.repoPath` as today. In `launchQueued`, a worktree batch whose path is missing calls `onWorktreeMissing` once (the `warned` set) and continues; otherwise `batchLaunchVerdict(batch, branches.get(checkout))` and `onWrongBranch(batch, current, checkout)`. `acquireClaims` gets `areaScope: batch.id` when the batch has a `worktreePath`.

**Watcher.** `watched` is keyed by the checkout's path: `{ projectId, batchId: BatchId | null, root, handle }`; `pending` too. `sync()` wants every checkout of a workstream in `WATCHED_STATES` (`checkoutOf`). In `straysIn` and `raiseForeign`, holders for **area** claims are the workstreams of the batch (worktree) or the project (shared); for **hazard** claims always the project's (W9). `stepEnd` reads `checkoutOf(ws)`. In worktree mode the fold-key scope is the batch id and a card's body is `<worktree path>: <rel>` (decision 18); shared mode keeps the project id and the bare path, so existing rows stay unchanged.

- [ ] **Step 1: Write the failing scheduler tests**

`describe('worktree batches')` in `scheduler.test.ts`, with a fake `branches` reader keyed by path and temp dirs standing in for worktrees:

- `launches three batches' work in one tick with the same area claimed` — three `OPEN` worktree batches, each with one `QUEUED` workstream claiming `ui`; `maxLanes: 3`; one `tick()` launches 3; three active `ui` claims with three scopes.
- `a hazard still serializes them` — the tasks claim hazard `docker`: one launches.
- `waits with one folded card while a worktree is missing` — remove the dir; two ticks; one `onWorktreeMissing` call; nothing launched.
- `waits without a card while a worktree is unpinned` — the reader throws `GitTrustError`: nothing launched; neither callback called.
- `waits on another branch and names the worktree` — `onWrongBranch` gets the worktree path.
- `reads nothing for a cutting batch` — the reader records no call for its path.

- [ ] **Step 2: Write the failing watcher tests**

`describe('worktree checkouts')` in `watcher.test.ts` (fake `WatchFn` recording roots; real git worktrees for `changedPaths`):

- `watches each live worktree with work in it and stops when its work ends`.
- `a write in a worktree is judged by its batch's areas` — batch A holds `ui`; a write to `src/ui/x` in A's worktree is no stray; the same write in B's worktree (B holds `api`) is a stray card whose body leads with B's path.
- `a hazard claim held in another batch still excuses nothing and still counts as held` — `findForeignClaimWrites` sees project-wide hazard holders.
- `two worktrees writing the same path raise two cards` (different fold keys).

- [ ] **Step 3: Run them; expect failures**

Run: `pnpm --filter @10db/daemon exec vitest run src/scheduler src/watcher`
Expected: FAIL (one launch, not three; one watch per project).

- [ ] **Step 4: Implement, and wire `onWorktreeMissing: (b, p) => flagWorktreeMissing(inbox, b, p)` in `daemon/start.ts`**

- [ ] **Step 5: Run the suites**

Run: `pnpm --filter @10db/daemon exec vitest run src/scheduler src/watcher src/delivery`
Expected: PASS; existing scheduler and watcher rows unchanged.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/scheduler apps/daemon/src/watcher apps/daemon/src/delivery/launch-rule.ts apps/daemon/src/delivery/index.ts apps/daemon/src/daemon/start.ts && git commit -m 'feat(daemon): launch and watch worktree batches each in their own checkout' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_018BmFCKUAT9ouhdy3mHWbVt'
```

---

### Task 7: Shipping, cleanup, Retry and Abandon in a worktree

**Files:**

- Create: `apps/daemon/src/delivery/worktree-cleanup.ts`, `apps/daemon/src/delivery/worktree-repair.ts`, `apps/daemon/src/delivery/worktree-ship.test.ts`
- Modify: `apps/daemon/src/delivery/ship.ts`, `start.ts` (join to `FAILED`), `cards.ts`, `index.ts`, `apps/daemon/src/team/steps.ts`, `apps/daemon/src/daemon/start.ts`, `apps/daemon/src/daemon/services.ts`
- Test: `apps/daemon/src/team/steps.test.ts` (or the retry suite) new row; delete Task 5's temporary 409 row

**Interfaces:**

- Produces:
  ```ts
  // delivery/worktree-cleanup.ts
  /** W12/W14 after SHIPPED or CLOSED: remove the worktree (and its pin), delete a CLOSED batch's branch at
   *  its base, then clear worktree_path. Safe to repeat; a no-op once cleared. */
  export async function retireWorktree(ctx: DeliveryContext, batchId: BatchId): Promise<void>;
  /** After ABANDONED: retire a clean or missing worktree; keep a dirty one and raise keptDirty. */
  export async function abandonWorktree(ctx: DeliveryContext, batchId: BatchId): Promise<void>;

  // delivery/worktree-repair.ts
  export type Wholeness = 'whole' | 'replaced' | 'refused';
  /** Spec §5 Retry: keep a whole worktree, else replace it from the existing branch (W5 without update-ref, plus
   *  the seed). Refuses (card) over a worktree on another branch with uncommitted changes (decision 8). */
  export async function ensureWorktreeWhole(ctx: DeliveryContext, batch: BatchDto, signal: AbortSignal): Promise<Wholeness>;
  /** Decision 14: in the cut queue, make the worktree whole, then FAILED → OPEN and ask for a tick. */
  export function reopenWorktreeBatch(ctx: DeliveryContext, batchId: BatchId, reason: string, then?: (w: WriteContext) => void): void;
  // BatchStarter gains: reopen(batchId: BatchId): void   (used by the composition root after a workstream Retry)
  ```

**Whole** means: `existsAsEntry(path)`, `git.gitDirs(path)` resolves (pinned), `existsSync(join(gitDir, 'index'))`, and `currentBranch(path) === batch.branch`. Otherwise: if something is at the path and `currentBranch` reads a branch other than `batch.branch` (or a detached HEAD) **and** `changedPaths(path)` is non-empty → `worktreeCards.notWhole(...)`, `'refused'`. Else `removeWorktree(main, path)` (a `WorktreeNotOursError` → `leftBehind` card, `'refused'`), then `addWorktree({ ..., startPoint: null })`, then the seed, `'replaced'`.

**Ship** (`shipSteps`) for a worktree batch: step −1 `ensureWorktreeWhole` (`'refused'` fails the batch with `failure: WrongBranch` and the card it raised); step 0 `currentBranch(worktree)` and `changedPaths(worktree)` (the dirty card names the worktree path: `shipCards.dirtyCheckout` gains an optional `checkout` argument, used in its body only when given, so the shared card is unchanged); step 1 `commitsSince(worktree, …)`; the gate gets `projectAtCheckout(project, worktree)`; the push runs in `project.repoPath` (decision 5); `createPr` reads `head(worktree)` and `readPrTemplate(worktree)`; after step 1's `CLOSED` or step 5's `SHIPPED` transaction, `await retireWorktree(ctx, batchId)` in the same job (the ship queue). `resume` and `checkBatch` use `jobKey(project, Ship)`.

**Retry/reopen.** `ship()` from `FAILED` with unfinished work in a worktree batch calls `reopenWorktreeBatch(ctx, id, 'retried with unfinished work')` and answers the batch as it is (`FAILED`). A fix-task join (`batchId`) on a `FAILED` worktree batch queues `reopenWorktreeBatch` with `then` inserting the new workstreams in the same transaction as `FAILED → OPEN`. `retryWorkstream` (`team/steps.ts`): when the batch is `FAILED` and has a `worktreePath`, it re-queues the workstream and leaves the batch `FAILED`; `answerBatchCard`'s `retry` and `services.retryWorkstream` then call `starter.reopen(batchId)` when the retried row's batch is a `FAILED` worktree batch.

**Abandon.** `shipper.abandon` keeps its synchronous checks and transaction; for a worktree batch it then queues `abandonWorktree` in the ship queue. `abandonWorktree`: path null → return; nothing at the path → `retireWorktree`; `changedPaths(path)` non-empty → `worktreeCards.keptDirty(batch, path, paths)` with `foldKey: worktree-kept:<batchId>` and body ending `remove it with git worktree remove --force --force <path>` (decision 7); else `retireWorktree`. A `GitTrustError` reading it keeps it (the trust card explains).

`retireWorktree`: read the batch; `worktreePath === null` → return; `removeWorktree(main, path)` (on `WorktreeNotOursError`: an empty directory is removed with `rmdirSync`, else `leftBehind` card; either way go on, decision 22); if `state === CLOSED` and `branch` and `baseSha`, `deleteBranchIfAt(main, branch, baseSha)`; then `ctx.state.write((w) => clearWorktreePath(w, id))`. Order matters: the clear is last, so recovery re-runs every earlier step after a crash.

- [ ] **Step 1: Write the failing tests**

`delivery/worktree-ship.test.ts` (harness with `workspaceMode: 'worktree'`, commits made in the worktree with the harness's git as the commit tool would):

- `ships a worktree batch: gate in its worktree, its branch pushed, one PR titled after the task, the worktree removed and the main checkout untouched` — the gate command writes `$PWD` to a file under the data dir; assert it is the worktree; origin has `refs/heads/<branch>` at the worktree's HEAD; `gh.prCreate` once with title `feat(app): <task title>`; `worktreePath` null; `git worktree list` holds only main; `getAppSetting(checkout_pin.<id>)` undefined; main's HEAD, index, status unchanged.
- `closes a worktree batch with no commits, removes the worktree and deletes its branch at the base`.
- `keeps a CLOSED batch's branch that moved` — a `CLOSED` row with its worktree still set, the branch moved one commit past `base_sha` by test git; `retireWorktree` removes the worktree and keeps the branch.
- `fails with the worktree's path when it has uncommitted changes`.
- Retry table (`FAILED` worktree batch, then `shipper.ship(id)`; every row ends `SHIPPED` with one PR, or as stated):

| name                                           | before Retry                                                   | expected                         |
| ---------------------------------------------- | -------------------------------------------------------------- | -------------------------------- |
| `keeps a whole worktree`                       | nothing                                                        | same git dir inode; shipped      |
| `rebuilds a missing worktree from the branch`  | `rm -rf` the worktree dir                                      | shipped; seed present            |
| `rebuilds a half-made worktree`                | delete `<gitDir>/index`                                        | shipped                          |
| `rebuilds a clean worktree on another branch`  | `git -C wt switch -c other`                                    | shipped from the batch branch    |
| `refuses a worktree on another branch with changes` | switch and edit a file                                    | `FAILED`, card names the path; the edit is still there |

- `Retry with unfinished work reopens only after the worktree is whole` — `rm -rf` the worktree, a `FAILED` member; after `ship()` and `jobs.idle()`: `OPEN`, worktree back.
- `a fix task joins a FAILED worktree batch and reopens it after making its worktree whole`.
- `a workstream Retry in a FAILED worktree batch reopens it through the cut queue` (through `createBatchCardAnswers` with the composition-root `retry` callback built as in `daemon/start.ts`).
- Abandon: `removes a clean worktree and clears its path`, `keeps a dirty worktree, keeps its path and names it with --force --force`.

`team` suite: `retryWorkstream leaves a FAILED worktree batch FAILED and re-queues the workstream`.

- [ ] **Step 2: Run them; expect failures**

Run: `pnpm --filter @10db/daemon exec vitest run src/delivery/worktree-ship.test.ts src/team`
Expected: FAIL (the gate runs in the main checkout; the worktree stays).

- [ ] **Step 3: Implement cleanup, repair, ship, join-to-FAILED, retry wiring; delete Task 5's temporary row**

- [ ] **Step 4: Run the delivery and team suites**

Run: `pnpm --filter @10db/daemon exec vitest run src/delivery src/team test/batch-delivery.test.ts`
Expected: PASS; `ship.test.ts` and the team suite's old rows unchanged.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/delivery apps/daemon/src/team apps/daemon/src/daemon/start.ts apps/daemon/src/daemon/services.ts && git commit -m 'feat(daemon): ship, retry and abandon worktree batches and remove their worktrees' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_018BmFCKUAT9ouhdy3mHWbVt'
```

---

### Task 8: Startup recovery and the sweep

**Files:**

- Create: `apps/daemon/src/delivery/worktree-sweep.ts`, `apps/daemon/src/delivery/worktree-recover.test.ts`
- Modify: `apps/daemon/src/delivery/recover.ts`, `apps/daemon/src/daemon/start.ts`

**Interfaces:**

- Produces:
  ```ts
  // delivery/worktree-sweep.ts
  /** W12: in each pull_request project's main checkout, remove every worktree under `root` locked
   *  `10db <batch id>` whose batch is gone or whose worktree_path is cleared or different; then prune. */
  export async function sweepWorktrees(deps: { state: StateStore; git: Git; root: string; logger: Logger }): Promise<string[]>;
  // recoverBatches deps gain: worktrees?: { ctx: DeliveryContext; root: string };  BatchRecoveryReport gains: retired: BatchId[]; swept: string[]
  ```

**Order inside `recoverBatches`** (startup order stays: `recoverOnStartup` → `recoverBatches` → scheduler start; `QUEUED` workstreams in a `CUTTING` batch are kept by `recoverOnStartup`'s `KEEP_STATE` and reach step 1 here):

```ts
// 1. CUTTING rows. A worktree one: remove what git lists at its path; an unlisted directory only when empty.
for (const batch of listBatches(db, { states: [BatchState.Cutting] })) {
  const project = getProject(db, batch.projectId);
  let left: string | null = null;
  if (batch.worktreePath !== null) {
    try {
      await deps.git.removeWorktree(project.repoPath, batch.worktreePath);
    } catch (error) {
      if (!(error instanceof WorktreeNotOursError)) throw error;
      if (!removeIfEmptyDirectory(batch.worktreePath)) left = batch.worktreePath;
    }
  }
  deps.state.write((w) => deleteCuttingBatch(w, batch.id, 'the daemon restarted while cutting'));
  raise(deps.inbox, project.id, left ? worktreeCards.leftBehind(batch, left) : startCards.cutInterrupted(batch));
  report.deleted.push(batch.id);
}
// 2. Orphaned shipping gates (unchanged).
// 3. OPEN and SHIPPING: the checkout is batchCheckout(db, batch). A worktree batch whose path is missing
//    fails with worktreeCards.missing(batch, path, 'failed'); one unpinned or off its branch fails with
//    wrongBranchCard(batch, current, path, 'failed'). SHIPPING on its branch resumes (ship step −1 runs first).
//    FAILED worktree batches are left as they are (decision 13).
// 4. Finished batches with a path still set: SHIPPED and CLOSED → retireWorktree; ABANDONED → abandonWorktree.
for (const batch of listLiveWorktrees(db)) {
  if (batch.state === BatchState.Shipped || batch.state === BatchState.Closed) await retireWorktree(ctx, batch.id);
  else if (batch.state === BatchState.Abandoned) await abandonWorktree(ctx, batch.id);
}
// 5. The sweep, after every removal above, so it only catches what no row names.
report.swept.push(...(await sweepWorktrees({ state, git, root: worktrees.root, logger })));
// 6. shipper.checkOpenBatches() (unchanged).
```

`recoverBatches`' deps gain an optional `worktrees?: { readonly ctx: DeliveryContext; readonly root: string }`. `daemon/start.ts` passes its `delivery` context and the hashed root. Without it (`recover.test.ts`, unchanged) steps 4 and 5 are skipped and step 1 treats every `CUTTING` row as today.

`sweepWorktrees`: for each `listProjects` project with `delivery === pull_request` whose checkout exists: `listWorktrees(main)`; for each entry not `bare`, with `lockedBatchId(entry)` set and its path under `root` (`surelyInside` on the real path, or the resolved string when the directory is gone): if `getBatch` finds no row, or the row's `worktreePath` is not `samePath` to the entry → `removeWorktree(main, entry.path)` (catch `WorktreeNotOursError`: log and skip). Then `pruneWorktrees(main)`. A `GitTrustError` on a project skips that project (its card is raised).

- [ ] **Step 1: Write the failing recovery table**

`delivery/worktree-recover.test.ts`. A helper `stateAfter(point)` builds each crash point with the harness's real git and direct store writes (no daemon kill needed: the rows and the repository are left as a crash at that point would leave them), then runs `recoverBatches` and `jobs.idle()`:

| name                                     | left behind                                                                               | expected after recovery                                                     |
| ---------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `after the CUTTING insert`               | row + `QUEUED` workstreams, nothing in git                                                | row gone, workstreams cancelled and detached, `cutInterrupted` card          |
| `after update-ref`                       | + the branch                                                                              | as above; the branch is left alone                                           |
| `after worktree add`                     | + a locked entry with no `index`                                                          | entry removed, directory gone                                                |
| `after read-tree`                        | + files                                                                                    | entry removed                                                                |
| `mid seed`                               | + part of `node_modules`                                                                   | entry removed                                                                |
| `an unlisted empty directory at the path`| row + `mkdir` at the path                                                                  | directory removed                                                            |
| `an unlisted directory with files`       | row + a file at the path                                                                   | directory kept; `leftBehind` card names it; row gone                         |
| `OPEN with its worktree missing`         | `OPEN` row, directory removed                                                              | `FAILED`, card names the path                                               |
| `SHIPPING with its worktree on another branch` | `SHIPPING`, worktree switched                                                       | `FAILED`, wrong-branch card names the worktree                               |
| `OPEN with no pin`                       | `OPEN`, the pin's app setting deleted                                                      | `FAILED`                                                                    |
| `FAILED with its worktree missing`       | `FAILED`                                                                                   | still `FAILED`, no new card                                                 |
| `SHIPPING after the gate`                | `SHIPPING`, gate evidence recorded                                                         | `SHIPPED`, one PR, origin at the worktree HEAD, worktree removed             |
| `SHIPPING after the push`                | + origin has the branch                                                                    | same, origin SHA unchanged, one PR                                           |
| `SHIPPING after gh pr create`            | + `gh` already has the PR                                                                  | same, `prCreate` called zero more times                                      |
| `SHIPPED with its path still set`        | `SHIPPED`, worktree present                                                                | removed, path cleared, pin gone                                             |
| `SHIPPED after the removal, before the clear` | `SHIPPED`, entry already removed                                                      | path cleared                                                                |
| `CLOSED with its path still set`         | `CLOSED`, worktree present, branch at base                                                 | removed, branch deleted, path cleared                                       |
| `ABANDONED clean with its path set`      | `ABANDONED`, clean worktree                                                                | removed, path cleared                                                       |
| `ABANDONED dirty`                        | `ABANDONED`, an edit in the worktree                                                       | kept, path kept, `keptDirty` card                                            |

Every row also asserts `git worktree list` holds only the main checkout and live batches' worktrees.

Sweep table (`sweepWorktrees` directly):

| name                                             | entry                                                              | removed |
| ------------------------------------------------ | ------------------------------------------------------------------ | ------- |
| `a 10db-locked orphan whose batch is gone`       | locked `10db bat_<unknown>`, under the root                        | yes     |
| `a 10db-locked entry whose path was cleared`     | row exists with `worktreePath` null                                | yes     |
| `a live batch's worktree`                        | row with the same path                                             | no      |
| `an unlocked worktree under the root`            | `git worktree add` with no lock                                    | no      |
| `someone else's lock`                            | locked `mine`                                                      | no      |
| `outside the root`                               | locked `10db bat_x` in another temp dir                            | no      |
| `under another data dir's level`                 | locked `10db bat_x` under `<base>/<other hash>`                    | no      |

Plus `prunes after removing`.

- [ ] **Step 2: Run them; expect failures**

Run: `pnpm --filter @10db/daemon exec vitest run src/delivery/worktree-recover.test.ts`
Expected: FAIL (the `CUTTING` row's worktree stays listed; `deleteCuttingBatch` used to fail on its workstreams).

- [ ] **Step 3: Implement the order above and the sweep; pass `worktrees` from `daemon/start.ts`**

- [ ] **Step 4: Run the delivery and crash suites**

Run: `pnpm --filter @10db/daemon exec vitest run src/delivery test/crash-recovery.test.ts`
Expected: PASS; `recover.test.ts` unchanged.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/delivery apps/daemon/src/daemon/start.ts && git commit -m 'feat(daemon): recover worktree batches and sweep orphaned worktrees at startup' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_018BmFCKUAT9ouhdy3mHWbVt'
```

---

### Task 9: API, wiring and the end-to-end test

**Files:**

- Modify: `apps/daemon/src/api/services.ts`, `apps/daemon/src/api/app.ts`, `apps/daemon/src/api/app.test.ts`, `apps/daemon/src/daemon/services.ts`, `apps/daemon/src/daemon/start.ts`
- Modify: `apps/daemon/test/batch-delivery.test.ts` (forced: the batch answer is an array), `apps/daemon/test/api-client.ts` if it wraps the route
- Create: `apps/daemon/test/worktree-delivery.test.ts`

**Interfaces:**

- `ApiServices.startBatch(projectId, input): BatchDto[]`; the route answers `202` with `BatchStartResult`. `startTask` keeps answering one batch (`TaskStarted` unchanged). `PATCH /projects/:id` surfaces `patchProject`'s `InvalidError` (400) and `ConflictError` (409) as today; seed names fail zod (400).

- [ ] **Step 1: Write the failing API tests**

`app.test.ts` (`app.request()` with a stub `ApiServices`, as the file does): `POST /projects/:id/batches answers an array`, `PATCH /projects/:id refuses a seed name with a slash`. Through a real store where the file already does so: `PATCH refuses worktree mode with local delivery (400)`, `PATCH refuses a mode change while a batch is unfinished (409)`, `POST /projects refuses a checkout that holds the worktree root (400)`.

- [ ] **Step 2: Write the failing end-to-end test**

`test/worktree-delivery.test.ts`: `startDaemon({ sandbox: null, gh: FakeGh, networkEnv, worktreeRoot: tempDir('worktrees').path, watch: false, adapter: FakeAdapter(BOOK) })` on `createTempRepoWithOrigin` + `githubOrigin`, a project `delivery: pull_request`, `workspaceMode: worktree`, `maxLanes: 3`, three tasks `Alpha`, `Beta`, `Gamma` all with area `ui`, each script writing `src/ui/<name>.txt` and committing it (the `write`/`commit` helpers of `batch-delivery.test.ts`).

`it('runs three tasks at once in three worktrees, ships three PRs and leaves the main checkout as it was')`:

1. Record the main checkout: `rev-parse HEAD`, `symbolic-ref HEAD`, `ls-files -s`, `status --porcelain`, README bytes. Make it dirty and on a branch of the builder's first (`switch -c mine`, edit README).
2. `POST /projects/:id/batches` with the three tasks: three `CUTTING` batches answered.
3. Wait until all three batches are `SHIPPED`.
4. Assert: the event log has three `claim.acquired` for `ui` before the first `claim.released` (they ran at once); `gh.prCreate` calls are three with three distinct heads and titles `feat(app): Alpha` etc.; origin has three `10db/*` branches each holding its one file and not the others'; `git worktree list` holds only the main checkout; nothing under the worktree root but the empty project dir; the main checkout's recorded values are unchanged.

- [ ] **Step 3: Run them; expect failures**

Run: `pnpm --filter @10db/daemon exec vitest run src/api test/worktree-delivery.test.ts`
Expected: FAIL (the route answers an object).

- [ ] **Step 4: Implement the API change; fix `batch-delivery.test.ts`'s parse to `BatchStartResult` (forced edit, nothing else in that file)**

- [ ] **Step 5: Run the whole daemon suite**

Run: `pnpm --filter @10db/daemon test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/api apps/daemon/src/daemon apps/daemon/test/batch-delivery.test.ts apps/daemon/test/api-client.ts apps/daemon/test/worktree-delivery.test.ts && git commit -m 'feat(daemon): answer every batch a start makes and test three tasks in three worktrees' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_018BmFCKUAT9ouhdy3mHWbVt'
```

---

### Task 10: Desktop

**Files:**

- Modify: `apps/desktop/src/views/board/batch/sheet-mode.ts`, `sheet-mode.test.ts`, `use-start-work.ts`, `batch-sheet.tsx`, `batch-sheet.test.tsx`
- Modify: `apps/desktop/src/views/board/board-view.tsx`, `board-view.test.tsx`, `batch-strip.tsx`, `batch-strip.test.tsx`
- Create: `apps/desktop/src/views/board/batch/add-fix-task.tsx`
- Modify: `apps/desktop/src/views/board/new-project-form.tsx`, `apps/desktop/src/views/settings/project-general-form.tsx`, `general-values.ts`, `general-values.test.ts`, `settings-view.test.tsx`
- Modify: `apps/desktop/src/test/fixtures.ts`

**Interfaces:**

- `sheetMode(project: Pick<ProjectViewDto, 'delivery' | 'currentBatch' | 'workspaceMode'>)`: worktree mode → `{ kind: 'worktrees' }`; `submitLabel` → `Start ${tasks(count)} in worktrees`. `useStartWork` parses `BatchStartResult` for every batch request; for `worktrees` it sends `title` = the first ticked task's title.
- Board: in worktree mode, one `BatchStrip` per `project.openBatches` (newest first); with none, `currentBatch`'s strip as today. Shared mode unchanged.
- `BatchStrip` shows `batch.worktreePath` (monospace `Code`, with Mantine `CopyButton`) when set, and, in worktree mode for an `OPEN` or `FAILED` batch, an "Add a fix task" button opening `AddFixTask` (`Modal` + `Select` of the project's open, unparked tasks with no active workstream), which posts `{ title: batch.title, taskIds: [id], batchId: batch.id }`.
- Project forms: a "Workspace" `SegmentedControl` (`Shared checkout` · `A worktree per task`), shown only for `pull_request` delivery; a "Seed from the main checkout" `TagsInput` (default `node_modules`), shown only in worktree mode, with the help text "Ignored directories cloned into each new worktree, by name". Look up `SegmentedControl`, `TagsInput` and `CopyButton` props with the Mantine MCP server only if their use isn't already in the codebase.

- [ ] **Step 1: Write the failing tests**

- `sheet-mode.test.ts` rows: `worktree mode always starts new work`, `its label says worktrees`.
- `batch-strip.test.tsx`: `shows the worktree path`; `Add a fix task posts the batch id` (MSW handler asserts the body).
- `board-view.test.tsx`: `shows one strip per open batch in worktree mode`.
- `settings-view.test.tsx`: `saves the workspace mode and the seed` (PATCH body); `general-values.test.ts`: the new fields round-trip.
- `batch-sheet.test.tsx`: `starts tasks in worktrees with one request`.

- [ ] **Step 2: Run them; expect failures**

Run: `pnpm --filter @10db/desktop test`
Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run the desktop suite, typecheck and lint**

Run: `pnpm --filter @10db/desktop test && pnpm --filter @10db/desktop typecheck && pnpm --filter @10db/desktop lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src && git commit -m 'feat(desktop): choose worktree mode and show a strip per open batch' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_018BmFCKUAT9ouhdy3mHWbVt'
```

---

### Task 11: Docs, decisions and the gate

**Files:**

- Modify: `docs/architecture/02-batch-delivery.md`, `docs/architecture/03-trust-boundaries.md`, `docs/security.md`, `docs/open-items.md`, `docs/superpowers/specs/2026-10-13-10db-factory-loop-design.md`, `apps/daemon/AGENTS.md`, `apps/desktop/AGENTS.md`
- Modify: the decision record, in whatever format `origin/main` has at the time (see Step 1)

- [ ] **Step 1: Find the decision format**

Run: `git fetch origin main && git ls-tree --name-only origin/main docs/architecture/ docs/architecture/decisions/ 2>/dev/null`
If `origin/main` has a `docs/architecture/decisions/` directory (one file per decision, PR #82), add one file per lasting decision in its format: W1–W14 as built, and this plan's decisions 1, 2, 5, 6, 8, 12, 14 and 22. If `main` still has only the table in `decisions.md`, add no numbered rows: the decisions stay in the spec, and the spec's header gains one line naming this plan's decisions section as their companion.

- [ ] **Step 2: Write the docs**

- `02-batch-delivery.md`: a "Worktree mode" section: the mode and its rule (W1), batches per task and grouping (W2, W3), where worktrees live (W4), cut steps and checks, the two queues (W13), the launch rule, ship and after-ship, Retry, Abandon, recovery and the sweep, `checkoutOf` (W7). Built, not designed.
- `03-trust-boundaries.md`: a worktree is one more checkout: its pin made at creation and keyed by batch, `Unpinned` refusals under the root, the root among lane-writable roots, the profile a worktree lane gets (the main checkout and sibling worktrees denied as other checkouts; its git dir, gitfile and common dir read-only), the seed copy (reads the main checkout, links as links, nothing runs).
- `docs/security.md`: one line: worktree mode adds no process outside the sandbox; the daemon's worktree git calls run under the same config, and the seed copy runs nothing.
- `docs/open-items.md`: tick the worktree item; add the spec's §11 leftovers (ports per worktree; a setup command run in the sandbox; parallel ships behind a limit; rebasing an unmerged PR; a per-task mode choice; dropping `tasks.workspace_mode`) and seeding ignored files (such as `.env`), which seed names (directories) don't cover.
- The factory spec's decision 13 note: worktree mode is built (link the worktree spec).
- `apps/daemon/AGENTS.md`: the `delivery/` bullet gains worktree mode's modules and the two queues; the `git/` bullet gains the worktree calls, pins by batch and `Unpinned`; `TENDB_WORKTREE_ROOT`. `apps/desktop/AGENTS.md`: the batch sheet bullet covers worktree mode and the strips.

- [ ] **Step 3: Run the gate**

Run: `pnpm format && make gate`
Expected: `GATE PASS`. Fix any drift (`generated/`, `drizzle/`), lint or knip finding at its cause.

- [ ] **Step 4: Commit**

```bash
git add docs apps/daemon/AGENTS.md apps/desktop/AGENTS.md && git commit -m 'docs(docs): document worktree mode' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_018BmFCKUAT9ouhdy3mHWbVt'
```

(Add the decision files' paths to the `git add` when Step 1 found the per-file format.)

---

### Task 12: [Travis] Manual acceptance on 10db itself

Not for an agent. Spec §10.

- [ ] Build and run the app from this branch; in Settings › General set 10db's project to pull request delivery, "A worktree per task", seed `node_modules`.
- [ ] Start three UI tasks at once (all claiming `apps/desktop`). Three worktrees appear under `~/.10db/worktrees/<hash>/10db-<6 hex>/`; their lanes run at the same time; the main checkout stays on its branch with your edits in it.
- [ ] `cd` into a worktree in a terminal: `mise` asks for no trust prompt.
- [ ] Three PRs open, each titled after its task, each green in CI; the worktrees are gone afterwards and the branches remain.
- [ ] Abandon a fourth task's batch with an uncommitted edit: the card names the worktree and the `--force --force` command, which removes it.
