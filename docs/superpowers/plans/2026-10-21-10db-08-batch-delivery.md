# 10db Batch Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On a project in `pull_request` delivery, starting tasks cuts a fresh branch from the up-to-date base, the tasks' workstreams run only while that branch is checked out, and when every workstream in the batch is done or cancelled 10db runs the gate on the clean branch, pushes it and opens one pull request, recovering from a crash at any point without a wrong-branch commit, a different push or a second PR.

**Architecture:**

- **Data.** Projects gain `delivery` (`local` | `pull_request`), `base_branch` and `pr_title_prefix`, with database defaults. A new `batches` table holds one row per batch (`CUTTING → OPEN → SHIPPING → SHIPPED | CLOSED | FAILED`, and `ABANDONED`), with a partial unique index that allows one unfinished batch per project. Workstreams gain `batch_id`.
- **Wrappers.** `git/` gains `currentBranch`, `remoteUrl`, `fetch`, `switchNewBranch` and `push`. A new `github/` module wraps the `gh` CLI behind a `Gh` interface (`authStatus`, `repoView`, `prView`, `prCreate`) whose output is parsed with zod. Every network call runs in the captured login environment with prompts off, a timeout and an abort signal.
- **Delivery.** A new `delivery/` module owns the batch lifecycle. The starter validates a start in the request, writes the batch row before any git side effect, and finishes the git and `gh` checks, the branch cut or the join in a background job whose refusals are inbox cards. The shipper runs the shipping steps (branch and clean check, commit count, gate, push, find-or-create PR, record) and the ship trigger moves an `OPEN` batch to `SHIPPING` from `workstream.changed` events. Startup recovery deletes `CUTTING` rows, fails batches whose branch is not checked out, kills an orphaned shipping gate and re-runs shipping from step 0.
- **Integration.** The scheduler launches `pull_request` work only when its batch is `OPEN` and the checkout is on the batch branch, reading the branch once per tick per project. A workstream retry respects its batch. The guard stops agents pushing in `pull_request` projects and mutating PRs or the repository through `gh` in every project.
- **API and UI.** `POST /projects/:id/batches`, `POST /batches/:id/ship` and `POST /batches/:id/abandon`; `GET /projects` carries each project's `currentBatch`. The project form gains the delivery fields, and the Tasks view gains a batch strip.

**Tech Stack:** As in M2a. No new dependencies: `git` and `gh` run through `node:child_process` `execFile` with argument arrays.

**Spec:** `docs/superpowers/specs/2026-10-21-10db-batch-delivery-design.md` (approved; this plan does not change its decisions). It extends `docs/superpowers/specs/2026-10-13-10db-factory-loop-design.md` §4, §5 and §8. This plan implements every section of the batch delivery spec: §3 data (Tasks 1 and 2), §4 lifecycle (Tasks 5, 6, 7 and 9), §5 starting work (Tasks 5 and 7), §6 shipping (Tasks 6 and 9), §7 components (Tasks 3 to 10), §8 API and UI (Tasks 10 and 11) and §10 testing (every task). §9 "Later" is not built; Task 12 records it as open items.

**Plan series:** `00-spikes` … `06-m2a-teams-and-routing`, `07-m2b-board-and-settings` (written in parallel), **`08-batch-delivery` (this file)**. The M2b plan builds its batch approval on this plan's `POST /projects/:id/batches`. That route's contract is fixed here and must not change without updating M2b:

- **Request:** `POST /projects/:projectId/batches` with `BatchStartInput` `{ title: string (1–200), taskIds: TaskId[] (1–50, unique) }`.
- **Answer:** `202` with the `BatchDto` the tasks run in: a new `CUTTING` batch, or the project's `OPEN` or `FAILED` batch they joined. Git and `gh` refusals arrive afterwards as inbox cards and `batch.updated` events (a refused new batch is deleted).
- **Refusals in the request:** `400` for a `local` project or an invalid body or over-budget step plan, `404` for an unknown project or task, `409` while the project's batch is `CUTTING` or `SHIPPING`, for a task that is not open or already running, and for an unfinished dependency outside the batch (which also raises a card).

This plan was written against `origin/docs/batch-delivery-design` at `6ae9adc` (main at `2b3d811` plus the spec). Where a file, signature or anchor it names doesn't match the code, trust the code, adapt the step and say so in the task's report.

## Decisions made in the plan

The spec leaves these open; the plan decides them. Task 12 records the lasting ones in `docs/architecture/decisions.md`.

