# 10db batch delivery: one branch and one pull request per batch

**Status:** design approved in conversation on 2026-10-21; this document awaits review.
**Extends:** `2026-10-13-10db-factory-loop-design.md` (§4 `projects` and `tasks`, §5 lifecycle, §8 guard).
**Builds on:** M2a (plan 06). It runs alongside the M2b board plan, which builds batch approval on the batch
entity defined here.

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
   up-to-date base branch, without anyone running git by hand.
2. When every task in the batch has ended, 10db runs the gate on the branch, pushes it and opens one PR whose
   title passes the project's commit-message rules.
3. A daemon killed while shipping finishes shipping after restart, without a second push of different content
   or a second PR.
4. Every refusal (dirty checkout, no `origin`, `gh` signed out, gate failed, push rejected) is an inbox card
   that says what to fix, and nothing is pushed.

## 2. Decisions

| Decision | Why |
|---|---|
| The delivery unit is the batch. One open batch per project. | The shared checkout holds one branch at a time (factory spec decision 13), so parallel tasks share it. |
| The daemon creates and switches branches; agents still can't. | Switching branches under running sessions moves their files. The daemon switches only when no lane runs in the project. |
| The daemon pushes and opens the PR; agents may no longer push in `pull_request` projects. | One deterministic shipper, with a PR body built from records rather than model output. |
| Merging stays with the builder. | Merge is the step that can't be taken back. Auto-merge is a later per-batch option (§9). |
| A project chooses `local` or `pull_request` delivery. | `local` keeps today's behavior for disposable repos and the M1 acceptance run, which have no remote. |
| `gh` is the only host integration. | The builder's repos are on GitHub and `gh` is already signed in. Other hosts aren't needed yet. |

## 3. Data

**`projects` gains:**

| Column | Values | Default |
|---|---|---|
| `delivery` | `local` · `pull_request` | `local` |
| `base_branch` | a branch on `origin` | `main` |
| `pr_title_prefix` | a Conventional Commit type and scope, e.g. `feat(daemon)` | `feat` |

**New `batches` table:** `id` (branded `BatchId`, UUIDv7), `project_id`, `title`, `branch`, `base_branch`,
`base_sha` (the base commit the branch was cut from), `state`, `pr_url` (nullable), `gate_exit_code` and
`gate_log_path` (nullable, from the last ship attempt), `failure` (nullable text), `created_at`,
`updated_at`. A partial unique index allows one batch per project in an unfinished state.

**`tasks` gains** `batch_id` (nullable). A task joins a batch when it starts and keeps it.

Until the first published release the migration baseline is regenerated, not extended
(`packages/db/AGENTS.md`).

## 4. Batch lifecycle

```
OPEN → SHIPPING → SHIPPED
   ↘       ↓
    CLOSED  FAILED → SHIPPING (retry) | OPEN (a task is started in it) | ABANDONED
OPEN | FAILED → ABANDONED
```

- **OPEN.** The branch is checked out and tasks run. "Unfinished" means `OPEN`, `SHIPPING` or `FAILED`.
- **Ship trigger.** When a task's workstream reaches `DONE`, `FAILED` or `CANCELLED`, and every task in its
  batch has ended, the batch moves to `SHIPPING`. The daemon re-checks this at startup, so a missed trigger
  is caught.
- **CLOSED.** The batch ended with no commits beyond `base_sha`. Nothing is pushed.
- **SHIPPED.** The PR is open and `pr_url` is set. The checkout stays on the branch until the next batch.
- **FAILED.** The gate failed or shipping hit an error. `failure` says which, and an inbox `flag` card links
  the gate log or the error. From here the builder retries shipping, starts a fix task in the batch (which
  reopens it) or abandons it.
- **ABANDONED.** Nothing more happens. The branch stays local for the builder to inspect.

## 5. Starting a batch

`POST /projects/:id/batches` with `{ title, taskIds }` starts a batch and its tasks. In a `pull_request`
project, starting one task with no unfinished batch (`POST /tasks/:id/start`) opens a batch of one titled after
the task. Starting a task while a batch is `OPEN` adds it to that batch. Starting tasks while the batch is
`SHIPPING` is refused.

Before cutting the branch, the daemon checks the following, in order. Each failure refuses the start with a
specific inbox card:
1. No lane runs in the project.
2. The checkout has no uncommitted changes (`git status --porcelain` is empty).
3. `origin` exists and `git fetch origin <base_branch>` succeeds.
4. `gh auth status` succeeds, and `gh repo view` can see the repo.

