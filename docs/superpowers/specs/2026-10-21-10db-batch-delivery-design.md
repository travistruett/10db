# 10db batch delivery: one branch and one pull request per batch

**Status:** design approved in conversation on 2026-10-21 and revised after plan review; this document awaits
review.
**Extends:** `2026-10-13-10db-factory-loop-design.md` (§4 `projects` and `workstreams`, §5 lifecycle, §8 guard).
**Builds on:** M2a (plan 06). It runs alongside the M2b board plan, which builds batch approval on the batch
entity and API defined here.

## 1. Intent

Today a managed session commits onto whatever branch the shared checkout has checked out. Sessions may not
create or switch branches, and nothing pushes or opens a pull request. Using 10db on a real repo means preparing
a branch and opening the PR by hand.

**What the builder said:**
- Get the work done and delivered now; single-scoped PRs don't matter during development.
- One pull request per batch.
- 10db pushes and opens the PR automatically when the batch is done. Merging stays with the builder.
- Worktrees, which bring one PR per task, are the expected fast-follow.
- Later, starting a batch or task could choose to auto-merge or deploy, which suits bug fixes.

**Success means:**
1. On a project in `pull_request` delivery, starting tasks puts their commits on a fresh branch cut from the
   up-to-date base branch, without anyone running git by hand. No workstream ever runs while the checkout is on
   any other branch.
2. When every workstream in the batch is done or cancelled, 10db runs the gate on the clean branch, pushes it
   and opens one PR whose title passes the project's commit-message rules.
3. A daemon killed at any point while cutting or shipping recovers without commits on the wrong branch, a
   push of different content, or a second PR.
4. Every refusal (dirty checkout, wrong branch, no `origin`, `gh` missing or signed out, gate failed or timed
   out, push rejected) is an inbox card that says what to fix, and nothing is pushed.

## 2. Decisions

| Decision | Why |
|---|---|
| The delivery unit is the batch. One unfinished batch per project. | The shared checkout holds one branch at a time (factory spec decision 13), so parallel tasks share it. |
| The daemon creates and switches branches; agents still can't. | Switching branches under running sessions moves their files. The daemon switches only when no lane runs in the project. |
| The daemon pushes and opens the PR. Agents may not push in `pull_request` projects, and may not create, merge, close or edit PRs in any project. | One deterministic shipper, a PR body built from records, and merging stays with the builder. |
| A failed workstream holds its batch open. Shipping with a failed task in it is an explicit "Ship anyway". | Factory spec §5.4 sends failed work back for a retry; auto-shipping partial work would race that retry. |
| The batch row is written before any git side effect, and the branch is verified before every launch and every ship. | The pattern the runner and recovery already use for workstreams: a crash leaves a row that says what to finish. |
| A project chooses `local` or `pull_request` delivery. | `local` keeps today's behavior for disposable repos and the M1 acceptance run, which have no remote. |
| `gh` is the only host integration. | The builder's repos are on GitHub and `gh` is already signed in. Other hosts aren't needed yet. |

## 3. Data

**`projects` gains** (database defaults in the migration, so code that opens the database directly still
works):

| Column | Values | Default |
|---|---|---|
| `delivery` | `local` · `pull_request` | `local` |
| `base_branch` | a branch on `origin` | `main` |
| `pr_title_prefix` | a Conventional Commit type and scope, e.g. `feat(daemon)` | none; required when `delivery` is `pull_request` |

**New `batches` table:** `id` (branded `BatchId`, UUIDv7), `project_id`, `title`, `state`, `branch`
(nullable until cut), `base_branch`, `base_sha` (nullable until cut), `repo` (the GitHub `owner/name` from
`gh repo view`, recorded at cut), `pr_url`, `gate_exit_code`, `gate_log_path`, `gate_pid`, `gate_pid_start`,
`failure` (all nullable), `created_at`, `updated_at`. A partial unique index allows one batch per project in an
unfinished state (`CUTTING`, `OPEN`, `SHIPPING`, `FAILED`).

**`workstreams` gains** `batch_id` (nullable). The workstream is what runs on a branch, and a task started again
later gets a new workstream in a new batch.

Until the first published release the migration baseline is regenerated, not extended
(`packages/db/AGENTS.md`).

## 4. Batch lifecycle

```
CUTTING → OPEN → SHIPPING → SHIPPED
   ↓        ↓        ↓    ↘ CLOSED
(deleted)   ↓      FAILED → SHIPPING (retry) | OPEN (fix task or workstream retry) | ABANDONED
            → ABANDONED
```

- **CUTTING.** The row exists, the branch does not yet. If the start checks fail, or the daemon restarts and
  finds a `CUTTING` row, the row is deleted and nothing else references it. A local branch left by a crash
  after `git switch` is left alone; the next cut uses a new name.
- **OPEN.** The branch is checked out and its workstreams run.
- **Ship trigger.** A handler on the event bus (like `keep-awake/` and `watcher/`) reacts to `workstream.*`
  events. When a workstream in a batch reaches `DONE` or `CANCELLED`, it re-reads the batch and, in one
  `state.write`, moves an `OPEN` batch whose workstreams are all `DONE` or `CANCELLED` to `SHIPPING`. Startup
  runs the same check, so a missed event is caught. A workstream with no batch returns early.