1. **Batch IDs** are `bat_<uuidv7>` (`BatchId`, minted by `mintId('Batch')`), like every other ID. The branch suffix is the last 8 hex digits of the UUID.
2. **Which refusals answer the request and which are cards.** Refusals the daemon can see without git or the network answer the HTTP request: a `local` project (400), a task that is not open or already running (409), a batch that is `CUTTING` or `SHIPPING` (409), and an over-budget step plan (400, as today). An unfinished dependency outside the batch answers 409 and also raises the card the spec asks for. The four cutting checks, the branch check for a join and the unmerged-PR dependency check run after the API returns, and refuse only with a card.
3. **`POST /projects/:id/batches` joins.** When the project has an `OPEN` batch it joins it, and when it has a `FAILED` batch the tasks are fix tasks that reopen it, exactly as `POST /tasks/:id/start` does; the new title is ignored. It refuses a `local` project with 400.
4. **`POST /tasks/:id/start` answers 201 with the `WorkstreamDto` in a `local` project (unchanged) and 202 with the `BatchDto` in a `pull_request` project.** `TaskStartResult` is the union. Additive: `PROTOCOL_VERSION` stays 2.
5. **The project view is `GET /projects`,** which returns `ProjectViewDto[]`: `ProjectDto` plus `currentBatch` (the unfinished batch, else the latest, else null). `ProjectDto` itself stays the row type every module reads. `WorkstreamDto` gains `batchId`.
6. **Retry from `FAILED` (`POST /batches/:id/ship`) never ships unfinished work.** It ships when every workstream in the batch is `DONE`, `CANCELLED` or `FAILED`; otherwise it reopens the batch (`FAILED → OPEN`) so the unfinished work runs and the batch ships itself. This is the way back for a batch failed at startup for being on the wrong branch while its work was still queued.
7. **Batch actions live on the batch strip.** Spec §4 says a failed workstream's "existing flag card offers Retry and, for the batch, Ship anyway", but today's flag cards carry text and a Dismiss button only. Retry, Ship anyway and Abandon are buttons on the batch strip (and Retry for a workstream stays in the Factory view); every card names the button to use. Answerable actions on flag cards are an open item (Task 12).
8. **A wrong branch at run time pauses, a wrong branch at startup fails.** While the daemon runs, a `QUEUED` workstream whose `OPEN` batch's branch is not checked out waits, and the scheduler raises one folded card "checkout is on X, the batch branch is Y"; the batch stays `OPEN` and its work launches once the builder switches back. At startup such a batch moves to `FAILED`, as the spec says. A join or reopen that finds the wrong branch raises the same card and adds nothing.
9. **Delivery can't change under running work.** Patching a project's `delivery` is refused (409) while it has an unfinished workstream or batch. A `QUEUED` workstream in a `pull_request` project with no batch never launches, so this keeps any from being stranded.
10. **The `gh` rules for agents are allowlists.** `gh pr` allows `view`, `list`, `checks`, `diff` and `status`, which also denies `gh pr checkout` (it would switch the shared checkout's branch). `gh repo` allows `view` and `list`. `gh api` allows GET only; a request with `-f`, `-F`, `--field`, `--raw-field` or `--input` and no explicit method counts as POST, as `gh` sends it, so `gh api graphql` is denied too.
11. **`failure` is a code:** `wrong_branch`, `dirty_checkout`, `gate_failed`, `gate_timed_out`, `push_rejected`, `gh_unavailable` or `network`. The card carries the detail.
12. **Git details.** Fetch uses the explicit refspec `+refs/heads/<base>:refs/remotes/origin/<base>`, so it doesn't depend on the clone's fetch config. The cut runs `git switch --no-track -c <branch> origin/<base>`, so the branch has no upstream until the push sets it. "`origin` exists" is `git remote get-url origin`, through a `remoteUrl` method beside the four the spec names, so a missing origin gets its own card.
13. **Timeouts.** Each network call (`fetch`, `push`, every `gh` call) gets `DEFAULT_DELIVERY_LIMITS.networkTimeoutMs` = 2 minutes. The shipping gate uses the runner's `gateTimeoutMs` (30 minutes by default).
14. **`gh` states.** `gh auth status --active` is the sign-in check. An exit code of 4, or a message naming `gh auth login`, from any other call reads as signed out. A spawn `ENOENT` reads as not installed.
15. **The system check always lists `gh`;** it is `required` only while some project uses `pull_request`.
16. **Delivery jobs run one at a time per project.** Cut, join and ship jobs for one project are serialized. Shutdown aborts their gate and their git and `gh` children, and waits for them.
17. **The scheduler's `tick()` becomes `Promise<number>`,** serialized, because reading the branch is asynchronous. It reads the branch of each `pull_request` project with queued work once, then runs the existing synchronous launch loop. Work queued after that read waits for the next tick.
18. **Files.** The PR body is written to `<dataDir>/delivery/<batchId>-pr-body.md`; the shipping gate logs to `<dataDir>/logs/gate/batch-<batchId>-<epoch ms>.log`.
19. **Abandoning raises a card** that names the tasks that finished in the batch and the local branch holding their unmerged code.
20. **Input rules.** The PR title prefix is a lowercase type with an optional scope and an optional `!` (`fix`, `feat(app)`, `feat(app)!`). A base branch is a plain branch name: no leading `-`, no `..`, `//` or `@{`, no trailing `/`, `.` or `.lock`. Both reach git and `gh` as arguments.
21. **Which dependencies count as on `origin/<base_branch>`.** A dependency that finished in a batch counts when that batch is `CLOSED` (it had no commits) or its PR's state is `MERGED`. One that finished with no batch (in `local` delivery) counts as merged.
22. **A batch member is a task's latest workstream in the batch.** A task cancelled and started again in the same batch, or one whose failed workstream was replaced by a fresh start, is judged by its latest workstream for shipping and the PR body (`latestPerTask`).

## New decisions

Task 12 appends these to the decision log in `docs/architecture/decisions.md` as consecutive rows numbered from the next free number at merge (69 on `main` when this plan was written). The code follows them from Task 1.

| Label | Decision                                                                                                                                                                                                                                                                                                                                                                         | Why                                                                                                                                  |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| B1    | A project delivers `local` (commits stay on the checked-out branch, as before) or `pull_request`. In `pull_request` the delivery unit is the batch: one branch and one pull request, and at most one unfinished batch (`CUTTING`, `OPEN`, `SHIPPING`, `FAILED`) per project, enforced by a partial unique index.                                                                 | Batch delivery spec §2. The shared checkout holds one branch at a time (factory spec decision 13), so parallel tasks share it.       |
| B2    | The daemon creates and switches branches, only when no lane runs in the project; agents still can't. The daemon pushes and opens the PR; agents may not push in `pull_request` projects and may not create, merge, close, edit or check out PRs, call `gh api` with any method but GET, or change the repository through `gh`, in any project. Merging stays with the builder.   | Spec §2: switching under running sessions moves their files; one deterministic shipper builds the PR from records.                   |
| B3    | The batch row is written before any git side effect, and the branch is verified before every launch and every ship. A `CUTTING` row found at startup is deleted; a branch a crash left behind stays, and the next cut uses a new name.                                                                                                                                           | Spec §2: the pattern the runner and recovery already use for workstreams.                                                            |
| B4    | A batch ships automatically when all its workstreams are `DONE` or `CANCELLED`. A `FAILED` or waiting workstream holds it `OPEN`; "Ship anyway" ships one whose workstreams are all `DONE`, `CANCELLED` or `FAILED`. Retrying a `FAILED` batch ships it when its work is settled and otherwise reopens it; it never ships unfinished work.                                       | Spec §4; factory spec §5.4 sends failed work back for a retry.                                                                       |
| B5    | Shipping: verify the branch and a clean checkout, close a batch with no commits beyond its base, run the project gate, `git push -u` (never forced), find any PR for the branch in any state with `gh pr view` and create one only when there is none, then record the URL. A restart re-runs from the first step, which neither pushes different content nor opens a second PR. | Spec §6. Every step is idempotent, so recovery is "run it again".                                                                    |
| B6    | `gh` is the only host integration. Network calls (`fetch`, `push`, `gh`) run in the captured login environment with `GIT_TERMINAL_PROMPT=0`, `GH_PROMPT_DISABLED=1` and `GH_NO_UPDATE_NOTIFIER=1`, a 2-minute timeout each and an abort signal. Any failure is a `FAILED` batch or a refused start with a card that says what to fix.                                            | Spec §2 and §6. The builder's repos are on GitHub and `gh` is already signed in; a prompt nobody sees would hang forever.            |
| B7    | Requests answer what the daemon can check without git or the network; the git and `gh` checks run after the API returns, and their refusals are inbox cards. `POST /tasks/:id/start` answers 202 with the batch in a `pull_request` project and 201 with the workstream in a `local` one.                                                                                        | Spec §5 "the API returns the batch at once". The local answer is unchanged, so `PROTOCOL_VERSION` stays 2.                           |
| B8    | A wrong branch at startup fails the batch; while the daemon runs, it pauses the batch's launches with a card until the builder switches back. Changing a project's delivery is refused while it has unfinished work.                                                                                                                                                             | Spec §5 scheduler rule. A pause is enough while the daemon watches every launch; at startup nobody knows how the checkout got there. |
| B9    | Batch actions (Retry, Ship anyway, Abandon) are buttons on the Tasks view's batch strip; flag cards explain and name the button.                                                                                                                                                                                                                                                 | Today's flag cards have no actions; making flag cards answerable is a separate change.                                               |

## Global Constraints

Everything in M0's, M1a's, M1b's and M2a's Global Constraints still applies. On top of that:

- **Branch:** `feat/batch-delivery`, cut from `main` after the spec PR (#39) merges. Open one PR to `main` at the end; its title is a Conventional Commit. Between Task 2 and Task 10 a `pull_request` project can be created but its tasks don't run yet; the branch ships as one PR.
- **Commits:**
  - Each commit is one command that names its paths: `git add <path> … && git commit -m '…'`. Never `git add -A`, `git add .` or `git commit -a`.
  - The scope is one of `daemon`, `desktop`, `contracts`, `db`, `harness`, `repo`, `ci`, `docs`, `deps`. The subject is lowercase and the header is at most 100 characters.
  - Every message ends with this footer, after a blank line:
    ```
    Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
    Claude-Session: https://claude.ai/code/session_01KFqjacxo6Va8EyHF93n3xr
    ```
    The commit commands below pass it as two extra `-m` paragraphs.
  - Run `pnpm format` first. A failing hook leaves the paths staged: fix the cause and rerun the same line. Never `--no-verify` or `LEFTHOOK=0`.
- **Generated files** are regenerated, never edited: `pnpm --filter @10db/contracts generate` after a contracts change. A schema change regenerates the migration baseline (`packages/db/AGENTS.md`, decision 67): there is no published release, so no new migration file. After Task 2, delete any local `.dev/data` (the daemon refuses a database made under the old baseline and exits with code 3).
- **Contracts are additive** (`packages/contracts/AGENTS.md`): new fields on `ProjectInput`, `ProjectDto`, `ProjectPatch` and `WorkstreamDto`, new schemas, a new `ToolName`, a new event type and a new response shape for a new delivery mode. `PROTOCOL_VERSION` stays 2.
- **IDs** are minted only through `mintId`. New kind: `Batch` (`bat`).
- **Every state change writes its row and its event in one transaction** (`state.write`). `batch.updated` (`entityType: 'batch'`) is emitted when a batch is inserted, on every change and when a `CUTTING` row is deleted; the desktop's `INVALIDATIONS` maps it (Task 11).
- **Git and `gh` run only through `git/` and `github/`,** with `execFile` and argument arrays, never a shell. Network calls take a `NetworkCall` (`env`, `timeoutMs`, `signal`) built from the login environment (`environment/buildNetworkEnv`); nothing reads `process.env` for them. Branch names and the base branch reach git only after `BranchName` validated them.
- **No `as` casts, no `!`, no `any`** except at a validated boundary with a comment (`.claude/rules/code-style.md`). Exhaustive switches over `BatchState`, `BatchFailure`, `GhFailure` and `GitNetworkFailure`.
- **Tests** (`.claude/rules/testing.md`):
  - Red first, with the expected failure written in each step.
  - Real git: a temp repo whose `origin` is a local bare repo (`createTempRepoWithOrigin`), so fetches and pushes are real.
  - `gh` is faked at the `Gh` interface (`apps/daemon/test/fake-gh.ts`) in delivery tests; `github/gh.test.ts` covers the real `execFile` boundary with scripts on a temp `PATH`.
  - Table-driven for batch transitions, cutting checks, shipping failures, the launch rule, guard verdicts and recovery after each shipping step.
  - No sleeps: wait on `jobs.idle()` or `waitFor` with a deadline.
- **`local` delivery is unchanged.** The existing daemon suites pass as they are, except where an interface this plan changes forces an edit: the scheduler tests await the now-async `tick()`, the system check lists `gh`, and the project form sends `delivery`.
- **Tunable values are named constants:** `DEFAULT_DELIVERY_LIMITS`, `BRANCH_PREFIX = '10db/'`, `MAX_SLUG = 40`, `MAX_LISTED_PATHS = 20`.
- **knip:** an `index.ts` re-exports only what another module or a test imports.
- **Comments never carry decision numbers** (`.claude/rules/code-style.md`); they cite the spec (`batch delivery spec §6`) or say the why in words.

## Review Focus

The conditions most likely to bite a person, each with the task whose tests pin it:

1. **Work runs on the wrong branch.**
   - Case: the builder runs `git switch main` by hand while a batch is open, or the daemon crashed after `git switch` during a cut, or the checkout is detached.
   - Nothing in the batch launches; a running daemon raises one card and waits, a restarted one fails the batch with "checkout is on X, the batch branch is Y".
   - Tests: Task 7 (launch-rule table, `waits and raises one card when the checkout left the batch branch`), Task 9 (`fails an unfinished batch whose branch is not checked out and launches nothing in it`).
2. **A crash mid-ship pushes twice or opens a second PR.**
   - Case: `kill -9` after any of shipping steps 0–4, including after `gh pr create` returned but before `SHIPPED` was written.
   - Recovery re-runs from step 0; the origin branch ends at the same SHA and `prCreate` was called exactly once.
   - Tests: Task 9 (`finishes a batch left in SHIPPING after <step> with one PR and the same pushed SHA`, one row per step).
3. **Unfinished or failed work ships.**
   - Case: one workstream failed or waits for an answer while the others finished; the builder hits Retry on a batch failed at startup with queued work.
   - The batch stays `OPEN`; Ship anyway is refused (409) while anything is not `DONE`, `CANCELLED` or `FAILED`; Retry from `FAILED` reopens instead of shipping.
   - Tests: Task 6 (`holds the batch open while a workstream failed or waits`, `ships anyway only when…`, `retries a failed batch…`).
4. **An agent ships or merges behind 10db's back.**
   - Case: `git push` in a `pull_request` project, `gh pr merge`, `gh pr checkout`, `gh api repos/o/r/pulls -f title=x` (an implicit POST), `gh api -X PATCH`, `gh repo edit`, any of them behind `env`, `sh -c` or `-R owner/repo`.
   - The guard denies each with a reason; `gh pr view`, `list` and `checks` and `gh api` GETs stay allowed.
   - Tests: Task 8 (guard table, both delivery modes).
5. **A network call hangs or prompts.**
   - Case: `git fetch` against an unreachable host, `gh` waiting for a login prompt, a slow push.
   - Each call is killed at its timeout; the start is refused or the batch fails with a card; prompts are off whatever the login environment says.
   - Tests: Task 3 (`times out a fetch that hangs`, `stops a fetch when its signal aborts`), Task 4 (`turns prompts off whatever the environment says`, `times out a gh that hangs`).
6. **Two starts race.**
   - Case: two Start clicks, or two API calls, in the same instant.
   - One batch row and one `10db/*` branch; the second start joins or answers 409.
   - Tests: Task 2 (`the unique index refuses a second unfinished batch`), Task 5 (`gives two simultaneous starts one batch and one branch`), Task 10 (the same over HTTP).
7. **The daemon stops while the shipping gate runs.**
   - The gate's process group is killed, the batch stays `SHIPPING` with no gate pid, and the next start finishes it; an orphaned gate from a `kill -9` is terminated before the rerun.
   - Tests: Task 9 (`leaves a batch SHIPPING when the daemon stops during its gate`, `terminates an orphaned shipping gate before re-running`).
8. **A hostile name reaches git or `gh`.**
   - Case: a base branch `-delete` or `main..x`, a batch title with quotes, `$()` or a leading dash.
   - The base branch is refused at the API; the title only becomes a slug in the branch name and one `--title` argument, never shell text.
   - Tests: Task 1 (`BranchName` and `PrTitlePrefix` tables), Task 5 (`batchBranchName` table), Task 6 (`passes a title with quotes and $() through as one argument`).

---

## File Structure

```
packages/contracts/src/
  states.ts            (+ Delivery, BatchState, BatchFailure)
  ids.ts               (+ Batch: bat)
  events.ts            (+ BatchUpdated)
  system.ts            (+ ToolName.Gh)
  git-names.ts         BranchName, PrTitlePrefix
  batch-workflow.ts    BATCH_TRANSITIONS, canBatchTransition, UNFINISHED_BATCH_STATES, ShipReadiness,
                       shipReadiness, isSettled, latestPerTask
  batches.ts           BatchDto, BatchStartInput, ProjectViewDto, TaskStartResult
  entities.ts          (+ ProjectInput/ProjectDto/ProjectPatch delivery fields, WorkstreamDto.batchId)
packages/db/src/
  schema.ts            (+ batches table, projects columns, workstreams.batch_id)
  store/batches.ts     insertBatch, getBatch, getBatchRow, findUnfinishedBatch, currentBatch, listBatches,
                       transitionBatch, patchBatch, deleteCuttingBatch
  store/workstreams.ts (+ batchId, insertWorkstream opts, listWorkstreams batchId filter, latestDoneWorkstream)
  store/projects.ts    (+ delivery rules in patchProject, listProjectViews)
packages/db/drizzle/   0000_init.sql, 0001_decisions_fts.sql (baseline regenerated)
apps/daemon/src/
  git/                 (+ currentBranch, remoteUrl, fetch, switchNewBranch, push, NetworkCall, GitNetworkError)
  github/              gh.ts index.ts (+ test): Gh, createGh, systemGhExec, GhError, PullRequest
  environment/         network-env.ts (buildNetworkEnv); system-check.ts (+ gh, markGhRequired)
  guard/               gh-rules.ts; git-rules.ts (+ delivery); judge.ts (+ delivery, gh)
  delivery/            jobs.ts branch-name.ts cards.ts deps.ts context.ts start.ts pr-text.ts ship.ts
                       trigger.ts launch-rule.ts recover.ts index.ts (+ tests)
  team/steps.ts        (+ planForStart, insertPlannedWorkstream; retryWorkstream batch rule)
  scheduler/           scheduler.ts (async tick, launch rule)
  runner/runner.ts     (passes delivery to the guard)
  api/                 app.ts services.ts (+ batch routes, ProjectViewDto, TaskStartResult)
  daemon/              services.ts start.ts (+ delivery wiring, gh, networkEnv)
  main.ts              (+ networkEnv)
apps/daemon/test/      fixtures.ts (+ createTempRepoWithOrigin, NETWORK_ENV), fake-gh.ts, delivery-harness.ts,
                       orphan-gate.ts, batch-delivery.test.ts
apps/desktop/src/      daemon/queries.ts daemon/events.ts test/fixtures.ts
                       views/tasks/new-project-form.tsx tasks-view.tsx batch-strip.tsx (+ tests)
docs/architecture/     02-batch-delivery.md, decisions.md, (open-items in docs/open-items.md)
README.md  apps/daemon/AGENTS.md
```

---

### Task 1: Contracts for batches, delivery and the batch routes

New vocabularies and schemas, standalone: no existing schema changes shape yet, so nothing downstream breaks. `ProjectDto` and `WorkstreamDto` gain their fields in Task 2, together with the tables they are read from.

**Files:**

- Modify: `packages/contracts/src/states.ts`, `ids.ts`, `events.ts`, `system.ts`, `index.ts`, `json-schema.ts`
- Create: `packages/contracts/src/git-names.ts`, `batch-workflow.ts`, `batches.ts`
- Test: `packages/contracts/src/batches.test.ts`
- Generated: `packages/contracts/generated/*.schema.json` (four new files, plus `system-check-dto.schema.json`)

**Interfaces:**

- Consumes: `ProjectDto`, `WorkstreamDto` (`entities.ts`), `idSchema`/`mintId` (`ids.ts`), `WorkstreamState` (`states.ts`).
- Produces (used by every later task):
  - Vocabularies in `states.ts`: `Delivery` (`local | pull_request`), `BatchState` (`CUTTING | OPEN | SHIPPING | SHIPPED | CLOSED | FAILED | ABANDONED`), `BatchFailure` (`wrong_branch | dirty_checkout | gate_failed | gate_timed_out | push_rejected | gh_unavailable | network`).
  - `BatchId` (`bat_<uuidv7>`), `mintId('Batch')`.
  - `EventType.BatchUpdated = 'batch.updated'`.
  - `ToolName.Gh = 'gh'`.
  - `git-names.ts`: `BranchName` (zod string), `PrTitlePrefix` (zod string).
  - `batch-workflow.ts`:
    - `BATCH_TRANSITIONS: Readonly<Record<BatchState, readonly BatchState[]>>`, `canBatchTransition(from: BatchState, to: BatchState): boolean`
    - `UNFINISHED_BATCH_STATES: readonly BatchState[]` (`CUTTING`, `OPEN`, `SHIPPING`, `FAILED`)
    - `ShipReadiness` (`ready | ship_anyway | blocked`), `shipReadiness(states: readonly WorkstreamState[]): ShipReadiness`, `isSettled(state: WorkstreamState): boolean` (`DONE` or `CANCELLED`)
    - `latestPerTask<T extends { readonly taskId: TaskId }>(rows: readonly T[]): T[]` (rows oldest first; keeps each task's last row, in first-seen order)
  - `batches.ts`: `BatchDto`, `BatchStartInput`, `ProjectViewDto` (`ProjectDto` + `currentBatch: BatchDto | null`), `TaskStartResult` (`WorkstreamDto | BatchDto`).

- [ ] **Step 1: Write the failing test**

`packages/contracts/src/batches.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  BATCH_TRANSITIONS,
  canBatchTransition,
  latestPerTask,
  shipReadiness,
  UNFINISHED_BATCH_STATES,
} from './batch-workflow';
import { BatchDto, BatchStartInput, TaskStartResult } from './batches';
import { BranchName, PrTitlePrefix } from './git-names';
import { mintId } from './ids';
import { BatchState as B, WorkstreamState as S, type BatchState } from './states';

describe('batch state machine', () => {
  it.each<[BatchState, BatchState]>([
    [B.Cutting, B.Open],
    [B.Open, B.Shipping],
    [B.Open, B.Failed],
    [B.Open, B.Abandoned],
    [B.Shipping, B.Shipped],
    [B.Shipping, B.Closed],
    [B.Shipping, B.Failed],
    [B.Failed, B.Shipping],
    [B.Failed, B.Open],
    [B.Failed, B.Abandoned],
  ])('allows %s -> %s', (from, to) => {
    expect(canBatchTransition(from, to)).toBe(true);
  });

  it.each<[BatchState, BatchState]>([
    [B.Cutting, B.Shipping],
    [B.Cutting, B.Failed],
    [B.Cutting, B.Abandoned],
    [B.Open, B.Shipped],
    [B.Open, B.Closed],
    [B.Shipping, B.Open],
    [B.Shipping, B.Abandoned],
    [B.Failed, B.Shipped],
    [B.Shipped, B.Open],
    [B.Closed, B.Shipping],
    [B.Abandoned, B.Open],
  ])('refuses %s -> %s', (from, to) => {
    expect(canBatchTransition(from, to)).toBe(false);
  });

  it('leaves SHIPPED, CLOSED and ABANDONED for good', () => {
    for (const s of [B.Shipped, B.Closed, B.Abandoned]) expect(BATCH_TRANSITIONS[s]).toEqual([]);
  });

  it('counts CUTTING, OPEN, SHIPPING and FAILED as unfinished', () => {
    expect([...UNFINISHED_BATCH_STATES].sort()).toEqual(['CUTTING', 'FAILED', 'OPEN', 'SHIPPING']);
  });
});

describe('shipReadiness', () => {
  it.each([
    { name: 'no workstreams', states: [], expected: 'ready' },
    { name: 'all done', states: [S.Done, S.Done], expected: 'ready' },
    { name: 'done and cancelled', states: [S.Done, S.Cancelled], expected: 'ready' },
    { name: 'a failed one among done ones', states: [S.Done, S.Failed], expected: 'ship_anyway' },
    { name: 'a running one', states: [S.Done, S.Running], expected: 'blocked' },
    {
      name: 'a waiting one beside a failed one',
      states: [S.Failed, S.WaitingHuman],
      expected: 'blocked',
    },
    { name: 'a paused one', states: [S.PausedLimit], expected: 'blocked' },
    { name: 'a queued one', states: [S.Queued], expected: 'blocked' },
  ])('$name', ({ states, expected }) => {
    expect(shipReadiness(states)).toBe(expected);
  });
});

describe('latestPerTask', () => {
  it("keeps each task's last row in the order tasks first appear", () => {
    const a = mintId('Task');
    const b = mintId('Task');
    const rows = [
      { taskId: a, n: 1 },
      { taskId: b, n: 2 },
      { taskId: a, n: 3 },
    ];
    expect(latestPerTask(rows)).toEqual([
      { taskId: a, n: 3 },
      { taskId: b, n: 2 },
    ]);
  });
});

describe('names that reach git and gh', () => {
  it.each([
    { value: 'main', ok: true },
    { value: 'release/2.x', ok: true },
    { value: 'feat_x-1.2', ok: true },
    { value: '-delete', ok: false },
    { value: 'main..x', ok: false },
    { value: 'a//b', ok: false },
    { value: 'main/', ok: false },
    { value: 'main.', ok: false },
    { value: 'x.lock', ok: false },
    { value: 'a@{1}', ok: false },
    { value: 'has space', ok: false },
    { value: '$(id)', ok: false },
    { value: '', ok: false },
  ])('branch name "$value"', ({ value, ok }) => {
    expect(BranchName.safeParse(value).success).toBe(ok);
  });

  it.each([
    { value: 'feat(daemon)', ok: true },
    { value: 'fix', ok: true },
    { value: 'feat(api)!', ok: true },
    { value: 'Feat(daemon)', ok: false },
    { value: 'feat(daemon):', ok: false },
    { value: 'feat daemon', ok: false },
    { value: 'feat()', ok: false },
    { value: '', ok: false },
  ])('PR title prefix "$value"', ({ value, ok }) => {
    expect(PrTitlePrefix.safeParse(value).success).toBe(ok);
  });
});

describe('batch schemas', () => {
  const task = mintId('Task');
  it.each([
    {
      name: 'a title and two tasks',
      input: { title: 'Greetings', taskIds: [task, mintId('Task')] },
      ok: true,
    },
    { name: 'no tasks', input: { title: 'Empty', taskIds: [] }, ok: false },
    { name: 'the same task twice', input: { title: 'Twice', taskIds: [task, task] }, ok: false },
    { name: 'an empty title', input: { title: '', taskIds: [task] }, ok: false },
    {
      name: 'a title over 200 characters',
      input: { title: 'x'.repeat(201), taskIds: [task] },
      ok: false,
    },
    { name: 'a task id that is not one', input: { title: 'Bad', taskIds: ['tsk_1'] }, ok: false },
  ])('BatchStartInput: $name', ({ input, ok }) => {
    expect(BatchStartInput.safeParse(input).success).toBe(ok);
  });

  it('tells a started batch from a started workstream', () => {
    const batch = BatchDto.parse({
      id: mintId('Batch'),
      projectId: mintId('Project'),
      title: 'Greetings',
      state: 'CUTTING',
      branch: null,
      baseBranch: 'main',
      baseSha: null,
      repo: null,
      prUrl: null,
      gateExitCode: null,
      gateLogPath: null,
      failure: null,
      createdAt: '2026-10-21T12:00:00.000Z',
      updatedAt: '2026-10-21T12:00:00.000Z',
    });
    const parsed = TaskStartResult.parse(batch);
    expect('taskId' in parsed).toBe(false);
    expect(parsed).toEqual(batch);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @10db/contracts exec vitest run src/batches.test.ts`
Expected: FAIL. Vitest reports `Failed to load url ./batch-workflow` (and `./batches`, `./git-names`), because none of the three modules exists.

- [ ] **Step 3: Add the vocabularies, the ID, the event and the tool**

In `packages/contracts/src/states.ts`, append:

```ts
/** How a project's finished work leaves the machine (batch delivery spec §3). */
export const Delivery = { Local: 'local', PullRequest: 'pull_request' } as const;
export type Delivery = ValueOf<typeof Delivery>;

/** A batch's lifecycle (batch delivery spec §4). */
export const BatchState = {
  Cutting: 'CUTTING',
  Open: 'OPEN',
  Shipping: 'SHIPPING',
  Shipped: 'SHIPPED',
  Closed: 'CLOSED',
  Failed: 'FAILED',
  Abandoned: 'ABANDONED',
} as const;
export type BatchState = ValueOf<typeof BatchState>;

/** Why shipping stopped; the batch's flag card carries the detail. */
export const BatchFailure = {
  WrongBranch: 'wrong_branch',
  DirtyCheckout: 'dirty_checkout',
  GateFailed: 'gate_failed',
  GateTimedOut: 'gate_timed_out',
  PushRejected: 'push_rejected',
  GhUnavailable: 'gh_unavailable',
  Network: 'network',
} as const;
export type BatchFailure = ValueOf<typeof BatchFailure>;
```

In `packages/contracts/src/ids.ts`, following the existing pattern exactly:

```ts
// ID_SCHEMAS, after ModelProfile
  Batch: idSchema('bat', 'BatchId'),
// ID_PREFIX, after ModelProfile
  Batch: 'bat',
// exports, after ModelProfileId
export const BatchId = ID_SCHEMAS.Batch;
export type BatchId = IdOf<'Batch'>;
```

In `packages/contracts/src/events.ts`, add to `EventType` after `StepChanged`:

```ts
  BatchUpdated: 'batch.updated',
```

In `packages/contracts/src/system.ts`, add `gh` to `ToolName`:

```ts
export const ToolName = { Claude: 'claude', Git: 'git', Docker: 'docker', Gh: 'gh' } as const;
```

- [ ] **Step 4: Write the schemas and the state machine**

`packages/contracts/src/git-names.ts`:

```ts
import { z } from 'zod';

/**
 * A branch name 10db hands to git and gh as an argument: never an option (no leading `-`), never a
 * ref expression (`..`, `@{`), and within git's own rules for a ref name.
 */
export const BranchName = z
  .string()
  .min(1)
  .max(200)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/,
    'letters, digits, ".", "_", "/" and "-", starting with a letter or digit',
  )
  .refine(
    (b) =>
      !b.includes('..') &&
      !b.includes('//') &&
      !b.endsWith('/') &&
      !b.endsWith('.') &&
      !b.endsWith('.lock'),
    'not a valid git branch name',
  );

/** A Conventional Commit type with an optional scope and `!`; the PR title is `<prefix>: <batch title>`. */
export const PrTitlePrefix = z
  .string()
  .regex(
    /^[a-z]+(\([a-z0-9][a-z0-9._/-]*\))?!?$/,
    'a Conventional Commit type and scope, such as feat(daemon)',
  );
```

`packages/contracts/src/batch-workflow.ts`:

```ts
import type { TaskId } from './ids';
import {
  BatchState as B,
  WorkstreamState as S,
  type BatchState,
  type WorkstreamState,
} from './states';

/** Allowed batch transitions (batch delivery spec §4). A refused CUTTING row is deleted, not moved. */
export const BATCH_TRANSITIONS: Readonly<Record<BatchState, readonly BatchState[]>> = {
  [B.Cutting]: [B.Open],
  [B.Open]: [B.Shipping, B.Failed, B.Abandoned],
  [B.Shipping]: [B.Shipped, B.Closed, B.Failed],
  [B.Failed]: [B.Shipping, B.Open, B.Abandoned],
  [B.Shipped]: [],
  [B.Closed]: [],
  [B.Abandoned]: [],
};

export function canBatchTransition(from: BatchState, to: BatchState): boolean {
  return BATCH_TRANSITIONS[from].includes(to);
}

/** A project has at most one batch in these states; the database's partial unique index lists the same four. */
export const UNFINISHED_BATCH_STATES: readonly BatchState[] = [
  B.Cutting,
  B.Open,
  B.Shipping,
  B.Failed,
];

export const ShipReadiness = {
  Ready: 'ready',
  ShipAnyway: 'ship_anyway',
  Blocked: 'blocked',
} as const;
export type ShipReadiness = (typeof ShipReadiness)[keyof typeof ShipReadiness];

const SETTLED: readonly WorkstreamState[] = [S.Done, S.Cancelled];

/** A workstream in one of these states no longer holds its batch open. */
export function isSettled(state: WorkstreamState): boolean {
  return SETTLED.includes(state);
}

/**
 * Whether a batch's members let it ship: all settled ships by itself; settled or failed needs the
 * builder's "Ship anyway"; anything else (running, queued, waiting, paused) blocks it.
 */
export function shipReadiness(states: readonly WorkstreamState[]): ShipReadiness {
  if (states.every(isSettled)) return ShipReadiness.Ready;
  if (states.every((s) => isSettled(s) || s === S.Failed)) return ShipReadiness.ShipAnyway;
  return ShipReadiness.Blocked;
}

/** A batch member is a task's latest workstream in it; `rows` come oldest first. */
export function latestPerTask<T extends { readonly taskId: TaskId }>(rows: readonly T[]): T[] {
  const last = new Map<TaskId, T>();
  for (const row of rows) last.set(row.taskId, row);
  return [...last.values()];
}
```

`Map` keeps a key's first insertion position when its value is replaced, which gives the first-seen order the test expects.

`packages/contracts/src/batches.ts`:

```ts
import { z } from 'zod';
import { ProjectDto, WorkstreamDto } from './entities';
import { BatchId, ProjectId, TaskId } from './ids';
import { BatchFailure, BatchState } from './states';

const Timestamp = z.iso.datetime();

/** One batch: one branch and one pull request (batch delivery spec §3). */
export const BatchDto = z.object({
  id: BatchId,
  projectId: ProjectId,
  title: z.string(),
  state: z.enum(BatchState),
  /** Null until the branch is cut. */
  branch: z.string().nullable(),
  baseBranch: z.string(),
  /** The commit the branch was cut from; null until it is cut. */
  baseSha: z.string().nullable(),
  /** The GitHub `owner/name`, recorded when the branch is cut. */
  repo: z.string().nullable(),
  prUrl: z.string().nullable(),
  gateExitCode: z.int().nullable(),
  gateLogPath: z.string().nullable(),
  failure: z.enum(BatchFailure).nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type BatchDto = z.infer<typeof BatchDto>;

/** `POST /projects/:projectId/batches`. M2b's batch approval sends this; keep it stable. */
export const BatchStartInput = z
  .object({
    title: z.string().min(1).max(200),
    taskIds: z.array(TaskId).min(1).max(50),
  })
  .refine((i) => new Set(i.taskIds).size === i.taskIds.length, {
    message: 'Name each task once',
    path: ['taskIds'],
  });
export type BatchStartInput = z.infer<typeof BatchStartInput>;

/**
 * `GET /projects`: each project with its unfinished batch, else its latest one. A body without the
 * field reads as no batch, so a client that only knows ProjectDto-shaped answers still parses.
 */
export const ProjectViewDto = ProjectDto.extend({
  currentBatch: BatchDto.nullable().default(null),
});
export type ProjectViewDto = z.infer<typeof ProjectViewDto>;

/** `POST /tasks/:taskId/start`: the workstream in local delivery, the batch it runs in for pull requests. */
export const TaskStartResult = z.union([WorkstreamDto, BatchDto]);
export type TaskStartResult = z.infer<typeof TaskStartResult>;
```

In `packages/contracts/src/index.ts`, add (keeping the list sorted):

```ts
export * from './batch-workflow';
export * from './batches';
export * from './git-names';
```

In `packages/contracts/src/json-schema.ts`, import `BatchDto`, `BatchStartInput`, `ProjectViewDto` and `TaskStartResult` from `./batches` and register them in `CONTRACT_SCHEMAS`:

```ts
  'batch-dto': BatchDto,
  'batch-start-input': BatchStartInput,
  'project-view-dto': ProjectViewDto,
  'task-start-result': TaskStartResult,
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @10db/contracts exec vitest run src/batches.test.ts`
Expected: PASS, every row.

- [ ] **Step 6: Regenerate the JSON schemas and check the package**

Run: `pnpm --filter @10db/contracts generate && pnpm --filter @10db/contracts exec vitest run && pnpm typecheck`
Expected: four new files (`batch-dto`, `batch-start-input`, `project-view-dto`, `task-start-result`) and a changed `system-check-dto.schema.json` (the `gh` tool name) under `packages/contracts/generated/`; every contracts test passes; typecheck is clean across the workspace.

- [ ] **Step 7: Commit**

```bash
pnpm format && git add packages/contracts/src/states.ts packages/contracts/src/ids.ts packages/contracts/src/events.ts packages/contracts/src/system.ts packages/contracts/src/git-names.ts packages/contracts/src/batch-workflow.ts packages/contracts/src/batches.ts packages/contracts/src/batches.test.ts packages/contracts/src/index.ts packages/contracts/src/json-schema.ts packages/contracts/generated && git commit -m 'feat(contracts): add batches, delivery modes and the batch route schemas' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>' -m 'Claude-Session: https://claude.ai/code/session_01KFqjacxo6Va8EyHF93n3xr'
```

---

### Task 2: The batches table, the project delivery fields and the batch repositories

**Files:**

- Modify: `packages/contracts/src/entities.ts` (project delivery fields, `WorkstreamDto.batchId`)
- Modify: `packages/db/src/schema.ts`, `packages/db/src/store/workstreams.ts`, `packages/db/src/store/projects.ts`, `packages/db/src/store/index.ts`
- Create: `packages/db/src/store/batches.ts`
- Test: `packages/db/src/store/batches.test.ts`
- Modify: `apps/desktop/src/test/fixtures.ts` (the DTO fixtures parse the new required fields)
- Generated: `packages/db/drizzle/` (baseline regenerated), `packages/contracts/generated/*.schema.json`

**Interfaces:**

- Consumes: Task 1's `Delivery`, `BatchState`, `BatchFailure`, `BatchId`, `BranchName`, `PrTitlePrefix`, `canBatchTransition`, `UNFINISHED_BATCH_STATES`, `BatchDto`, `ProjectViewDto`, `EventType.BatchUpdated`.
- Produces:
  - `ProjectInput` gains `delivery` (default `local`), `baseBranch` (`BranchName`, default `main`) and `prTitlePrefix` (`PrTitlePrefix | null`, default null; required when `delivery` is `pull_request`). `ProjectDto` gains `delivery: Delivery`, `baseBranch: string`, `prTitlePrefix: string | null`. `ProjectPatch` gains the same three, optional.
  - `WorkstreamDto.batchId: BatchId | null`; `WorkstreamRow.batchId`.
  - `packages/db` (exported from the package entry):
    - `type BatchRow` (the row, with `gatePid` and `gatePidStart`), `interface BatchPatch`
    - `insertBatch(ctx: WriteContext, input: { projectId: ProjectId; title: string; baseBranch: string }): BatchDto`: a `CUTTING` row; `ConflictError` naming the unfinished batch when there is one
    - `getBatch(db: DbReader, id: BatchId): BatchDto`, `getBatchRow(db: DbReader, id: BatchId): BatchRow`
    - `findUnfinishedBatch(db: DbReader, projectId: ProjectId): BatchDto | undefined`
    - `currentBatch(db: DbReader, projectId: ProjectId): BatchDto | null`
    - `listBatches(db: DbReader, filter?: { projectId?: ProjectId; states?: readonly BatchState[] }): BatchDto[]` (oldest first)
    - `transitionBatch(ctx, id, opts: { to: BatchState; patch?: BatchPatch; reason?: string }): BatchDto`
    - `patchBatch(ctx, id, patch: BatchPatch): BatchDto`
    - `deleteCuttingBatch(ctx, id, reason: string): void`
    - `insertWorkstream(ctx, taskId, opts?: { batchId?: BatchId | null }): WorkstreamDto`
    - `listWorkstreams(db, filter?: { states?; projectId?; batchId?: BatchId })`
    - `latestDoneWorkstream(db: DbReader, taskId: TaskId): WorkstreamRow | undefined`
    - `listProjectViews(db: DbReader): ProjectViewDto[]`
    - `patchProject` refuses a `delivery` change while the project has an active workstream or an unfinished batch (`ConflictError`), and `pull_request` delivery without a prefix (`InvalidError`).

- [ ] **Step 1: Write the failing test**

`packages/db/src/store/batches.test.ts`:

```ts
import {
  ConflictError,
  InvalidError,
  mintId,
  UNFINISHED_BATCH_STATES,
  type BatchId,
  type BatchState,
  type ProjectId,
  type ProjectInput,
} from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../schema';
import {
  createTestStore,
  currentBatch,
  deleteCuttingBatch,
  findUnfinishedBatch,
  getBatch,
  getBatchRow,
  getProject,
  insertBatch,
  insertTask,
  insertWorkstream,
  latestDoneWorkstream,
  listBatches,
  listProjectViews,
  listWorkstreams,
  patchBatch,
  patchProject,
  seedProject,
  transitionBatch,
  transitionWorkstream,
  type Store,
} from './index';

let store: Store;
let close: () => void;
beforeEach(() => {
  ({ store, close } = createTestStore());
});
afterEach(() => {
  close();
});

const AT = '2026-10-21T12:00:00.000Z';
const prProject = () =>
  seedProject(store, { delivery: 'pull_request', prTitlePrefix: 'feat(app)' });
const newBatch = (projectId: ProjectId, title = 'Greetings') =>
  store.write((ctx) => insertBatch(ctx, { projectId, title, baseBranch: 'main' })).value;
const move = (id: BatchId, ...states: BatchState[]) => {
  for (const to of states) store.write((ctx) => transitionBatch(ctx, id, { to }));
};
const addTask = (projectId: ProjectId, title = 'Alpha') =>
  store.write((ctx) =>
    insertTask(ctx, projectId, { title, acceptanceCriteria: ['x'], areas: ['api'] }),
  ).value;

/** Bypasses the repository, so only the partial unique index stands between two unfinished rows. */
function rawBatch(projectId: ProjectId, state: BatchState): void {
  store.db
    .insert(schema.batches)
    .values({
      id: mintId('Batch'),
      projectId,
      title: 'raw',
      state,
      baseBranch: 'main',
      createdAt: AT,
      updatedAt: AT,
    })
    .run();
}

/** drizzle wraps the SQLite error; its cause carries the constraint's name. */
function sqliteMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.cause instanceof Error ? `${error.message} ${error.cause.message}` : error.message;
}

describe('batches', () => {
  it('inserts a CUTTING batch with no branch yet and emits batch.updated', () => {
    const project = prProject();
    const { value: batch, events } = store.write((ctx) =>
      insertBatch(ctx, { projectId: project.id, title: 'Greetings', baseBranch: 'main' }),
    );
    expect(batch).toMatchObject({
      projectId: project.id,
      title: 'Greetings',
      state: 'CUTTING',
      branch: null,
      baseBranch: 'main',
      baseSha: null,
      repo: null,
      prUrl: null,
      failure: null,
    });
    expect(events.map((e) => [e.type, e.entityType, e.entityId])).toEqual([
      ['batch.updated', 'batch', batch.id],
    ]);
  });

  it('refuses a second unfinished batch in a project, naming the first', () => {
    const project = prProject();
    newBatch(project.id, 'First');
    expect(() => newBatch(project.id, 'Second')).toThrow(ConflictError);
    expect(() => newBatch(project.id, 'Second')).toThrow(/First/);
    expect(newBatch(prProject().id).state).toBe('CUTTING');
  });

  it.each(UNFINISHED_BATCH_STATES)(
    'the unique index refuses a second unfinished batch while one is %s',
    (state) => {
      const project = prProject();
      rawBatch(project.id, state);
      let error: unknown = null;
      try {
        rawBatch(project.id, 'CUTTING');
      } catch (caught) {
        error = caught;
      }
      expect(sqliteMessage(error)).toMatch(/UNIQUE constraint failed: batches\.project_id/);
    },
  );

  it.each<BatchState>(['SHIPPED', 'CLOSED', 'ABANDONED'])(
    'allows a new batch beside a %s one',
    (state) => {
      const project = prProject();
      rawBatch(project.id, state);
      expect(newBatch(project.id).state).toBe('CUTTING');
    },
  );

  it('moves only along the batch state machine and records each move', () => {
    const batch = newBatch(prProject().id);
    expect(() => store.write((ctx) => transitionBatch(ctx, batch.id, { to: 'SHIPPING' }))).toThrow(
      ConflictError,
    );
    const { events } = store.write((ctx) =>
      transitionBatch(ctx, batch.id, {
        to: 'OPEN',
        patch: { branch: '10db/greetings-0a1b2c3d', baseSha: 'a'.repeat(40), repo: 'acme/widgets' },
        reason: 'branch cut',
      }),
    );
    expect(getBatch(store.db, batch.id)).toMatchObject({
      state: 'OPEN',
      branch: '10db/greetings-0a1b2c3d',
      repo: 'acme/widgets',
    });
    expect(events[0]?.data).toEqual({ from: 'CUTTING', to: 'OPEN', reason: 'branch cut' });
  });

  it('keeps the gate pid on the row, out of the DTO, and emits on every change', () => {
    const batch = newBatch(prProject().id);
    const { value, events } = store.write((ctx) =>
      patchBatch(ctx, batch.id, {
        gatePid: 4242,
        gatePidStart: 'Tue Oct 21 12:00:00 2026',
        gateExitCode: 0,
      }),
    );
    expect(value.gateExitCode).toBe(0);
    expect(value).not.toHaveProperty('gatePid');
    expect(getBatchRow(store.db, batch.id)).toMatchObject({ gatePid: 4242 });
    expect(events.map((e) => e.type)).toEqual(['batch.updated']);
  });

  it('deletes only a CUTTING batch, and says so in an event', () => {
    const batch = newBatch(prProject().id);
    const { events } = store.write((ctx) => {
      deleteCuttingBatch(ctx, batch.id, 'the checkout is dirty');
    });
    expect(listBatches(store.db)).toEqual([]);
    expect(events[0]?.data).toEqual({ from: 'CUTTING', to: null, reason: 'the checkout is dirty' });
    const open = newBatch(prProject().id);
    move(open.id, 'OPEN');
    expect(() =>
      store.write((ctx) => {
        deleteCuttingBatch(ctx, open.id, 'too late');
      }),
    ).toThrow(ConflictError);
  });

  it("reports a project's unfinished batch as current, else its latest", () => {
    const project = prProject();
    expect(currentBatch(store.db, project.id)).toBeNull();
    const first = newBatch(project.id, 'First');
    move(first.id, 'OPEN', 'SHIPPING', 'CLOSED');
    expect(findUnfinishedBatch(store.db, project.id)).toBeUndefined();
    expect(currentBatch(store.db, project.id)?.id).toBe(first.id);
    const second = newBatch(project.id, 'Second');
    expect(currentBatch(store.db, project.id)?.id).toBe(second.id);
    expect(listProjectViews(store.db).find((p) => p.id === project.id)?.currentBatch?.id).toBe(
      second.id,
    );
    expect(listBatches(store.db, { projectId: project.id }).map((b) => b.id)).toEqual([
      first.id,
      second.id,
    ]);
  });

  it("lists a batch's workstreams and finds a task's latest done workstream", () => {
    const project = prProject();
    const batch = newBatch(project.id);
    move(batch.id, 'OPEN');
    const task = addTask(project.id);
    const ws = store.write((ctx) => insertWorkstream(ctx, task.id, { batchId: batch.id })).value;
    expect(ws.batchId).toBe(batch.id);
    expect(listWorkstreams(store.db, { batchId: batch.id }).map((w) => w.id)).toEqual([ws.id]);
    expect(latestDoneWorkstream(store.db, task.id)).toBeUndefined();
    store.write((ctx) => {
      for (const to of ['STARTING', 'RUNNING', 'VERIFYING', 'DONE'] as const)
        transitionWorkstream(ctx, ws.id, { to, fence: null });
    });
    expect(latestDoneWorkstream(store.db, task.id)?.batchId).toBe(batch.id);
  });
});

describe('project delivery', () => {
  it('defaults to local delivery on main with no prefix', () => {
    expect(seedProject(store)).toMatchObject({
      delivery: 'local',
      baseBranch: 'main',
      prTitlePrefix: null,
    });
  });

  it('fills the column defaults for a row written without the delivery columns', () => {
    const id = mintId('Project');
    store.db
      .insert(schema.projects)
      .values({
        id,
        name: 'raw',
        repoPath: '/tmp/raw-delivery',
        gateCommand: 'true',
        areas: [],
        hazards: [],
        maxLanes: 1,
        provider: 'claude',
        billingMode: 'subscription',
        model: 'sonnet',
        effort: 'medium',
        handoffPct: 40,
        nudgePct: 50,
        humanWaitMinutes: 10,
        createdAt: AT,
        updatedAt: AT,
      })
      .run();
    expect(getProject(store.db, id)).toMatchObject({
      delivery: 'local',
      baseBranch: 'main',
      prTitlePrefix: null,
    });
  });

  it.each<{ name: string; input: Partial<ProjectInput> }>([
    { name: 'pull requests without a prefix', input: { delivery: 'pull_request' } },
    { name: 'a base branch that is an option', input: { baseBranch: '-delete' } },
    {
      name: 'a prefix that is not a Conventional Commit type',
      input: { delivery: 'pull_request', prTitlePrefix: 'Feature' },
    },
  ])('refuses a project with $name', ({ input }) => {
    expect(() => seedProject(store, input)).toThrow();
  });

  it('refuses a patch that leaves pull request delivery without a prefix', () => {
    const project = seedProject(store);
    expect(() =>
      store.write((ctx) => patchProject(ctx, project.id, { delivery: 'pull_request' })),
    ).toThrow(InvalidError);
    const patched = store.write((ctx) =>
      patchProject(ctx, project.id, { delivery: 'pull_request', prTitlePrefix: 'feat(app)' }),
    ).value;
    expect(patched).toMatchObject({ delivery: 'pull_request', prTitlePrefix: 'feat(app)' });
    expect(() =>
      store.write((ctx) => patchProject(ctx, project.id, { prTitlePrefix: null })),
    ).toThrow(InvalidError);
  });

  it.each<{ name: string; arrange: (projectId: ProjectId) => void }>([
    {
      name: 'an active workstream',
      arrange: (projectId) => {
        const task = addTask(projectId);
        store.write((ctx) => insertWorkstream(ctx, task.id));
      },
    },
    { name: 'an unfinished batch', arrange: (projectId) => newBatch(projectId) },
  ])('refuses to change delivery while the project has $name', ({ arrange }) => {
    const project = seedProject(store);
    arrange(project.id);
    expect(() =>
      store.write((ctx) =>
        patchProject(ctx, project.id, { delivery: 'pull_request', prTitlePrefix: 'feat(app)' }),
      ),
    ).toThrow(ConflictError);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @10db/db exec vitest run src/store/batches.test.ts`
Expected: FAIL. The suite fails to collect with `insertBatch is not a function` (or a TypeError reading `schema.batches`), because no batches table or repository exists.

- [ ] **Step 3: Add the project and workstream fields to the contracts**

In `packages/contracts/src/entities.ts`:

- Import `BatchId` from `./ids`, `Delivery` from `./states`, and `BranchName`, `PrTitlePrefix` from `./git-names`.
- In `ProjectInput`'s object, after `budgetCeiling`:

```ts
    /** How finished work leaves the machine: on the checked-out branch, or as a batch's pull request. */
    delivery: z.enum(Delivery).default(Delivery.Local),
    /** The branch on `origin` a batch is cut from and its pull request targets. */
    baseBranch: BranchName.default('main'),
    /** `pull_request` delivery titles each PR `<prefix>: <batch title>`. */
    prTitlePrefix: PrTitlePrefix.nullable().default(null),
```

and chain a second refinement after the existing one:

```ts
  .refine((p) => p.delivery !== Delivery.PullRequest || p.prTitlePrefix !== null, {
    message: 'Pull request delivery needs a PR title prefix such as feat(app)',
    path: ['prTitlePrefix'],
  });
```

- In `ProjectDto`, after `budgetCeiling`:

```ts
  delivery: z.enum(Delivery),
  baseBranch: z.string(),
  prTitlePrefix: z.string().nullable(),
```

- In `ProjectPatch`'s object, after `budgetCeiling`:

```ts
    delivery: z.enum(Delivery),
    baseBranch: BranchName,
    prTitlePrefix: PrTitlePrefix.nullable(),
```

- In `WorkstreamDto`, after `projectId`:

```ts
  /** The batch it runs in; null in local delivery. */
  batchId: BatchId.nullable(),
```

- [ ] **Step 4: Add the table and columns**

In `packages/db/src/schema.ts`, import `BatchFailure`, `BatchId`, `BatchState` and `Delivery` as types from `@10db/contracts`.

In `projects`, after `budgetCeiling`:

```ts
  delivery: text('delivery').$type<Delivery>().notNull().default('local'),
  baseBranch: text('base_branch').notNull().default('main'),
  prTitlePrefix: text('pr_title_prefix'),
```

After the `projects` table, add:

```ts
/**
 * One branch and one pull request (batch delivery spec §3). The partial unique index allows one
 * unfinished batch per project; its state list matches UNFINISHED_BATCH_STATES.
 */
export const batches = sqliteTable(
  'batches',
  {
    id: text('id').$type<BatchId>().primaryKey(),
    projectId: text('project_id')
      .$type<ProjectId>()
      .notNull()
      .references(() => projects.id),
    title: text('title').notNull(),
    state: text('state').$type<BatchState>().notNull(),
    branch: text('branch'),
    baseBranch: text('base_branch').notNull(),
    baseSha: text('base_sha'),
    /** The GitHub `owner/name` from `gh repo view`, recorded at cut. */
    repo: text('repo'),
    prUrl: text('pr_url'),
    gateExitCode: integer('gate_exit_code'),
    gateLogPath: text('gate_log_path'),
    /** The shipping gate's process-group leader and its OS start time, so recovery can kill an orphaned gate. */
    gatePid: integer('gate_pid'),
    gatePidStart: text('gate_pid_start'),
    failure: text('failure').$type<BatchFailure>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('batches_project_idx').on(t.projectId),
    uniqueIndex('batches_one_unfinished')
      .on(t.projectId)
      .where(sql`state IN ('CUTTING', 'OPEN', 'SHIPPING', 'FAILED')`),
  ],
);
```

In `workstreams`, after `projectId`:

```ts
    batchId: text('batch_id')
      .$type<BatchId>()
      .references(() => batches.id),
```

and add `index('workstreams_batch_idx').on(t.batchId)` to its index list.

- [ ] **Step 5: Regenerate the migration baseline**

Until `v0.1.0` the baseline is regenerated, not extended (`packages/db/AGENTS.md`). Run in `packages/db`:

```bash
cp drizzle/0001_decisions_fts.sql "$TMPDIR/decisions_fts.sql" && rm -rf drizzle && pnpm exec drizzle-kit generate --name init && pnpm exec drizzle-kit generate --custom --name decisions_fts && cp "$TMPDIR/decisions_fts.sql" drizzle/0001_decisions_fts.sql
```

Expected: `drizzle/0000_init.sql` now has `CREATE TABLE \`batches\``, the `batches_one_unfinished`index with its`WHERE`clause, the three`projects`columns with their defaults and`workstreams.batch_id`; `drizzle/0001_decisions_fts.sql` is byte for byte what it was (`git diff packages/db/drizzle/0001_decisions_fts.sql` prints nothing).

- [ ] **Step 6: Write the batches repository**

`packages/db/src/store/batches.ts`:

```ts
import {
  BatchState,
  canBatchTransition,
  ConflictError,
  EventType,
  mintId,
  NotFoundError,
  UNFINISHED_BATCH_STATES,
  type BatchDto,
  type BatchFailure,
  type BatchId,
  type ProjectId,
} from '@10db/contracts';
import { and, asc, desc, eq, inArray, type SQL } from 'drizzle-orm';
import type { Json } from '../json';
import * as schema from '../schema';
import type { DbReader, WriteContext } from './store';

export type BatchRow = typeof schema.batches.$inferSelect;

export interface BatchPatch {
  readonly branch?: string;
  readonly baseSha?: string;
  readonly repo?: string;
  readonly prUrl?: string;
  readonly gateExitCode?: number | null;
  readonly gateLogPath?: string | null;
  readonly gatePid?: number | null;
  readonly gatePidStart?: string | null;
  readonly failure?: BatchFailure | null;
}

/** The gate pid stays internal: only recovery reads it. */
function toBatchDto(row: BatchRow): BatchDto {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    state: row.state,
    branch: row.branch,
    baseBranch: row.baseBranch,
    baseSha: row.baseSha,
    repo: row.repo,
    prUrl: row.prUrl,
    gateExitCode: row.gateExitCode,
    gateLogPath: row.gateLogPath,
    failure: row.failure,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function emitBatch(ctx: WriteContext, id: BatchId, data: Record<string, Json>): void {
  ctx.emit({ type: EventType.BatchUpdated, entityType: 'batch', entityId: id, data });
}

export function getBatchRow(db: DbReader, id: BatchId): BatchRow {
  const row = db.select().from(schema.batches).where(eq(schema.batches.id, id)).get();
  if (!row) throw new NotFoundError('batch', id);
  return row;
}

export function getBatch(db: DbReader, id: BatchId): BatchDto {
  return toBatchDto(getBatchRow(db, id));
}

export function findUnfinishedBatch(db: DbReader, projectId: ProjectId): BatchDto | undefined {
  const row = db
    .select()
    .from(schema.batches)
    .where(
      and(
        eq(schema.batches.projectId, projectId),
        inArray(schema.batches.state, [...UNFINISHED_BATCH_STATES]),
      ),
    )
    .get();
  return row ? toBatchDto(row) : undefined;
}

/** The batch a project view shows: the unfinished one, else the latest. */
export function currentBatch(db: DbReader, projectId: ProjectId): BatchDto | null {
  const unfinished = findUnfinishedBatch(db, projectId);
  if (unfinished) return unfinished;
  const latest = db
    .select()
    .from(schema.batches)
    .where(eq(schema.batches.projectId, projectId))
    .orderBy(desc(schema.batches.createdAt), desc(schema.batches.id))
    .limit(1)
    .get();
  return latest ? toBatchDto(latest) : null;
}

export function listBatches(
  db: DbReader,
  filter: { readonly projectId?: ProjectId; readonly states?: readonly BatchState[] } = {},
): BatchDto[] {
  const where: SQL[] = [];
  if (filter.projectId) where.push(eq(schema.batches.projectId, filter.projectId));
  if (filter.states) where.push(inArray(schema.batches.state, [...filter.states]));
  return db
    .select()
    .from(schema.batches)
    .where(and(...where))
    .orderBy(asc(schema.batches.createdAt), asc(schema.batches.id))
    .all()
    .map(toBatchDto);
}

/** A new batch is CUTTING: the row exists before any git side effect (batch delivery spec §5). */
export function insertBatch(
  ctx: WriteContext,
  input: { readonly projectId: ProjectId; readonly title: string; readonly baseBranch: string },
): BatchDto {
  const unfinished = findUnfinishedBatch(ctx.tx, input.projectId);
  if (unfinished) {
    throw new ConflictError(
      `Batch "${unfinished.title}" is still ${unfinished.state.toLowerCase()}; a project runs one batch at a time`,
    );
  }
  const row: BatchRow = {
    id: mintId('Batch'),
    projectId: input.projectId,
    title: input.title,
    state: BatchState.Cutting,
    branch: null,
    baseBranch: input.baseBranch,
    baseSha: null,
    repo: null,
    prUrl: null,
    gateExitCode: null,
    gateLogPath: null,
    gatePid: null,
    gatePidStart: null,
    failure: null,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
  ctx.tx.insert(schema.batches).values(row).run();
  emitBatch(ctx, row.id, { from: null, to: BatchState.Cutting, reason: null });
  return toBatchDto(row);
}

export function transitionBatch(
  ctx: WriteContext,
  id: BatchId,
  opts: { readonly to: BatchState; readonly patch?: BatchPatch; readonly reason?: string },
): BatchDto {
  const row = getBatchRow(ctx.tx, id);
  if (!canBatchTransition(row.state, opts.to))
    throw new ConflictError(`Cannot move batch "${row.title}" from ${row.state} to ${opts.to}`);
  ctx.tx
    .update(schema.batches)
    .set({ ...opts.patch, state: opts.to, updatedAt: ctx.now })
    .where(eq(schema.batches.id, id))
    .run();
  emitBatch(ctx, id, { from: row.state, to: opts.to, reason: opts.reason ?? null });
  return getBatch(ctx.tx, id);
}

export function patchBatch(ctx: WriteContext, id: BatchId, patch: BatchPatch): BatchDto {
  getBatchRow(ctx.tx, id);
  ctx.tx
    .update(schema.batches)
    .set({ ...patch, updatedAt: ctx.now })
    .where(eq(schema.batches.id, id))
    .run();
  emitBatch(ctx, id, { changed: Object.keys(patch) });
  return getBatch(ctx.tx, id);
}

/** A refused or interrupted cut leaves nothing behind: nothing references a CUTTING row. */
export function deleteCuttingBatch(ctx: WriteContext, id: BatchId, reason: string): void {
  const row = getBatchRow(ctx.tx, id);
  if (row.state !== BatchState.Cutting)
    throw new ConflictError(
      `Batch "${row.title}" is ${row.state}; only a cutting batch is deleted`,
    );
  ctx.tx.delete(schema.batches).where(eq(schema.batches.id, id)).run();
  emitBatch(ctx, id, { from: BatchState.Cutting, to: null, reason });
}
```

In `packages/db/src/store/index.ts`, add `export * from './batches';` (sorted, first).

- [ ] **Step 7: Carry `batch_id` on workstreams**

In `packages/db/src/store/workstreams.ts`:

- Import `BatchId` as a type and `desc` from `drizzle-orm`.
- In `toDto`, add `batchId: row.batchId,` after `projectId`.
- Give `listWorkstreams` a `batchId` filter:

```ts
export function listWorkstreams(
  db: DbReader,
  filter: { states?: readonly WorkstreamState[]; projectId?: ProjectId; batchId?: BatchId } = {},
): WorkstreamDto[] {
  const where: SQL[] = [];
  if (filter.states) where.push(inArray(schema.workstreams.state, [...filter.states]));
  if (filter.projectId) where.push(eq(schema.workstreams.projectId, filter.projectId));
  if (filter.batchId) where.push(eq(schema.workstreams.batchId, filter.batchId));
  // ...the existing select, order and map stay as they are
}
```

- Give `insertWorkstream` an options argument and put the batch on the row:

```ts
export function insertWorkstream(
  ctx: WriteContext,
  taskId: TaskId,
  opts: { readonly batchId?: BatchId | null } = {},
): WorkstreamDto {
  // ...unchanged checks; in the row literal, after projectId:
    batchId: opts.batchId ?? null,
  // ...and in the emitted event's data:
    data: { taskId, projectId: project.id, batchId: opts.batchId ?? null },
```

- Add:

```ts
/** The task's most recent DONE workstream: where its code was finished, and in which batch. */
export function latestDoneWorkstream(db: DbReader, taskId: TaskId): WorkstreamRow | undefined {
  return db
    .select()
    .from(schema.workstreams)
    .where(
      and(
        eq(schema.workstreams.taskId, taskId),
        eq(schema.workstreams.state, WorkstreamState.Done),
      ),
    )
    .orderBy(desc(schema.workstreams.createdAt), desc(schema.workstreams.id))
    .limit(1)
    .get();
}
```

- [ ] **Step 8: Enforce the delivery rules on projects and add the project views**

In `packages/db/src/store/projects.ts`, import `ACTIVE_STATES`, `Delivery` and `type ProjectViewDto` from `@10db/contracts`, `and`, `inArray` from `drizzle-orm`, and `currentBatch`, `findUnfinishedBatch` from `./batches`. In `patchProject`, after the nudge check and before the update:

```ts
if (changes.delivery !== undefined && changes.delivery !== current.delivery) {
  // A QUEUED pull-request workstream needs a batch to launch, so delivery can't change under work.
  const busy = ctx.tx
    .select({ id: schema.workstreams.id })
    .from(schema.workstreams)
    .where(
      and(
        eq(schema.workstreams.projectId, id),
        inArray(schema.workstreams.state, [...ACTIVE_STATES]),
      ),
    )
    .get();
  if (busy || findUnfinishedBatch(ctx.tx, id))
    throw new ConflictError(
      `${current.name} has unfinished work; finish or cancel it before changing its delivery`,
    );
}
const delivery = changes.delivery ?? current.delivery;
const prefix = changes.prTitlePrefix === undefined ? current.prTitlePrefix : changes.prTitlePrefix;
if (delivery === Delivery.PullRequest && prefix === null)
  throw new InvalidError('Pull request delivery needs a PR title prefix such as feat(app)');
```

and add:

```ts
/** `GET /projects`: each project with the batch its view shows. */
export function listProjectViews(db: DbReader): ProjectViewDto[] {
  return listProjects(db).map((p) => ({ ...p, currentBatch: currentBatch(db, p.id) }));
}
```

`insertProject` needs no change: it spreads the parsed config, which now carries the three fields.

- [ ] **Step 9: Update the desktop fixtures**

In `apps/desktop/src/test/fixtures.ts`, add to `projectDto`'s object, after `budgetCeiling: null`:

```ts
    delivery: 'local',
    baseBranch: 'main',
    prTitlePrefix: null,
```

and to `workstreamDto`'s object, after `projectId`:

```ts
    batchId: null,
```

- [ ] **Step 10: Run the tests to verify they pass**

Run: `pnpm --filter @10db/db exec vitest run && pnpm --filter @10db/contracts generate && pnpm typecheck && pnpm --filter @10db/daemon exec vitest run && pnpm --filter @10db/desktop exec vitest run`
Expected: the new suite passes; every existing db, daemon and desktop test still passes (local delivery is the default); `project-dto`, `project-patch`, `project-view-dto`, `task-start-result` and `workstream-dto` schemas regenerate; typecheck is clean.

- [ ] **Step 11: Commit**

```bash
pnpm format && git add packages/contracts/src/entities.ts packages/contracts/generated packages/db/src/schema.ts packages/db/src/store/batches.ts packages/db/src/store/batches.test.ts packages/db/src/store/workstreams.ts packages/db/src/store/projects.ts packages/db/src/store/index.ts packages/db/drizzle apps/desktop/src/test/fixtures.ts && git commit -m 'feat(db): add the batches table, project delivery fields and batch repositories' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>' -m 'Claude-Session: https://claude.ai/code/session_01KFqjacxo6Va8EyHF93n3xr'
```

---

### Task 3: Git: the branch, the remote, fetch, switch and push

**Files:**

- Modify: `apps/daemon/src/git/git.ts`, `apps/daemon/src/git/index.ts`
- Modify: `apps/daemon/test/fixtures.ts` (`createTempRepoWithOrigin`, `NETWORK_ENV`)
- Test: `apps/daemon/src/git/git.test.ts` (new `describe` blocks)

**Interfaces:**

- Consumes: the existing `Git`, `createGit()` and its `git()` helper.
- Produces:
  - `interface NetworkCall { readonly env: Readonly<Record<string, string>>; readonly timeoutMs: number; readonly signal?: AbortSignal }`
  - `GitNetworkFailure` (`timeout | rejected | aborted | failed`), `class GitNetworkError extends Error { readonly kind: GitNetworkFailure; readonly detail: string }`
  - New `Git` methods:
    - `currentBranch(repo: string): Promise<string | null>`: `git branch --show-current`; null when detached.
    - `remoteUrl(repo: string, name: string): Promise<string | null>`: `git remote get-url <name>`; null when there is no such remote.
    - `fetch(repo: string, branch: string, net: NetworkCall): Promise<void>`: `git fetch --no-tags origin +refs/heads/<branch>:refs/remotes/origin/<branch>`.
    - `switchNewBranch(repo: string, name: string, startPoint: string): Promise<void>`: `git switch --no-track -c <name> <startPoint>`.
    - `push(repo: string, branch: string, net: NetworkCall): Promise<void>`: `git push -u origin refs/heads/<branch>:refs/heads/<branch>`, never forced.
  - Test fixtures: `createTempRepoWithOrigin(): { repo: TempDir; origin: TempDir; cleanup(): void }` (the repo's `origin` is a local bare repo holding `main`) and `NETWORK_ENV: Readonly<Record<string, string>>` (`PATH` only).

- [ ] **Step 1: Add the fixture**

In `apps/daemon/test/fixtures.ts`, add:

```ts
/** What network calls get in tests: enough PATH to find git and gh scripts, nothing else. */
export const NETWORK_ENV: Readonly<Record<string, string>> = {
  PATH: process.env['PATH'] ?? '/usr/bin:/bin',
};

/** A temp repo whose `origin` is a local bare repo holding `main`, so fetch and push are real. */
export function createTempRepoWithOrigin(): { repo: TempDir; origin: TempDir; cleanup(): void } {
  const origin = tempDir('origin');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin.path], { stdio: 'pipe' });
  const repo = createTempRepo();
  execFileSync('git', ['-C', repo.path, 'remote', 'add', 'origin', origin.path], { stdio: 'pipe' });
  execFileSync('git', ['-C', repo.path, 'push', '-q', 'origin', 'main'], { stdio: 'pipe' });
  return {
    repo,
    origin,
    cleanup: () => {
      repo.cleanup();
      origin.cleanup();
    },
  };
}
```

- [ ] **Step 2: Write the failing tests**

Append to `apps/daemon/src/git/git.test.ts` (add `createTempRepoWithOrigin`, `NETWORK_ENV` to the fixtures import and `GitNetworkError` to the `./index` import):

```ts
describe('branches and remotes', () => {
  it('reads the current branch, and null when HEAD is detached', async () => {
    expect(await git.currentBranch(repo.path)).toBe('main');
    rawGit('checkout', '-q', '--detach');
    expect(await git.currentBranch(repo.path)).toBeNull();
  });

  it("reads a remote's URL, and null when there is no such remote", async () => {
    expect(await git.remoteUrl(repo.path, 'origin')).toBeNull();
    rawGit('remote', 'add', 'origin', '/nowhere/x.git');
    expect(await git.remoteUrl(repo.path, 'origin')).toBe('/nowhere/x.git');
  });

  it('switches to a new branch from a start point, with no upstream', async () => {
    const base = rawGit('rev-parse', 'HEAD');
    write('later.txt', 'later');
    rawGit('add', 'later.txt');
    rawGit('commit', '-q', '-m', 'later');
    await git.switchNewBranch(repo.path, '10db/greetings-0a1b2c3d', base);
    expect(rawGit('branch', '--show-current')).toBe('10db/greetings-0a1b2c3d');
    expect(rawGit('rev-parse', 'HEAD')).toBe(base);
    expect(() => rawGit('rev-parse', '--abbrev-ref', '@{u}')).toThrow();
    await expect(git.switchNewBranch(repo.path, '10db/greetings-0a1b2c3d', base)).rejects.toThrow(
      /already exists/,
    );
  });
});

describe('network calls', () => {
  let remote: ReturnType<typeof createTempRepoWithOrigin>;
  beforeEach(() => {
    remote = createTempRepoWithOrigin();
  });
  afterEach(() => {
    remote.cleanup();
  });

  const net = { env: NETWORK_ENV, timeoutMs: 10_000 };
  const local = (...args: string[]) =>
    execFileSync('git', ['-C', remote.repo.path, ...args])
      .toString()
      .trim();
  const origin = (...args: string[]) =>
    execFileSync('git', ['-C', remote.origin.path, ...args])
      .toString()
      .trim();
  /** Another clone adds a commit to `branch` on origin, as a teammate would. */
  function pushFromElsewhere(branch: string, file: string): string {
    const other = tempDir('other');
    try {
      execFileSync('git', ['clone', '-q', remote.origin.path, other.path], { stdio: 'pipe' });
      const g = (...args: string[]) =>
        execFileSync('git', ['-C', other.path, ...args], { stdio: 'pipe' })
          .toString()
          .trim();
      g('config', 'user.name', 'teammate');
      g('config', 'user.email', 'teammate@10db.invalid');
      g('config', 'commit.gpgsign', 'false');
      if (branch !== 'main') g('switch', '-q', '-c', branch);
      writeFileSync(join(other.path, file), file);
      g('add', file);
      g('commit', '-q', '-m', `Add ${file}`);
      g('push', '-q', 'origin', branch);
      return g('rev-parse', 'HEAD');
    } finally {
      other.cleanup();
    }
  }

  it('fetches the base branch into origin/<branch> without touching the checkout', async () => {
    const before = local('rev-parse', 'HEAD');
    const upstream = pushFromElsewhere('main', 'upstream.txt');
    await git.fetch(remote.repo.path, 'main', net);
    expect(local('rev-parse', 'origin/main')).toBe(upstream);
    expect(local('rev-parse', 'HEAD')).toBe(before);
  });

  it('fails to fetch a branch origin does not have', async () => {
    const failure = git.fetch(remote.repo.path, 'develop', net);
    await expect(failure).rejects.toBeInstanceOf(GitNetworkError);
    await expect(failure).rejects.toMatchObject({ kind: 'failed' });
  });

  it('pushes a branch and sets its upstream, and pushing it again changes nothing', async () => {
    await git.switchNewBranch(remote.repo.path, '10db/x-0a1b2c3d', 'main');
    writeFileSync(join(remote.repo.path, 'x.txt'), 'x');
    local('add', 'x.txt');
    local('commit', '-q', '-m', 'Add x');
    await git.push(remote.repo.path, '10db/x-0a1b2c3d', net);
    const sha = local('rev-parse', 'HEAD');
    expect(origin('rev-parse', 'refs/heads/10db/x-0a1b2c3d')).toBe(sha);
    expect(local('rev-parse', '--abbrev-ref', '@{u}')).toBe('origin/10db/x-0a1b2c3d');
    await git.push(remote.repo.path, '10db/x-0a1b2c3d', net);
    expect(origin('rev-parse', 'refs/heads/10db/x-0a1b2c3d')).toBe(sha);
  });

  it('reports a rejected push and never forces it', async () => {
    const theirs = pushFromElsewhere('10db/x-0a1b2c3d', 'theirs.txt');
    await git.switchNewBranch(remote.repo.path, '10db/x-0a1b2c3d', 'main');
    writeFileSync(join(remote.repo.path, 'ours.txt'), 'ours');
    local('add', 'ours.txt');
    local('commit', '-q', '-m', 'Add ours');
    const failure = git.push(remote.repo.path, '10db/x-0a1b2c3d', net);
    await expect(failure).rejects.toMatchObject({ name: 'GitNetworkError', kind: 'rejected' });
    expect(origin('rev-parse', 'refs/heads/10db/x-0a1b2c3d')).toBe(theirs);
  });

  it('times out a fetch that hangs', async () => {
    local('remote', 'set-url', 'origin', 'ssh://git@example.invalid/hang.git');
    // ssh is replaced by a command that hangs; git appends the host and command as arguments.
    const hang = {
      env: { ...NETWORK_ENV, GIT_SSH_COMMAND: 'sleep 5; true', GIT_SSH_VARIANT: 'simple' },
      timeoutMs: 300,
    };
    await expect(git.fetch(remote.repo.path, 'main', hang)).rejects.toMatchObject({
      kind: 'timeout',
    });
  });

  it('stops a fetch when its signal aborts', async () => {
    local('remote', 'set-url', 'origin', 'ssh://git@example.invalid/hang.git');
    const controller = new AbortController();
    const call = {
      env: { ...NETWORK_ENV, GIT_SSH_COMMAND: 'sleep 5; true', GIT_SSH_VARIANT: 'simple' },
      timeoutMs: 10_000,
      signal: controller.signal,
    };
    const pending = git.fetch(remote.repo.path, 'main', call);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ kind: 'aborted' });
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @10db/daemon exec vitest run src/git/git.test.ts`
Expected: FAIL: the new cases throw `TypeError: git.currentBranch is not a function` (and the same for `remoteUrl`, `switchNewBranch`, `fetch`, `push`); the existing `commit` cases still pass.

- [ ] **Step 4: Implement the methods**

In `apps/daemon/src/git/git.ts`, add after `GitError`:

```ts
/** How a network call is made: in the login environment, bounded in time, stoppable. */
export interface NetworkCall {
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export const GitNetworkFailure = {
  Timeout: 'timeout',
  Rejected: 'rejected',
  Aborted: 'aborted',
  Failed: 'failed',
} as const;
export type GitNetworkFailure = (typeof GitNetworkFailure)[keyof typeof GitNetworkFailure];

/** A fetch or push that did not complete; `detail` is git's own message, trimmed. */
export class GitNetworkError extends Error {
  override readonly name = 'GitNetworkError';
  readonly kind: GitNetworkFailure;
  readonly detail: string;
  constructor(kind: GitNetworkFailure, args: readonly string[], detail: string) {
    super(`git ${args.join(' ')}: ${kind}${detail ? `: ${detail}` : ''}`);
    this.kind = kind;
    this.detail = detail;
  }
}

/** Prompts are off whatever the environment says: nobody can answer one. */
const NO_PROMPTS = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', LC_ALL: 'C' } as const;
const REJECTED = /\[(remote )?rejected\]|failed to push some refs/i;

function stderrOf(error: unknown): string {
  return typeof error === 'object' && error !== null && 'stderr' in error
    ? String(error.stderr).trim().slice(-2000)
    : String(error);
}

async function gitNetwork(repo: string, args: readonly string[], net: NetworkCall): Promise<void> {
  try {
    await run('git', ['-C', repo, ...args], {
      env: { ...net.env, ...NO_PROMPTS },
      timeout: net.timeoutMs,
      killSignal: 'SIGKILL',
      ...(net.signal ? { signal: net.signal } : {}),
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    if (net.signal?.aborted) throw new GitNetworkError(GitNetworkFailure.Aborted, args, '');
    const killed =
      typeof error === 'object' && error !== null && 'killed' in error && error.killed === true;
    if (killed)
      throw new GitNetworkError(
        GitNetworkFailure.Timeout,
        args,
        `no answer within ${String(Math.round(net.timeoutMs / 1000))} s`,
      );
    const stderr = stderrOf(error);
    throw new GitNetworkError(
      REJECTED.test(stderr) ? GitNetworkFailure.Rejected : GitNetworkFailure.Failed,
      args,
      stderr,
    );
  }
}
```

Add to the `Git` interface:

```ts
  /** The checked-out branch; null when HEAD is detached. */
  currentBranch(repo: string): Promise<string | null>;
  /** The URL of remote `name`; null when the repository has no such remote. */
  remoteUrl(repo: string, name: string): Promise<string | null>;
  /** Updates `origin/<branch>` from origin; the checkout is untouched. */
  fetch(repo: string, branch: string, net: NetworkCall): Promise<void>;
  /** Creates `name` at `startPoint` and checks it out, with no upstream. */
  switchNewBranch(repo: string, name: string, startPoint: string): Promise<void>;
  /** Pushes `branch` to the same name on origin and sets it as upstream; never forced. */
  push(repo: string, branch: string, net: NetworkCall): Promise<void>;
```

and to the object `createGit()` returns:

```ts
    async currentBranch(repo) {
      const name = (await git(repo, ['branch', '--show-current'])).trim();
      return name === '' ? null : name;
    },
    async remoteUrl(repo, name) {
      try {
        return (await git(repo, ['remote', 'get-url', name])).trim();
      } catch (error) {
        if (error instanceof GitError && /no such remote/i.test(error.stderr)) return null;
        throw error;
      }
    },
    fetch: (repo, branch, net) =>
      gitNetwork(repo, ['fetch', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], net),
    async switchNewBranch(repo, name, startPoint) {
      await withRepoLock(repo, () => git(repo, ['switch', '--no-track', '-c', name, startPoint]));
    },
    push: (repo, branch, net) =>
      gitNetwork(repo, ['push', '-u', 'origin', `refs/heads/${branch}:refs/heads/${branch}`], net),
```

`switchNewBranch` takes the repo lock that `commit` uses, so a switch never interleaves with a commit's `add` and `commit`. Every branch name reaching these methods was validated by `BranchName` or built by `batchBranchName` (Task 5), so none starts with `-`.

In `apps/daemon/src/git/index.ts`:

```ts
export { createGit, GitNetworkError, type Git, type NetworkCall } from './git';
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @10db/daemon exec vitest run src/git/git.test.ts && pnpm typecheck`
Expected: PASS, every case; the timeout case finishes in well under a second.

- [ ] **Step 6: Commit**

```bash
pnpm format && git add apps/daemon/src/git/git.ts apps/daemon/src/git/index.ts apps/daemon/src/git/git.test.ts apps/daemon/test/fixtures.ts && git commit -m 'feat(daemon): read the branch and fetch, switch and push through the git module' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>' -m 'Claude-Session: https://claude.ai/code/session_01KFqjacxo6Va8EyHF93n3xr'
```

---

### Task 4: The `gh` wrapper, the network environment and `gh` in the system check

**Files:**

- Create: `apps/daemon/src/github/gh.ts`, `apps/daemon/src/github/index.ts`
- Test: `apps/daemon/src/github/gh.test.ts`
- Create: `apps/daemon/test/fake-gh.ts` (the `Gh` fake later tasks use)
- Create: `apps/daemon/src/environment/network-env.ts`; Modify: `apps/daemon/src/environment/system-check.ts`, `apps/daemon/src/environment/index.ts`
- Test: `apps/daemon/src/environment/network-env.test.ts`, `apps/daemon/src/environment/system-check.test.ts` (the `gh` row)
- Modify: `apps/daemon/AGENTS.md` (the module order line)

**Interfaces:**

- Consumes: `ToolName.Gh` (Task 1), `NESTED_SESSION_VARS` (`environment/session-env.ts`).
- Produces:
  - `github/`:
    - `interface GhCall { readonly cwd: string; readonly env: Readonly<Record<string, string>>; readonly timeoutMs: number; readonly signal?: AbortSignal }`
    - `GhFailure` (`not_installed | signed_out | timeout | aborted | failed`), `class GhError extends Error { readonly kind: GhFailure }`
    - `PrState` (`OPEN | CLOSED | MERGED`), `interface PullRequest { readonly url: string; readonly state: PrState }`
    - `interface Gh`:
      - `authStatus(call: GhCall): Promise<void>`: throws `GhError` `signed_out` or `not_installed`
      - `repoView(call: GhCall): Promise<string>`: the `owner/name` of the repository at `call.cwd`
      - `prView(input: { repo: string; ref: string }, call: GhCall): Promise<PullRequest | null>`: `ref` is a branch or a PR URL; null when there is no PR, in any state
      - `prCreate(input: { repo: string; base: string; head: string; title: string; bodyFile: string }, call: GhCall): Promise<string>`: the new PR's URL
    - `type GhExec = (args: readonly string[], call: GhCall) => Promise<{ exitCode: number; stdout: string; stderr: string }>`, `systemGhExec: GhExec`, `createGh(exec?: GhExec): Gh`
  - `environment/`: `buildNetworkEnv(base: Readonly<Record<string, string>>): Record<string, string>`, `markGhRequired(check: SystemCheckDto, needed: boolean): SystemCheckDto`; `REQUIRED_TOOLS` lists `gh` (`required: false`).
  - `apps/daemon/test/fake-gh.ts`: `class FakeGh implements Gh` with `auth: 'ok' | 'signed_out' | 'not_installed'`, `repo: string`, `failNext: Map<GhMethod, GhError>`, `calls`, `prCreates(): PrCreateCall[]`, `body(url: string): string`, `setState(url: string, state: PrState): void`, `openPr(branch: string, state?: PrState): string`.

- [ ] **Step 1: Write the failing tests**

`apps/daemon/src/github/gh.test.ts`:

```ts
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../test/fixtures';
import { createGh, GhError, systemGhExec, type GhCall, type GhExec } from './index';

const CALL: GhCall = { cwd: '/tmp', env: {}, timeoutMs: 5_000 };

/** A scripted exec: answers each call with the output for its first two arguments. */
function scripted(
  answers: Record<string, { exitCode: number; stdout?: string; stderr?: string } | GhError>,
) {
  const seen: (readonly string[])[] = [];
  const exec: GhExec = (args) => {
    seen.push(args);
    const answer = answers[args.slice(0, 2).join(' ')];
    if (answer === undefined) return Promise.reject(new Error(`unexpected gh ${args.join(' ')}`));
    if (answer instanceof GhError) return Promise.reject(answer);
    return Promise.resolve({ stdout: '', stderr: '', ...answer });
  };
  return { exec, seen };
}

describe('createGh', () => {
  it('passes a signed-in check and refuses a signed-out one', async () => {
    await expect(
      createGh(scripted({ 'auth status': { exitCode: 0 } }).exec).authStatus(CALL),
    ).resolves.toBeUndefined();
    await expect(
      createGh(
        scripted({
          'auth status': {
            exitCode: 1,
            stderr: 'You are not logged into any GitHub hosts. To log in, run: gh auth login',
          },
        }).exec,
      ).authStatus(CALL),
    ).rejects.toMatchObject({ name: 'GhError', kind: 'signed_out' });
  });

  it.each([
    {
      name: 'the owner and name',
      answer: { exitCode: 0, stdout: '{"nameWithOwner":"acme/widgets"}\n' },
      expected: 'acme/widgets',
    },
    { name: 'output that is not JSON', answer: { exitCode: 0, stdout: 'oops' }, kind: 'failed' },
    {
      name: 'a name without an owner',
      answer: { exitCode: 0, stdout: '{"nameWithOwner":"widgets"}' },
      kind: 'failed',
    },
    {
      name: 'no GitHub remote',
      answer: {
        exitCode: 1,
        stderr:
          'none of the git remotes configured for this repository point to a known GitHub host',
      },
      kind: 'failed',
    },
    {
      name: 'authentication required',
      answer: { exitCode: 4, stderr: 'To get started with GitHub CLI, please run:  gh auth login' },
      kind: 'signed_out',
    },
  ])('repoView: $name', async ({ answer, expected, kind }) => {
    const view = createGh(scripted({ 'repo view': answer }).exec).repoView(CALL);
    if (kind) await expect(view).rejects.toMatchObject({ kind });
    else await expect(view).resolves.toBe(expected);
  });

  it.each([
    {
      name: 'an open PR',
      answer: {
        exitCode: 0,
        stdout: '{"state":"OPEN","url":"https://github.com/acme/widgets/pull/7"}',
      },
      expected: { state: 'OPEN', url: 'https://github.com/acme/widgets/pull/7' },
    },
    {
      name: 'a merged PR',
      answer: {
        exitCode: 0,
        stdout: '{"state":"MERGED","url":"https://github.com/acme/widgets/pull/7"}',
      },
      expected: { state: 'MERGED', url: 'https://github.com/acme/widgets/pull/7' },
    },
    {
      name: 'no PR for the branch',
      answer: { exitCode: 1, stderr: 'no pull requests found for branch "10db/x-0a1b2c3d"' },
      expected: null,
    },
    {
      name: 'a signed-out gh',
      answer: { exitCode: 4, stderr: 'gh auth login' },
      kind: 'signed_out',
    },
    { name: 'any other failure', answer: { exitCode: 1, stderr: 'HTTP 502' }, kind: 'failed' },
  ])('prView: $name', async ({ answer, expected, kind }) => {
    const { exec, seen } = scripted({ 'pr view': answer });
    const view = createGh(exec).prView({ repo: 'acme/widgets', ref: '10db/x-0a1b2c3d' }, CALL);
    if (kind) await expect(view).rejects.toMatchObject({ kind });
    else await expect(view).resolves.toEqual(expected);
    expect(seen[0]).toEqual([
      'pr',
      'view',
      '10db/x-0a1b2c3d',
      '-R',
      'acme/widgets',
      '--json',
      'url,state',
    ]);
  });

  it('creates a PR with every value as its own argument and returns the URL gh prints', async () => {
    const { exec, seen } = scripted({
      'pr create': {
        exitCode: 0,
        stdout:
          'Creating pull request for 10db/x-0a1b2c3d into main\n\nhttps://github.com/acme/widgets/pull/8\n',
      },
    });
    const title = `feat(app): say "hi" and $(whoami)`;
    const url = await createGh(exec).prCreate(
      {
        repo: 'acme/widgets',
        base: 'main',
        head: '10db/x-0a1b2c3d',
        title,
        bodyFile: '/tmp/body.md',
      },
      CALL,
    );
    expect(url).toBe('https://github.com/acme/widgets/pull/8');
    expect(seen[0]).toEqual([
      'pr',
      'create',
      '-R',
      'acme/widgets',
      '--base',
      'main',
      '--head',
      '10db/x-0a1b2c3d',
      '--title',
      title,
      '--body-file',
      '/tmp/body.md',
    ]);
  });

  it('passes not-installed through from the exec', async () => {
    const missing = new GhError('not_installed', 'gh is not installed');
    await expect(createGh(scripted({ 'auth status': missing }).exec).authStatus(CALL)).rejects.toBe(
      missing,
    );
  });
});

describe('systemGhExec', () => {
  let bin: { path: string; cleanup(): void };
  beforeEach(() => {
    bin = tempDir('gh-bin');
  });
  afterEach(() => {
    bin.cleanup();
  });
  function fakeGh(script: string): void {
    mkdirSync(bin.path, { recursive: true });
    const path = join(bin.path, 'gh');
    writeFileSync(path, `#!/bin/sh\n${script}\n`);
    chmodSync(path, 0o755);
  }
  const call = (overrides: Partial<GhCall> = {}): GhCall => ({
    cwd: bin.path,
    env: { PATH: `${bin.path}:/usr/bin:/bin` },
    timeoutMs: 5_000,
    ...overrides,
  });

  it('turns prompts off whatever the environment says, and runs in the given directory', async () => {
    fakeGh('echo "$GH_PROMPT_DISABLED $GH_NO_UPDATE_NOTIFIER $GIT_TERMINAL_PROMPT $(pwd) $*"');
    const env = {
      PATH: `${bin.path}:/usr/bin:/bin`,
      GH_PROMPT_DISABLED: '0',
      GIT_TERMINAL_PROMPT: '1',
    };
    const out = await systemGhExec(['auth', 'status'], call({ env }));
    expect(out).toMatchObject({ exitCode: 0 });
    // macOS resolves /var to /private/var in pwd.
    expect(out.stdout.trim()).toMatch(
      new RegExp(`^1 1 0 \\S*${bin.path.split('/').pop() ?? ''} auth status$`),
    );
  });

  it('returns a non-zero exit with its stderr', async () => {
    fakeGh('echo "HTTP 502" >&2; exit 3');
    expect(await systemGhExec(['pr', 'view'], call())).toMatchObject({
      exitCode: 3,
      stderr: 'HTTP 502\n',
    });
  });

  it('reports gh missing from the PATH as not installed', async () => {
    await expect(
      systemGhExec(['auth', 'status'], call({ env: { PATH: '/usr/bin:/bin' } })),
    ).rejects.toMatchObject({
      kind: 'not_installed',
    });
  });

  it('times out a gh that hangs', async () => {
    fakeGh('sleep 5');
    await expect(systemGhExec(['pr', 'create'], call({ timeoutMs: 300 }))).rejects.toMatchObject({
      kind: 'timeout',
    });
  });
});
```

`apps/daemon/src/environment/network-env.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildNetworkEnv } from './index';

describe('buildNetworkEnv', () => {
  it("keeps the login environment's credentials and paths, and drops 10db's own and nested-session variables", () => {
    expect(
      buildNetworkEnv({
        PATH: '/opt/homebrew/bin:/usr/bin',
        HOME: '/Users/me',
        SSH_AUTH_SOCK: '/tmp/agent.sock',
        GH_TOKEN: 'secret',
        TENDB_DATA_DIR: '/x',
        CLAUDECODE: '1',
        CLAUDE_PROJECT_DIR: '/y',
      }),
    ).toEqual({
      PATH: '/opt/homebrew/bin:/usr/bin',
      HOME: '/Users/me',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      GH_TOKEN: 'secret',
    });
  });
});
```

In `apps/daemon/src/environment/system-check.test.ts`, the `systemCheck` case expects a fourth tool row, `{ name: 'gh', path: null, version: null, required: false }`, after `docker`; and add (importing `markGhRequired`):

```ts
describe('markGhRequired', () => {
  it('requires gh only while some project delivers pull requests', () => {
    const check = {
      loginEnv: { source: 'login_shell' as const, warning: null },
      tools: [
        { name: 'git' as const, path: '/usr/bin/git', version: '2', required: true },
        { name: 'gh' as const, path: null, version: null, required: false },
      ],
    };
    expect(markGhRequired(check, true).tools.map((t) => [t.name, t.required])).toEqual([
      ['git', true],
      ['gh', true],
    ]);
    expect(markGhRequired(check, false).tools.map((t) => [t.name, t.required])).toEqual([
      ['git', true],
      ['gh', false],
    ]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @10db/daemon exec vitest run src/github src/environment`
Expected: FAIL. `gh.test.ts` can't load `./index` (no `github` module); `network-env.test.ts` fails with `buildNetworkEnv is not a function`; the `systemCheck` case fails because the report has three tools, not four; `markGhRequired is not a function`.

- [ ] **Step 3: Write the `gh` wrapper**

`apps/daemon/src/github/gh.ts`:

```ts
import { execFile } from 'node:child_process';
import { z } from 'zod';

/** One `gh` call: where it runs, in which environment, for how long, and how to stop it. */
export interface GhCall {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export const GhFailure = {
  NotInstalled: 'not_installed',
  SignedOut: 'signed_out',
  Timeout: 'timeout',
  Aborted: 'aborted',
  Failed: 'failed',
} as const;
export type GhFailure = (typeof GhFailure)[keyof typeof GhFailure];

/** A `gh` call that did not give an answer; `kind` picks the card text. */
export class GhError extends Error {
  override readonly name = 'GhError';
  readonly kind: GhFailure;
  constructor(kind: GhFailure, message: string) {
    super(message);
    this.kind = kind;
  }
}

export const PrState = { Open: 'OPEN', Closed: 'CLOSED', Merged: 'MERGED' } as const;
export type PrState = (typeof PrState)[keyof typeof PrState];

export interface PullRequest {
  readonly url: string;
  readonly state: PrState;
}

/** The host integration (batch delivery spec §7): everything 10db asks GitHub, through the gh CLI. */
export interface Gh {
  authStatus(call: GhCall): Promise<void>;
  repoView(call: GhCall): Promise<string>;
  prView(
    input: { readonly repo: string; readonly ref: string },
    call: GhCall,
  ): Promise<PullRequest | null>;
  prCreate(
    input: {
      readonly repo: string;
      readonly base: string;
      readonly head: string;
      readonly title: string;
      readonly bodyFile: string;
    },
    call: GhCall,
  ): Promise<string>;
}

export interface GhOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs gh. Throws GhError for not installed, timeout and abort; returns any exit code otherwise. */
export type GhExec = (args: readonly string[], call: GhCall) => Promise<GhOutput>;

/** gh's documented exit code for "authentication required". */
const AUTH_REQUIRED_EXIT = 4;
const NO_PR = /no pull requests found/i;
const SIGNED_OUT = /gh auth login|not logged in/i;
const MAX_OUTPUT = 4 * 1024 * 1024;
/** Prompts are off whatever the environment says: nobody can answer one. */
const NO_PROMPTS = {
  GH_PROMPT_DISABLED: '1',
  GH_NO_UPDATE_NOTIFIER: '1',
  GIT_TERMINAL_PROMPT: '0',
} as const;

export const systemGhExec: GhExec = (args, call) =>
  new Promise((resolve, reject) => {
    execFile(
      'gh',
      [...args],
      {
        cwd: call.cwd,
        env: { ...call.env, ...NO_PROMPTS },
        timeout: call.timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: MAX_OUTPUT,
        encoding: 'utf8',
        ...(call.signal ? { signal: call.signal } : {}),
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ exitCode: 0, stdout, stderr });
          return;
        }
        if (call.signal?.aborted) {
          reject(new GhError(GhFailure.Aborted, 'gh was stopped'));
          return;
        }
        if (error.code === 'ENOENT') {
          reject(
            new GhError(
              GhFailure.NotInstalled,
              'gh is not installed or not on your login PATH. Install the GitHub CLI (brew install gh) and sign in with gh auth login.',
            ),
          );
          return;
        }
        if (error.killed) {
          reject(
            new GhError(
              GhFailure.Timeout,
              `gh ${args.slice(0, 2).join(' ')} gave no answer within ${String(Math.round(call.timeoutMs / 1000))} s`,
            ),
          );
          return;
        }
        resolve({ exitCode: typeof error.code === 'number' ? error.code : 1, stdout, stderr });
      },
    );
  });

const RepoView = z.object({ nameWithOwner: z.string().regex(/^[^/\s]+\/[^/\s]+$/) });
const PrView = z.object({ url: z.url(), state: z.enum(PrState) });

function failure(args: readonly string[], out: GhOutput): GhError {
  if (out.exitCode === AUTH_REQUIRED_EXIT || SIGNED_OUT.test(out.stderr))
    return new GhError(
      GhFailure.SignedOut,
      'gh is not signed in. Run gh auth login in a terminal.',
    );
  return new GhError(
    GhFailure.Failed,
    `gh ${args.slice(0, 2).join(' ')} failed (exit ${String(out.exitCode)}): ${out.stderr.trim().slice(0, 500)}`,
  );
}

/** gh's JSON output is a boundary: parse it, and turn a surprise into a GhError. */
function parseOutput<S extends z.ZodType>(
  schema: S,
  args: readonly string[],
  text: string,
): z.output<S> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new GhError(
      GhFailure.Failed,
      `gh ${args.slice(0, 2).join(' ')} printed output that is not JSON`,
    );
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    throw new GhError(
      GhFailure.Failed,
      `gh ${args.slice(0, 2).join(' ')} printed output 10db can't read`,
    );
  return parsed.data;
}

export function createGh(exec: GhExec = systemGhExec): Gh {
  async function ok(args: readonly string[], call: GhCall): Promise<string> {
    const out = await exec(args, call);
    if (out.exitCode !== 0) throw failure(args, out);
    return out.stdout;
  }
  return {
    async authStatus(call) {
      const out = await exec(['auth', 'status', '--active'], call);
      if (out.exitCode !== 0)
        throw new GhError(
          GhFailure.SignedOut,
          'gh is not signed in. Run gh auth login in a terminal.',
        );
    },
    async repoView(call) {
      const args = ['repo', 'view', '--json', 'nameWithOwner'];
      return parseOutput(RepoView, args, await ok(args, call)).nameWithOwner;
    },
    async prView({ repo, ref }, call) {
      const args = ['pr', 'view', ref, '-R', repo, '--json', 'url,state'];
      const out = await exec(args, call);
      if (out.exitCode !== 0 && NO_PR.test(out.stderr)) return null;
      if (out.exitCode !== 0) throw failure(args, out);
      return parseOutput(PrView, args, out.stdout);
    },
    async prCreate({ repo, base, head, title, bodyFile }, call) {
      const args = [
        'pr',
        'create',
        '-R',
        repo,
        '--base',
        base,
        '--head',
        head,
        '--title',
        title,
        '--body-file',
        bodyFile,
      ];
      const url = (await ok(args, call))
        .split('\n')
        .map((line) => line.trim())
        .reverse()
        .find((line) => line.startsWith('https://'));
      if (url === undefined)
        throw new GhError(GhFailure.Failed, 'gh pr create printed no pull request URL');
      return url;
    },
  };
}
```

`apps/daemon/src/github/index.ts`:

```ts
export {
  createGh,
  GhError,
  GhFailure,
  PrState,
  systemGhExec,
  type Gh,
  type GhCall,
  type GhExec,
  type PullRequest,
} from './gh';
```

- [ ] **Step 4: Write the fake**

`apps/daemon/test/fake-gh.ts`:

```ts
import { readFileSync } from 'node:fs';
import { GhError, PrState, type Gh, type PullRequest } from '../src/github';

export type GhMethod = 'authStatus' | 'repoView' | 'prView' | 'prCreate';
export interface PrCreateCall {
  readonly repo: string;
  readonly base: string;
  readonly head: string;
  readonly title: string;
}

/** gh at the Gh interface: an in-memory GitHub with one repository. */
export class FakeGh implements Gh {
  auth: 'ok' | 'signed_out' | 'not_installed' = 'ok';
  repo = 'acme/widgets';
  /** One error per method, thrown by its next call only. */
  readonly failNext = new Map<GhMethod, GhError>();
  readonly calls: { readonly method: GhMethod; readonly args: unknown }[] = [];
  private readonly byRef = new Map<
    string,
    { pr: { url: string; state: PrState }; body: string; create: PrCreateCall | null }
  >();
  private next = 1;

  private call<T>(method: GhMethod, args: unknown, answer: () => T): Promise<T> {
    this.calls.push({ method, args });
    const queued = this.failNext.get(method);
    if (queued) {
      this.failNext.delete(method);
      return Promise.reject(queued);
    }
    if (this.auth === 'not_installed')
      return Promise.reject(new GhError('not_installed', 'gh is not installed'));
    if (this.auth === 'signed_out')
      return Promise.reject(new GhError('signed_out', 'gh is not signed in'));
    return Promise.resolve(answer());
  }

  // Each method omits the GhCall it ignores; a shorter parameter list still implements Gh.
  authStatus(): Promise<void> {
    return this.call('authStatus', {}, () => undefined);
  }

  repoView(): Promise<string> {
    return this.call('repoView', {}, () => this.repo);
  }

  prView(input: { readonly repo: string; readonly ref: string }): Promise<PullRequest | null> {
    return this.call('prView', input, () => {
      const found = this.byRef.get(input.ref);
      return found ? { ...found.pr } : null;
    });
  }

  prCreate(input: {
    readonly repo: string;
    readonly base: string;
    readonly head: string;
    readonly title: string;
    readonly bodyFile: string;
  }): Promise<string> {
    return this.call('prCreate', input, () => {
      const create = { repo: input.repo, base: input.base, head: input.head, title: input.title };
      return this.add(input.head, PrState.Open, readFileSync(input.bodyFile, 'utf8'), create);
    });
  }

  /** A PR that exists already, as if opened by an earlier run or by hand. */
  openPr(branch: string, state: PrState = PrState.Open): string {
    return this.add(branch, state, '', null);
  }

  setState(url: string, state: PrState): void {
    const found = this.byRef.get(url);
    if (!found) throw new Error(`no PR ${url}`);
    found.pr.state = state;
  }

  prCreates(): PrCreateCall[] {
    return [...new Set(this.byRef.values())].flatMap((e) => (e.create ? [e.create] : []));
  }

  body(url: string): string {
    return this.byRef.get(url)?.body ?? '';
  }

  private add(branch: string, state: PrState, body: string, create: PrCreateCall | null): string {
    const url = `https://github.com/${this.repo}/pull/${String(this.next++)}`;
    const entry = { pr: { url, state }, body, create };
    this.byRef.set(branch, entry);
    this.byRef.set(url, entry);
    return url;
  }
}
```

- [ ] **Step 5: Build the network environment and list `gh` in the system check**

`apps/daemon/src/environment/network-env.ts`:

```ts
import { NESTED_SESSION_VARS } from './session-env';

const OWN_PREFIX = 'TENDB_';
const NESTED: readonly string[] = NESTED_SESSION_VARS;

/**
 * The environment fetch, push and gh run in: the builder's login environment, which holds their
 * git credentials, SSH agent and gh token, minus 10db's own and nested-session variables. The git
 * and github modules turn prompts off on top of it. It holds secrets: memory only, never logged.
 */
export function buildNetworkEnv(base: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(base).filter(([name]) => !name.startsWith(OWN_PREFIX) && !NESTED.includes(name)),
  );
}
```

In `apps/daemon/src/environment/system-check.ts`, add `gh` to `REQUIRED_TOOLS` and add `markGhRequired`:

```ts
export const REQUIRED_TOOLS = [
  { name: ToolName.Claude, required: true },
  { name: ToolName.Git, required: true },
  { name: ToolName.Docker, required: false },
  // Required only while a project delivers pull requests (markGhRequired).
  { name: ToolName.Gh, required: false },
] as const;

/** gh is needed once any project ships pull requests (batch delivery spec §6). */
export function markGhRequired(check: SystemCheckDto, needed: boolean): SystemCheckDto {
  return {
    ...check,
    tools: check.tools.map((t) => (t.name === ToolName.Gh ? { ...t, required: needed } : t)),
  };
}
```

In `apps/daemon/src/environment/index.ts`, add `export { buildNetworkEnv } from './network-env';` and add `markGhRequired` to the `./system-check` export.

In `apps/daemon/AGENTS.md`, change the module order line to:

```
`clock`, `log`, `events`, `guard`, `permissions`, `git`, `github`, `verify`, `routing` → `sessions`, `inbox`, `briefing`, `team` →
`delivery` → `mcp` → `runner` → `watcher`, `scheduler`, `recovery`, `backups`, `benchmarks` → `daemon` (composition root) → `main.ts`.
```

and add a bullet:

```
- `github/` is the only module that runs `gh`, and `git/` the only one that runs `git`; both use `execFile` with argument arrays. Network calls (fetch, push, every `gh` call) take a `NetworkCall` built from `environment/buildNetworkEnv`, a timeout and an abort signal, with prompts off. Delivery tests fake `gh` with `test/fake-gh.ts`; real git runs against a local bare `origin` (`createTempRepoWithOrigin`).
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @10db/daemon exec vitest run src/github src/environment && pnpm typecheck`
Expected: PASS. The `systemGhExec` timeout case finishes in well under a second.

- [ ] **Step 7: Commit**

```bash
pnpm format && git add apps/daemon/src/github apps/daemon/test/fake-gh.ts apps/daemon/src/environment/network-env.ts apps/daemon/src/environment/network-env.test.ts apps/daemon/src/environment/system-check.ts apps/daemon/src/environment/system-check.test.ts apps/daemon/src/environment/index.ts apps/daemon/AGENTS.md && git commit -m 'feat(daemon): wrap the gh cli and build the network environment' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>' -m 'Claude-Session: https://claude.ai/code/session_01KFqjacxo6Va8EyHF93n3xr'
```

---

### Task 5: Delivery: starting a batch, cutting its branch, joining it and checking dependencies

**Files:**

- Create: `apps/daemon/src/delivery/jobs.ts`, `context.ts`, `branch-name.ts`, `cards.ts`, `deps.ts`, `start.ts`, `index.ts`
- Modify: `apps/daemon/src/team/steps.ts`, `apps/daemon/src/team/index.ts` (`planForStart`, `insertPlannedWorkstream`)
- Create: `apps/daemon/test/delivery-harness.ts`
- Test: `apps/daemon/src/delivery/jobs.test.ts`, `apps/daemon/src/delivery/start.test.ts`

**Interfaces:**

- Consumes:
  - Task 2: `insertBatch`, `getBatch`, `findUnfinishedBatch`, `listBatches`, `transitionBatch`, `patchBatch`, `deleteCuttingBatch`, `listWorkstreams({ batchId })`, `latestDoneWorkstream`, `countLanes`.
  - Task 3: `Git.status`, `remoteUrl`, `fetch`, `switchNewBranch`, `head`, `currentBranch`; `NetworkCall`, `GitNetworkError`.
  - Task 4: `Gh`, `GhCall`, `GhError`, `PrState`; `FakeGh`.
  - `InboxService.flag`, `StateStore`, `Logger`; `resolveStepPlan` (`team/steps.ts`).
- Produces:
  - `team/`: `planForStart(db: DbReader, taskId: TaskId): StepPlanDto` (throws the over-budget `InvalidError` `startTaskWithPlan` throws today) and `insertPlannedWorkstream(ctx: WriteContext, taskId: TaskId, plan: StepPlanDto, batchId: BatchId | null): WorkstreamDto`. `startTaskWithPlan` is now those two.
  - `delivery/jobs.ts`: `interface DeliveryJobs { run(key: string, job: (signal: AbortSignal) => Promise<void>): void; idle(): Promise<void>; stop(): Promise<void> }`, `createDeliveryJobs(logger: Logger): DeliveryJobs`.
  - `delivery/context.ts`: `interface DeliveryLimits { readonly networkTimeoutMs: number; readonly gateTimeoutMs: number }`, `DEFAULT_DELIVERY_LIMITS`, `interface DeliveryContext { state; git; gh; inbox; jobs; logger; limits; networkEnv(): Readonly<Record<string, string>>; onWorkQueued(): void }`, `networkCall(ctx, signal): NetworkCall`, `ghCall(ctx, repoPath, signal): GhCall`, `raise(inbox: InboxService, projectId: ProjectId, card: Card): void`.
  - `delivery/branch-name.ts`: `BRANCH_PREFIX = '10db/'`, `MAX_SLUG = 40`, `batchBranchName(title: string, id: BatchId): string`.
  - `delivery/cards.ts`: `interface Card { title; body; foldKey?; detail? }`, `MAX_LISTED_PATHS = 20`, `listPaths(paths)`, `detailOf(error)`, `startCards`, `wrongBranchCard(batch: BatchDto, current: string | null, repoPath: string, outcome: 'waits' | 'failed'): Card`.
  - `delivery/deps.ts`: `unfinishedDependencies(db, tasks, inBatch): BlockedTask[]`, `unmergedDependencies(input): Promise<UnmergedDependency[]>`.
  - `delivery/start.ts`: `interface BatchStarter { startBatch(projectId: ProjectId, input: BatchStartInput): BatchDto; startTask(taskId: TaskId): BatchDto }`, `createBatchStarter(ctx: DeliveryContext): BatchStarter`.
  - Test harness `createDeliveryHarness(project?: Partial<ProjectInput>): DeliveryHarness` with `store`, `bus`, `state`, `inbox`, `git`, `gh` (`FakeGh`), `jobs`, `ctx`, `starter`, `project`, `repo`, `origin`, `ticks`, `addTask`, `settle`, `commit`, `git$`, `origin$`, `teammatePush`, `cards`, `only`, `close`.

- [ ] **Step 1: Split `startTaskWithPlan`**

The cut inserts its workstreams in the transaction that opens the batch, so planning and inserting come apart. In `apps/daemon/src/team/steps.ts` (import `BatchId`, `DbReader` and `WriteContext` types):

```ts
/** The plan a start would run; refuses one that no profile within the budget ceiling can run. */
export function planForStart(db: DbReader, taskId: TaskId): StepPlanDto {
  const plan = resolveStepPlan(db, taskId);
  if (plan.overBudget.length > 0) {
    // ...the over-budget message startTaskWithPlan builds today, moved here unchanged
  }
  if (plan.steps.length === 0) throw new InvalidError('The flow resolved to no steps');
  return plan;
}

/** Inserts the task's workstream on its plan; `batchId` is the batch it runs in, null in local delivery. */
export function insertPlannedWorkstream(
  ctx: WriteContext,
  taskId: TaskId,
  plan: StepPlanDto,
  batchId: BatchId | null,
): WorkstreamDto {
  const [first] = plan.steps;
  if (!first) throw new InvalidError('The flow resolved to no steps');
  const ws = insertWorkstream(ctx, taskId, { batchId });
  patchWorkstream(ctx, ws.id, null, {
    steps: plan.steps.map((s, i) =>
      i === 0 ? { ...s, status: 'running', startedAt: ctx.now } : s,
    ),
    stepIndex: 0,
    model: first.model,
    effort: first.effort,
  });
  return getWorkstream(ctx.tx, ws.id);
}

/** Starts a task in local delivery: its plan, then its workstream. */
export function startTaskWithPlan(state: StateStore, taskId: TaskId): WorkstreamDto {
  const plan = planForStart(state.db, taskId);
  return state.write((ctx) => insertPlannedWorkstream(ctx, taskId, plan, null));
}
```

Export `planForStart` and `insertPlannedWorkstream` from `apps/daemon/src/team/index.ts`.

Run: `pnpm --filter @10db/daemon exec vitest run src/team`
Expected: PASS, unchanged (the refactor keeps `startTaskWithPlan`'s behavior and messages).

- [ ] **Step 2: Write the harness**

`apps/daemon/test/delivery-harness.ts`:

```ts
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  InboxKind,
  WORKSTREAM_TRANSITIONS,
  type InboxItemDto,
  type ProjectDto,
  type ProjectInput,
  type TaskDto,
  type TaskId,
  type WorkstreamId,
  type WorkstreamState,
} from '@10db/contracts';
import {
  createTestStore,
  findFlowByName,
  getWorkstreamRow,
  insertTask,
  listInbox,
  seedProject,
  setTaskStatus,
  transitionWorkstream,
  type Store,
} from '@10db/db';
import { readDefaultPersonas } from '@10db/harness';
import {
  createBatchStarter,
  createDeliveryJobs,
  DEFAULT_DELIVERY_LIMITS,
  type BatchStarter,
  type DeliveryContext,
  type DeliveryJobs,
} from '../src/delivery';
import { createEventBus, createStateStore, type EventBus, type StateStore } from '../src/events';
import { createGit, type Git } from '../src/git';
import { createInboxService, type InboxService } from '../src/inbox';
import { silentLogger } from '../src/log';
import { seedTeam } from '../src/team';
import { measureForTests } from './catalogue';
import { FakeGh } from './fake-gh';
import { createTempRepoWithOrigin, NETWORK_ENV, tempDir } from './fixtures';

type Settled = 'DONE' | 'FAILED' | 'CANCELLED' | 'WAITING_HUMAN' | 'RUNNING';

/** The shortest run of allowed transitions from `from` to `to`, as the runner would take it. */
function pathBetween(from: WorkstreamState, to: WorkstreamState): WorkstreamState[] {
  const previous = new Map<WorkstreamState, WorkstreamState>();
  const queue: WorkstreamState[] = [from];
  for (let state = queue.shift(); state !== undefined; state = queue.shift()) {
    if (state === to) break;
    for (const next of WORKSTREAM_TRANSITIONS[state]) {
      if (next === from || previous.has(next)) continue;
      previous.set(next, state);
      queue.push(next);
    }
  }
  const path: WorkstreamState[] = [];
  for (let s: WorkstreamState | undefined = to; s !== undefined && s !== from; s = previous.get(s))
    path.unshift(s);
  if (path[0] === undefined || !WORKSTREAM_TRANSITIONS[from].includes(path[0]))
    throw new Error(`no path from ${from} to ${to}`);
  return path;
}

export interface DeliveryHarness {
  readonly store: Store;
  readonly bus: EventBus;
  readonly state: StateStore;
  readonly inbox: InboxService;
  readonly git: Git;
  readonly gh: FakeGh;
  readonly jobs: DeliveryJobs;
  readonly ctx: DeliveryContext;
  readonly starter: BatchStarter;
  readonly project: ProjectDto;
  readonly repo: string;
  readonly origin: string;
  /** How many times delivery asked the scheduler to look for work. */
  readonly ticks: { count: number };
  addTask(
    title: string,
    opts?: { readonly areas?: string[]; readonly dependsOn?: TaskId[] },
  ): TaskDto;
  /** Moves a workstream on from where it is, as the runner would; DONE also marks its task done. */
  settle(id: WorkstreamId, to: Settled): void;
  /** Commits a file on the checked-out branch, as the commit tool does for an agent. */
  commit(path: string): string;
  git$(...args: string[]): string;
  origin$(...args: string[]): string;
  /** Another clone commits `path` to `branch` on origin, as a teammate would; returns the new SHA. */
  teammatePush(branch: string, path: string): string;
  /** Open flag cards, oldest first. */
  cards(): InboxItemDto[];
  /** The single element of `items`; throws on none or several. */
  only<T>(items: readonly T[]): T;
  close(): void;
}

export function createDeliveryHarness(project: Partial<ProjectInput> = {}): DeliveryHarness {
  const remote = createTempRepoWithOrigin();
  const { store, close } = createTestStore();
  const bus = createEventBus();
  const state = createStateStore(store, bus);
  seedTeam(state, readDefaultPersonas());
  measureForTests(state);
  const inbox = createInboxService({ state, onParkedAnswer: () => undefined });
  const git = createGit();
  const gh = new FakeGh();
  const jobs = createDeliveryJobs(silentLogger);
  const ticks = { count: 0 };
  const quick = findFlowByName(store.db, 'quick');
  if (!quick) throw new Error('the quick flow was not seeded');
  const seeded = seedProject(store, {
    repoPath: remote.repo.path,
    gateCommand: 'true',
    delivery: 'pull_request',
    prTitlePrefix: 'feat(app)',
    flowId: quick.id,
    areas: [
      { name: 'api', globs: ['src/api/**'] },
      { name: 'ui', globs: ['src/ui/**'] },
    ],
    ...project,
  });
  const ctx: DeliveryContext = {
    state,
    git,
    gh,
    inbox,
    jobs,
    logger: silentLogger,
    limits: { ...DEFAULT_DELIVERY_LIMITS, networkTimeoutMs: 10_000, gateTimeoutMs: 20_000 },
    networkEnv: () => NETWORK_ENV,
    onWorkQueued: () => {
      ticks.count += 1;
    },
  };
  const run = (dir: string, args: string[]): string =>
    execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' })
      .toString()
      .trim();
  return {
    store,
    bus,
    state,
    inbox,
    git,
    gh,
    jobs,
    ctx,
    starter: createBatchStarter(ctx),
    project: seeded,
    repo: remote.repo.path,
    origin: remote.origin.path,
    ticks,
    addTask(title, opts = {}) {
      return state.write((c) =>
        insertTask(c, seeded.id, {
          title,
          acceptanceCriteria: ['it works'],
          areas: opts.areas ?? ['api'],
          dependsOn: opts.dependsOn ?? [],
        }),
      );
    },
    settle(id, to) {
      state.write((c) => {
        for (const step of pathBetween(getWorkstreamRow(c.tx, id).state, to))
          transitionWorkstream(c, id, { to: step, fence: null });
        if (to === 'DONE') setTaskStatus(c, getWorkstreamRow(c.tx, id).taskId, 'done');
      });
    },
    commit(path) {
      const file = join(remote.repo.path, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${path}\n`);
      run(remote.repo.path, ['add', path]);
      run(remote.repo.path, ['commit', '-q', '-m', `Add ${path}`]);
      return run(remote.repo.path, ['rev-parse', 'HEAD']);
    },
    git$: (...args) => run(remote.repo.path, args),
    origin$: (...args) => run(remote.origin.path, args),
    teammatePush(branch, path) {
      const other = tempDir('teammate');
      try {
        execFileSync('git', ['clone', '-q', remote.origin.path, other.path], { stdio: 'pipe' });
        run(other.path, ['config', 'user.name', 'teammate']);
        run(other.path, ['config', 'user.email', 'teammate@10db.invalid']);
        run(other.path, ['config', 'commit.gpgsign', 'false']);
        if (branch !== 'main') run(other.path, ['switch', '-q', '-c', branch]);
        const file = join(other.path, path);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, `${path}\n`);
        run(other.path, ['add', path]);
        run(other.path, ['commit', '-q', '-m', `Add ${path}`]);
        run(other.path, ['push', '-q', 'origin', branch]);
        return run(other.path, ['rev-parse', 'HEAD']);
      } finally {
        other.cleanup();
      }
    },
    cards: () => listInbox(store.db, { states: ['OPEN'] }).filter((i) => i.kind === InboxKind.Flag),
    only(items) {
      const [item] = items;
      if (item === undefined || items.length !== 1)
        throw new Error(`expected exactly one, got ${String(items.length)}`);
      return item;
    },
    close() {
      close();
      remote.cleanup();
    },
  };
}
```

- [ ] **Step 3: Write the failing tests**

`apps/daemon/src/delivery/jobs.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { silentLogger } from '../log';
import { createDeliveryJobs } from './index';

const tick = () => new Promise<void>((r) => setImmediate(r));

describe('delivery jobs', () => {
  it("runs one key's jobs in order and other keys alongside", async () => {
    const jobs = createDeliveryJobs(silentLogger);
    const order: string[] = [];
    let release = (): void => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    jobs.run('a', async () => {
      await gate;
      order.push('a1');
    });
    jobs.run('a', () => {
      order.push('a2');
      return Promise.resolve();
    });
    jobs.run('b', () => {
      order.push('b1');
      return Promise.resolve();
    });
    await tick();
    expect(order).toEqual(['b1']);
    release();
    await jobs.idle();
    expect(order).toEqual(['b1', 'a1', 'a2']);
  });

  it('logs a failing job and runs the next one', async () => {
    const errors: unknown[] = [];
    const jobs = createDeliveryJobs({ ...silentLogger, error: (obj) => errors.push(obj) });
    const ran: string[] = [];
    jobs.run('a', () => Promise.reject(new Error('boom')));
    jobs.run('a', () => {
      ran.push('next');
      return Promise.resolve();
    });
    await jobs.idle();
    expect(ran).toEqual(['next']);
    expect(errors).toHaveLength(1);
  });

  it('aborts the running job on stop, waits for it, and takes no new jobs', async () => {
    const jobs = createDeliveryJobs(silentLogger);
    let sawAbort = false;
    jobs.run(
      'a',
      (signal) =>
        new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => {
            sawAbort = true;
            resolve();
          });
        }),
    );
    await jobs.stop();
    expect(sawAbort).toBe(true);
    let ranAfterStop = false;
    jobs.run('a', () => {
      ranAfterStop = true;
      return Promise.resolve();
    });
    await jobs.idle();
    expect(ranAfterStop).toBe(false);
  });
});
```

`apps/daemon/src/delivery/start.test.ts`:

```ts
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BranchName, ConflictError, InvalidError, mintId, type TaskDto } from '@10db/contracts';
import {
  getBatch,
  insertWorkstream,
  listBatches,
  listWorkstreams,
  patchProject,
  seedProject,
  transitionBatch,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { GhError } from '../github';
import { batchBranchName } from './index';

let h: DeliveryHarness;
beforeEach(() => {
  h = createDeliveryHarness();
});
afterEach(() => {
  h.close();
});

/** Starts the tasks as one batch and waits for the background cut. */
async function started(title: string, ...tasks: TaskDto[]) {
  const batch = h.starter.startBatch(h.project.id, { title, taskIds: tasks.map((t) => t.id) });
  await h.jobs.idle();
  return getBatch(h.store.db, batch.id);
}

describe('batchBranchName', () => {
  it.each([
    { title: 'Add greetings', slug: 'add-greetings' },
    { title: 'Ünïcode & spaces!', slug: 'unicode-spaces' },
    { title: '  --Leading dashes', slug: 'leading-dashes' },
    { title: '$(rm -rf /)', slug: 'rm-rf' },
    { title: '***', slug: 'batch' },
    { title: `${'a'.repeat(30)} ${'b'.repeat(30)}`, slug: `${'a'.repeat(30)}-${'b'.repeat(9)}` },
    { title: `${'x'.repeat(39)} yz`, slug: 'x'.repeat(39) },
  ])('names "$title" 10db/$slug-<id>', ({ title, slug }) => {
    const id = mintId('Batch');
    const name = batchBranchName(title, id);
    expect(name).toBe(`10db/${slug}-${id.slice(-8)}`);
    expect(BranchName.safeParse(name).success).toBe(true);
  });
});

describe('cutting a branch', () => {
  it('cuts the branch from the fetched base, opens the batch and queues its workstreams', async () => {
    const alpha = h.addTask('Alpha');
    const beta = h.addTask('Beta', { areas: ['ui'] });
    // A teammate's commit lands on origin/main after this clone last fetched, so only a fetch sees it.
    const upstream = h.teammatePush('main', 'src/api/upstream.txt');

    const request = h.starter.startBatch(h.project.id, {
      title: 'Greetings',
      taskIds: [alpha.id, beta.id],
    });
    expect(request.state).toBe('CUTTING');
    await h.jobs.idle();

    const batch = getBatch(h.store.db, request.id);
    expect(batch).toMatchObject({
      state: 'OPEN',
      branch: batchBranchName('Greetings', batch.id),
      baseBranch: 'main',
      baseSha: upstream,
      repo: 'acme/widgets',
    });
    expect(h.git$('branch', '--show-current')).toBe(batch.branch);
    expect(h.git$('rev-parse', 'HEAD')).toBe(upstream);
    expect(
      listWorkstreams(h.store.db, { batchId: batch.id }).map((w) => [w.taskId, w.state]),
    ).toEqual([
      [alpha.id, 'QUEUED'],
      [beta.id, 'QUEUED'],
    ]);
    expect(h.ticks.count).toBe(1);
    expect(h.cards()).toEqual([]);
  });

  it.each<{ name: string; arrange: (h: DeliveryHarness) => void; title: string }>([
    {
      name: 'a lane runs in the project',
      arrange: (x) => {
        const other = x.addTask('Running', { areas: ['ui'] });
        const ws = x.state.write((c) => insertWorkstream(c, other.id));
        x.settle(ws.id, 'RUNNING');
      },
      title: 'work is still running',
    },
    {
      name: 'the checkout is dirty',
      arrange: (x) => {
        writeFileSync(join(x.repo, 'scratch.txt'), 'uncommitted\n');
      },
      title: 'the checkout has uncommitted changes',
    },
    {
      name: 'there is no origin',
      arrange: (x) => {
        x.git$('remote', 'remove', 'origin');
      },
      title: 'has no remote named origin',
    },
    {
      name: 'the base branch is not on origin',
      arrange: (x) => {
        x.state.write((c) => patchProject(c, x.project.id, { baseBranch: 'develop' }));
      },
      title: 'git fetch origin develop failed',
    },
    {
      name: 'gh is not installed',
      arrange: (x) => {
        x.gh.auth = 'not_installed';
      },
      title: 'gh is not installed',
    },
    {
      name: 'gh is signed out',
      arrange: (x) => {
        x.gh.auth = 'signed_out';
      },
      title: 'gh is signed out',
    },
    {
      name: 'gh cannot name the repository',
      arrange: (x) => {
        x.gh.failNext.set('repoView', new GhError('failed', 'no git remotes point to GitHub'));
      },
      title: "gh can't find the GitHub repository",
    },
  ])('refuses when $name: a card, no batch row, HEAD unmoved', async ({ arrange, title }) => {
    const task = h.addTask('Alpha');
    arrange(h);
    const head = h.git$('rev-parse', 'HEAD');
    const branch = h.git$('branch', '--show-current');
    h.starter.startBatch(h.project.id, { title: 'Greetings', taskIds: [task.id] });
    await h.jobs.idle();
    expect(listBatches(h.store.db)).toEqual([]);
    expect(h.cards().map((c) => c.title)).toEqual([expect.stringContaining(title)]);
    expect(h.git$('rev-parse', 'HEAD')).toBe(head);
    expect(h.git$('branch', '--show-current')).toBe(branch);
    expect(listWorkstreams(h.store.db, {}).filter((w) => w.taskId === task.id)).toEqual([]);
  });

  it('gives two simultaneous starts one batch and one branch', async () => {
    const alpha = h.addTask('Alpha');
    const beta = h.addTask('Beta', { areas: ['ui'] });
    const results = await Promise.allSettled(
      [alpha, beta].map(async (t) => {
        await Promise.resolve();
        return h.starter.startTask(t.id);
      }),
    );
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const refused = results.find((r) => r.status === 'rejected');
    expect(refused?.status === 'rejected' ? refused.reason : null).toBeInstanceOf(ConflictError);
    await h.jobs.idle();
    expect(listBatches(h.store.db)).toHaveLength(1);
    expect(h.git$('branch', '--list', '10db/*').split('\n').filter(Boolean)).toHaveLength(1);
  });
});

describe('joining a batch', () => {
  it('adds a task started while the batch is open', async () => {
    const batch = await started('Greetings', h.addTask('Alpha'));
    const beta = h.addTask('Beta', { areas: ['ui'] });
    expect(h.starter.startTask(beta.id).id).toBe(batch.id);
    await h.jobs.idle();
    expect(listWorkstreams(h.store.db, { batchId: batch.id }).map((w) => w.taskId)).toContain(
      beta.id,
    );
    expect(h.ticks.count).toBe(2);
  });

  it('adds nothing and raises a card when the checkout left the batch branch', async () => {
    const batch = await started('Greetings', h.addTask('Alpha'));
    h.git$('switch', '-q', 'main');
    const beta = h.addTask('Beta', { areas: ['ui'] });
    h.starter.startTask(beta.id);
    await h.jobs.idle();
    expect(listWorkstreams(h.store.db, { batchId: batch.id }).map((w) => w.taskId)).not.toContain(
      beta.id,
    );
    expect(h.only(h.cards()).title).toContain(
      `checkout is on main, the batch branch is ${batch.branch ?? ''}`,
    );
    expect(getBatch(h.store.db, batch.id).state).toBe('OPEN');
  });

  it('reopens a failed batch with a fix task', async () => {
    const batch = await started('Greetings', h.addTask('Alpha'));
    h.state.write((c) =>
      transitionBatch(c, batch.id, { to: 'FAILED', patch: { failure: 'gate_failed' } }),
    );
    const fix = h.addTask('Fix the gate', { areas: ['ui'] });
    expect(h.starter.startTask(fix.id).id).toBe(batch.id);
    await h.jobs.idle();
    expect(getBatch(h.store.db, batch.id)).toMatchObject({ state: 'OPEN', failure: null });
    expect(listWorkstreams(h.store.db, { batchId: batch.id }).map((w) => w.taskId)).toContain(
      fix.id,
    );
  });

  it.each(['CUTTING', 'SHIPPING'] as const)(
    'refuses a start while the batch is %s',
    async (state) => {
      const alpha = h.addTask('Alpha');
      if (state === 'CUTTING') {
        h.starter.startTask(alpha.id);
      } else {
        const batch = await started('Greetings', alpha);
        h.state.write((c) => transitionBatch(c, batch.id, { to: 'SHIPPING' }));
      }
      const beta = h.addTask('Beta', { areas: ['ui'] });
      expect(() => h.starter.startTask(beta.id)).toThrow(ConflictError);
      expect(() => h.starter.startTask(beta.id)).toThrow(state.toLowerCase());
      await h.jobs.idle();
    },
  );
});

describe('dependencies', () => {
  it('refuses a task whose dependency is unfinished outside the set, with a card, and starts both together', async () => {
    const alpha = h.addTask('Alpha');
    const beta = h.addTask('Beta', { areas: ['ui'], dependsOn: [alpha.id] });
    expect(() => h.starter.startTask(beta.id)).toThrow(ConflictError);
    expect(h.only(h.cards()).body).toContain('Beta needs Alpha');
    expect(listBatches(h.store.db)).toEqual([]);
    const batch = await started('Both', alpha, beta);
    expect(batch.state).toBe('OPEN');
  });

  it("refuses a task whose dependency finished in a batch whose pull request isn't merged, until it is", async () => {
    const alpha = h.addTask('Alpha');
    const first = await started('First', alpha);
    h.settle(h.only(listWorkstreams(h.store.db, { batchId: first.id })).id, 'DONE');
    const url = h.gh.openPr(first.branch ?? '');
    h.state.write((c) => {
      transitionBatch(c, first.id, { to: 'SHIPPING' });
      transitionBatch(c, first.id, { to: 'SHIPPED', patch: { prUrl: url } });
    });
    const beta = h.addTask('Beta', { areas: ['ui'], dependsOn: [alpha.id] });

    h.starter.startTask(beta.id);
    await h.jobs.idle();
    expect(listBatches(h.store.db).map((b) => b.id)).toEqual([first.id]);
    expect(h.only(h.cards()).body).toContain(`its pull request ${url} is open, not merged`);

    h.gh.setState(url, 'MERGED');
    const second = h.starter.startTask(beta.id);
    await h.jobs.idle();
    expect(getBatch(h.store.db, second.id).state).toBe('OPEN');
  });

  it('refuses a task whose dependency finished in an abandoned batch', async () => {
    const alpha = h.addTask('Alpha');
    const first = await started('First', alpha);
    h.settle(h.only(listWorkstreams(h.store.db, { batchId: first.id })).id, 'DONE');
    h.state.write((c) => transitionBatch(c, first.id, { to: 'ABANDONED' }));
    const beta = h.addTask('Beta', { areas: ['ui'], dependsOn: [alpha.id] });
    h.starter.startTask(beta.id);
    await h.jobs.idle();
    expect(h.only(h.cards()).body).toContain('was abandoned');
  });
});

describe('refusals in the request', () => {
  it('refuses a local project', () => {
    const local = seedProject(h.store, { repoPath: `${h.repo}-local` });
    expect(() =>
      h.starter.startBatch(local.id, { title: 'x', taskIds: [h.addTask('Alpha').id] }),
    ).toThrow(InvalidError);
  });

  it('refuses a task that is already running, and one from another project', async () => {
    const alpha = h.addTask('Alpha');
    await started('Greetings', alpha);
    expect(() => h.starter.startTask(alpha.id)).toThrow(/already running/);
    const elsewhere = seedProject(h.store, {
      repoPath: `${h.repo}-other`,
      delivery: 'pull_request',
      prTitlePrefix: 'fix',
    });
    expect(() =>
      h.starter.startBatch(elsewhere.id, { title: 'x', taskIds: [h.addTask('Beta').id] }),
    ).toThrow(/belongs to another project/);
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `pnpm --filter @10db/daemon exec vitest run src/delivery`
Expected: FAIL. Both files fail to load: `../../test/delivery-harness` imports `../src/delivery`, which doesn't exist (`Failed to load url ../src/delivery`).

- [ ] **Step 5: Write the jobs and the context**

`apps/daemon/src/delivery/jobs.ts`:

```ts
import type { Logger } from '../log';

/** Background delivery work. Jobs with the same key (a project) run one at a time, in order. */
export interface DeliveryJobs {
  run(key: string, job: (signal: AbortSignal) => Promise<void>): void;
  /** Settles once no job is queued or running. */
  idle(): Promise<void>;
  /** Aborts the running jobs' signal, waits for every job to settle and takes no new ones. */
  stop(): Promise<void>;
}

export function createDeliveryJobs(logger: Logger): DeliveryJobs {
  const controller = new AbortController();
  const tails = new Map<string, Promise<void>>();
  const pending = new Set<Promise<void>>();

  async function idle(): Promise<void> {
    while (pending.size > 0) await Promise.all([...pending]);
  }

  return {
    run(key, job) {
      if (controller.signal.aborted) return;
      const previous = tails.get(key) ?? Promise.resolve();
      const next = previous
        .then(() => (controller.signal.aborted ? undefined : job(controller.signal)))
        .catch((error: unknown) => {
          logger.error(
            { err: error instanceof Error ? error.message : String(error), key },
            'delivery job failed',
          );
        });
      tails.set(key, next);
      pending.add(next);
      void next.then(() => {
        pending.delete(next);
        if (tails.get(key) === next) tails.delete(key);
      });
    },
    idle,
    async stop() {
      controller.abort();
      await idle();
    },
  };
}
```

`apps/daemon/src/delivery/context.ts`:

```ts
import type { ProjectId } from '@10db/contracts';
import type { StateStore } from '../events';
import type { Git, NetworkCall } from '../git';
import type { Gh, GhCall } from '../github';
import type { InboxService } from '../inbox';
import type { Logger } from '../log';
import type { Card } from './cards';
import type { DeliveryJobs } from './jobs';

export interface DeliveryLimits {
  /** Each fetch, push and gh call. */
  readonly networkTimeoutMs: number;
  /** The shipping gate; the daemon passes the runner's gate timeout. */
  readonly gateTimeoutMs: number;
}

export const DEFAULT_DELIVERY_LIMITS: DeliveryLimits = {
  networkTimeoutMs: 2 * 60_000,
  gateTimeoutMs: 30 * 60_000,
};

/** What every delivery step needs. */
export interface DeliveryContext {
  readonly state: StateStore;
  readonly git: Git;
  readonly gh: Gh;
  readonly inbox: InboxService;
  readonly jobs: DeliveryJobs;
  readonly logger: Logger;
  readonly limits: DeliveryLimits;
  /** The login environment network calls run in (environment/buildNetworkEnv). */
  networkEnv(): Readonly<Record<string, string>>;
  /** Asks the scheduler to look for work: a batch opened, grew or reopened. */
  onWorkQueued(): void;
}

export function networkCall(ctx: DeliveryContext, signal: AbortSignal): NetworkCall {
  return { env: ctx.networkEnv(), timeoutMs: ctx.limits.networkTimeoutMs, signal };
}

export function ghCall(ctx: DeliveryContext, repoPath: string, signal: AbortSignal): GhCall {
  return { cwd: repoPath, ...networkCall(ctx, signal) };
}

/** Delivery cards belong to the project, not to one workstream. */
export function raise(inbox: InboxService, projectId: ProjectId, card: Card): void {
  inbox.flag({
    projectId,
    workstreamId: null,
    title: card.title,
    body: card.body,
    ...(card.foldKey ? { foldKey: card.foldKey } : {}),
    ...(card.detail ? { detail: card.detail } : {}),
  });
}
```

- [ ] **Step 6: Write the branch name, the cards and the dependency checks**

`apps/daemon/src/delivery/branch-name.ts`:

```ts
import type { BatchId } from '@10db/contracts';

export const BRANCH_PREFIX = '10db/';
export const MAX_SLUG = 40;
const ID_SUFFIX = 8;

/**
 * `10db/<slug>-<last 8 hex of the batch id>` (batch delivery spec §5). The slug keeps ASCII letters
 * and digits only, so a title can't put an option, a ref expression or shell text into the name.
 */
export function batchBranchName(title: string, id: BatchId): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG)
    .replace(/-+$/, '');
  return `${BRANCH_PREFIX}${slug === '' ? 'batch' : slug}-${id.slice(-ID_SUFFIX)}`;
}
```

`apps/daemon/src/delivery/cards.ts`:

```ts
import type { BatchDto, ProjectDto } from '@10db/contracts';
import type { Json } from '@10db/db';
import { GitNetworkError } from '../git';
import { GhError } from '../github';
import type { BlockedTask, UnmergedDependency } from './deps';

/** A flag card's text. Every delivery card says what to fix (batch delivery spec §1). */
export interface Card {
  readonly title: string;
  readonly body: string;
  /** An open card with the same key is reused instead of raising another. */
  readonly foldKey?: string;
  readonly detail?: Record<string, Json>;
}

export const MAX_LISTED_PATHS = 20;

export function listPaths(paths: readonly string[]): string {
  const shown = paths.slice(0, MAX_LISTED_PATHS).map((p) => `- ${p}`);
  const extra = paths.length - MAX_LISTED_PATHS;
  return [...shown, ...(extra > 0 ? [`- and ${String(extra)} more`] : [])].join('\n');
}

/** The part of an error a builder can act on. */
export function detailOf(error: unknown): string {
  if (error instanceof GitNetworkError) return error.detail || error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

const NOT_STARTED = 'Batch not started';

function ghCard(prefix: string, error: unknown, then: string): Card | null {
  if (!(error instanceof GhError)) return null;
  switch (error.kind) {
    case 'not_installed':
      return {
        title: `${prefix}: gh is not installed`,
        body: `Install the GitHub CLI (brew install gh) and sign in with gh auth login, then ${then}.`,
      };
    case 'signed_out':
      return {
        title: `${prefix}: gh is signed out`,
        body: `Run gh auth login in a terminal, then ${then}.`,
      };
    case 'timeout':
    case 'aborted':
    case 'failed':
      return null;
  }
}

export const startCards = {
  lanesRunning: (project: ProjectDto, lanes: number): Card => ({
    title: `${NOT_STARTED}: work is still running in ${project.name}`,
    body: `10db switches branches only when no lane runs in the project, and ${String(lanes)} lane(s) run now. Let them finish, or cancel them in the Factory view, then start again.`,
  }),
  dirtyCheckout: (project: ProjectDto, paths: readonly string[]): Card => ({
    title: `${NOT_STARTED}: the checkout has uncommitted changes`,
    body: `10db cuts a batch branch only from a clean checkout. Commit, stash or discard these paths in ${project.repoPath}, then start again:\n${listPaths(paths)}`,
  }),
  noOrigin: (project: ProjectDto): Card => ({
    title: `${NOT_STARTED}: ${project.repoPath} has no remote named origin`,
    body: 'Pull request delivery pushes to origin. Add it with git remote add origin <GitHub URL>, then start again.',
  }),
  fetchFailed: (base: string, error: unknown): Card => ({
    title: `${NOT_STARTED}: git fetch origin ${base} failed`,
    body: `${detailOf(error)}\n\nCheck that ${base} exists on origin and that git reaches origin from your login shell (its credential helper or SSH agent), then start again.`,
  }),
  ghUnavailable: (error: unknown): Card =>
    ghCard(NOT_STARTED, error, 'start again') ?? {
      title: `${NOT_STARTED}: gh auth status failed`,
      body: `${detailOf(error)}\n\nRun gh auth status in a terminal to see why, then start again.`,
    },
  repoUnknown: (project: ProjectDto, error: unknown): Card =>
    ghCard(NOT_STARTED, error, 'start again') ?? {
      title: `${NOT_STARTED}: gh can't find the GitHub repository for ${project.repoPath}`,
      body: `${detailOf(error)}\n\nPull request delivery needs origin to point at github.com and gh to be signed in to an account that can open pull requests there.`,
    },
  unfinishedDependencies: (blocked: readonly BlockedTask[]): Card => ({
    title: 'Not started: tasks depend on unfinished work',
    body: `${blocked.map((b) => `- ${b.task.title} needs ${b.deps.map((d) => d.title).join(', ')}`).join('\n')}\n\nStart them together, or finish those tasks first.`,
  }),
  unmergedDependencies: (found: readonly UnmergedDependency[]): Card => ({
    title: 'Not started: tasks depend on code that is not on the base branch',
    body: `${found.map((f) => `- ${f.task.title} needs ${f.dep.title}: ${f.reason}`).join('\n')}\n\nMerge that work into the base branch, then start again.`,
  }),
  notStarted: (error: unknown): Card => ({
    title: `${NOT_STARTED}: ${detailOf(error)}`,
    body: 'Nothing was pushed. Fix the cause, then start again.',
  }),
  notJoined: (batch: BatchDto, error: unknown): Card => ({
    title: `Not added to batch "${batch.title}": ${detailOf(error)}`,
    body: 'Start the task again once the batch is open, or after it ships.',
    detail: { batchId: batch.id },
  }),
};

/** The spec's wrong-branch card: "checkout is on X, the batch branch is Y". */
export function wrongBranchCard(
  batch: BatchDto,
  current: string | null,
  repoPath: string,
  outcome: 'waits' | 'failed',
): Card {
  const on = current ?? 'a detached HEAD';
  const branch = batch.branch ?? '(not cut)';
  return {
    title: `Batch "${batch.title}" ${outcome === 'waits' ? 'waits' : 'failed'}: checkout is on ${on}, the batch branch is ${branch}`,
    body:
      outcome === 'waits'
        ? `Nothing in the batch starts until the checkout is back on its branch. Run git switch ${branch} in ${repoPath}, or abandon the batch on the Tasks view.`
        : `10db restarted with the checkout off the batch branch, so nothing in the batch runs. Run git switch ${branch} in ${repoPath}, then press Retry on the Tasks view's batch strip; or abandon the batch there.`,
    foldKey: `batch-branch:${batch.id}:${on}:${outcome}`,
    detail: { batchId: batch.id },
  };
}
```

`apps/daemon/src/delivery/deps.ts`:

```ts
import {
  BatchState,
  TaskStatus,
  type BatchDto,
  type BatchId,
  type TaskDto,
  type TaskId,
} from '@10db/contracts';
import { getBatch, getTask, latestDoneWorkstream, type DbReader } from '@10db/db';
import { PrState, type Gh, type GhCall } from '../github';

export interface BlockedTask {
  readonly task: TaskDto;
  readonly deps: readonly TaskDto[];
}

/** Dependencies that are not done and not in the batch (batch delivery spec §5). */
export function unfinishedDependencies(
  db: DbReader,
  tasks: readonly TaskDto[],
  inBatch: ReadonlySet<TaskId>,
): BlockedTask[] {
  return tasks
    .map((task) => ({
      task,
      deps: task.dependsOn
        .filter((id) => !inBatch.has(id))
        .map((id) => getTask(db, id))
        .filter((dep) => dep.status !== TaskStatus.Done),
    }))
    .filter((b) => b.deps.length > 0);
}

export interface UnmergedDependency {
  readonly task: TaskDto;
  readonly dep: TaskDto;
  readonly reason: string;
}

/**
 * Done dependencies outside the batch whose code is not on origin/<base>: they finished in a batch
 * that was abandoned or whose pull request is not merged. A dependency done in a batch that closed
 * (no commits), or done in local delivery, counts as on the base.
 */
export async function unmergedDependencies(input: {
  readonly db: DbReader;
  readonly gh: Gh;
  readonly call: GhCall;
  readonly tasks: readonly TaskDto[];
  readonly inBatch: ReadonlySet<TaskId>;
  readonly batchId: BatchId;
}): Promise<UnmergedDependency[]> {
  const found: UnmergedDependency[] = [];
  for (const task of input.tasks) {
    for (const depId of task.dependsOn) {
      if (input.inBatch.has(depId)) continue;
      const done = latestDoneWorkstream(input.db, depId);
      if (!done?.batchId || done.batchId === input.batchId) continue;
      const reason = await notOnBase(getBatch(input.db, done.batchId), input.gh, input.call);
      if (reason !== null) found.push({ task, dep: getTask(input.db, depId), reason });
    }
  }
  return found;
}

async function notOnBase(batch: BatchDto, gh: Gh, call: GhCall): Promise<string | null> {
  switch (batch.state) {
    case BatchState.Closed:
      return null;
    case BatchState.Abandoned:
      return `its batch "${batch.title}" was abandoned, so its code is only on the local branch ${batch.branch ?? '(none)'}`;
    case BatchState.Shipped: {
      if (batch.prUrl === null || batch.repo === null)
        return `its batch "${batch.title}" has no pull request`;
      const pr = await gh.prView({ repo: batch.repo, ref: batch.prUrl }, call);
      if (pr === null) return `its pull request ${batch.prUrl} was not found`;
      return pr.state === PrState.Merged
        ? null
        : `its pull request ${pr.url} is ${pr.state.toLowerCase()}, not merged`;
    }
    case BatchState.Cutting:
    case BatchState.Open:
    case BatchState.Shipping:
    case BatchState.Failed:
      return `its batch "${batch.title}" has not shipped`;
  }
}
```

- [ ] **Step 7: Write the starter**

`apps/daemon/src/delivery/start.ts`:

```ts
import {
  ACTIVE_STATES,
  BatchStartInput,
  BatchState,
  ConflictError,
  Delivery,
  InvalidError,
  TaskStatus,
  type BatchDto,
  type BatchId,
  type ProjectDto,
  type ProjectId,
  type StepPlanDto,
  type TaskDto,
  type TaskId,
} from '@10db/contracts';
import {
  countLanes,
  deleteCuttingBatch,
  findUnfinishedBatch,
  getBatch,
  getProject,
  getTask,
  getWorkstreamRow,
  insertBatch,
  listWorkstreams,
  patchBatch,
  transitionBatch,
} from '@10db/db';
import { insertPlannedWorkstream, planForStart } from '../team';
import { batchBranchName } from './branch-name';
import { startCards, wrongBranchCard, type Card } from './cards';
import { ghCall, networkCall, raise, type DeliveryContext } from './context';
import { unfinishedDependencies, unmergedDependencies } from './deps';

export interface BatchStarter {
  /**
   * Starts the tasks as a new batch, or adds them to the project's OPEN batch (or, as fix tasks,
   * its FAILED one). Answers at once; git and gh checks finish in the background, and their
   * refusals are cards (batch delivery spec §5).
   */
  startBatch(projectId: ProjectId, input: BatchStartInput): BatchDto;
  /** One task in a pull-request project: a batch of one titled after it, or a member of the open batch. */
  startTask(taskId: TaskId): BatchDto;
}

/** What a start hands its background job: the plans resolved in the request, by task. */
type Plans = ReadonlyMap<TaskId, StepPlanDto>;

export function createBatchStarter(ctx: DeliveryContext): BatchStarter {
  const db = ctx.state.db;

  function startBatch(projectId: ProjectId, raw: BatchStartInput): BatchDto {
    const input = BatchStartInput.parse(raw);
    const project = getProject(db, projectId);
    if (project.delivery !== Delivery.PullRequest)
      throw new InvalidError(`${project.name} delivers locally; start its tasks one at a time`);
    const tasks = input.taskIds.map((id) => getTask(db, id));
    for (const task of tasks) checkStartable(project, task);
    const existing = findUnfinishedBatch(db, projectId) ?? null;
    if (existing?.state === BatchState.Cutting || existing?.state === BatchState.Shipping)
      throw new ConflictError(
        `Batch "${existing.title}" is ${existing.state.toLowerCase()}; start again once it is open or has shipped`,
      );
    const plans: Plans = new Map(tasks.map((t) => [t.id, planForStart(db, t.id)]));
    const inBatch = new Set<TaskId>([
      ...input.taskIds,
      ...(existing ? listWorkstreams(db, { batchId: existing.id }).map((w) => w.taskId) : []),
    ]);
    const blocked = unfinishedDependencies(db, tasks, inBatch);
    if (blocked.length > 0) {
      const card = startCards.unfinishedDependencies(blocked);
      raise(ctx.inbox, projectId, card);
      throw new ConflictError(`${card.title}. ${card.body}`);
    }
    if (existing) {
      ctx.jobs.run(projectId, (signal) => join(existing.id, tasks, plans, inBatch, signal));
      return existing;
    }
    const batch = ctx.state.write((w) =>
      insertBatch(w, { projectId, title: input.title, baseBranch: project.baseBranch }),
    );
    ctx.jobs.run(projectId, (signal) => cut(batch.id, tasks, plans, inBatch, signal));
    return batch;
  }

  function checkStartable(project: ProjectDto, task: TaskDto): void {
    if (task.projectId !== project.id)
      throw new InvalidError(`Task ${task.title} belongs to another project`);
    if (task.status !== TaskStatus.Open)
      throw new ConflictError(`Task ${task.title} is ${task.status}`);
    const latest = task.workstreamId ? getWorkstreamRow(db, task.workstreamId) : null;
    if (latest && ACTIVE_STATES.includes(latest.state))
      throw new ConflictError(`Task ${task.title} is already running`);
  }

  /** Cutting a branch (batch delivery spec §5): checks in order, then switch, then open. */
  async function cut(
    batchId: BatchId,
    tasks: readonly TaskDto[],
    plans: Plans,
    inBatch: ReadonlySet<TaskId>,
    signal: AbortSignal,
  ): Promise<void> {
    const batch = getBatch(db, batchId);
    const project = getProject(db, batch.projectId);
    const refuse = (card: Card): void => {
      ctx.state.write((w) => {
        deleteCuttingBatch(w, batchId, card.title);
      });
      raise(ctx.inbox, project.id, card);
    };
    // A shutdown mid-cut leaves the CUTTING row; startup deletes it.
    const stopped = (): boolean => signal.aborted;
    try {
      const lanes = countLanes(db).byProject.get(project.id) ?? 0;
      if (lanes > 0) {
        refuse(startCards.lanesRunning(project, lanes));
        return;
      }
      const dirty = await ctx.git.status(project.repoPath);
      if (dirty.length > 0) {
        refuse(
          startCards.dirtyCheckout(
            project,
            dirty.map((d) => d.path),
          ),
        );
        return;
      }
      if ((await ctx.git.remoteUrl(project.repoPath, 'origin')) === null) {
        refuse(startCards.noOrigin(project));
        return;
      }
      try {
        await ctx.git.fetch(project.repoPath, batch.baseBranch, networkCall(ctx, signal));
      } catch (error) {
        if (!stopped()) refuse(startCards.fetchFailed(batch.baseBranch, error));
        return;
      }
      const call = ghCall(ctx, project.repoPath, signal);
      try {
        await ctx.gh.authStatus(call);
      } catch (error) {
        if (!stopped()) refuse(startCards.ghUnavailable(error));
        return;
      }
      let repo: string;
      try {
        repo = await ctx.gh.repoView(call);
      } catch (error) {
        if (!stopped()) refuse(startCards.repoUnknown(project, error));
        return;
      }
      const unmerged = await unmergedDependencies({
        db,
        gh: ctx.gh,
        call,
        tasks,
        inBatch,
        batchId,
      });
      if (unmerged.length > 0) {
        refuse(startCards.unmergedDependencies(unmerged));
        return;
      }
      if (stopped()) return;
      const branch = batchBranchName(batch.title, batch.id);
      await ctx.git.switchNewBranch(project.repoPath, branch, `origin/${batch.baseBranch}`);
      const baseSha = await ctx.git.head(project.repoPath);
      ctx.state.write((w) => {
        patchBatch(w, batchId, { branch, baseSha, repo });
        transitionBatch(w, batchId, { to: BatchState.Open, reason: 'branch cut' });
        for (const [taskId, plan] of plans) insertPlannedWorkstream(w, taskId, plan, batchId);
      });
      ctx.onWorkQueued();
    } catch (error) {
      if (!stopped()) refuse(startCards.notStarted(error));
    }
  }

  /** Joining or reopening (batch delivery spec §5): only the branch is checked; the rest holds by construction. */
  async function join(
    batchId: BatchId,
    tasks: readonly TaskDto[],
    plans: Plans,
    inBatch: ReadonlySet<TaskId>,
    signal: AbortSignal,
  ): Promise<void> {
    const batch = getBatch(db, batchId);
    const project = getProject(db, batch.projectId);
    try {
      const current = await ctx.git.currentBranch(project.repoPath);
      if (current !== batch.branch) {
        raise(ctx.inbox, project.id, wrongBranchCard(batch, current, project.repoPath, 'waits'));
        return;
      }
      const call = ghCall(ctx, project.repoPath, signal);
      const unmerged = await unmergedDependencies({
        db,
        gh: ctx.gh,
        call,
        tasks,
        inBatch,
        batchId,
      });
      if (unmerged.length > 0) {
        raise(ctx.inbox, project.id, startCards.unmergedDependencies(unmerged));
        return;
      }
      if (signal.aborted) return;
      ctx.state.write((w) => {
        const now = getBatch(w.tx, batchId);
        if (now.state === BatchState.Failed)
          transitionBatch(w, batchId, {
            to: BatchState.Open,
            patch: { failure: null },
            reason: 'a fix task joined',
          });
        else if (now.state !== BatchState.Open)
          throw new ConflictError(`Batch "${now.title}" is ${now.state.toLowerCase()} now`);
        for (const [taskId, plan] of plans) insertPlannedWorkstream(w, taskId, plan, batchId);
      });
      ctx.onWorkQueued();
    } catch (error) {
      if (!signal.aborted) raise(ctx.inbox, project.id, startCards.notJoined(batch, error));
    }
  }

  return {
    startBatch,
    startTask(taskId) {
      const task = getTask(db, taskId);
      return startBatch(task.projectId, { title: task.title, taskIds: [taskId] });
    },
  };
}
```

`apps/daemon/src/delivery/index.ts`:

```ts
export { batchBranchName } from './branch-name';
export { DEFAULT_DELIVERY_LIMITS, type DeliveryContext, type DeliveryLimits } from './context';
export { createDeliveryJobs, type DeliveryJobs } from './jobs';
export { createBatchStarter, type BatchStarter } from './start';
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm --filter @10db/daemon exec vitest run src/delivery src/team && pnpm typecheck && pnpm lint`
Expected: PASS: every jobs, branch-name, cutting, joining, dependency and request-refusal case. Typecheck and lint are clean (the `switch` statements in `cards.ts` and `deps.ts` are exhaustive).

- [ ] **Step 9: Commit**

```bash
pnpm format && git add apps/daemon/src/delivery apps/daemon/src/team/steps.ts apps/daemon/src/team/index.ts apps/daemon/test/delivery-harness.ts && git commit -m 'feat(daemon): start batches by cutting a branch, joining the open batch and checking dependencies' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>' -m 'Claude-Session: https://claude.ai/code/session_01KFqjacxo6Va8EyHF93n3xr'
```

---

### Task 6: Delivery: shipping, the ship trigger, Ship anyway and Abandon

**Files:**

- Create: `apps/daemon/src/delivery/pr-text.ts`, `apps/daemon/src/delivery/ship.ts`, `apps/daemon/src/delivery/trigger.ts`
- Modify: `apps/daemon/src/delivery/cards.ts` (shipping cards), `apps/daemon/src/delivery/index.ts`
- Modify: `apps/daemon/test/delivery-harness.ts` (a shipper on a real gate runner)
- Test: `apps/daemon/src/delivery/pr-text.test.ts`, `apps/daemon/src/delivery/ship.test.ts`

**Interfaces:**

- Consumes:
  - Task 5: `DeliveryContext`, `networkCall`, `ghCall`, `raise`, `Card`, `listPaths`, `detailOf`, `wrongBranchCard`, `DeliveryJobs`, the harness.
  - Task 1: `shipReadiness`, `isSettled`, `latestPerTask`, `BatchFailure`.
  - Task 2: `getBatch`, `getBatchRow`, `listBatches`, `transitionBatch`, `patchBatch`, `listWorkstreams({ batchId })`.
  - `GateRunner` and `GateResult` (`verify/`), `Clock`, `transitionWorkstream`, `releaseClaims`, `clearLease`, `InboxService.cancelForWorkstream`.
- Produces:
  - `delivery/pr-text.ts`: `prTitle(prefix: string | null, title: string): string`, `prBody(input: { batch: { id: BatchId; title: string }; rows: readonly { title: string; state: WorkstreamState }[]; gate: { command: string; exitCode: number } }): string`.
  - `delivery/ship.ts`:
    - `interface ShipperDeps extends DeliveryContext { readonly gate: GateRunner; readonly clock: Clock; readonly dataDir: string; sessionEnv(project: ProjectDto): Readonly<Record<string, string>>; identifyProcess?(pid: number): Promise<string | null>; isRunning(id: WorkstreamId): boolean }`
    - `interface Shipper`:
      - `checkBatch(batchId: BatchId): void`: an `OPEN` batch whose members are all `DONE` or `CANCELLED` moves to `SHIPPING` and ships
      - `checkOpenBatches(): void`: `checkBatch` for every `OPEN` batch (startup)
      - `resume(batchId: BatchId): void`: runs the shipping steps for a `SHIPPING` batch in a background job
      - `ship(batchId: BatchId): BatchDto`: `POST /batches/:id/ship`
      - `abandon(batchId: BatchId): BatchDto`: `POST /batches/:id/abandon`
    - `createShipper(deps: ShipperDeps): Shipper`
  - `delivery/trigger.ts`: `subscribeShipTrigger(bus: EventBus, db: DbReader, shipper: Shipper): () => void`.
  - Harness gains `shipper: Shipper`, `dataDir: string` and the option `gateTimeoutMs`.

- [ ] **Step 1: Give the harness a shipper**

In `apps/daemon/test/delivery-harness.ts`:

- Import `createShipper`, `subscribeShipTrigger` and `type Shipper` from `../src/delivery`, `createGateRunner` from `../src/verify`, `ManualClock` from `../src/clock` and `systemProcesses` from `../src/recovery`.
- Change the signature to `createDeliveryHarness(project: Partial<ProjectInput> = {}, opts: { readonly gateTimeoutMs?: number; readonly trigger?: boolean } = {})`.
- After `ctx`, build the shipper and, unless `opts.trigger === false`, subscribe the trigger:

```ts
const data = tempDir('delivery-data');
const ctx: DeliveryContext = {
  // ...as before, with gateTimeoutMs from the option:
  limits: {
    ...DEFAULT_DELIVERY_LIMITS,
    networkTimeoutMs: 10_000,
    gateTimeoutMs: opts.gateTimeoutMs ?? 20_000,
  },
};
const running = new Set<WorkstreamId>();
const shipper = createShipper({
  ...ctx,
  gate: createGateRunner(),
  clock: new ManualClock(),
  dataDir: data.path,
  sessionEnv: () => ({ PATH: '/usr/bin:/bin' }),
  identifyProcess: (pid) => systemProcesses.identify(pid),
  isRunning: (id) => running.has(id),
});
const unsubscribe =
  opts.trigger === false ? () => undefined : subscribeShipTrigger(bus, store.db, shipper);
```

- Add to `DeliveryHarness` and the returned object: `shipper`, `dataDir: data.path`, and `running` (the set `isRunning` reads, so a test can mark a workstream's runner as live). `close()` calls `unsubscribe()` and `data.cleanup()` too.

- [ ] **Step 2: Write the failing tests**

`apps/daemon/src/delivery/pr-text.test.ts`:

````ts
import { mintId } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { prBody, prTitle } from './index';

describe('prTitle', () => {
  it.each([
    { prefix: 'feat(app)', title: 'Add greetings', expected: 'feat(app): add greetings' },
    {
      prefix: 'fix',
      title: 'Fix "quotes" and $(stuff)',
      expected: 'fix: fix "quotes" and $(stuff)',
    },
    { prefix: 'feat(app)', title: 'already lowercase', expected: 'feat(app): already lowercase' },
    { prefix: null, title: 'No prefix', expected: 'no prefix' },
  ])('$prefix + "$title"', ({ prefix, title, expected }) => {
    expect(prTitle(prefix, title)).toBe(expected);
  });
});

describe('prBody', () => {
  it('lists every task with its final state, the gate, the unfinished tasks and the footer', () => {
    const id = mintId('Batch');
    const body = prBody({
      batch: { id, title: 'Greetings' },
      rows: [
        { title: 'Alpha', state: 'DONE' },
        { title: 'Beta', state: 'FAILED' },
        { title: 'Gamma', state: 'CANCELLED' },
      ],
      gate: { command: 'make gate', exitCode: 0 },
    });
    expect(body).toBe(
      [
        '## Greetings',
        '',
        '### Tasks',
        '',
        '- Alpha: done',
        '- Beta: failed',
        '- Gamma: cancelled',
        '',
        '### Gate',
        '',
        '```',
        'make gate',
        '```',
        '',
        'Exited 0 on the branch as pushed.',
        '',
        '### Not done',
        '',
        '- Beta (failed)',
        '- Gamma (cancelled)',
        '',
        '---',
        '',
        `Shipped by 10db, batch ${id}`,
        '',
      ].join('\n'),
    );
  });
});
````