Then it runs `git switch -c 10db/<slug>-<short id> origin/<base_branch>`, records `base_sha`, and lets the
scheduler start the tasks. Agents commit through the existing `commit` tool, which commits to the checked-out
branch, so claims and the commit lock are unchanged.

## 6. Shipping

1. Count commits on the branch beyond `base_sha`. If there are none, the batch moves to `CLOSED`.
2. Run the project's gate on the branch with the existing gate runner and record its exit code and log path.
   A non-zero exit moves the batch to `FAILED`.
3. `git push -u origin <branch>`, never forced. A rejected push moves the batch to `FAILED`.
4. Look for an existing PR for the branch (`gh pr view <branch> --json url,state`). If none exists, run
   `gh pr create --base <base_branch> --head <branch> --title '<pr_title_prefix>: <title>' --body-file <file>`. The title's first letter is lowercased, because commitlint
   requires a lowercase subject.
5. Record `pr_url`, move the batch to `SHIPPED`, and emit `batch.updated`.

The PR body is built from records: the batch title, each task's title and final state, the gate command and its
result, any tasks that failed or were cancelled, and the attribution footer.

**Recovery.** At startup, a batch in `SHIPPING` re-runs this procedure. Re-running the gate is safe. Pushing the
same commits again changes nothing. Step 4 finds the PR a previous attempt opened. So a crash at any point
produces neither a different push nor a second PR.

## 7. Components

| Unit | Job |
|---|---|
| `apps/daemon/src/delivery/` | the batch state machine, start checks, branch cutting, shipping and recovery |
| `apps/daemon/src/git/` | gains `currentBranch`, `fetch`, `switchNewBranch` and `push` |
| `apps/daemon/src/github/` | a `Gh` interface over the `gh` CLI (`authStatus`, `repoView`, `prView`, `prCreate`), output parsed with zod |
| `apps/daemon/src/guard/git-rules.ts` | denies `git push` in `pull_request` projects: "10db pushes when the batch ships." |
| `apps/daemon/src/scheduler/` | starts tasks only through their batch in `pull_request` projects |
| `packages/contracts` | `Batch`, `BatchState`, the project fields, the routes in §5 and §8, and `batch.updated` |
| `packages/db` | the `batches` table, the new columns and a batches repository |
| `apps/desktop` | project form fields, "Start as batch" in the task list, and a batch strip (§8) |

## 8. API and UI

- `POST /projects/:id/batches`, `GET /projects/:id/batches`, `POST /batches/:id/ship` (retry from `FAILED`),
  `POST /batches/:id/abandon`.
- The project form gains delivery, base branch and PR title prefix.
- The task list gains multi-select and "Start as batch", which asks for a title.
- A batch strip on the project shows the open or latest batch: title, state, branch, the PR link once shipped,
  and Retry or Abandon when `FAILED`.

The M2b board replaces the task-list action with batch approval on the same API.

## 9. Later

- **Worktrees and one PR per task.** `workspace_mode = worktree` gives each task its own worktree and branch.
  A task then ships alone through the same shipping steps, and a batch becomes only a grouping. Parallel
  batches in one project become possible.
- **Auto-merge or deploy on ship.** Choose an after-ship action when starting a batch or task: `none` (today),
  `auto_merge` (`gh pr merge --auto --squash`, which waits for required checks), or a project-defined deploy
  command run after the merge. Each is an additive column on `batches` and one more step after §6 step 5.
- Rebasing or updating an unmerged PR, and hosts other than GitHub.

## 10. Testing

- **Real git.** Each test uses a temporary repo with a local bare repo as `origin`, so fetches and pushes are
  real.
- **Fake `gh`.** `gh` is faked at the child-process boundary through the `Gh` interface.
- **Table-driven:** batch transitions, one row per transition including refused ones; and start checks, one row
  per failing check, asserting the card and that HEAD did not move.
- **Shipping:** a batch with no commits ends `CLOSED`; a failing gate ends `FAILED` with nothing pushed; a
  passing gate pushes the branch to the bare repo and records the PR URL.
- **Recovery:** a batch left in `SHIPPING` after each step 1-4 finishes with exactly one `prCreate` call and
  the bare repo at the same SHA.
- **Guard:** `git push` is denied in a `pull_request` project and keeps today's checks in a `local` one.
- **Desktop:** one render test for the batch strip in each state.