- **Failed workstreams hold the batch open.** Their existing flag card offers Retry and, for the batch,
  **Ship anyway**. Ship anyway (`POST /batches/:id/ship` from `OPEN`) is allowed when every workstream in the
  batch is `DONE`, `CANCELLED` or `FAILED`.
- **Waiting workstreams hold the batch open.** `WAITING_HUMAN` and `PAUSED_LIMIT` keep it `OPEN`; the lane is
  already freed after `human_wait_minutes`, so nothing is spent. The batch strip lists what blocks shipping.
- **CLOSED.** The batch had no commits beyond `base_sha`. Nothing is pushed.
- **SHIPPED.** The PR exists and `pr_url` is set. The checkout stays on the branch until the next batch cuts.
- **FAILED.** Shipping stopped: the checkout was dirty or on the wrong branch, the gate failed or timed out, or a
  network step failed. `failure` says which, and a flag card carries the detail. From here the builder retries
  shipping, starts a fix task or retries a workstream in the batch (both reopen it), or abandons it.
- **ABANDONED.** Refused while any lane in the batch runs. Otherwise, in one transaction, every workstream in
  the batch that is not `DONE`, `CANCELLED` or `FAILED` is cancelled and its claims released. The branch stays
  local for the builder. Tasks that finished in it stay done on the board, and the card says their code is
  unmerged.
- **Workstream retry** (`retryWorkstream`) is refused unless its batch is `OPEN` or `FAILED`; from `FAILED` it
  reopens the batch.

## 5. Starting work

**Routes.** `POST /projects/:id/batches` with `{ title, taskIds }` starts a batch; the M2b board's batch
approval calls it. `POST /tasks/:id/start` in a `pull_request` project starts a batch of one, titled after the
task, when the project has no unfinished batch, and joins the `OPEN` batch when there is one. Starting while
the batch is `CUTTING` or `SHIPPING` is refused. Starting in a `FAILED` batch is a fix task and reopens it.

**Dependencies.** A start is refused, with a card naming them, when a task has unfinished dependencies outside
the set being started (or, when joining, outside the batch). It is also refused when a dependency finished in a
batch whose PR is not merged (`gh pr view --json state`), because its code is not on `origin/<base_branch>`.

**Cutting a branch** happens only when a new batch starts:
1. In one transaction, insert the batch as `CUTTING`. The unique index refuses a second concurrent start.
2. Check, in order, each failure deleting the row and raising a card:
   1. No lane runs in the project.
   2. The checkout is clean (`git status --porcelain` is empty).
   3. `origin` exists and `git fetch origin <base_branch>` succeeds.
   4. `gh` is installed, `gh auth status` succeeds, and `gh repo view --json nameWithOwner` names the repo.
3. `git switch -c 10db/<slug>-<last 8 hex of the batch id> origin/<base_branch>`.
4. In one transaction: set `branch`, `base_sha` and `repo`, move the batch to `OPEN`, insert the QUEUED
   workstreams with `batch_id`, and emit `batch.updated`.

**Joining or reopening** checks only that the checkout is on `batch.branch`; the other checks hold by
construction. The API returns the batch at once; cutting finishes in the background and its refusals arrive as
cards.

**Scheduler rule.** In a `pull_request` project a QUEUED workstream launches only when its batch is `OPEN`,
`base_sha` is set, and `git branch --show-current` equals `batch.branch`, checked once per tick per project.
**At startup**, an unfinished batch whose branch is not checked out moves to `FAILED` with the card "checkout is
on X, the batch branch is Y", and nothing in it launches.

## 6. Shipping

0. If the checkout is not on `batch.branch` or `git status --porcelain` is not empty, the batch moves to
   `FAILED` with a card naming the branch or the dirty paths.
1. Count commits beyond `base_sha`. None moves the batch to `CLOSED`.
2. Run the project's gate with the existing gate runner and `limits.gateTimeoutMs`, recording `gate_pid` and
   `gate_pid_start` as workstreams do. Exit code and log path are recorded. A non-zero exit moves the batch to
   `FAILED`; a timeout's card says "timed out after N min".
3. `git push -u origin <branch>`, never forced. A rejected push moves the batch to `FAILED`.
4. `gh pr view <branch> -R <repo> --json url,state` finds any PR for the branch in any state and records its
   URL. Only when there is none does `gh pr create -R <repo> --base <base_branch> --head <branch> --title
   '<pr_title_prefix>: <title>' --body-file <file>` run. The title's first letter is lowercased because
   commitlint requires a lowercase subject; header length is the builder's to keep.
5. Record `pr_url`, move the batch to `SHIPPED`, and emit `batch.updated`.

**PR body,** built from records: the batch title; each task's title and final workstream state; the gate
command and result; failed or cancelled tasks, listed; and a footer line `Shipped by 10db, batch <id>`.