`apps/daemon/src/delivery/ship.test.ts`:

```ts
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConflictError, type BatchDto, type TaskDto } from '@10db/contracts';
import {
  activeClaims,
  acquireClaims,
  claimRequestsForTask,
  getBatch,
  getBatchRow,
  getTask,
  getWorkstream,
  listWorkstreams,
  transitionBatch,
} from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { GhError } from '../github';

let h: DeliveryHarness;
afterEach(() => {
  h.close();
});

/** Opens a batch of `titles`, one task per area, and returns it with its workstreams. */
async function openBatch(title: string, ...titles: string[]) {
  const areas = ['api', 'ui'];
  const tasks: TaskDto[] = titles.map((t, i) => h.addTask(t, { areas: [areas[i % 2] ?? 'api'] }));
  const started = h.starter.startBatch(h.project.id, { title, taskIds: tasks.map((t) => t.id) });
  await h.jobs.idle();
  const batch = getBatch(h.store.db, started.id);
  return { batch, workstreams: listWorkstreams(h.store.db, { batchId: batch.id }) };
}

/** The SHA of `branch` on origin, or null when origin doesn't have it. */
function onOrigin(branch: string | null): string | null {
  try {
    return h.origin$('rev-parse', '--verify', '-q', `refs/heads/${branch ?? ''}`);
  } catch {
    return null;
  }
}

/** Every workstream DONE, as the runner would leave them; the trigger then ships the batch. */
async function finishAll(batch: BatchDto) {
  for (const ws of listWorkstreams(h.store.db, { batchId: batch.id })) h.settle(ws.id, 'DONE');
  await h.jobs.idle();
  return getBatch(h.store.db, batch.id);
}

describe('shipping', () => {
  it('closes a batch with no commits beyond its base, pushing nothing', async () => {
    h = createDeliveryHarness();
    const { batch } = await openBatch('Nothing', 'Alpha');
    const shipped = await finishAll(batch);
    expect(shipped.state).toBe('CLOSED');
    expect(onOrigin(batch.branch)).toBeNull();
    expect(h.gh.prCreates()).toEqual([]);
  });

  it('pushes the branch, opens one PR titled with the prefix and records its URL', async () => {
    h = createDeliveryHarness();
    const { batch } = await openBatch('Add greetings', 'Alpha', 'Beta');
    h.commit('src/api/alpha.txt');
    h.commit('src/ui/beta.txt');
    const shipped = await finishAll(batch);
    expect(shipped).toMatchObject({
      state: 'SHIPPED',
      prUrl: 'https://github.com/acme/widgets/pull/1',
      gateExitCode: 0,
      failure: null,
    });
    expect(onOrigin(batch.branch)).toBe(h.git$('rev-parse', 'HEAD'));
    expect(h.git$('rev-parse', '--abbrev-ref', '@{u}')).toBe(`origin/${batch.branch ?? ''}`);
    expect(h.gh.prCreates()).toEqual([
      { repo: 'acme/widgets', base: 'main', head: batch.branch, title: 'feat(app): add greetings' },
    ]);
    const body = h.gh.body(shipped.prUrl ?? '');
    expect(body).toContain('- Alpha: done');
    expect(body).toContain('- Beta: done');
    expect(body).toContain(`Shipped by 10db, batch ${batch.id}`);
    expect(getBatchRow(h.store.db, batch.id)).toMatchObject({ gatePid: null, gatePidStart: null });
  });

  it('passes a title with quotes and $() through as one argument', async () => {
    h = createDeliveryHarness();
    const { batch } = await openBatch(`Say "hi" and $(whoami)`, 'Alpha');
    h.commit('src/api/alpha.txt');
    await finishAll(batch);
    expect(h.gh.prCreates().map((c) => c.title)).toEqual([`feat(app): say "hi" and $(whoami)`]);
  });

  it('records an existing PR for the branch instead of opening a second one', async () => {
    h = createDeliveryHarness();
    const { batch } = await openBatch('Greetings', 'Alpha');
    h.commit('src/api/alpha.txt');
    const url = h.gh.openPr(batch.branch ?? '', 'CLOSED');
    const shipped = await finishAll(batch);
    expect(shipped).toMatchObject({ state: 'SHIPPED', prUrl: url });
    expect(h.gh.prCreates()).toEqual([]);
  });

  it.each<{
    name: string;
    gate?: string;
    gateTimeoutMs?: number;
    arrange?: (x: DeliveryHarness, batch: BatchDto) => void;
    failure: string;
    title: string;
  }>([
    {
      name: 'a dirty checkout',
      arrange: (x) => {
        writeFileSync(join(x.repo, 'scratch.txt'), 'uncommitted\n');
      },
      failure: 'dirty_checkout',
      title: 'the checkout has uncommitted changes',
    },
    {
      name: 'the checkout on another branch',
      arrange: (x) => {
        x.git$('switch', '-q', 'main');
      },
      failure: 'wrong_branch',
      title: 'checkout is on main, the batch branch is',
    },
    {
      name: 'a failing gate',
      gate: 'echo broken >&2; exit 3',
      failure: 'gate_failed',
      title: 'the gate failed (exit 3)',
    },
    {
      name: 'a gate that times out',
      gate: 'sleep 5',
      gateTimeoutMs: 300,
      failure: 'gate_timed_out',
      title: 'the gate timed out after',
    },
    {
      name: 'a rejected push',
      arrange: (x, batch) => {
        x.teammatePush(batch.branch ?? '', 'src/api/theirs.txt');
      },
      failure: 'push_rejected',
      title: 'git push was rejected',
    },
    {
      name: 'gh signed out',
      arrange: (x) => {
        x.gh.failNext.set('prView', new GhError('signed_out', 'gh is not signed in'));
      },
      failure: 'gh_unavailable',
      title: 'gh is signed out',
    },
    {
      name: 'gh failing',
      arrange: (x) => {
        x.gh.failNext.set('prCreate', new GhError('failed', 'HTTP 502'));
      },
      failure: 'network',
      title: 'gh pr create failed',
    },
  ])('fails on $name with a card, and opens no PR', async (row) => {
    h = createDeliveryHarness(
      row.gate ? { gateCommand: row.gate } : {},
      row.gateTimeoutMs ? { gateTimeoutMs: row.gateTimeoutMs } : {},
    );
    const { batch } = await openBatch('Greetings', 'Alpha');
    h.commit('src/api/alpha.txt');
    const before = onOrigin(batch.branch);
    row.arrange?.(h, batch);
    const ended = await finishAll(batch);
    expect(ended).toMatchObject({ state: 'FAILED', failure: row.failure });
    expect(h.only(h.cards()).title).toContain(row.title);
    expect(h.gh.prCreates()).toEqual([]);
    if (
      row.failure !== 'push_rejected' &&
      row.failure !== 'gh_unavailable' &&
      row.failure !== 'network'
    )
      expect(onOrigin(batch.branch)).toBe(before);
  });

  it('holds the batch open while a workstream failed or waits, and ships when the last one is done', async () => {
    h = createDeliveryHarness();
    const { batch, workstreams } = await openBatch('Greetings', 'Alpha', 'Beta');
    const [alpha, beta] = workstreams;
    if (!alpha || !beta) throw new Error('two workstreams expected');
    h.commit('src/api/alpha.txt');
    h.settle(alpha.id, 'DONE');
    h.settle(beta.id, 'WAITING_HUMAN');
    await h.jobs.idle();
    expect(getBatch(h.store.db, batch.id).state).toBe('OPEN');
    h.settle(beta.id, 'FAILED');
    await h.jobs.idle();
    expect(getBatch(h.store.db, batch.id).state).toBe('OPEN');
  });
});

describe('Ship anyway, Retry and Abandon', () => {
  it('ships anyway only when every workstream is done, cancelled or failed, listing the failed one', async () => {
    h = createDeliveryHarness();
    const { batch, workstreams } = await openBatch('Greetings', 'Alpha', 'Beta');
    const [alpha, beta] = workstreams;
    if (!alpha || !beta) throw new Error('two workstreams expected');
    h.commit('src/api/alpha.txt');
    h.settle(alpha.id, 'DONE');
    h.settle(beta.id, 'WAITING_HUMAN');
    expect(() => h.shipper.ship(batch.id)).toThrow(ConflictError);
    expect(() => h.shipper.ship(batch.id)).toThrow(/Beta \(waiting_human\)/);
    h.settle(beta.id, 'FAILED');
    expect(h.shipper.ship(batch.id).state).toBe('SHIPPING');
    await h.jobs.idle();
    const shipped = getBatch(h.store.db, batch.id);
    expect(shipped.state).toBe('SHIPPED');
    expect(h.gh.body(shipped.prUrl ?? '')).toContain('- Beta (failed)');
  });

  it('retries a failed batch: ships it when its work is settled, reopens it when work is unfinished', async () => {
    h = createDeliveryHarness();
    const { batch, workstreams } = await openBatch('Greetings', 'Alpha');
    const ws = h.only(workstreams);
    h.commit('src/api/alpha.txt');
    // Failed at startup for the wrong branch while its work was still queued.
    h.state.write((c) =>
      transitionBatch(c, batch.id, { to: 'FAILED', patch: { failure: 'wrong_branch' } }),
    );
    expect(h.shipper.ship(batch.id)).toMatchObject({ state: 'OPEN', failure: null });
    expect(getWorkstream(h.store.db, ws.id).state).toBe('QUEUED');
    // Now its gate failed after the work finished: Retry ships.
    h.state.write((c) =>
      transitionBatch(c, batch.id, { to: 'FAILED', patch: { failure: 'gate_failed' } }),
    );
    h.settle(ws.id, 'DONE');
    expect(h.shipper.ship(batch.id).state).toBe('SHIPPING');
    await h.jobs.idle();
    expect(getBatch(h.store.db, batch.id).state).toBe('SHIPPED');
  });

  it('refuses to abandon while a lane runs, then cancels the waiting work, releases its claims and keeps the branch', async () => {
    h = createDeliveryHarness();
    const { batch, workstreams } = await openBatch('Greetings', 'Alpha', 'Beta');
    const [alpha, beta] = workstreams;
    if (!alpha || !beta) throw new Error('two workstreams expected');
    h.commit('src/api/alpha.txt');
    h.settle(alpha.id, 'DONE');
    h.state.write((c) =>
      acquireClaims(c, {
        projectId: h.project.id,
        workstreamId: beta.id,
        requests: claimRequestsForTask(getTask(c.tx, beta.taskId), h.project),
        leaseExpiresAt: '2999-01-01T00:00:00.000Z',
      }),
    );
    h.settle(beta.id, 'RUNNING');
    expect(() => h.shipper.abandon(batch.id)).toThrow(/running/);
    h.settle(beta.id, 'WAITING_HUMAN');
    const abandoned = h.shipper.abandon(batch.id);
    expect(abandoned.state).toBe('ABANDONED');
    expect(getWorkstream(h.store.db, beta.id).state).toBe('CANCELLED');
    expect(getWorkstream(h.store.db, alpha.id).state).toBe('DONE');
    expect(activeClaims(h.store.db, beta.id)).toEqual([]);
    expect(h.git$('branch', '--list', batch.branch ?? '')).toContain(batch.branch ?? '');
    expect(h.only(h.cards()).body).toContain('Alpha');
    await h.jobs.idle();
    expect(getBatch(h.store.db, batch.id).state).toBe('ABANDONED');
  });

  it.each(['SHIPPED', 'CLOSED', 'ABANDONED'] as const)(
    'refuses Ship and Abandon from %s',
    async (state) => {
      h = createDeliveryHarness();
      const { batch } = await openBatch('Greetings', 'Alpha');
      h.state.write((c) => {
        if (state === 'ABANDONED') transitionBatch(c, batch.id, { to: 'ABANDONED' });
        else {
          transitionBatch(c, batch.id, { to: 'SHIPPING' });
          transitionBatch(c, batch.id, {
            to: state,
            ...(state === 'SHIPPED'
              ? { patch: { prUrl: 'https://github.com/acme/widgets/pull/9' } }
              : {}),
          });
        }
      });
      expect(() => h.shipper.ship(batch.id)).toThrow(ConflictError);
      expect(() => h.shipper.abandon(batch.id)).toThrow(ConflictError);
    },
  );
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @10db/daemon exec vitest run src/delivery/pr-text.test.ts src/delivery/ship.test.ts`
Expected: FAIL. `pr-text.test.ts` fails with `prTitle is not a function`; `ship.test.ts` can't build the harness because `createShipper` is not exported from `../src/delivery`.

- [ ] **Step 4: Write the PR text**

`apps/daemon/src/delivery/pr-text.ts`:

````ts
import { WorkstreamState, type BatchId } from '@10db/contracts';

/** `<prefix>: <title>` with the title's first letter lowercased: commitlint wants a lowercase subject. */
export function prTitle(prefix: string | null, title: string): string {
  const subject = `${title.charAt(0).toLowerCase()}${title.slice(1)}`;
  return prefix === null ? subject : `${prefix}: ${subject}`;
}

/** The PR body, built from records only (batch delivery spec §6). */
export function prBody(input: {
  readonly batch: { readonly id: BatchId; readonly title: string };
  readonly rows: readonly { readonly title: string; readonly state: WorkstreamState }[];
  readonly gate: { readonly command: string; readonly exitCode: number };
}): string {
  const word = (state: WorkstreamState): string => state.toLowerCase();
  const notDone = input.rows.filter((r) => r.state !== WorkstreamState.Done);
  const lines = [
    `## ${input.batch.title}`,
    '',
    '### Tasks',
    '',
    ...input.rows.map((r) => `- ${r.title}: ${word(r.state)}`),
    '',
    '### Gate',
    '',
    '```',
    input.gate.command,
    '```',
    '',
    `Exited ${String(input.gate.exitCode)} on the branch as pushed.`,
    ...(notDone.length > 0
      ? ['', '### Not done', '', ...notDone.map((r) => `- ${r.title} (${word(r.state)})`)]
      : []),
    '',
    '---',
    '',
    `Shipped by 10db, batch ${input.batch.id}`,
  ];
  return `${lines.join('\n')}\n`;
}
````