**Network calls** (`fetch`, `push`, every `gh` call) run in the captured login environment from
`environment/`, with `GIT_TERMINAL_PROMPT=0`, `GH_PROMPT_DISABLED=1` and `GH_NO_UPDATE_NOTIFIER=1`, and a
per-call timeout. A timeout or error moves the batch to `FAILED`. The `Gh` interface tells "no PR" apart from
"signed out" and "not installed", and each has its own card text. The system check verifies `gh` when any
project uses `pull_request`.

**Shutdown** aborts the shipping gate and any child, as the runner does for a task's gate, and leaves the batch
`SHIPPING`.

**Recovery.** At startup, a batch in `SHIPPING` first terminates an orphaned gate process group recorded in
`gate_pid` and `gate_pid_start`, then re-runs from step 0. Re-running the gate is safe, pushing the same commits
again changes nothing, and step 4 finds the PR an earlier attempt opened. A crash at any point produces neither
a different push nor a second PR.

## 7. Components

| Unit | Job |
|---|---|
| `apps/daemon/src/delivery/` | the batch state machine, cutting, the ship trigger handler, shipping and recovery |
| `apps/daemon/src/git/` | gains `currentBranch`, `fetch`, `switchNewBranch` and `push` |
| `apps/daemon/src/github/` | a `Gh` interface over the `gh` CLI (`authStatus`, `repoView`, `prView`, `prCreate`), output parsed with zod |
| `apps/daemon/src/guard/` | `GuardInput` gains `delivery`, defaulting to `local`. `git push` is denied in `pull_request` projects ("10db pushes when the batch ships"). In every project, agents are denied `gh pr create`, `merge`, `close`, `edit` and `ready`, `gh api` with a method other than GET, and `gh repo` mutations; `gh pr view`, `list` and `checks` stay allowed |
| `apps/daemon/src/scheduler/` | the launch rule in §5 |
| `apps/daemon/src/team/` | `retryWorkstream` respects the batch rules in §4 |
| `apps/daemon/src/environment/` | the system check verifies `gh` when needed |
| `packages/contracts` | `Batch`, `BatchState`, the project fields, the routes in §8, and `batch.updated` |
| `packages/db` | the `batches` table, the new columns and a batches repository |
| `apps/desktop` | project form fields and the batch strip (§8) |

## 8. API and UI

- `POST /projects/:id/batches`, `POST /batches/:id/ship` (from `FAILED`, or Ship anyway from `OPEN`) and
  `POST /batches/:id/abandon`. The project view carries `currentBatch`. `batch.updated` is emitted on insert and
  on every change.
- The project form gains delivery, base branch and PR title prefix, which is required for `pull_request`.
- A batch strip on the project shows the unfinished or latest batch: title, state, branch, the PR link once
  shipped, the workstreams blocking a ship with their states, and Retry, Ship anyway or Abandon where allowed.

Several tasks join one batch by starting them while it is `OPEN`. The M2b board adds starting a chosen set at
once through `POST /projects/:id/batches`.

## 9. Later

- **Worktrees and one PR per task.** `workspace_mode = worktree` gives each task its own worktree and branch.
  A task then ships alone through the same shipping steps, and a batch becomes only a grouping. Parallel
  batches in one project become possible.
- **Auto-merge or deploy on ship.** Choose an after-ship action when starting a batch or task: `none` (today),
  `auto_merge` (`gh pr merge --auto --squash`, which waits for required checks), or a project-defined deploy
  command run after the merge. Each is an additive column on `batches` and one more step after §6 step 5.
- Stacked batches, where a batch builds on an unmerged one.
- Rebasing or updating an unmerged PR, and hosts other than GitHub.

## 10. Testing

- **Real git.** Each test uses a temporary repo with a local bare repo as `origin`, so fetches and pushes are
  real.
- **Fake `gh`.** `gh` is faked at the child-process boundary through the `Gh` interface.
- **Table-driven:**
  - batch transitions, one row per transition including refused ones;
  - cutting checks, one row per failing check, asserting the card, that the row is gone and that HEAD did not
    move;
  - the scheduler launch rule, including the wrong-branch row;
  - guard verdicts for `git push` in both delivery modes and for each denied and allowed `gh` form.
- **Concurrency:** two simultaneous starts produce one batch and one branch.
- **Shipping:** no commits ends `CLOSED`; a dirty checkout, a failing gate and a timed-out gate each end
  `FAILED` with nothing pushed; a passing gate pushes to the bare repo and records the PR URL.
- **Recovery:** a `CUTTING` row is deleted; an unfinished batch on the wrong branch ends `FAILED` and launches
  nothing; a batch left in `SHIPPING` after each of steps 0-4 finishes with exactly one `prCreate` call and the
  bare repo at the same SHA; an orphaned shipping gate is terminated before the rerun.
- **Workstreams:** a failed workstream holds the batch `OPEN`; retry is refused in a `SHIPPED` batch; abandon
  cancels the waiting workstreams and releases their claims.
- **`local` delivery:** the existing daemon suites pass unchanged.
- **Desktop:** one table-driven render test of the batch strip across its states.