- [ ] **Step 5: Add the shipping cards**

Append to `apps/daemon/src/delivery/cards.ts` (import `BatchFailure`, `type BatchDto` from `@10db/contracts`, `type GateResult` from `../verify`):

```ts
const notShipped = (batch: BatchDto): string => `Batch "${batch.title}" not shipped`;
const RETRY = 'Press Retry on the Tasks view’s batch strip to ship again; nothing was merged.';

/** A shipping failure: the code the batch records and the card the builder reads. */
export interface ShipFailure {
  readonly failure: BatchFailure;
  readonly card: Card;
}

export const shipCards = {
  dirtyCheckout: (batch: BatchDto, paths: readonly string[]): ShipFailure => ({
    failure: BatchFailure.DirtyCheckout,
    card: {
      title: `${notShipped(batch)}: the checkout has uncommitted changes`,
      body: `10db ships only a clean branch. Commit these with a fix task in the batch, or discard them, then retry:\n${listPaths(paths)}\n\n${RETRY}`,
      detail: { batchId: batch.id },
    },
  }),
  gateFailed: (batch: BatchDto, gate: GateResult): ShipFailure => ({
    failure: BatchFailure.GateFailed,
    card: {
      title: `${notShipped(batch)}: the gate failed (exit ${String(gate.exitCode)})`,
      body: `Last output:\n${gate.tail.slice(-1500)}\n\nFull log: ${gate.logPath}\n\nStart a fix task in the batch (it reopens the batch), or ${RETRY.charAt(0).toLowerCase()}${RETRY.slice(1)}`,
      detail: { batchId: batch.id },
    },
  }),
  gateTimedOut: (batch: BatchDto, timeoutMs: number, logPath: string): ShipFailure => ({
    failure: BatchFailure.GateTimedOut,
    card: {
      title: `${notShipped(batch)}: the gate timed out after ${String(Math.round(timeoutMs / 60_000))} min`,
      body: `10db stopped the gate and pushed nothing. Log: ${logPath}\n\n${RETRY}`,
      detail: { batchId: batch.id },
    },
  }),
  pushRejected: (batch: BatchDto, detail: string): ShipFailure => ({
    failure: BatchFailure.PushRejected,
    card: {
      title: `${notShipped(batch)}: git push was rejected`,
      body: `${detail}\n\norigin's ${batch.branch ?? 'branch'} has commits this checkout doesn't, and 10db never force-pushes. Reconcile the branch by hand, then retry.`,
      detail: { batchId: batch.id },
    },
  }),
  /** gh missing or signed out; anything else gh or the network did is `network`. */
  network: (batch: BatchDto, step: string, error: unknown): ShipFailure => {
    const gh = ghCard(notShipped(batch), error, 'retry');
    return gh
      ? { failure: BatchFailure.GhUnavailable, card: { ...gh, detail: { batchId: batch.id } } }
      : {
          failure: BatchFailure.Network,
          card: {
            title: `${notShipped(batch)}: ${step} failed`,
            body: `${detailOf(error)}\n\n${RETRY}`,
            detail: { batchId: batch.id },
          },
        };
  },
  abandoned: (batch: BatchDto, doneTitles: readonly string[]): Card => ({
    title: `Batch "${batch.title}" abandoned`,
    body:
      doneTitles.length > 0
        ? `These tasks stay done, but their code is unmerged, only on the local branch ${batch.branch ?? '(none)'}:\n${doneTitles.map((t) => `- ${t}`).join('\n')}`
        : `Nothing in it finished. The local branch ${batch.branch ?? '(none)'} is kept.`,
    detail: { batchId: batch.id },
  }),
};
```

`ghCard(prefix, error, 'retry')` from Task 5 yields titles ending `gh is not installed` / `gh is signed out`.

- [ ] **Step 6: Write the shipper and the trigger**

`apps/daemon/src/delivery/ship.ts`:

```ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  BatchFailure,
  BatchState,
  ConflictError,
  isTerminal,
  LANE_STATES,
  latestPerTask,
  shipReadiness,
  ShipReadiness,
  WorkstreamState,
  type BatchDto,
  type BatchId,
  type ProjectDto,
  type WorkstreamDto,
  type WorkstreamId,
} from '@10db/contracts';
import {
  clearLease,
  getBatch,
  getProject,
  listBatches,
  listWorkstreams,
  patchBatch,
  releaseClaims,
  transitionBatch,
  transitionWorkstream,
  type DbReader,
} from '@10db/db';
import type { Clock } from '../clock';
import { GitNetworkError } from '../git';
import type { GateResult, GateRunner } from '../verify';
import { shipCards, wrongBranchCard, type ShipFailure } from './cards';
import { ghCall, networkCall, raise, type DeliveryContext } from './context';
import { prBody, prTitle } from './pr-text';

export interface ShipperDeps extends DeliveryContext {
  readonly gate: GateRunner;
  readonly clock: Clock;
  readonly dataDir: string;
  /** The gate runs in the session environment, as a task's gate does. */
  sessionEnv(project: ProjectDto): Readonly<Record<string, string>>;
  identifyProcess?(pid: number): Promise<string | null>;
  /** True while a runner holds the workstream (its lane is live). */
  isRunning(id: WorkstreamId): boolean;
}

export interface Shipper {
  checkBatch(batchId: BatchId): void;
  checkOpenBatches(): void;
  resume(batchId: BatchId): void;
  ship(batchId: BatchId): BatchDto;
  abandon(batchId: BatchId): BatchDto;
}

/** A batch's members: each task's latest workstream in it. */
function members(db: DbReader, batchId: BatchId): WorkstreamDto[] {
  return latestPerTask(listWorkstreams(db, { batchId }));
}

export function createShipper(deps: ShipperDeps): Shipper {
  const db = deps.state.db;

  function resume(batchId: BatchId): void {
    deps.jobs.run(getBatch(db, batchId).projectId, (signal) => shipSteps(batchId, signal));
  }

  function fail(batch: BatchDto, outcome: ShipFailure): void {
    const moved = deps.state.write((w) => {
      if (getBatch(w.tx, batch.id).state !== BatchState.Shipping) return false;
      transitionBatch(w, batch.id, {
        to: BatchState.Failed,
        patch: { failure: outcome.failure },
        reason: outcome.card.title,
      });
      return true;
    });
    if (moved) raise(deps.inbox, batch.projectId, outcome.card);
  }

  /** Runs the project gate on the batch branch, recording its process group for recovery. */
  async function runGate(
    batch: BatchDto,
    project: ProjectDto,
    signal: AbortSignal,
  ): Promise<GateResult | null> {
    let recording: Promise<void> = Promise.resolve();
    const result = await deps.gate.run({
      repo: project.repoPath,
      command: project.gateCommand,
      logPath: join(
        deps.dataDir,
        'logs',
        'gate',
        `batch-${batch.id}-${String(deps.clock.now().getTime())}.log`,
      ),
      timeoutMs: deps.limits.gateTimeoutMs,
      env: deps.sessionEnv(project),
      signal,
      onSpawn: (pid) => {
        recording = (deps.identifyProcess?.(pid) ?? Promise.resolve(null)).then((gatePidStart) => {
          if (gatePidStart !== null)
            deps.state.write((w) => patchBatch(w, batch.id, { gatePid: pid, gatePidStart }));
        });
      },
    });
    await recording.catch(() => undefined);
    deps.state.write((w) =>
      patchBatch(w, batch.id, {
        gatePid: null,
        gatePidStart: null,
        ...(result.aborted ? {} : { gateExitCode: result.exitCode, gateLogPath: result.logPath }),
      }),
    );
    // Shutdown killed the gate: record nothing; the batch stays SHIPPING and recovery re-runs it.
    return result.aborted ? null : result;
  }

  async function createPr(
    batch: BatchDto,
    project: ProjectDto,
    signal: AbortSignal,
  ): Promise<string> {
    const rows = members(db, batch.id).map((w) => ({ title: w.taskTitle, state: w.state }));
    const file = join(deps.dataDir, 'delivery', `${batch.id}-pr-body.md`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      prBody({ batch, rows, gate: { command: project.gateCommand, exitCode: 0 } }),
    );
    return deps.gh.prCreate(
      {
        repo: batch.repo ?? '',
        base: batch.baseBranch,
        head: batch.branch ?? '',
        title: prTitle(project.prTitlePrefix, batch.title),
        bodyFile: file,
      },
      ghCall(deps, project.repoPath, signal),
    );
  }

  /** Batch delivery spec §6, steps 0–5. Each step is safe to repeat, so a restart runs them all again. */
  async function shipSteps(batchId: BatchId, signal: AbortSignal): Promise<void> {
    const batch = getBatch(db, batchId);
    if (batch.state !== BatchState.Shipping) return;
    const project = getProject(db, batch.projectId);
    const { branch, baseSha, repo } = batch;
    let step = 'checking the branch';
    try {
      // 0. The branch and a clean checkout.
      const current = await deps.git.currentBranch(project.repoPath);
      if (branch === null || baseSha === null || repo === null || current !== branch) {
        fail(batch, {
          failure: BatchFailure.WrongBranch,
          card: wrongBranchCard(batch, current, project.repoPath, 'failed'),
        });
        return;
      }
      const dirty = await deps.git.status(project.repoPath);
      if (dirty.length > 0) {
        fail(
          batch,
          shipCards.dirtyCheckout(
            batch,
            dirty.map((d) => d.path),
          ),
        );
        return;
      }
      // 1. Nothing beyond the base: nothing to push.
      if ((await deps.git.commitsSince(project.repoPath, baseSha)).length === 0) {
        deps.state.write((w) =>
          transitionBatch(w, batchId, {
            to: BatchState.Closed,
            reason: 'no commits beyond the base',
          }),
        );
        return;
      }
      // 2. The gate, on the branch as it will be pushed.
      step = 'the gate';
      const gate = await runGate(batch, project, signal);
      if (gate === null) return;
      if (gate.timedOut) {
        fail(batch, shipCards.gateTimedOut(batch, deps.limits.gateTimeoutMs, gate.logPath));
        return;
      }
      if (gate.exitCode !== 0) {
        fail(batch, shipCards.gateFailed(batch, gate));
        return;
      }
      // 3. Push, never forced.
      step = 'git push';
      await deps.git.push(project.repoPath, branch, networkCall(deps, signal));
      // 4. Any PR for the branch, in any state; create one only when there is none.
      step = 'gh pr view';
      const existing = await deps.gh.prView(
        { repo, ref: branch },
        ghCall(deps, project.repoPath, signal),
      );
      step = 'gh pr create';
      const prUrl = existing?.url ?? (await createPr(batch, project, signal));
      // 5. Record it.
      deps.state.write((w) =>
        transitionBatch(w, batchId, {
          to: BatchState.Shipped,
          patch: { prUrl },
          reason: 'pull request open',
        }),
      );
    } catch (error) {
      // Shutdown: leave SHIPPING; recovery re-runs from step 0.
      if (signal.aborted) return;
      if (error instanceof GitNetworkError && error.kind === 'rejected') {
        fail(batch, shipCards.pushRejected(batch, error.detail));
        return;
      }
      fail(batch, shipCards.network(batch, step, error));
    }
  }

  function toShipping(batchId: BatchId, reason: string): BatchDto {
    return deps.state.write((w) =>
      transitionBatch(w, batchId, { to: BatchState.Shipping, patch: { failure: null }, reason }),
    );
  }

  function checkBatch(batchId: BatchId): void {
    const moved = deps.state.write((w) => {
      const batch = getBatch(w.tx, batchId);
      if (batch.state !== BatchState.Open) return false;
      if (shipReadiness(members(w.tx, batchId).map((m) => m.state)) !== ShipReadiness.Ready)
        return false;
      transitionBatch(w, batchId, {
        to: BatchState.Shipping,
        reason: 'every workstream is done or cancelled',
      });
      return true;
    });
    if (moved) resume(batchId);
  }

  return {
    checkBatch,
    checkOpenBatches() {
      for (const batch of listBatches(db, { states: [BatchState.Open] })) checkBatch(batch.id);
    },
    resume,
    ship(batchId) {
      const batch = getBatch(db, batchId);
      const current = members(db, batchId);
      const readiness = shipReadiness(current.map((m) => m.state));
      const blockers = current
        .filter((m) => !isTerminal(m.state))
        .map((m) => `${m.taskTitle} (${m.state.toLowerCase()})`);
      switch (batch.state) {
        case BatchState.Open: {
          if (readiness === ShipReadiness.Blocked)
            throw new ConflictError(
              `Batch "${batch.title}" still has unfinished work: ${blockers.join(', ')}`,
            );
          const shipping = toShipping(batchId, 'shipped anyway by the builder');
          resume(batchId);
          return shipping;
        }
        case BatchState.Failed: {
          if (readiness === ShipReadiness.Blocked) {
            // Never ship unfinished work: resume it; the batch ships itself when it settles.
            const reopened = deps.state.write((w) =>
              transitionBatch(w, batchId, {
                to: BatchState.Open,
                patch: { failure: null },
                reason: 'retried with unfinished work',
              }),
            );
            deps.onWorkQueued();
            return reopened;
          }
          const shipping = toShipping(batchId, 'retried by the builder');
          resume(batchId);
          return shipping;
        }
        case BatchState.Cutting:
        case BatchState.Shipping:
        case BatchState.Shipped:
        case BatchState.Closed:
        case BatchState.Abandoned:
          throw new ConflictError(
            `Batch "${batch.title}" is ${batch.state.toLowerCase()}; only an open or failed batch ships`,
          );
      }
    },
    abandon(batchId) {
      const batch = getBatch(db, batchId);
      if (batch.state !== BatchState.Open && batch.state !== BatchState.Failed)
        throw new ConflictError(
          `Batch "${batch.title}" is ${batch.state.toLowerCase()}; only an open or failed batch can be abandoned`,
        );
      const all = listWorkstreams(db, { batchId });
      const running = all.filter(
        (w) =>
          LANE_STATES.includes(w.state) ||
          w.state === WorkstreamState.TakenOver ||
          (w.state === WorkstreamState.WaitingHuman && w.currentSessionId !== null) ||
          deps.isRunning(w.id),
      );
      if (running.length > 0)
        throw new ConflictError(
          `${String(running.length)} workstream(s) in batch "${batch.title}" are running: ${running.map((w) => w.taskTitle).join(', ')}. Cancel them first.`,
        );
      const toCancel = all.filter((w) => !isTerminal(w.state));
      const abandoned = deps.state.write((w) => {
        for (const ws of toCancel) {
          transitionWorkstream(w, ws.id, {
            to: WorkstreamState.Cancelled,
            fence: null,
            patch: { currentSessionId: null },
            reason: 'batch abandoned',
          });
          releaseClaims(w, ws.id);
          clearLease(w, ws.id);
        }
        return transitionBatch(w, batchId, {
          to: BatchState.Abandoned,
          reason: 'abandoned by the builder',
        });
      });
      for (const ws of toCancel) deps.inbox.cancelForWorkstream(ws.id);
      const done = members(db, batchId)
        .filter((m) => m.state === WorkstreamState.Done)
        .map((m) => m.taskTitle);
      raise(deps.inbox, batch.projectId, shipCards.abandoned(abandoned, done));
      return abandoned;
    },
  };
}
```

`apps/daemon/src/delivery/trigger.ts`:

```ts
import { EventType, WorkstreamId, WorkstreamState } from '@10db/contracts';
import { getWorkstreamRow, type DbReader } from '@10db/db';
import type { EventBus } from '../events';
import type { Shipper } from './ship';

/**
 * The ship trigger (batch delivery spec §4): when a workstream in a batch reaches DONE or CANCELLED,
 * the shipper re-reads the batch and moves it to SHIPPING once all its members settled. Startup
 * runs the same check (`checkOpenBatches`), so a missed event is caught.
 */
export function subscribeShipTrigger(bus: EventBus, db: DbReader, shipper: Shipper): () => void {
  return bus.subscribe((event) => {
    if (event.type !== EventType.WorkstreamChanged) return;
    const to = event.data['to'];
    if (to !== WorkstreamState.Done && to !== WorkstreamState.Cancelled) return;
    const id = WorkstreamId.safeParse(event.entityId);
    if (!id.success) return;
    const { batchId } = getWorkstreamRow(db, id.data);
    if (batchId === null) return;
    shipper.checkBatch(batchId);
  });
}
```

In `apps/daemon/src/delivery/index.ts`, add:

```ts
export { prBody, prTitle } from './pr-text';
export { createShipper, type Shipper, type ShipperDeps } from './ship';
export { subscribeShipTrigger } from './trigger';
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm --filter @10db/daemon exec vitest run src/delivery && pnpm typecheck && pnpm lint`
Expected: PASS, every row. In the failure table: the dirty, wrong-branch, gate and timeout rows leave origin without the branch; the rejected-push row leaves origin at the teammate's commit; the `gh` rows push the branch but open no PR. The timeout row finishes in about a second.

- [ ] **Step 8: Commit**

```bash
pnpm format && git add apps/daemon/src/delivery apps/daemon/test/delivery-harness.ts && git commit -m 'feat(daemon): ship a settled batch as one pull request, and ship anyway, retry or abandon it' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>' -m 'Claude-Session: https://claude.ai/code/session_01KFqjacxo6Va8EyHF93n3xr'
```

---

### Task 7: The scheduler's launch rule and workstream retry in a batch

**Files:**

- Create: `apps/daemon/src/delivery/launch-rule.ts`; Modify: `apps/daemon/src/delivery/index.ts`
- Modify: `apps/daemon/src/scheduler/scheduler.ts`, `apps/daemon/src/daemon/start.ts` (pass the new scheduler options)
- Modify: `apps/daemon/src/team/steps.ts` (`retryWorkstream`)
- Test: `apps/daemon/src/delivery/launch-rule.test.ts`, `apps/daemon/src/scheduler/scheduler.test.ts`, `apps/daemon/src/team/steps.test.ts`

**Interfaces:**

- Consumes: Task 2's `getBatch`, `insertBatch`, `transitionBatch`, `patchBatch`, `insertWorkstream({ batchId })`, `WorkstreamDto.batchId`, `ProjectDto.delivery`; Task 5's `wrongBranchCard`, `raise`-style flagging; `Git.currentBranch`.
- Produces:
  - `delivery/launch-rule.ts`: `LaunchVerdict` (`launch | wait | wrong_branch`), `batchLaunchVerdict(batch: BatchDto | null, currentBranch: string | null): LaunchVerdict`, `flagWrongBranch(inbox: InboxService, batch: BatchDto, current: string | null, repoPath: string): void`.
  - `Scheduler.tick(): Promise<number>` (was `number`); ticks are serialized.
  - `SchedulerOptions` gains `branches: { currentBranch(repo: string): Promise<string | null> }` and `onWrongBranch(batch: BatchDto, current: string | null, repoPath: string): void`.
  - `retryWorkstream` refuses a workstream whose batch is not `OPEN` or `FAILED` (`ConflictError`) and reopens a `FAILED` batch in the same transaction.

- [ ] **Step 1: Write the failing tests**

`apps/daemon/src/delivery/launch-rule.test.ts`:

```ts
import { mintId, type BatchDto } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { batchLaunchVerdict } from './index';

const AT = '2026-10-21T12:00:00.000Z';
const batch = (overrides: Partial<BatchDto>): BatchDto => ({
  id: mintId('Batch'),
  projectId: mintId('Project'),
  title: 'Greetings',
  state: 'OPEN',
  branch: '10db/greetings-0a1b2c3d',
  baseBranch: 'main',
  baseSha: 'a'.repeat(40),
  repo: 'acme/widgets',
  prUrl: null,
  gateExitCode: null,
  gateLogPath: null,
  failure: null,
  createdAt: AT,
  updatedAt: AT,
  ...overrides,
});

describe('batchLaunchVerdict', () => {
  it.each<{ name: string; batch: BatchDto | null; current: string | null; expected: string }>([
    { name: 'no batch', batch: null, current: 'main', expected: 'wait' },
    {
      name: 'a cutting batch',
      batch: batch({ state: 'CUTTING', branch: null, baseSha: null }),
      current: 'main',
      expected: 'wait',
    },
    {
      name: 'an open batch with no base yet',
      batch: batch({ baseSha: null }),
      current: '10db/greetings-0a1b2c3d',
      expected: 'wait',
    },
    {
      name: 'an open batch on its branch',
      batch: batch({}),
      current: '10db/greetings-0a1b2c3d',
      expected: 'launch',
    },
    {
      name: 'an open batch on another branch',
      batch: batch({}),
      current: 'main',
      expected: 'wrong_branch',
    },
    {
      name: 'an open batch on a detached HEAD',
      batch: batch({}),
      current: null,
      expected: 'wrong_branch',
    },
    {
      name: 'a failed batch on its branch',
      batch: batch({ state: 'FAILED' }),
      current: '10db/greetings-0a1b2c3d',
      expected: 'wait',
    },
    {
      name: 'a shipping batch on its branch',
      batch: batch({ state: 'SHIPPING' }),
      current: '10db/greetings-0a1b2c3d',
      expected: 'wait',
    },
  ])('$name: $expected', ({ batch: b, current, expected }) => {
    expect(batchLaunchVerdict(b, current)).toBe(expected);
  });
});
```

In `apps/daemon/src/scheduler/scheduler.test.ts`:

- Every `scheduler(...).tick()` and `s.tick()` call is awaited (`await s.tick()`, `expect(await scheduler().tick()).toBe(2)`), and the tests that call it become `async`.
- The factory passes the two new options from per-test state:

```ts
let branchOf: Map<string, string | null>;
let branchReads: string[];
let wrongBranch: { batchId: string; current: string | null }[];
// in beforeEach:
  branchOf = new Map();
  branchReads = [];
  wrongBranch = [];
// in createScheduler({...}):
    branches: {
      currentBranch: (repo) => {
        branchReads.push(repo);
        return Promise.resolve(branchOf.get(repo) ?? null);
      },
    },
    onWrongBranch: (batch, current) => {
      wrongBranch.push({ batchId: batch.id, current });
    },
```

- Add (importing `insertBatch`, `transitionBatch`, `patchBatch` from `@10db/db` and `type BatchState` from `@10db/contracts`):

```ts
describe('pull-request delivery', () => {
  const BRANCH = '10db/greetings-0a1b2c3d';
  /** A pull-request project whose one task is queued in a batch moved through `to` from CUTTING. */
  function inBatch(to: readonly BatchState[], baseSha: string | null = 'a'.repeat(40)) {
    const project = seedProject(store, { delivery: 'pull_request', prTitlePrefix: 'feat(app)' });
    const task = state.write((ctx) =>
      insertTask(ctx, project.id, { title: 't', acceptanceCriteria: ['x'], areas: ['api'] }),
    );
    const batch = state.write((ctx) => {
      const b = insertBatch(ctx, { projectId: project.id, title: 'Greetings', baseBranch: 'main' });
      for (const next of to) transitionBatch(ctx, b.id, { to: next });
      if (to.length > 0) patchBatch(ctx, b.id, { branch: BRANCH, ...(baseSha ? { baseSha } : {}) });
      return b;
    });
    const workstream = state.write((ctx) => insertWorkstream(ctx, task.id, { batchId: batch.id }));
    return { project, batch, workstream };
  }

  it.each<{
    name: string;
    to: BatchState[];
    baseSha?: string | null;
    current: string | null;
    launched: boolean;
    warned: boolean;
  }>([
    {
      name: 'an open batch on its branch',
      to: ['OPEN'],
      current: BRANCH,
      launched: true,
      warned: false,
    },
    {
      name: 'an open batch on another branch',
      to: ['OPEN'],
      current: 'main',
      launched: false,
      warned: true,
    },
    {
      name: 'an open batch with no base',
      to: ['OPEN'],
      baseSha: null,
      current: BRANCH,
      launched: false,
      warned: false,
    },
    { name: 'a cutting batch', to: [], current: BRANCH, launched: false, warned: false },
    {
      name: 'a failed batch',
      to: ['OPEN', 'FAILED'],
      current: BRANCH,
      launched: false,
      warned: false,
    },
  ])('$name: launched $launched', async ({ to, baseSha, current, launched: expected, warned }) => {
    const q = inBatch(to, baseSha === undefined ? 'a'.repeat(40) : baseSha);
    branchOf.set(q.project.repoPath, current);
    await scheduler().tick();
    expect(launched.map((l) => l.id)).toEqual(expected ? [q.workstream.id] : []);
    expect(wrongBranch).toEqual(warned ? [{ batchId: q.batch.id, current }] : []);
  });

  it('never launches pull-request work that has no batch', async () => {
    const project = seedProject(store, { delivery: 'pull_request', prTitlePrefix: 'feat(app)' });
    add(project, ['api']);
    expect(await scheduler().tick()).toBe(0);
  });

  it("reads each pull-request project's branch once per tick, and never a local project's", async () => {
    const q = inBatch(['OPEN']);
    add(q.project, ['ui']);
    queue();
    branchOf.set(q.project.repoPath, BRANCH);
    await scheduler().tick();
    expect(branchReads).toEqual([q.project.repoPath]);
  });

  it('runs one tick at a time', async () => {
    const q = inBatch(['OPEN']);
    branchOf.set(q.project.repoPath, BRANCH);
    const s = scheduler();
    const [first, second] = await Promise.all([s.tick(), s.tick()]);
    expect([first, second]).toEqual([1, 0]);
  });
});
```

In `apps/daemon/src/team/steps.test.ts`, add (importing `insertBatch`, `transitionBatch`, `insertWorkstream`, `getBatch`, `transitionWorkstream` from `@10db/db`, `ConflictError` and `type BatchState` from `@10db/contracts`, and `retryWorkstream` from `./steps`):

```ts
describe('retryWorkstream in a batch', () => {
  it.each<{ name: string; to: BatchState[]; allowed: boolean; after?: BatchState }>([
    { name: 'an open batch', to: ['OPEN'], allowed: true, after: 'OPEN' },
    {
      name: 'a failed batch, which it reopens',
      to: ['OPEN', 'FAILED'],
      allowed: true,
      after: 'OPEN',
    },
    { name: 'a shipping batch', to: ['OPEN', 'SHIPPING'], allowed: false },
    { name: 'a shipped batch', to: ['OPEN', 'SHIPPING', 'SHIPPED'], allowed: false },
    { name: 'a closed batch', to: ['OPEN', 'SHIPPING', 'CLOSED'], allowed: false },
    { name: 'an abandoned batch', to: ['OPEN', 'ABANDONED'], allowed: false },
  ])('$name: allowed $allowed', ({ to, allowed, after }) => {
    const task = addTask();
    const batch = state.write((ctx) => {
      const b = insertBatch(ctx, { projectId: project.id, title: 'B', baseBranch: 'main' });
      transitionBatch(ctx, b.id, { to: 'OPEN' });
      return b;
    });
    const ws = state.write((ctx) => insertWorkstream(ctx, task.id, { batchId: batch.id }));
    state.write((ctx) => {
      for (const s of ['STARTING', 'RUNNING', 'FAILED'] as const)
        transitionWorkstream(ctx, ws.id, { to: s, fence: null });
      for (const s of to.slice(1)) transitionBatch(ctx, batch.id, { to: s });
    });
    if (!allowed) {
      expect(() => retryWorkstream(state, ws.id)).toThrow(ConflictError);
      return;
    }
    expect(retryWorkstream(state, ws.id).state).toBe('QUEUED');
    expect(getBatch(state.db, batch.id).state).toBe(after);
  });

  it('retries a workstream with no batch as before', () => {
    const ws = state.write((ctx) => insertWorkstream(ctx, addTask().id));
    state.write((ctx) => {
      for (const s of ['STARTING', 'RUNNING', 'FAILED'] as const)
        transitionWorkstream(ctx, ws.id, { to: s, fence: null });
    });
    expect(retryWorkstream(state, ws.id).state).toBe('QUEUED');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @10db/daemon exec vitest run src/delivery/launch-rule.test.ts src/scheduler src/team`
Expected: FAIL. `batchLaunchVerdict is not a function`; the pull-request scheduler rows launch work they should not (the scheduler ignores batches) and `branchReads` stays empty; the retry rows for `SHIPPING`, `SHIPPED`, `CLOSED` and `ABANDONED` don't throw, and the `FAILED` row leaves the batch `FAILED`.

- [ ] **Step 3: Write the launch rule**

`apps/daemon/src/delivery/launch-rule.ts`:

```ts
import { BatchState, type BatchDto } from '@10db/contracts';
import type { InboxService } from '../inbox';
import { wrongBranchCard } from './cards';
import { raise } from './context';

export const LaunchVerdict = {
  Launch: 'launch',
  Wait: 'wait',
  WrongBranch: 'wrong_branch',
} as const;
export type LaunchVerdict = (typeof LaunchVerdict)[keyof typeof LaunchVerdict];

/**
 * Batch delivery spec §5: pull-request work launches only when its batch is OPEN, its base is set
 * and the checkout is on its branch. Work with no batch never launches.
 */
export function batchLaunchVerdict(
  batch: BatchDto | null,
  currentBranch: string | null,
): LaunchVerdict {
  if (
    batch === null ||
    batch.state !== BatchState.Open ||
    batch.baseSha === null ||
    batch.branch === null
  )
    return LaunchVerdict.Wait;
  return currentBranch === batch.branch ? LaunchVerdict.Launch : LaunchVerdict.WrongBranch;
}

/** One folded card while an open batch's work waits for its branch. */
export function flagWrongBranch(
  inbox: InboxService,
  batch: BatchDto,
  current: string | null,
  repoPath: string,
): void {
  raise(inbox, batch.projectId, wrongBranchCard(batch, current, repoPath, 'waits'));
}
```

In `apps/daemon/src/delivery/index.ts`, add `export { batchLaunchVerdict, flagWrongBranch, LaunchVerdict } from './launch-rule';`.

- [ ] **Step 4: Make the tick asynchronous and apply the rule**

In `apps/daemon/src/scheduler/scheduler.ts`:

- Import `Delivery`, `WorkstreamState`, `type BatchDto`, `type ProjectId` from `@10db/contracts`, `getBatch` from `@10db/db`, and `batchLaunchVerdict`, `LaunchVerdict` from `../delivery`.
- Add to `SchedulerOptions`:

```ts
  /** Reads the checkout's branch; asked once per tick for each pull-request project with queued work. */
  readonly branches: { currentBranch(repo: string): Promise<string | null> };
  /** An open batch's work waits because the checkout is on another branch. */
  readonly onWrongBranch: (batch: BatchDto, current: string | null, repoPath: string) => void;
```

- Change `Scheduler.tick` to `tick(): Promise<number>;` with the doc comment "Launches what fits now; resolves to how many were launched. Ticks run one at a time."
- Rename the existing `tick` to `launchQueued(branches: ReadonlyMap<ProjectId, string | null>): number` and, at the top of its per-workstream loop, after the provider-cap check, add:

```ts
if (project.delivery === Delivery.PullRequest) {
  // Read after this tick's branch snapshot: wait for the next tick rather than guess.
  if (!branches.has(project.id)) continue;
  const current = branches.get(project.id) ?? null;
  const batch = ws.batchId ? getBatch(db, ws.batchId) : null;
  const verdict = batchLaunchVerdict(batch, current);
  if (verdict === LaunchVerdict.WrongBranch && batch && !warned.has(batch.id)) {
    warned.add(batch.id);
    opts.onWrongBranch(batch, current, project.repoPath);
  }
  if (verdict !== LaunchVerdict.Launch) continue;
}
```

with `const warned = new Set<string>();` declared before the loop.

- Add the snapshot and the serialized tick:

```ts
/** The checkout's branch for each pull-request project with queued work, read once per tick. */
async function branchSnapshot(): Promise<Map<ProjectId, string | null>> {
  const repos = new Map<ProjectId, string>();
  for (const ws of listWorkstreams(db, { states: [WorkstreamState.Queued] })) {
    const project = getProject(db, ws.projectId);
    if (project.delivery === Delivery.PullRequest) repos.set(project.id, project.repoPath);
  }
  const out = new Map<ProjectId, string | null>();
  for (const [id, repo] of repos)
    out.set(id, await opts.branches.currentBranch(repo).catch(() => null));
  return out;
}

let chain: Promise<unknown> = Promise.resolve();
function tick(): Promise<number> {
  const run = chain.then(async () => {
    requeueExpiredPauses();
    return launchQueued(await branchSnapshot());
  });
  chain = run.catch(() => undefined);
  return run;
}

const logTickError = (error: unknown): void => {
  opts.logger.error(
    { err: error instanceof Error ? error.message : String(error) },
    'scheduler tick failed',
  );
};
```

(`requeueExpiredPauses()` moves from the top of the old `tick` into this wrapper.)

- In `loop()`, keep `heartbeat()` synchronous and re-arm only after the tick settles:

```ts
function loop(): void {
  try {
    heartbeat();
  } catch (error) {
    logTickError(error);
  }
  void tick()
    .catch(logTickError)
    .finally(() => {
      if (started) timer = opts.clock.setTimeout(loop, opts.tickMs);
    });
}
```

- In `requestTick()`, replace the `try { tick(); } catch` block with `void tick().catch(logTickError);` (keeping the `pending` and `started` checks).

In `apps/daemon/src/daemon/start.ts`, pass the new options to `createScheduler` (import `flagWrongBranch` from `../delivery`):

```ts
    branches: git,
    onWrongBranch: (batch, current, repoPath) => {
      flagWrongBranch(inbox, batch, current, repoPath);
    },
```

- [ ] **Step 5: Apply the batch rule to retries**

In `apps/daemon/src/team/steps.ts` (import `BatchState` from `@10db/contracts`, `getBatch`, `transitionBatch` from `@10db/db`), change `retryWorkstream`:

```ts
/**
 * A failed workstream goes back to the queue; its current step restarts clean. In a batch it may
 * retry only while the batch is OPEN or FAILED, and a FAILED batch reopens (batch delivery spec §4).
 */
export function retryWorkstream(state: StateStore, id: WorkstreamId): WorkstreamDto {
  const row = getWorkstreamRow(state.db, id);
  if (row.state !== WorkstreamState.Failed)
    throw new ConflictError('Only a failed workstream can be retried');
  const batch = row.batchId ? getBatch(state.db, row.batchId) : null;
  if (batch && batch.state !== BatchState.Open && batch.state !== BatchState.Failed)
    throw new ConflictError(
      `Batch "${batch.title}" is ${batch.state.toLowerCase()}; start the task again to run it in a new batch`,
    );
  return state.write((ctx) => {
    if (batch?.state === BatchState.Failed)
      transitionBatch(ctx, batch.id, {
        to: BatchState.Open,
        patch: { failure: null },
        reason: 'a workstream was retried',
      });
    // ...the existing step restart and transition to QUEUED, unchanged
  });
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @10db/daemon exec vitest run && pnpm typecheck && pnpm lint`
Expected: PASS: the new rows, and every existing daemon suite (local projects never read the branch, so their scheduling is unchanged; the runner, recovery and `start.test.ts` suites go through `requestTick`).

- [ ] **Step 7: Commit**

```bash
pnpm format && git add apps/daemon/src/delivery/launch-rule.ts apps/daemon/src/delivery/launch-rule.test.ts apps/daemon/src/delivery/index.ts apps/daemon/src/scheduler/scheduler.ts apps/daemon/src/scheduler/scheduler.test.ts apps/daemon/src/daemon/start.ts apps/daemon/src/team/steps.ts apps/daemon/src/team/steps.test.ts && git commit -m 'feat(daemon): launch batch work only on its branch and keep retries inside open batches' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>' -m 'Claude-Session: https://claude.ai/code/session_01KFqjacxo6Va8EyHF93n3xr'
```

---

### Task 8: The guard: no agent pushes in pull-request projects, and no PR or repository changes through `gh`

**Files:**

- Create: `apps/daemon/src/guard/gh-rules.ts`
- Modify: `apps/daemon/src/guard/git-rules.ts`, `apps/daemon/src/guard/judge.ts`, `apps/daemon/src/runner/runner.ts` (pass the project's delivery)
- Test: `apps/daemon/src/guard/judge.test.ts`

**Interfaces:**

- Consumes: `Delivery` (Task 1), `ProjectDto.delivery` (Task 2), the guard's `splitCommand`, `stripCommandPrefixes` and `judgeShell`.
- Produces:
  - `GuardInput.delivery?: Delivery` (absent means `local`).
  - `gitVerdict(words: readonly string[], delivery: Delivery): GitVerdict`: `push` is denied with "10db pushes when the batch ships…" in `pull_request`.
  - `ghVerdict(words: readonly string[]): GhVerdict` (`{ deny: string } | null`): `gh pr` allows `view`, `list`, `checks`, `diff`, `status`; `gh repo` allows `view`, `list`; `gh api` allows only GET, counting `-f`, `-F`, `--field`, `--raw-field` or `--input` without an explicit method as POST.

- [ ] **Step 1: Write the failing test**

Append to `apps/daemon/src/guard/judge.test.ts` (import `type Delivery` from `@10db/contracts`):

```ts
describe('delivery and gh', () => {
  const run = (command: string, delivery: Delivery) =>
    judgeToolUse({
      toolName: 'Bash',
      toolInput: { command },
      repoPath: repo.path,
      areas: AREAS,
      hazards: DEFAULT_HAZARDS,
      claims: [{ kind: 'area', name: 'api' }],
      readOnly: false,
      delivery,
    }).decision;

  it.each<{
    name: string;
    command: string;
    local: 'allow' | 'deny';
    pullRequest: 'allow' | 'deny';
  }>([
    {
      name: 'push a feature branch',
      command: 'git push origin feat/x',
      local: 'allow',
      pullRequest: 'deny',
    },
    {
      name: 'push -u HEAD',
      command: 'git push -u origin HEAD',
      local: 'allow',
      pullRequest: 'deny',
    },
    {
      name: 'push behind git -C',
      command: 'git -C . push origin feat/x',
      local: 'allow',
      pullRequest: 'deny',
    },
    {
      name: 'push inside sh -c',
      command: "sh -c 'git push origin feat/x'",
      local: 'allow',
      pullRequest: 'deny',
    },
    {
      name: 'read-only git',
      command: 'git log --oneline -3',
      local: 'allow',
      pullRequest: 'allow',
    },
    { name: 'pr view', command: 'gh pr view 12', local: 'allow', pullRequest: 'allow' },
    { name: 'pr list', command: 'gh pr list --state open', local: 'allow', pullRequest: 'allow' },
    { name: 'pr checks', command: 'gh pr checks 12', local: 'allow', pullRequest: 'allow' },
    { name: 'pr diff', command: 'gh pr diff 12', local: 'allow', pullRequest: 'allow' },
    { name: 'pr status', command: 'gh pr status', local: 'allow', pullRequest: 'allow' },
    {
      name: 'pr create',
      command: 'gh pr create --title x --body y',
      local: 'deny',
      pullRequest: 'deny',
    },
    { name: 'pr merge', command: 'gh pr merge 12 --squash', local: 'deny', pullRequest: 'deny' },
    { name: 'pr close', command: 'gh pr close 12', local: 'deny', pullRequest: 'deny' },
    { name: 'pr edit', command: 'gh pr edit 12 --title x', local: 'deny', pullRequest: 'deny' },
    { name: 'pr ready', command: 'gh pr ready 12', local: 'deny', pullRequest: 'deny' },
    {
      name: 'pr checkout, which switches the branch',
      command: 'gh pr checkout 12',
      local: 'deny',
      pullRequest: 'deny',
    },
    { name: 'pr review', command: 'gh pr review 12 --approve', local: 'deny', pullRequest: 'deny' },
    {
      name: 'pr create with -R first',
      command: 'gh -R acme/widgets pr create',
      local: 'deny',
      pullRequest: 'deny',
    },
    {
      name: 'pr merge behind env',
      command: 'env GH_TOKEN=x gh pr merge 12',
      local: 'deny',
      pullRequest: 'deny',
    },
    {
      name: 'pr merge by full path',
      command: '/opt/homebrew/bin/gh pr merge 12',
      local: 'deny',
      pullRequest: 'deny',
    },
    {
      name: 'pr merge after cd',
      command: 'cd src && gh pr merge 3',
      local: 'deny',
      pullRequest: 'deny',
    },
    {
      name: 'pr merge in sh -c',
      command: "sh -c 'gh pr merge 3'",
      local: 'deny',
      pullRequest: 'deny',
    },
    {
      name: 'api GET',
      command: 'gh api repos/acme/widgets/pulls',
      local: 'allow',
      pullRequest: 'allow',
    },
    {
      name: 'api explicit GET with fields',
      command: 'gh api -X GET search/issues -f q=bug',
      local: 'allow',
      pullRequest: 'allow',
    },
    {
      name: 'api -X POST',
      command: 'gh api -X POST repos/acme/widgets/pulls',
      local: 'deny',
      pullRequest: 'deny',
    },
    {
      name: 'api --method=PATCH',
      command: 'gh api --method=PATCH repos/acme/widgets',
      local: 'deny',
      pullRequest: 'deny',
    },
    {
      name: 'api -XDELETE',
      command: 'gh api -XDELETE repos/acme/widgets/git/refs/heads/x',
      local: 'deny',
      pullRequest: 'deny',
    },
    {
      name: 'api with a field (an implicit POST)',
      command: 'gh api repos/acme/widgets/issues -f title=x',
      local: 'deny',
      pullRequest: 'deny',
    },
    {
      name: 'api with a bundled field',
      command: 'gh api repos/acme/widgets/issues -ftitle=x',
      local: 'deny',
      pullRequest: 'deny',
    },
    {
      name: 'api with --input',
      command: 'gh api repos/acme/widgets/pulls --input body.json',
      local: 'deny',
      pullRequest: 'deny',
    },
    {
      name: 'api graphql',
      command: "gh api graphql -f query='mutation { x }'",
      local: 'deny',
      pullRequest: 'deny',
    },
    {
      name: 'repo view',
      command: 'gh repo view --json nameWithOwner',
      local: 'allow',
      pullRequest: 'allow',
    },
    { name: 'repo list', command: 'gh repo list acme', local: 'allow', pullRequest: 'allow' },
    {
      name: 'repo edit',
      command: 'gh repo edit --visibility public',
      local: 'deny',
      pullRequest: 'deny',
    },
    {
      name: 'repo delete',
      command: 'gh repo delete acme/widgets --yes',
      local: 'deny',
      pullRequest: 'deny',
    },
    {
      name: 'repo create',
      command: 'gh repo create acme/other',
      local: 'deny',
      pullRequest: 'deny',
    },
    { name: 'repo sync', command: 'gh repo sync', local: 'deny', pullRequest: 'deny' },
    {
      name: 'repo set-default',
      command: 'gh repo set-default acme/widgets',
      local: 'deny',
      pullRequest: 'deny',
    },
    { name: 'issue list', command: 'gh issue list', local: 'allow', pullRequest: 'allow' },
    { name: 'gh with no command', command: 'gh', local: 'allow', pullRequest: 'allow' },
  ])('$name: $local in local, $pullRequest in pull_request', ({ command, local, pullRequest }) => {
    expect(run(command, 'local')).toBe(local);
    expect(run(command, 'pull_request')).toBe(pullRequest);
  });

  it('tells an agent in a pull-request project that 10db pushes', () => {
    const verdict = judgeToolUse({
      toolName: 'Bash',
      toolInput: { command: 'git push origin feat/x' },
      repoPath: repo.path,
      areas: AREAS,
      hazards: DEFAULT_HAZARDS,
      claims: [],
      readOnly: false,
      delivery: 'pull_request',
    });
    expect(verdict).toEqual({
      decision: 'deny',
      reason: '10db pushes when the batch ships; agents do not push in pull-request projects.',
    });
  });

  it('treats a missing delivery as local', () => {
    expect(bash('git push origin feat/x').decision).toBe('allow');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @10db/daemon exec vitest run src/guard/judge.test.ts`
Expected: FAIL. The push rows answer `allow` in `pull_request`; every `gh` deny row answers `allow`; the message test gets `{ decision: 'allow' }`.

- [ ] **Step 3: Write the rules**

`apps/daemon/src/guard/gh-rules.ts`:

```ts
export type GhVerdict = { readonly deny: string } | null;

/** gh flags that take a value and may come before the command group. */
const LEADING_VALUE_FLAGS = new Set(['-R', '--repo', '--hostname']);
/** gh pr commands that only read; checkout is not one: it switches the shared checkout's branch. */
const PR_READS = new Set(['view', 'list', 'checks', 'diff', 'status']);
const REPO_READS = new Set(['view', 'list']);
/** gh api sends POST by default once any of these is given (gh help api). */
const FIELD_FLAGS = ['-f', '-F', '--field', '--raw-field', '--input'];

/** The command group after `gh` and where it sits, skipping leading flags and their values. */
function commandGroup(words: readonly string[]): { group: string | undefined; at: number } {
  for (let i = 1; i < words.length; i += 1) {
    const w = words[i] ?? '';
    if (LEADING_VALUE_FLAGS.has(w)) i += 1;
    else if (!w.startsWith('-')) return { group: w, at: i };
  }
  return { group: undefined, at: words.length };
}

/** The first word after the group that is not a flag: `merge` in `gh pr merge 12`. */
function verbAfter(words: readonly string[], at: number): string | undefined {
  return words.slice(at + 1).find((w) => !w.startsWith('-'));
}

function isFieldFlag(arg: string): boolean {
  return (
    FIELD_FLAGS.includes(arg) ||
    FIELD_FLAGS.some((f) => f.startsWith('--') && arg.startsWith(`${f}=`)) ||
    /^-[fF]./.test(arg)
  );
}

/** The method a `gh api` call sends: an explicit -X/--method, else POST with fields, else GET. */
function apiMethod(args: readonly string[]): string {
  let method: string | null = null;
  let fields = false;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] ?? '';
    if (a === '-X' || a === '--method') {
      method = (args[i + 1] ?? '').toUpperCase();
      i += 1;
    } else if (a.startsWith('--method=')) method = a.slice('--method='.length).toUpperCase();
    else if (/^-X./.test(a)) method = a.slice(2).toUpperCase();
    else if (isFieldFlag(a)) fields = true;
  }
  return method ?? (fields ? 'POST' : 'GET');
}

/**
 * gh in a managed session reads only (batch delivery spec §7): 10db opens the pull request when a
 * batch ships, merging stays with the builder, and nothing changes the repository's settings.
 */
export function ghVerdict(words: readonly string[]): GhVerdict {
  const { group, at } = commandGroup(words);
  const verb = verbAfter(words, at);
  if (group === 'pr' && verb !== undefined && !PR_READS.has(verb))
    return {
      deny: `gh pr ${verb} is not allowed: 10db opens the pull request when the batch ships, and merging stays with the builder. gh pr view, list, checks, diff and status are allowed.`,
    };
  if (group === 'repo' && verb !== undefined && !REPO_READS.has(verb))
    return {
      deny: `gh repo ${verb} changes the repository and is not allowed; gh repo view and list are.`,
    };
  if (group === 'api') {
    // Every argument after `api`, so `-X POST` before or after the endpoint both count.
    const method = apiMethod(words.slice(at + 1));
    if (method !== 'GET')
      return {
        deny: `gh api ${method} requests are not allowed; only GET is. A request with -f, -F, --field or --input is a POST unless it says -X GET.`,
      };
  }
  return null;
}
```

In `apps/daemon/src/guard/git-rules.ts` (import `Delivery` and its type from `@10db/contracts`):

```ts
export function gitVerdict(words: readonly string[], delivery: Delivery): GitVerdict {
  // ...unchanged up to the push branch, which becomes:
  if (verb === 'push')
    return delivery === Delivery.PullRequest
      ? { deny: '10db pushes when the batch ships; agents do not push in pull-request projects.' }
      : pushVerdict(args);
```

In `apps/daemon/src/guard/judge.ts`:

- Import `Delivery` from `@10db/contracts` and `ghVerdict` from `./gh-rules`.
- Add to `GuardInput`:

```ts
  /** The project's delivery; absent means local. In pull-request projects only the daemon pushes. */
  readonly delivery?: Delivery;
```

- In `judgeShell`, change the git branch and add the gh one:

```ts
if (head === 'git') {
  const verdict = gitVerdict(words, input.delivery ?? Delivery.Local);
  if (verdict) return deny(verdict.deny);
}
if (head === 'gh') {
  const verdict = ghVerdict(words);
  if (verdict) return deny(verdict.deny);
}
```

In `apps/daemon/src/runner/runner.ts`, add `delivery: project.delivery,` to the `judgeToolUse({...})` call in `preToolUse`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @10db/daemon exec vitest run src/guard src/runner && pnpm typecheck && pnpm lint`
Expected: PASS: every row in both modes, and every existing guard and runner case (they pass no delivery, which reads as `local`).

- [ ] **Step 5: Commit**

```bash
pnpm format && git add apps/daemon/src/guard/gh-rules.ts apps/daemon/src/guard/git-rules.ts apps/daemon/src/guard/judge.ts apps/daemon/src/guard/judge.test.ts apps/daemon/src/runner/runner.ts && git commit -m 'feat(daemon): stop agents pushing in pull-request projects and changing prs through gh' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>' -m 'Claude-Session: https://claude.ai/code/session_01KFqjacxo6Va8EyHF93n3xr'
```

---

### Task 9: Batch recovery at startup, and shutdown while a batch ships

**Files:**

- Create: `apps/daemon/src/delivery/recover.ts`; Modify: `apps/daemon/src/delivery/index.ts`
- Create: `apps/daemon/test/orphan-gate.ts` (moved out of `src/recovery/recover.test.ts`, which now imports it)
- Test: `apps/daemon/src/delivery/recover.test.ts`

**Interfaces:**

- Consumes: Task 6's `Shipper` (`resume`, `checkOpenBatches`) and harness (`trigger: false`, `gateTimeoutMs`); Task 5's `wrongBranchCard`, `raise`; Task 7's scheduler options; `ProcessTerminator` shape from `recovery/` (structurally, as `GateTerminator`).
- Produces:
  - `interface GateTerminator { terminate(target: { readonly pid: number; readonly startedAt: string; readonly group?: boolean }): Promise<unknown> }`
  - `interface BatchRecoveryReport { readonly deleted: BatchId[]; readonly failed: BatchId[]; readonly resumed: BatchId[] }`
  - `recoverBatches(deps: { state: StateStore; git: Git; inbox: InboxService; processes: GateTerminator; shipper: Shipper; logger: Logger }): Promise<BatchRecoveryReport>`. It runs once at startup, after workstream recovery and before the scheduler starts: deletes `CUTTING` rows; kills an orphaned shipping gate group recorded on a `SHIPPING` batch; moves an `OPEN` or `SHIPPING` batch whose branch is not checked out to `FAILED` with the wrong-branch card; resumes shipping from step 0 for the rest of the `SHIPPING` batches; then runs the ship trigger's check for every `OPEN` batch.
  - `apps/daemon/test/orphan-gate.ts`: `orphanGateGroup(): Promise<{ leader; pid; startedAt; exited; grandchildPid; cleanup() }>` and `alive(pid: number): boolean`, exactly as `recover.test.ts` defines them today.

- [ ] **Step 1: Move the orphan helpers**

Move `orphanGateGroup` and `alive` from `apps/daemon/src/recovery/recover.test.ts` into `apps/daemon/test/orphan-gate.ts` unchanged (export both; the file imports `spawn`, `readFileSync`, `join`, `systemProcesses` from `../src/recovery`, and `tempDir`, `waitFor` from `./fixtures`), and import them in `recover.test.ts` from `../../test/orphan-gate`.

Run: `pnpm --filter @10db/daemon exec vitest run src/recovery`
Expected: PASS, unchanged.

- [ ] **Step 2: Write the failing tests**

`apps/daemon/src/delivery/recover.test.ts`:

```ts
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BatchDto } from '@10db/contracts';
import {
  getBatch,
  getBatchRow,
  insertBatch,
  listBatches,
  listWorkstreams,
  patchBatch,
  transitionBatch,
} from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { waitFor } from '../../test/fixtures';
import { alive, orphanGateGroup } from '../../test/orphan-gate';
import { ManualClock } from '../clock';
import { silentLogger } from '../log';
import { systemProcesses } from '../recovery';
import { createScheduler } from '../scheduler';
import { recoverBatches } from './index';

let h: DeliveryHarness;
afterEach(() => {
  h.close();
});

const recover = () =>
  recoverBatches({
    state: h.state,
    git: h.git,
    inbox: h.inbox,
    processes: systemProcesses,
    shipper: h.shipper,
    logger: silentLogger,
  });

/** An open batch of one task with one commit on its branch. */
async function openBatch(): Promise<BatchDto> {
  const task = h.addTask('Alpha');
  const started = h.starter.startBatch(h.project.id, { title: 'Greetings', taskIds: [task.id] });
  await h.jobs.idle();
  h.commit('src/api/alpha.txt');
  return getBatch(h.store.db, started.id);
}

/** As if the daemon died just after the ship trigger moved the batch to SHIPPING. */
async function shippingAfterCrash(): Promise<BatchDto> {
  const batch = await openBatch();
  for (const ws of listWorkstreams(h.store.db, { batchId: batch.id })) h.settle(ws.id, 'DONE');
  return h.state.write((c) => transitionBatch(c, batch.id, { to: 'SHIPPING' }));
}

function onOrigin(branch: string | null): string | null {
  try {
    return h.origin$('rev-parse', '--verify', '-q', `refs/heads/${branch ?? ''}`);
  } catch {
    return null;
  }
}

describe('recoverBatches', () => {
  it('deletes a CUTTING row and leaves the branch a crash left behind; the next cut uses a new name', async () => {
    h = createDeliveryHarness({}, { trigger: false });
    h.state.write((c) =>
      insertBatch(c, { projectId: h.project.id, title: 'Greetings', baseBranch: 'main' }),
    );
    h.git$('switch', '-q', '-c', '10db/greetings-0a1b2c3d');
    const report = await recover();
    expect(report.deleted).toHaveLength(1);
    expect(listBatches(h.store.db)).toEqual([]);
    expect(h.git$('branch', '--list', '10db/greetings-0a1b2c3d')).toContain(
      '10db/greetings-0a1b2c3d',
    );
    const next = await openBatch();
    expect(next.state).toBe('OPEN');
    expect(next.branch).not.toBe('10db/greetings-0a1b2c3d');
  });

  it('fails an unfinished batch whose branch is not checked out, and launches nothing in it', async () => {
    h = createDeliveryHarness({}, { trigger: false });
    const batch = await openBatch();
    h.git$('switch', '-q', 'main');
    const report = await recover();
    expect(report.failed).toEqual([batch.id]);
    expect(getBatch(h.store.db, batch.id)).toMatchObject({
      state: 'FAILED',
      failure: 'wrong_branch',
    });
    expect(h.only(h.cards()).title).toContain(
      `failed: checkout is on main, the batch branch is ${batch.branch ?? ''}`,
    );
    const launched: string[] = [];
    const scheduler = createScheduler({
      state: h.state,
      clock: new ManualClock(),
      caps: { global: 4, perProvider: 4 },
      instanceId: 'daemon-1',
      leaseMs: 60_000,
      tickMs: 2_000,
      logger: silentLogger,
      runner: {
        launch: (id) => {
          launched.push(id);
        },
        isRunning: () => false,
      },
      pauses: { isPaused: () => false },
      branches: h.git,
      onWrongBranch: () => undefined,
    });
    expect(await scheduler.tick()).toBe(0);
    expect(launched).toEqual([]);
  });

  it.each<{ name: string; crash: (h: DeliveryHarness, batch: BatchDto) => void }>([
    { name: 'before step 0', crash: () => undefined },
    {
      name: 'after the gate passed',
      crash: (x, batch) => {
        x.state.write((c) => patchBatch(c, batch.id, { gateExitCode: 0 }));
      },
    },
    {
      name: 'after the push',
      crash: (x, batch) => {
        x.git$('push', '-q', '-u', 'origin', batch.branch ?? '');
      },
    },
    {
      name: 'after gh pr create, before SHIPPED was written',
      crash: (x, batch) => {
        x.git$('push', '-q', '-u', 'origin', batch.branch ?? '');
        const body = join(x.dataDir, 'body.md');
        writeFileSync(body, 'from the run that crashed\n');
        void x.gh.prCreate(
          {
            repo: 'acme/widgets',
            base: 'main',
            head: batch.branch ?? '',
            title: 'feat(app): greetings',
            bodyFile: body,
          },
          { cwd: x.repo, env: {}, timeoutMs: 1_000 },
        );
      },
    },
  ])(
    'finishes a batch left in SHIPPING $name with one PR and the same pushed SHA',
    async ({ crash }) => {
      h = createDeliveryHarness({}, { trigger: false });
      const batch = await shippingAfterCrash();
      crash(h, batch);
      const report = await recover();
      expect(report.resumed).toEqual([batch.id]);
      await h.jobs.idle();
      expect(getBatch(h.store.db, batch.id)).toMatchObject({
        state: 'SHIPPED',
        prUrl: 'https://github.com/acme/widgets/pull/1',
      });
      expect(h.gh.calls.filter((c) => c.method === 'prCreate')).toHaveLength(1);
      expect(onOrigin(batch.branch)).toBe(h.git$('rev-parse', 'HEAD'));
    },
  );

  it('terminates an orphaned shipping gate before re-running', async () => {
    h = createDeliveryHarness({}, { trigger: false });
    const gate = await orphanGateGroup();
    try {
      const batch = await shippingAfterCrash();
      h.state.write((c) =>
        patchBatch(c, batch.id, { gatePid: gate.pid, gatePidStart: gate.startedAt }),
      );
      await recover();
      await gate.exited;
      await waitFor(() => !alive(gate.grandchildPid));
      await h.jobs.idle();
      expect(getBatch(h.store.db, batch.id).state).toBe('SHIPPED');
    } finally {
      if (alive(gate.grandchildPid)) process.kill(gate.grandchildPid, 'SIGKILL');
      gate.cleanup();
    }
  });

  it('ships an open batch whose last workstream finished while the daemon was down', async () => {
    h = createDeliveryHarness({}, { trigger: false });
    const batch = await openBatch();
    for (const ws of listWorkstreams(h.store.db, { batchId: batch.id })) h.settle(ws.id, 'DONE');
    expect(getBatch(h.store.db, batch.id).state).toBe('OPEN');
    await recover();
    await h.jobs.idle();
    expect(getBatch(h.store.db, batch.id).state).toBe('SHIPPED');
  });
});

describe('shutdown while shipping', () => {
  it('kills the gate, records no result and leaves the batch SHIPPING', async () => {
    h = createDeliveryHarness({ gateCommand: 'sleep 30' });
    const batch = await openBatch();
    for (const ws of listWorkstreams(h.store.db, { batchId: batch.id })) h.settle(ws.id, 'DONE');
    const pid = await waitFor(() => getBatchRow(h.store.db, batch.id).gatePid ?? undefined);
    await h.jobs.stop();
    expect(getBatchRow(h.store.db, batch.id)).toMatchObject({
      state: 'SHIPPING',
      gatePid: null,
      gateExitCode: null,
    });
    expect(alive(pid)).toBe(false);
    expect(onOrigin(batch.branch)).toBeNull();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @10db/daemon exec vitest run src/delivery/recover.test.ts`
Expected: FAIL. The recovery cases throw `recoverBatches is not a function`. The shutdown case already passes: Task 6's jobs and gate handle it; it stays as the regression test for spec §6 "Shutdown".

- [ ] **Step 4: Write the recovery**

`apps/daemon/src/delivery/recover.ts`:

```ts
import { BatchFailure, BatchState, type BatchId } from '@10db/contracts';
import {
  deleteCuttingBatch,
  getBatchRow,
  getProject,
  listBatches,
  patchBatch,
  transitionBatch,
} from '@10db/db';
import type { StateStore } from '../events';
import type { Git } from '../git';
import type { InboxService } from '../inbox';
import type { Logger } from '../log';
import { wrongBranchCard } from './cards';
import { raise } from './context';
import type { Shipper } from './ship';

/** Kills a recorded process (group) only while its start time still matches (recovery/processes.ts). */
export interface GateTerminator {
  terminate(target: {
    readonly pid: number;
    readonly startedAt: string;
    readonly group?: boolean;
  }): Promise<unknown>;
}

export interface BatchRecoveryReport {
  readonly deleted: BatchId[];
  readonly failed: BatchId[];
  readonly resumed: BatchId[];
}

/**
 * Batch delivery spec §5 and §6 at startup, after workstream recovery and before the scheduler: a
 * CUTTING row is deleted (a branch the crash left stays, and the next cut uses a new name); an
 * orphaned shipping gate is killed; an unfinished batch off its branch fails; a SHIPPING batch
 * re-runs from step 0; an OPEN batch whose work all settled ships.
 */
export async function recoverBatches(deps: {
  readonly state: StateStore;
  readonly git: Git;
  readonly inbox: InboxService;
  readonly processes: GateTerminator;
  readonly shipper: Shipper;
  readonly logger: Logger;
}): Promise<BatchRecoveryReport> {
  const db = deps.state.db;
  const report: BatchRecoveryReport = { deleted: [], failed: [], resumed: [] };

  for (const batch of listBatches(db, { states: [BatchState.Cutting] })) {
    deps.state.write((w) => {
      deleteCuttingBatch(w, batch.id, 'the daemon restarted while cutting the branch');
    });
    report.deleted.push(batch.id);
  }

  for (const batch of listBatches(db, { states: [BatchState.Shipping] })) {
    const row = getBatchRow(db, batch.id);
    if (row.gatePid === null || row.gatePidStart === null) continue;
    await deps.processes.terminate({ pid: row.gatePid, startedAt: row.gatePidStart, group: true });
    deps.state.write((w) => patchBatch(w, batch.id, { gatePid: null, gatePidStart: null }));
  }

  for (const batch of listBatches(db, { states: [BatchState.Open, BatchState.Shipping] })) {
    const project = getProject(db, batch.projectId);
    const current = await deps.git.currentBranch(project.repoPath).catch(() => null);
    if (current !== batch.branch) {
      const card = wrongBranchCard(batch, current, project.repoPath, 'failed');
      deps.state.write((w) =>
        transitionBatch(w, batch.id, {
          to: BatchState.Failed,
          patch: { failure: BatchFailure.WrongBranch },
          reason: card.title,
        }),
      );
      raise(deps.inbox, project.id, card);
      report.failed.push(batch.id);
      continue;
    }
    if (batch.state === BatchState.Shipping) {
      deps.shipper.resume(batch.id);
      report.resumed.push(batch.id);
    }
  }

  deps.shipper.checkOpenBatches();
  deps.logger.info({ ...report }, 'batch recovery complete');
  return report;
}
```

In `apps/daemon/src/delivery/index.ts`, add `export { recoverBatches, type GateTerminator } from './recover';`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @10db/daemon exec vitest run src/delivery src/recovery && pnpm typecheck && pnpm lint`
Expected: PASS. In every crash row the batch ends `SHIPPED`, `prCreate` was called once in total (by recovery, or by the run that crashed), and origin's branch equals the local `HEAD`.

- [ ] **Step 6: Commit**

```bash
pnpm format && git add apps/daemon/src/delivery/recover.ts apps/daemon/src/delivery/recover.test.ts apps/daemon/src/delivery/index.ts apps/daemon/test/orphan-gate.ts apps/daemon/src/recovery/recover.test.ts && git commit -m 'feat(daemon): recover batches at startup without a second push or pull request' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>' -m 'Claude-Session: https://claude.ai/code/session_01KFqjacxo6Va8EyHF93n3xr'
```

---

### Task 10: Wiring, the batch routes and the end-to-end batch

**Files:**

- Modify: `apps/daemon/src/api/services.ts`, `apps/daemon/src/api/app.ts`, `apps/daemon/src/api/app.test.ts`
- Modify: `apps/daemon/src/daemon/services.ts`, `apps/daemon/src/daemon/start.ts`, `apps/daemon/src/main.ts`
- Test: `apps/daemon/test/batch-delivery.test.ts`

**Interfaces:**

- Consumes: every delivery export (Tasks 5–9), `createGh` (Task 4), `buildNetworkEnv` and `markGhRequired` (Task 4), `listProjectViews` (Task 2), `startTaskWithPlan` (Task 5), `BatchStartInput`, `BatchDto`, `ProjectViewDto`, `TaskStartResult`, `BatchId` (Task 1).
- Produces:
  - `ApiServices`: `listProjects(): ProjectViewDto[]`; `startTask(taskId: TaskId): TaskStartResult`; `startBatch(projectId: ProjectId, input: BatchStartInput): BatchDto`; `shipBatch(id: BatchId): BatchDto`; `abandonBatch(id: BatchId): BatchDto`.
  - Routes:
    - `GET /projects` → `200 ProjectViewDto[]`
    - `POST /projects/:projectId/batches` (`BatchStartInput`) → `202 BatchDto` (the contract M2b builds on; see the header)
    - `POST /batches/:batchId/ship` → `200 BatchDto`
    - `POST /batches/:batchId/abandon` → `200 BatchDto`
    - `POST /tasks/:taskId/start` → `201 WorkstreamDto` in `local`, `202 BatchDto` in `pull_request`
  - `DaemonOptions` gains `gh?: Gh` (default `createGh()`), `networkEnv?: () => Readonly<Record<string, string>>` (default `{ PATH: '/usr/bin:/bin' }`) and `deliveryLimits?: Partial<DeliveryLimits>`. `main.ts` passes `networkEnv: () => buildNetworkEnv(login.vars)`.
  - `GET /system` marks `gh` required while some project delivers pull requests.

- [ ] **Step 1: Write the failing tests**

In `apps/daemon/src/api/app.test.ts`, add `startBatch: track('startBatch')`, `shipBatch: track('shipBatch')` and `abandonBatch: track('abandonBatch')` to `stubServices`, then add:

```ts
describe('batch routes', () => {
  const batch = {
    id: mintId('Batch'),
    projectId: mintId('Project'),
    title: 'Greetings',
    state: 'CUTTING',
    branch: null,
    baseBranch: 'main',
    baseSha: null,
    repo: null,
    prUrl: null,
    gateExitCode: null,
    gateLogPath: null,
    failure: null,
    createdAt: '2026-10-21T12:00:00.000Z',
    updatedAt: '2026-10-21T12:00:00.000Z',
  } as const;
  const post = (path: string, body?: unknown) => ({
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  it('answers 202 with the batch for a batch start, and 400 for an empty one', async () => {
    const services = stubServices({ startBatch: () => batch });
    const path = `/projects/${batch.projectId}/batches`;
    const ok = await app(services).request(
      path,
      post(path, { title: 'Greetings', taskIds: [mintId('Task')] }),
    );
    expect(ok.status).toBe(202);
    expect(await ok.json()).toEqual(batch);
    expect(
      (await app(services).request(path, post(path, { title: 'x', taskIds: [] }))).status,
    ).toBe(400);
  });

  it('answers 202 with the batch when a task starts in a pull-request project', async () => {
    const res = await app(stubServices({ startTask: () => batch })).request(
      `/tasks/${mintId('Task')}/start`,
      post(''),
    );
    expect(res.status).toBe(202);
  });

  it.each([
    { path: 'ship', service: 'shipBatch' },
    { path: 'abandon', service: 'abandonBatch' },
  ])(
    'routes $path to $service, and refuses an id that is not a batch',
    async ({ path, service }) => {
      await app().request(`/batches/${mintId('Batch')}/${path}`, post(''));
      expect(reached).toEqual([service]);
      expect((await app().request(`/batches/not-a-batch/${path}`, post(''))).status).toBe(400);
    },
  );
});
```

`apps/daemon/test/batch-delivery.test.ts`:

```ts
import { execFileSync } from 'node:child_process';
import {
  BatchDto,
  ProjectDto,
  ProjectViewDto,
  SystemCheckDto,
  TaskDto,
  WorkstreamDto,
  type SystemCheckDto as SystemCheck,
} from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { startDaemon, type RunningDaemon } from '../src/daemon';
import { FakeAdapter, type FakeScriptBook } from '../src/sessions';
import { apiClient, quickFlowId } from './api-client';
import { FakeGh } from './fake-gh';
import { createTempRepoWithOrigin, NETWORK_ENV, tempDir, waitForAsync } from './fixtures';

const write = (path: string) => ({
  do: 'tool' as const,
  toolName: 'Write',
  input: { file_path: path, content: `${path}\n` },
});
const commit = (opId: string, path: string) => ({
  do: 'mcp' as const,
  tool: 'commit',
  args: { opId, paths: [path], message: `Add ${path}` },
});
const BOOK: FakeScriptBook = {
  Alpha: [
    [
      write('src/api/alpha.txt'),
      commit('op-alpha-0001', 'src/api/alpha.txt'),
      { do: 'turn_complete' },
    ],
  ],
  Beta: [
    [write('src/ui/beta.txt'), commit('op-beta-00001', 'src/ui/beta.txt'), { do: 'turn_complete' }],
  ],
};

let data: { path: string; cleanup(): void };
let remote: ReturnType<typeof createTempRepoWithOrigin>;
let gh: FakeGh;
let daemon: RunningDaemon | null = null;
beforeEach(() => {
  data = tempDir('batch-daemon');
  remote = createTempRepoWithOrigin();
  gh = new FakeGh();
});
afterEach(async () => {
  await daemon?.stop();
  daemon = null;
  remote.cleanup();
  data.cleanup();
});

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, ...args])
    .toString()
    .trim();

async function start(systemCheck?: () => Promise<SystemCheck>) {
  daemon = await startDaemon({
    dataDir: data.path,
    port: 0,
    adapter: new FakeAdapter(BOOK),
    logLevel: 'warn',
    caffeinate: () => null,
    watch: false,
    gh,
    networkEnv: () => NETWORK_ENV,
    ...(systemCheck ? { systemCheck } : {}),
  });
  const api = apiClient(daemon.url, daemon.token);
  const project = await api.post('/projects', ProjectDto, {
    name: 'shop',
    repoPath: remote.repo.path,
    gateCommand: 'true',
    flowId: await quickFlowId(api),
    areas: [
      { name: 'api', globs: ['src/api/**'] },
      { name: 'ui', globs: ['src/ui/**'] },
    ],
    delivery: 'pull_request',
    prTitlePrefix: 'feat(app)',
  });
  const task = (title: string, area: string) =>
    api.post(`/projects/${project.id}/tasks`, TaskDto, {
      title,
      acceptanceCriteria: ['it exists'],
      areas: [area],
    });
  return { api, project, alpha: await task('Alpha', 'api'), beta: await task('Beta', 'ui') };
}

describe('batch delivery through the daemon', () => {
  it('ships a two-task batch as one pull request', async () => {
    const { api, project, alpha, beta } = await start();
    const batch = await api.post(`/projects/${project.id}/batches`, BatchDto, {
      title: 'Greetings for everyone',
      taskIds: [alpha.id, beta.id],
    });
    expect(batch.state).toBe('CUTTING');
    const shipped = await waitForAsync(async () => {
      const view = (await api.get('/projects', z.array(ProjectViewDto))).find(
        (p) => p.id === project.id,
      );
      return view?.currentBatch?.state === 'SHIPPED' ? view.currentBatch : undefined;
    }, 30_000);
    expect(shipped).toMatchObject({
      id: batch.id,
      prUrl: 'https://github.com/acme/widgets/pull/1',
    });
    expect(gh.prCreates()).toEqual([
      {
        repo: 'acme/widgets',
        base: 'main',
        head: shipped.branch,
        title: 'feat(app): greetings for everyone',
      },
    ]);
    expect(git(remote.origin.path, 'rev-parse', `refs/heads/${shipped.branch ?? ''}`)).toBe(
      git(remote.repo.path, 'rev-parse', 'HEAD'),
    );
    expect(
      git(remote.repo.path, 'log', '--format=%s', `${shipped.baseSha ?? ''}..HEAD`)
        .split('\n')
        .sort(),
    ).toEqual(['Add src/api/alpha.txt', 'Add src/ui/beta.txt']);
    expect(gh.body(shipped.prUrl ?? '')).toContain(`Shipped by 10db, batch ${shipped.id}`);
    expect(git(remote.origin.path, 'rev-parse', 'main')).toBe(shipped.baseSha);
  });

  it('answers 202 with the batch when a task starts, and gives two racing starts one batch and one branch', async () => {
    const { api, project, alpha, beta } = await start();
    const call = (id: string) =>
      fetch(`${daemon?.url ?? ''}/tasks/${id}/start`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${daemon?.token ?? ''}` },
      });
    const [a, b] = await Promise.all([call(alpha.id), call(beta.id)]);
    // The second start joins the batch (202) or meets it still CUTTING (409); it never makes a second one.
    expect([a.status, b.status]).toContain(202);
    for (const status of [a.status, b.status]) expect([202, 409]).toContain(status);
    await waitForAsync(async () => {
      const view = (await api.get('/projects', z.array(ProjectViewDto))).find(
        (p) => p.id === project.id,
      );
      return view?.currentBatch?.state === 'SHIPPED' || view?.currentBatch?.state === 'CLOSED'
        ? true
        : undefined;
    }, 30_000);
    expect(
      git(remote.repo.path, 'branch', '--list', '10db/*').split('\n').filter(Boolean),
    ).toHaveLength(1);
  });

  it('marks gh required in the system check once a project delivers pull requests', async () => {
    const check: SystemCheck = SystemCheckDto.parse({
      loginEnv: { source: 'login_shell', warning: null },
      tools: [{ name: 'gh', path: null, version: null, required: false }],
    });
    const { api } = await start(() => Promise.resolve(check));
    const system = await api.get('/system', SystemCheckDto);
    expect(system.tools.find((t) => t.name === 'gh')?.required).toBe(true);
  });

  it('still answers 201 with the workstream in a local project', async () => {
    daemon = await startDaemon({
      dataDir: data.path,
      port: 0,
      adapter: new FakeAdapter(BOOK),
      logLevel: 'warn',
      caffeinate: () => null,
      watch: false,
      gh,
    });
    const api = apiClient(daemon.url, daemon.token);
    const project = await api.post('/projects', ProjectDto, {
      name: 'local',
      repoPath: remote.repo.path,
      gateCommand: 'true',
      flowId: await quickFlowId(api),
      areas: [{ name: 'api', globs: ['src/api/**'] }],
    });
    const task = await api.post(`/projects/${project.id}/tasks`, TaskDto, {
      title: 'Alpha',
      acceptanceCriteria: ['x'],
      areas: ['api'],
    });
    expect((await api.post(`/tasks/${task.id}/start`, WorkstreamDto)).taskId).toBe(task.id);
    expect(gh.calls).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @10db/daemon exec vitest run src/api/app.test.ts test/batch-delivery.test.ts`
Expected: FAIL. The API cases get `404` (no batch routes) and `201` for the start. In the daemon cases `POST /projects/:id/batches` answers 404, a pull-request start answers 201 with a workstream that never launches, and `/system` reports `gh` as not required.

- [ ] **Step 3: Add the routes and services**

In `apps/daemon/src/api/services.ts`, import `BatchDto`, `BatchId`, `BatchStartInput`, `ProjectViewDto`, `TaskStartResult` as types and change or add:

```ts
  listProjects(): ProjectViewDto[];
  /** Local delivery: the workstream. Pull-request delivery: the batch the task runs in. */
  startTask(taskId: TaskId): TaskStartResult;
  /** Starts the tasks as a batch, or adds them to the project's open or failed batch. */
  startBatch(projectId: ProjectId, input: BatchStartInput): BatchDto;
  /** Ship anyway (from OPEN) or Retry (from FAILED). */
  shipBatch(id: BatchId): BatchDto;
  abandonBatch(id: BatchId): BatchDto;
```

In `apps/daemon/src/api/app.ts`, import `BatchId`, `BatchStartInput`, and add after the `/projects/:projectId/mcp-servers/review` route:

```ts
    .post(
      '/projects/:projectId/batches',
      validator('json', (value): BatchStartInput => BatchStartInput.parse(value)),
      (c) =>
        c.json(
          deps.services.startBatch(ProjectId.parse(c.req.param('projectId')), c.req.valid('json')),
          202,
        ),
    )
    .post('/batches/:batchId/ship', (c) =>
      c.json(deps.services.shipBatch(BatchId.parse(c.req.param('batchId')))),
    )
    .post('/batches/:batchId/abandon', (c) =>
      c.json(deps.services.abandonBatch(BatchId.parse(c.req.param('batchId')))),
    )
```

and change the start route:

```ts
    .post('/tasks/:taskId/start', (c) => {
      const started = deps.services.startTask(TaskId.parse(c.req.param('taskId')));
      // A workstream has a taskId; a batch, which a pull-request start answers with, doesn't.
      return 'taskId' in started ? c.json(started, 201) : c.json(started, 202);
    })
```

- [ ] **Step 4: Wire delivery into the daemon**

In `apps/daemon/src/daemon/start.ts`:

- Import `createBatchStarter`, `createDeliveryJobs`, `createShipper`, `DEFAULT_DELIVERY_LIMITS`, `recoverBatches`, `subscribeShipTrigger` and `type DeliveryContext`, `type DeliveryLimits`, `type BatchStarter`, `type Shipper` from `../delivery`; `createGh` and `type Gh` from `../github`.
- Add to `DaemonOptions`:

```ts
  /** The GitHub CLI wrapper; tests pass a fake. */
  readonly gh?: Gh;
  /** The login environment fetch, push and gh run in (main.ts builds it from the login shell). */
  readonly networkEnv?: () => Readonly<Record<string, string>>;
  readonly deliveryLimits?: Partial<DeliveryLimits>;
```

- After `const processes = …`, build delivery (the runner and scheduler are reached through the same late-bound references the inbox uses):

```ts
const sessionEnv = opts.sessionEnv ?? (() => ({ PATH: DEFAULT_SESSION_PATH }));
const deliveryJobs = createDeliveryJobs(logger.child({ component: 'delivery' }));
const delivery: DeliveryContext = {
  state,
  git,
  gh: opts.gh ?? createGh(),
  inbox,
  jobs: deliveryJobs,
  logger: logger.child({ component: 'delivery' }),
  limits: {
    ...DEFAULT_DELIVERY_LIMITS,
    gateTimeoutMs: limits.gateTimeoutMs,
    ...opts.deliveryLimits,
  },
  networkEnv: opts.networkEnv ?? (() => ({ PATH: DEFAULT_SESSION_PATH })),
  onWorkQueued: () => {
    scheduler?.requestTick();
  },
};
const starter = createBatchStarter(delivery);
const shipper = createShipper({
  ...delivery,
  gate: createGateRunner(),
  clock,
  dataDir: opts.dataDir,
  sessionEnv,
  identifyProcess: (pid) => processes.identify(pid),
  isRunning: (id) => runner?.isRunning(id) ?? false,
});
```

and pass `sessionEnv` (the same function) to `createRunner` instead of the inline default.

- After `await recoverOnStartup(...)` and `pauses.restore()`:

```ts
await recoverBatches({
  state,
  git,
  inbox,
  processes,
  shipper,
  logger: logger.child({ component: 'delivery' }),
});
const unsubscribeShip = subscribeShipTrigger(bus, state.db, shipper);
```

- Pass `starter` and `shipper` to `createServices`.
- In `shutdown()`, after `createdScheduler.stop()`:

```ts
unsubscribeShip();
// Aborts a shipping gate and any git or gh child; the batch stays SHIPPING for recovery.
await deliveryJobs.stop();
```

In `apps/daemon/src/daemon/services.ts`:

- Add `readonly starter: BatchStarter; readonly shipper: Shipper;` to the deps, and import `Delivery` from `@10db/contracts`, `listProjectViews` from `@10db/db`, `markGhRequired` from `../environment`, and the two types from `../delivery`.
- Change and add:

```ts
    listProjects: () => listProjectViews(db),
    startTask(taskId) {
      const project = getProject(db, getTask(db, taskId).projectId);
      const started =
        project.delivery === Delivery.PullRequest
          ? deps.starter.startTask(taskId)
          : startTaskWithPlan(deps.state, taskId);
      deps.scheduler.requestTick();
      return started;
    },
    startBatch: (projectId, input) => deps.starter.startBatch(projectId, input),
    shipBatch: (id) => deps.shipper.ship(id),
    abandonBatch: (id) => deps.shipper.abandon(id),
    systemCheck: async () =>
      markGhRequired(
        await deps.systemCheck(),
        listProjects(db).some((p) => p.delivery === Delivery.PullRequest),
      ),
```

(`getTask` joins the `@10db/db` import.)

In `apps/daemon/src/main.ts`, import `buildNetworkEnv` from `./environment` and pass to `startDaemon`:

```ts
    networkEnv: () => buildNetworkEnv(login.vars),
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @10db/daemon exec vitest run && pnpm typecheck && pnpm lint`
Expected: PASS: the new API and daemon cases, and every existing daemon suite (local projects start, run and recover as before; `start.test.ts`, `acceptance.test.ts` and `crash-recovery.test.ts` still parse `WorkstreamDto` from a local start).

- [ ] **Step 6: Commit**

```bash
pnpm format && git add apps/daemon/src/api/services.ts apps/daemon/src/api/app.ts apps/daemon/src/api/app.test.ts apps/daemon/src/daemon/services.ts apps/daemon/src/daemon/start.ts apps/daemon/src/main.ts apps/daemon/test/batch-delivery.test.ts && git commit -m 'feat(daemon): serve the batch routes and run delivery in the daemon' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>' -m 'Claude-Session: https://claude.ai/code/session_01KFqjacxo6Va8EyHF93n3xr'
```

---

### Task 11: Desktop: the delivery fields and the batch strip

**Files:**

- Modify: `apps/desktop/src/daemon/queries.ts`, `apps/desktop/src/daemon/events.ts`, `apps/desktop/src/test/fixtures.ts`
- Modify: `apps/desktop/src/views/tasks/new-project-form.tsx`, `apps/desktop/src/views/tasks/tasks-view.tsx`
- Create: `apps/desktop/src/views/tasks/batch-strip.tsx`
- Test: `apps/desktop/src/views/tasks/batch-strip.test.tsx`, `apps/desktop/src/views/tasks/tasks-view.test.tsx`

**Interfaces:**

- Consumes: Task 1's `BatchDto`, `ProjectViewDto`, `TaskStartResult`, `shipReadiness`, `isSettled`, `latestPerTask`, `Delivery`, `BatchState`, `BatchFailure`; Task 10's routes through the Hono client (`client.batches[':batchId'].ship.$post`, `.abandon.$post`).
- Produces:
  - `queries.ts`: `useProjects()` parses `ProjectViewDto[]`; `useStartTask()` parses `TaskStartResult`; `useShipBatch()` and `useAbandonBatch()` (mutations over a `BatchId`, invalidating projects, workstreams and tasks).
  - `INVALIDATIONS.batch = [queryKeys.projects, ['workstreams'], ['tasks']]`.
  - `BatchStrip({ batch, workstreams }: { readonly batch: BatchDto; readonly workstreams: readonly WorkstreamDto[] })`.
  - Fixtures: `batchDto(overrides)`, `projectViewDto(overrides)`.

- [ ] **Step 1: Add the fixtures**

In `apps/desktop/src/test/fixtures.ts` (import `BatchDto`, `ProjectViewDto`):

```ts
export function batchDto(overrides: Partial<BatchDto> = {}): BatchDto {
  return BatchDto.parse({
    id: mintId('Batch'),
    projectId: mintId('Project'),
    title: 'Greetings',
    state: 'OPEN',
    branch: '10db/greetings-0a1b2c3d',
    baseBranch: 'main',
    baseSha: 'a'.repeat(40),
    repo: 'acme/widgets',
    prUrl: null,
    gateExitCode: null,
    gateLogPath: null,
    failure: null,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  });
}

export function projectViewDto(overrides: Partial<ProjectViewDto> = {}): ProjectViewDto {
  return ProjectViewDto.parse({ ...projectDto(), currentBatch: null, ...overrides });
}
```

- [ ] **Step 2: Write the failing tests**

`apps/desktop/src/views/tasks/batch-strip.test.tsx`:

```tsx
import type { BatchDto, WorkstreamDto } from '@10db/contracts';
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithDaemon, server, baseHandlers } from '../../test/daemon';
import { batchDto, workstreamDto } from '../../test/fixtures';
import { BatchStrip } from './batch-strip';

const batch = batchDto();
const member = (taskTitle: string, state: WorkstreamDto['state']) =>
  workstreamDto({ batchId: batch.id, projectId: batch.projectId, taskTitle, state });

describe('BatchStrip', () => {
  it.each<{
    name: string;
    batch: BatchDto;
    workstreams: WorkstreamDto[];
    texts: string[];
    absent?: string[];
    buttons: string[];
    link?: string;
  }>([
    {
      name: 'cutting',
      batch: batchDto({ state: 'CUTTING', branch: null, baseSha: null }),
      workstreams: [],
      texts: ['Greetings', 'Cutting branch'],
      buttons: [],
    },
    {
      name: 'open with work running',
      batch,
      workstreams: [member('Alpha', 'RUNNING'), member('Beta', 'DONE')],
      texts: ['Open', '10db/greetings-0a1b2c3d', 'Alpha', 'Running'],
      absent: ['Beta'],
      buttons: ['Abandon'],
    },
    {
      name: 'open with a failed workstream',
      batch,
      workstreams: [member('Alpha', 'FAILED'), member('Beta', 'DONE')],
      texts: ['Alpha', 'Failed'],
      buttons: ['Ship anyway', 'Abandon'],
    },
    {
      name: 'shipping',
      batch: batchDto({ state: 'SHIPPING' }),
      workstreams: [],
      texts: ['Shipping'],
      buttons: [],
    },
    {
      name: 'shipped',
      batch: batchDto({ state: 'SHIPPED', prUrl: 'https://github.com/acme/widgets/pull/7' }),
      workstreams: [],
      texts: ['Shipped'],
      buttons: [],
      link: 'https://github.com/acme/widgets/pull/7',
    },
    {
      name: 'closed',
      batch: batchDto({ state: 'CLOSED' }),
      workstreams: [],
      texts: ['Closed: no changes'],
      buttons: [],
    },
    {
      name: 'failed',
      batch: batchDto({ state: 'FAILED', failure: 'gate_failed' }),
      workstreams: [member('Alpha', 'DONE')],
      texts: ['Not shipped', 'The gate failed'],
      buttons: ['Retry', 'Abandon'],
    },
    {
      name: 'abandoned',
      batch: batchDto({ state: 'ABANDONED' }),
      workstreams: [],
      texts: ['Abandoned'],
      buttons: [],
    },
  ])('$name', async ({ batch: b, workstreams, texts, absent = [], buttons, link }) => {
    server.use(...baseHandlers());
    renderWithDaemon(<BatchStrip batch={b} workstreams={workstreams} />);
    for (const text of texts) expect(await screen.findByText(text)).toBeTruthy();
    for (const text of absent) expect(screen.queryByText(text)).toBeNull();
    expect(screen.queryAllByRole('button').map((x) => x.textContent)).toEqual(buttons);
    if (link)
      expect(screen.getByRole('link', { name: 'Pull request' }).getAttribute('href')).toBe(link);
  });
});
```

In `apps/desktop/src/views/tasks/tasks-view.test.tsx`:

- The first test's expected body gains `delivery: 'local'` (the form now always sends the delivery).
- Add:

```tsx
it('creates a pull-request project with its base branch and title prefix, and requires the prefix', async () => {
  const posted: unknown[] = [];
  serve(
    http.post(daemonUrl('/projects'), async ({ request }) => {
      posted.push(await request.json());
      return HttpResponse.json(projectDto(), { status: 201 });
    }),
  );
  renderApp('/tasks');
  fireEvent.click(await screen.findByRole('button', { name: 'New project' }));
  const dialog = await screen.findByRole('dialog', { name: 'New project' });
  type('Name', 'shop', dialog);
  type('Repository path', '/repos/shop', dialog);
  type('Gate command', 'make gate', dialog);
  type('Areas', 'api: src/api/**', dialog);
  fireEvent.click(within(dialog).getByRole('radio', { name: 'One pull request per batch' }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Create project' }));
  expect(await within(dialog).findByText('Enter a PR title prefix such as feat(app)')).toBeTruthy();
  expect(posted).toEqual([]);
  type('PR title prefix', 'feat(app)', dialog);
  type('Base branch', 'develop', dialog);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Create project' }));
  await waitFor(() => {
    expect(posted).toHaveLength(1);
  });
  expect(posted[0]).toMatchObject({
    delivery: 'pull_request',
    baseBranch: 'develop',
    prTitlePrefix: 'feat(app)',
  });
});

it("shows the project's batch and retries a failed one", async () => {
  const batch = batchDto({ state: 'FAILED', failure: 'push_rejected' });
  const project = projectViewDto({
    id: batch.projectId,
    delivery: 'pull_request',
    prTitlePrefix: 'feat(app)',
    currentBatch: batch,
  });
  const shipped: string[] = [];
  serve(
    http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
    http.get(daemonUrl('/projects/:projectId/tasks'), () => HttpResponse.json([])),
    http.post(daemonUrl('/batches/:batchId/ship'), ({ params }) => {
      shipped.push(String(params['batchId']));
      return HttpResponse.json({ ...batch, state: 'SHIPPING', failure: null });
    }),
  );
  renderApp('/tasks');
  expect(await screen.findByText('git push was rejected')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => {
    expect(shipped).toEqual([batch.id]);
  });
});
```

(import `batchDto`, `projectViewDto` from the fixtures.)

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @10db/desktop exec vitest run src/views/tasks`
Expected: FAIL. `batch-strip.test.tsx` can't load `./batch-strip`; the project-form test can't find the `One pull request per batch` radio; the first form test's posted body lacks `delivery`; the strip test finds no `git push was rejected` text.

- [ ] **Step 4: Update the queries and the invalidations**

In `apps/desktop/src/daemon/queries.ts`:

- Replace `ProjectDto` with `ProjectViewDto` in `ProjectList` (`z.array(ProjectViewDto)`) and parse the start with `TaskStartResult`:

```ts
export function useStartTask() {
  // ...unchanged, except:
    mutationFn: async (taskId: TaskId) =>
      readJson(await client.tasks[':taskId'].start.$post({ param: { taskId } }), TaskStartResult),
  // onSuccess also invalidates queryKeys.projects (a pull-request start changes the batch).
}
```

- Add:

```ts
export function useShipBatch() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (batchId: BatchId) =>
      readJson(await client.batches[':batchId'].ship.$post({ param: { batchId } }), BatchDto),
    onSuccess: () => invalidateBatchViews(queryClient),
  });
}

export function useAbandonBatch() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (batchId: BatchId) =>
      readJson(await client.batches[':batchId'].abandon.$post({ param: { batchId } }), BatchDto),
    onSuccess: () => invalidateBatchViews(queryClient),
  });
}

/** A batch action changes the project's strip, its workstreams and its tasks' columns. */
function invalidateBatchViews(queryClient: QueryClient): Promise<unknown> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.projects }),
    queryClient.invalidateQueries({ queryKey: ['workstreams'] }),
    queryClient.invalidateQueries({ queryKey: ['tasks'] }),
  ]);
}
```

(imports: `BatchDto`, `ProjectViewDto`, `TaskStartResult`, `type BatchId` from `@10db/contracts`; `type QueryClient` from `@tanstack/react-query`.)

In `apps/desktop/src/daemon/events.ts`, add to `INVALIDATIONS`:

```ts
  // A batch's state shows on the project's strip; cancelling an abandoned batch's work moves tasks.
  batch: [queryKeys.projects, ...WORK],
```

- [ ] **Step 5: Write the batch strip**

`apps/desktop/src/views/tasks/batch-strip.tsx`:

```tsx
import {
  BatchFailure,
  BatchState,
  isSettled,
  latestPerTask,
  shipReadiness,
  ShipReadiness,
  type BatchDto,
  type WorkstreamDto,
} from '@10db/contracts';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Code,
  Group,
  Paper,
  Stack,
  Text,
  type MantineColor,
} from '@mantine/core';
import { useAbandonBatch, useShipBatch } from '../../daemon/queries';
import { StateBadge } from '../factory/state-badge';

const B = BatchState;

/** DESIGN.md status colors: blue in progress, red failed, green shipped, gray idle or over. */
const BATCH_COLORS: Readonly<Record<BatchState, MantineColor>> = {
  [B.Cutting]: 'blue',
  [B.Open]: 'blue',
  [B.Shipping]: 'blue',
  [B.Shipped]: 'green',
  [B.Closed]: 'gray',
  [B.Failed]: 'red',
  [B.Abandoned]: 'gray',
};

const BATCH_LABELS: Readonly<Record<BatchState, string>> = {
  [B.Cutting]: 'Cutting branch',
  [B.Open]: 'Open',
  [B.Shipping]: 'Shipping',
  [B.Shipped]: 'Shipped',
  [B.Closed]: 'Closed: no changes',
  [B.Failed]: 'Not shipped',
  [B.Abandoned]: 'Abandoned',
};

const FAILURE_LABELS: Readonly<Record<BatchFailure, string>> = {
  [BatchFailure.WrongBranch]: 'The checkout is not on the batch branch',
  [BatchFailure.DirtyCheckout]: 'The checkout has uncommitted changes',
  [BatchFailure.GateFailed]: 'The gate failed',
  [BatchFailure.GateTimedOut]: 'The gate timed out',
  [BatchFailure.PushRejected]: 'git push was rejected',
  [BatchFailure.GhUnavailable]: 'gh is missing or signed out',
  [BatchFailure.Network]: 'A network step failed',
};

/** The project's current batch: what it is, what holds it, and what the builder can do (batch delivery spec §8). */
export function BatchStrip({
  batch,
  workstreams,
}: {
  readonly batch: BatchDto;
  readonly workstreams: readonly WorkstreamDto[];
}) {
  const ship = useShipBatch();
  const abandon = useAbandonBatch();
  const members = latestPerTask(workstreams.filter((w) => w.batchId === batch.id));
  const blocking = members.filter((w) => !isSettled(w.state));
  const readiness = shipReadiness(members.map((w) => w.state));
  const canShipAnyway = batch.state === B.Open && readiness === ShipReadiness.ShipAnyway;
  const canAbandon = batch.state === B.Open || batch.state === B.Failed;
  const error = ship.error ?? abandon.error;

  return (
    <Paper withBorder p="sm">
      <Stack gap="xs">
        <Group gap="sm" wrap="wrap">
          <Text fw={600}>{batch.title}</Text>
          <Badge color={BATCH_COLORS[batch.state]} variant="light" size="sm">
            {BATCH_LABELS[batch.state]}
          </Badge>
          {batch.branch ? <Code>{batch.branch}</Code> : null}
          {batch.prUrl ? (
            <Anchor href={batch.prUrl} target="_blank" rel="noreferrer" size="sm">
              Pull request
            </Anchor>
          ) : null}
        </Group>
        {batch.failure ? (
          <Text size="sm" c="red">
            {FAILURE_LABELS[batch.failure]}
          </Text>
        ) : null}
        {blocking.length > 0 ? (
          <Stack gap={4}>
            {blocking.map((w) => (
              <Group key={w.id} gap="xs">
                <Text size="sm">{w.taskTitle}</Text>
                <StateBadge state={w.state} />
              </Group>
            ))}
          </Stack>
        ) : null}
        {error ? (
          <Alert color="red" variant="light">
            {error.message}
          </Alert>
        ) : null}
        {batch.state === B.Failed || canShipAnyway || canAbandon ? (
          <Group gap="xs">
            {batch.state === B.Failed ? (
              <Button
                size="xs"
                loading={ship.isPending}
                onClick={() => {
                  ship.mutate(batch.id);
                }}
              >
                Retry
              </Button>
            ) : null}
            {canShipAnyway ? (
              <Button
                size="xs"
                variant="light"
                loading={ship.isPending}
                onClick={() => {
                  ship.mutate(batch.id);
                }}
              >
                Ship anyway
              </Button>
            ) : null}
            {canAbandon ? (
              <Button
                size="xs"
                variant="default"
                color="red"
                loading={abandon.isPending}
                onClick={() => {
                  abandon.mutate(batch.id);
                }}
              >
                Abandon
              </Button>
            ) : null}
          </Group>
        ) : null}
      </Stack>
    </Paper>
  );
}
```

The failure label also appears as the strip's text for the `push_rejected` case, which the Tasks view test reads.

In `apps/desktop/src/views/tasks/tasks-view.tsx`, under the project's path line:

```tsx
{
  project?.currentBatch ? (
    <BatchStrip batch={project.currentBatch} workstreams={workstreams.data ?? []} />
  ) : null;
}
```

- [ ] **Step 6: Add the delivery fields to the project form**

In `apps/desktop/src/views/tasks/new-project-form.tsx` (import `Delivery`, `PrTitlePrefix`, `BranchName` from `@10db/contracts`, and `Radio`, `Group` from Mantine):

```tsx
const [delivery, setDelivery] = useState<Delivery>(Delivery.Local);
const [baseBranch, setBaseBranch] = useState('main');
const [prTitlePrefix, setPrTitlePrefix] = useState('');
```

In `submit`, before `create.mutate`:

```tsx
const pullRequests = delivery === Delivery.PullRequest;
if (pullRequests && !PrTitlePrefix.safeParse(prTitlePrefix.trim()).success) {
  setFormError('Enter a PR title prefix such as feat(app)');
  return;
}
if (pullRequests && !BranchName.safeParse(baseBranch.trim()).success) {
  setFormError('Enter the base branch, such as main');
  return;
}
```

and add to the mutate input:

```tsx
        delivery,
        ...(pullRequests ? { baseBranch: baseBranch.trim(), prTitlePrefix: prTitlePrefix.trim() } : {}),
```

After the Billing select:

```tsx
<Radio.Group
  label="Delivery"
  value={delivery}
  onChange={(value) => {
    setDelivery(value === Delivery.PullRequest ? Delivery.PullRequest : Delivery.Local);
  }}
>
  <Group mt="xs">
    <Radio value={Delivery.Local} label="Commits on the checked-out branch" />
    <Radio value={Delivery.PullRequest} label="One pull request per batch" />
  </Group>
</Radio.Group>;
{
  delivery === Delivery.PullRequest ? (
    <>
      <TextInput
        label="Base branch"
        description="The branch on origin each batch starts from and targets"
        ff="monospace"
        value={baseBranch}
        onChange={(e) => {
          setBaseBranch(e.currentTarget.value);
        }}
      />
      <TextInput
        label="PR title prefix"
        description="A Conventional Commit type and scope; titles read feat(app): <batch title>"
        placeholder="feat(app)"
        ff="monospace"
        value={prTitlePrefix}
        onChange={(e) => {
          setPrTitlePrefix(e.currentTarget.value);
        }}
      />
    </>
  ) : null;
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm --filter @10db/desktop exec vitest run && pnpm typecheck && pnpm lint`
Expected: PASS, every desktop test, the strip table included. Check the strip by hand in both color schemes with `pnpm dev` (`DESIGN.md`: every view works in light mode too).

- [ ] **Step 8: Commit**

```bash
pnpm format && git add apps/desktop/src/daemon/queries.ts apps/desktop/src/daemon/events.ts apps/desktop/src/test/fixtures.ts apps/desktop/src/views/tasks/new-project-form.tsx apps/desktop/src/views/tasks/tasks-view.tsx apps/desktop/src/views/tasks/batch-strip.tsx apps/desktop/src/views/tasks/batch-strip.test.tsx apps/desktop/src/views/tasks/tasks-view.test.tsx && git commit -m 'feat(desktop): add delivery to the project form and a batch strip to the tasks view' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>' -m 'Claude-Session: https://claude.ai/code/session_01KFqjacxo6Va8EyHF93n3xr'
```

---

### Task 12: Architecture section, decisions, open items, README and the gate

**Files:**

- Create: `docs/architecture/02-batch-delivery.md`
- Modify: `docs/architecture/decisions.md`, `docs/open-items.md`, `README.md`, `apps/daemon/AGENTS.md`

- [ ] **Step 1: Write the architecture section**

`docs/architecture/02-batch-delivery.md` (`tests/repo/src/architecture-docs.test.ts` checks the three header lines):

```markdown
# 02 Batch delivery

- **Status:** Locked
- **Scope:** How finished work leaves the machine: `local` delivery, and `pull_request` delivery with one branch and one pull request per batch.
- **Summary:** The design is `docs/superpowers/specs/2026-10-21-10db-batch-delivery-design.md`; its decisions and the plan's are rows <first>–<last> of `decisions.md`. Changes are new rows that name what they supersede.

## Where it lives

| Module                                         | Job                                                                                                                                    |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/db` `batches`                        | one row per batch; a partial unique index allows one unfinished batch (`CUTTING`, `OPEN`, `SHIPPING`, `FAILED`) per project            |
| `apps/daemon/src/delivery/`                    | starting (cut, join, dependency checks), shipping, the ship trigger, Ship anyway, Retry, Abandon, the launch rule and startup recovery |
| `apps/daemon/src/git/`                         | `currentBranch`, `remoteUrl`, `fetch`, `switchNewBranch`, `push`                                                                       |
| `apps/daemon/src/github/`                      | the `Gh` interface over the `gh` CLI                                                                                                   |
| `apps/daemon/src/guard/`                       | agents never push in `pull_request` projects, and never mutate PRs or the repository through `gh`                                      |
| `apps/desktop/src/views/tasks/batch-strip.tsx` | the batch strip                                                                                                                        |

## Lifecycle

CUTTING → OPEN → SHIPPING → SHIPPED | CLOSED | FAILED; FAILED → SHIPPING | OPEN | ABANDONED; OPEN → ABANDONED. A refused or interrupted cut deletes its CUTTING row.

## Invariants

- The batch row exists before any git side effect; the branch is checked before every launch and every ship.
- The daemon switches branches only when no lane runs in the project; agents never do.
- Shipping steps (branch and clean check, commit count, gate, push, find-or-create PR, record) are each safe to repeat; recovery re-runs them from the first.
- Every network call runs in the login environment with prompts off, a timeout and an abort signal.
- Every refusal is an inbox card that says what to fix, and nothing is pushed.
```

Replace `<first>` and `<last>` with the row numbers Step 2 assigns.

- [ ] **Step 2: Record the decisions**

Append rows B1 to B9 from this plan's "New decisions" table to the decision log in `docs/architecture/decisions.md`, as consecutive rows numbered from the next free number at merge (69 if nothing else has merged since this plan; check `main` when merging and renumber if another PR took it). The test in `tests/repo/src/architecture-docs.test.ts` checks the numbers run without gaps. Use the label's text verbatim, with the numbers in place of `B1`…`B9`, and write the same numbers into Step 1's Summary.

- [ ] **Step 3: Update the open items**

In `docs/open-items.md`, add:

- `- [ ] Batch delivery: worktrees and one PR per task (`workspace_mode = worktree`), the spec's expected fast-follow (batch delivery spec §9).`
- `- [ ] Batch delivery: an after-ship action per batch or task (`auto_merge`with`gh pr merge --auto --squash`, or a project deploy command), spec §9.`
- `- [ ] Batch delivery: stacked batches, rebasing or updating an unmerged PR, and hosts other than GitHub (spec §9).`
- `- [ ] Batch delivery: flag cards carry text only; give the failed-workstream and failed-batch cards answerable Retry and Ship anyway actions (spec §4 assumed the flag card offers them; plan 08 put them on the batch strip).`
- `- [ ] Batch delivery: agents' gh api is GET only, so read-only GraphQL queries (always POST) are denied too; allow them if a persona needs them.`
- `- [ ] Batch delivery: the manual acceptance on a throwaway GitHub repository (plan 08 Task 13).`

- [ ] **Step 4: Document pull-request delivery in the README**

In `README.md`, after "## Develop" and before "## Model data from Artificial Analysis", add:

```markdown
## Deliver through pull requests

A project delivers `local` by default: sessions commit on whatever branch the checkout has. Choose
**One pull request per batch** in the project form (or `PATCH /projects/:id` with
`{ "delivery": "pull_request", "prTitlePrefix": "feat(app)" }`) and 10db instead:

1. cuts `10db/<title>-<id>` from `origin/<base branch>` (default `main`) when you start a task or a set of
   tasks, provided the checkout is clean, no task runs in the project, `origin` exists and
   [`gh`](https://cli.github.com) is installed and signed in (`gh auth login`);
2. runs the batch's tasks on that branch, and adds tasks you start while it is open;
3. when every task is done or cancelled, runs the gate on the clean branch, pushes it and opens one pull
   request titled `<prefix>: <batch title>`. Merging stays with you.

Every refusal (a dirty checkout, the wrong branch, no `origin`, `gh` missing or signed out, a failed gate, a
rejected push) is an inbox card that says what to fix; nothing is pushed. The Tasks view's batch strip shows the
batch and offers Retry, Ship anyway (when a task failed) and Abandon. 10db never force-pushes, and agents can't
push, merge or open pull requests themselves.
```

- [ ] **Step 5: Check the daemon's AGENTS.md**

`apps/daemon/AGENTS.md` names `github` and `delivery` in the module order and has the `github/`/`git/` bullet from Task 4. Add one bullet:

```
- `delivery/` owns batches: a start answers at once and cuts or joins in a background job (`jobs.ts`, one at a time per project); git and gh refusals are flag cards (`cards.ts`). `recoverBatches` runs at startup after `recoverOnStartup`; `subscribeShipTrigger` follows `workstream.changed`. The scheduler imports only `batchLaunchVerdict`.
```

- [ ] **Step 6: Run the gate**

Run: `make gate`
Expected: the last line is `GATE PASS format lint typecheck test build e2e drift knip rust (…)`.

- A `knip` failure names an export nothing imports: remove it from its `index.ts`, or use it.
- A `drift` failure names a generated file: regenerate it and add it to the commit that owns its source.

- [ ] **Step 7: Commit and open the PR**

```bash
pnpm format && git add docs/architecture/02-batch-delivery.md docs/architecture/decisions.md docs/open-items.md README.md apps/daemon/AGENTS.md && git commit -m 'docs(docs): record batch delivery decisions, its architecture section and readme usage' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>' -m 'Claude-Session: https://claude.ai/code/session_01KFqjacxo6Va8EyHF93n3xr'
```

Push the branch and open a PR to `main` titled `feat(daemon): deliver batches as one branch and one pull request`. Its body lists what the plan builds, the `GATE PASS` line, the decisions recorded, and that Task 13's acceptance follows on a throwaway repository; it ends with the attribution lines the session asks for.

---

### Task 13: [Travis] Manual acceptance on a throwaway GitHub repository

Run by Travis, after Task 12's PR is green and before it merges. The automated suites cover git against a local bare `origin` and `gh` through `FakeGh`; this run is the one place real GitHub and the real `gh` are exercised. It uses real Claude Code sessions on two tiny tasks (a few cents of subscription use).

**Files:**

- Modify (at the end): `docs/open-items.md` (tick the acceptance item)

- [ ] **Step 1: Make the throwaway repository**

```bash
gh auth status --active
gh repo create "$(gh api user -q .login)/10db-batch-acceptance" --private --clone --add-readme
cd 10db-batch-acceptance
mkdir -p greetings
printf '#!/bin/sh\n# Every greeting file is non-empty.\nfor f in greetings/*.txt; do [ -e "$f" ] || exit 0; [ -s "$f" ] || exit 1; done\n' > gate.sh
chmod +x gate.sh
git add gate.sh && git commit -m 'chore: add the gate' && git push origin main
```

Expected: `gh auth status` prints a logged-in account; the repository exists on GitHub with `README.md` and `gate.sh` on `main`.

- [ ] **Step 2: Run 10db against it**

In the 10db checkout on the merged-candidate branch: `rm -rf .dev/data && pnpm dev` (the baseline changed in Task 2), and open the UI it prints.

In the Tasks view:

1. **New project**: name `acceptance`, the path of the throwaway clone, gate `./gate.sh`, areas `greetings: greetings/**`, Delivery **One pull request per batch**, base branch `main`, PR title prefix `feat(greetings)`.
2. Two tasks, each with area `greetings`:
   - `Add hello`: "Create greetings/hello.txt containing the word hello." Criterion: "greetings/hello.txt exists and says hello".
   - `Add goodbye`: "Create greetings/goodbye.txt containing the word goodbye." Criterion: "greetings/goodbye.txt exists and says goodbye".
3. Press **Start** on `Add hello`, wait for the batch strip to show **Open** with branch `10db/add-hello-…`, then press **Start** on `Add goodbye` while it is still open (it joins).

Expected: the strip goes **Open** → **Shipping** → **Shipped** and shows a **Pull request** link; the inbox has no delivery cards.

- [ ] **Step 3: Check the pull request**

```bash
branch=$(git -C 10db-batch-acceptance branch --show-current)
gh pr list -R "$(gh api user -q .login)/10db-batch-acceptance" --head "$branch" --state all --json number,title,state
gh pr view "$branch" -R "$(gh api user -q .login)/10db-batch-acceptance" --json title,body,commits,baseRefName -q '{title, base: .baseRefName, commits: [.commits[].messageHeadline], body}'
git -C 10db-batch-acceptance log --oneline origin/main -1
```

Expected:

- exactly one PR for the branch, `OPEN`, titled `feat(greetings): add hello`;
- base `main`, two commits (one per task), each made through 10db's commit tool;
- a body listing `Add hello: done` and `Add goodbye: done`, the gate `./gate.sh` with exit 0, and the footer `Shipped by 10db, batch bat_…`;
- `origin/main` still at the gate commit: nothing merged.

- [ ] **Step 4: Check one refusal**

With the batch shipped, create `greetings/scratch.txt` in the throwaway clone without committing, add a third task and press **Start**.

Expected: a card "Batch not started: the checkout has uncommitted changes" listing `greetings/scratch.txt`; no new batch on the strip; `git branch` shows no new `10db/` branch. Delete the file.

- [ ] **Step 5: Clean up and record the result**

Close the PR (`gh pr close <number> -R …`), then `gh repo delete "$(gh api user -q .login)/10db-batch-acceptance" --yes` (it needs the `delete_repo` scope: `gh auth refresh -s delete_repo`).

In `docs/open-items.md`, tick "Batch delivery: the manual acceptance on a throwaway GitHub repository (plan 08 Task 13)" and append the date and the PR's number, then:

```bash
git add docs/open-items.md && git commit -m 'docs(docs): record the batch delivery acceptance' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>' -m 'Claude-Session: https://claude.ai/code/session_01KFqjacxo6Va8EyHF93n3xr'
```

---

## Self-review notes

- **Spec coverage:**
  - §1 success 1 (fresh branch from the up-to-date base, never on another branch): Tasks 3, 5, 7. Success 2 (gate on the clean branch, push, one PR with a valid title): Task 6. Success 3 (crash at any point): Tasks 5 (shutdown mid-cut leaves CUTTING), 9. Success 4 (every refusal a card, nothing pushed): Tasks 5 and 6 refusal tables.
  - §2 decisions: B1–B9 and Tasks 2, 5, 6, 8.
  - §3 data: Tasks 1 and 2 (columns, defaults, `batches`, the partial unique index, `workstreams.batch_id`, baseline regenerated).
  - §4 lifecycle: transitions (Task 1), ship trigger and startup check (Tasks 6 and 9), failed and waiting workstreams (Task 6), CLOSED, SHIPPED, FAILED (Task 6), ABANDONED (Task 6), workstream retry (Task 7).
  - §5 starting: routes (Tasks 5 and 10), dependencies including unmerged PRs (Task 5), cutting steps 1–4 (Task 5), joining and reopening (Task 5), scheduler rule and startup wrong branch (Tasks 7 and 9).
  - §6 shipping: steps 0–5, PR body, network environment and timeouts, `Gh` states, system check, shutdown and recovery (Tasks 3, 4, 6, 9, 10).
  - §7 components: every row has a task (`git` 3, `github` 4, `guard` 8, `scheduler` 7, `team` 5 and 7, `environment` 4, contracts 1, db 2, desktop 11, delivery 5, 6, 7, 9).
  - §8 API and UI: Tasks 10 and 11. §9: open items (Task 12). §10 testing: every listed table, the concurrency case, the shipping, recovery and workstream cases, local delivery unchanged and the strip render table.
- **Types used across tasks:**
  - `BatchDto`, `BatchStartInput`, `ProjectViewDto`, `TaskStartResult`, `shipReadiness`, `latestPerTask`, `isSettled`, `BranchName`, `PrTitlePrefix`: Task 1; used in 2, 5, 6, 7, 10, 11.
  - `insertBatch`, `getBatch`, `getBatchRow`, `findUnfinishedBatch`, `currentBatch`, `listBatches`, `transitionBatch`, `patchBatch`, `deleteCuttingBatch`, `latestDoneWorkstream`, `listProjectViews`, `insertWorkstream({ batchId })`: Task 2; used in 5, 6, 7, 9, 10.
  - `NetworkCall`, `GitNetworkError`, `Git.currentBranch/remoteUrl/fetch/switchNewBranch/push`: Task 3; used in 5, 6, 7, 9.
  - `Gh`, `GhCall`, `GhError`, `PrState`, `FakeGh`, `buildNetworkEnv`, `markGhRequired`: Task 4; used in 5, 6, 9, 10.
  - `DeliveryContext`, `DeliveryJobs`, `raise(inbox, …)`, `wrongBranchCard(batch, current, repoPath, outcome)`, `planForStart`, `insertPlannedWorkstream`, the harness: Task 5; extended in 6, used in 7, 9, 10.
  - `Shipper` (`checkBatch`, `checkOpenBatches`, `resume`, `ship`, `abandon`), `subscribeShipTrigger`: Task 6; used in 9 and 10.
  - `batchLaunchVerdict`, `flagWrongBranch`, async `Scheduler.tick`: Task 7; used in 9 and 10.
  - `recoverBatches`, `GateTerminator`: Task 9; used in 10.
