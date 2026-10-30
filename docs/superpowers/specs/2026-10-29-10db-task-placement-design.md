# 10db task placement: choose Your folder or a separate copy for each task

**Status:** designed on 2026-10-29, not built. Written without a design conversation, as the worktree spec was: the
builder asked for a design only, then PR-sized build tasks. Every call the builder has not made is marked **(call)**
and listed in §11 for review.
**Extends:** `2026-10-27-10db-worktree-mode-design.md` (W1 made the mode per project; this amends it),
`2026-10-21-10db-batch-delivery-design.md`.
**Keeps:** `2026-10-25-10db-lane-sandbox-design.md` unchanged. A copy is still one more checkout the existing rules
describe.
**Words:** the desktop says "Your folder" for a task that works in the project's own checkout (`shared` in the code)
and "Separate copy" for a task that works in its own git worktree (`worktree`).

## 1. Intent

A project is Your folder or Separate copies today, once. The builder works both ways inside one project: frontend
tasks in their own checkout, where a dev server shows every change as the agents make it and several sessions
work on different screens at once; backend tasks in separate copies, which they don't watch. One mode per project
cannot do both.

This design moves the choice to the task. The project keeps a default. Each task shows where it will run before it
starts, is proposed from its areas and risks, and can be changed until it has a workstream.

**Success means** (the acceptance criteria; §9 turns each into tests):

1. Each task shows where it will run before it starts, and the builder can change it. (P1, P3)
2. Tasks in Your folder and tasks in separate copies of the same project run at the same time. (P5, P6, P7)
3. Two tasks in Your folder run at the same time only when their areas don't overlap. (P7)
4. A task touching migrations, the lockfile or contracts is proposed for a separate copy. (P2)
5. While tasks run in Your folder, the builder's dev server shows their edits as they are made. (P8)
6. This design is written and reviewed before any code. (this document)

**Non-goals:** a port block per worktree; building anything beyond what the worktree spec built; changing how the
checkout is switched back; parallel ships; the planner choosing the lane count (§10).

## 2. What is already per batch

Most of the delivery code already follows the batch, not the project. The facts below were read on 2026-10-29.

| Place | What it does now |
|---|---|
| `delivery/checkout.ts` | `checkoutOf`, `claimScopeOf`, `batchCheckout` and `allCheckouts` answer from the batch's `worktree_path`, falling back to the project's `repoPath`. |
| `scheduler/scheduler.ts` | The launch rule and `branchSnapshot` read each batch's own checkout. |
| `watcher/watcher.ts` | One watch per `checkoutOf` root. |
| ship, recover, base-update, the sweep | Per batch. The sweep walks every project (`listProjects`), not only worktree-mode ones. |
| `packages/db/src/store/claims.ts` | `scopeOf`: an area claim is scoped to the batch for a worktree batch and to the project otherwise; a hazard is scoped to the project. |
| `packages/db` | `batches_one_unfinished` is a partial unique index over batches without a `worktree_path`. |

Only two places in the daemon branch on `project.workspaceMode`: `startBatch` (`delivery/start.ts`) and `jobKey`
(`delivery/jobs.ts`). Two checks count lanes by project instead of by checkout: the shared cut (`start.ts`, the
`countLanes(db).byProject` test) and the switch back (`checkout-return.ts`, `runningIn`). Those four are what this
design changes in the daemon.

`tasks.workspace_mode` exists, `NOT NULL`, typed `'shared'` (`packages/db/src/schema.ts`), and is not in `TaskDto`
or `TaskPatch`. The desktop reads `project.workspaceMode` in `board/batch/sheet-mode.ts`, `board-view.tsx`,
`batch-panel.tsx`, `task-drawer.tsx`, `settings/general-values.ts` and `project-general-form.tsx`.

## 3. Decisions

| # | Decision | Why |
|---|---|---|
| P1 | Placement lives on the task: `tasks.workspace_mode` is `shared` or `worktree`. `projects.workspace_mode` becomes the default for new tasks, changeable at any time. `worktree` still needs `pull_request` delivery. In `local` delivery every task is `shared` and the choice is hidden. | The task is what the builder reasons about ("this is a screen I watch", "this is a migration"). The project's mode changing no longer needs an idle project, because it changes nothing that already exists. |
| P2 | A task is proposed a placement when it is made (the builder MCP `create_task` in `mcp/tools.ts`, an accepted proposal in `inbox/proposal-task.ts`, the desktop form). **Worktree** when any of its `areas` names an entry in the project's new `isolate` list, or its `riskTags` include `migration` or `dependency`; **otherwise the project default**. A short reason is kept (`tasks.placement_reason`, "touches migrations"). An explicit placement from the planner or the form wins and has no reason. The default `isolate` is the stock hazards `migrations` and `deps`; the builder adds `contracts` (and a long daemon area) for 10db itself. **(call: `isolate` names areas and hazards, not globs; and the reason is stored rather than derived)** | A task's `areas` already hold hazard names (`claimRequestsForTask` reads them that way), so a task that edits the lockfile carries `deps` and one that adds a migration carries `migrations`. Names keep the rule short and checkable. A stored reason survives a later change to `isolate`; a derived one would explain a placement the rule no longer gives. Covers success criterion 4: migrations and the lockfile by default, contracts once `isolate` names it. |
| P3 | The card and the task drawer show a "Your folder" / "Separate copy" badge with the reason as its tooltip. The drawer and the batch sheet change it until the task has a workstream in a state other than finished or cancelled (the landing rule, `dec_01a18a8e`, says "until it has a workstream"; a cancelled or failed run frees it here). **(call: whether a finished run frees it)** | The builder confirms the proposal (the open-items goal). A started task's placement is a fact about files that exist. |
| P4 | A start partitions its tasks by placement: shared tasks go to `startShared`, worktree tasks to `startWorktrees`. `POST /projects/:id/batches` answers `BatchDto[]` as it does for worktree mode now. A start whose tasks are linked by a dependency across the two placements is refused in plain words, naming both tasks and where each runs. **(call: refuse, or move the shared half of the chain to a copy)** A fix task sent with `batchId` takes that batch's placement (the start writes it onto the task, which has no workstream yet). | The dependency check already refuses a dependency that is neither in the group nor merged (`unfinishedDependencies`), so refusing needs only a better message. Moving a task from the folder the builder watches to a copy behind their back is the surprising one. |
| P5 | A project holds one unfinished shared batch and any number of worktree batches; the existing partial index already allows this. A batch's kind is whether `worktree_path` is set (no new column). `jobKey` keys on the batch's kind: the project's single queue for a shared batch, `<project>:cut` and `<project>:ship` for a worktree batch. `ProjectViewDto.currentBatch` is the unfinished shared batch, else the newest batch; `openBatches` lists every unfinished batch. | The shared cut and ship read and switch the main checkout, so they stay on one queue; worktree work never touches it and must not wait behind it. `jobKey` and the project view are the two readers of the project's mode that must follow the batch. |
| P6 | The shared cut's and the switch back's lane check counts only lanes whose checkout is the project's `repoPath` (`checkoutOf(ws) === project.repoPath`). A worktree lane no longer blocks a cut, and a shared lane still does. The daemon switches the main checkout's branch only while no lane works in it. Git concurrency is checked, below. | The check exists because the cut moves the branch under the files a lane is editing. A lane in a copy edits other files. |
| P7 | Claims are unchanged, plus the per-copy hazards of `dec_01a18a7e` (`harness` and `deps` scoped like areas; `migrations` and builder-added hazards per project). A shared task's areas are exclusive across the project's shared work; a copy's areas are exclusive within the copy. | `scopeOf` already gives a shared task and a copy's task different scopes, so a shared task and a copy's task on the same area launch in one tick, while two shared tasks on overlapping areas do not and on disjoint areas do. Project-wide hazards (`migrations`) still serialise a shared and a copy's task, which is right: they share a database. |
| P8 | The dev server: every write a shared lane makes lands in the main checkout as it is made. Nothing in a copy's life writes the main checkout (§6). What the builder sees: the cut switches the branch once, when the shared batch starts (the dev server reloads), the switch back does it once when the batch ends, and `gate-with-base` merges `origin` into a copy's branch, not into the main checkout. | Criterion 5 holds because a copy's creation, lanes, gate, ship and removal use `git` against the copy and the common git dir only. |
| P9 | The sandbox gets no new rule. A copy's lane is denied the main checkout and every other live copy (`allCheckouts`); a shared lane is denied every live copy. The seed copy (W10) now clones a directory a same-project shared lane could have written; §7 says what that changes. **(call: §7)** | The profiles are built from the checkout list, which already has both kinds. |

## 4. Data

Forward-only migration (`packages/db/AGENTS.md`; v0.1.0 is released), written by hand as a custom migration:

- `tasks.workspace_mode` widens from `'shared'` to `'shared' | 'worktree'` in the column's TypeScript type; the SQL
  stays text. The migration backfills `worktree` for tasks that have no workstream and belong to a project whose
  `workspace_mode` is `worktree`, so a task filed before the change keeps the placement its project gave it.
  Tasks with a workstream keep `shared`; nothing reads their value.
- `tasks.placement_reason` (nullable text).
- `projects.isolate` (JSON list of area and hazard names, default `["migrations","deps"]`), backfilled to the
  default.

**Contracts:** `TaskDto` gains `workspaceMode` and `placementReason`; `TaskPatch` gains `workspaceMode`; `TaskInput`
gains an optional `workspaceMode`; `ProjectDto` / `ProjectInput` / `ProjectPatch` gain `isolate`; `ProjectDto`'s
`workspaceMode` is documented as the default. A patch to `workspaceMode` is refused with a plain message when the
task has a workstream (P3) or when the project does not deliver by pull request.

## 5. Lifecycle

**Create.** The proposal rule (P2) runs where the task is built, in one function the three entry points share, so
the planner, the form and an accepted proposal agree.

**Start.** `startBatch` loads the tasks, partitions them (P4) and calls `startShared` for the shared part and
`startWorktrees` for the rest. The request-time checks are today's. Both parts return their batches in one array.
A second start of a shared task while the project's shared batch is `CUTTING` or `SHIPPING` is refused as now.

**Cut.** The shared cut is today's, with P6's lane check. A copy's cut is today's. The two queues of P5 mean a copy
can be cut while a shared batch is `OPEN`.

**Ship, retry, abandon, recovery.** Unchanged: they already read the batch. The switch back counts only lanes in
the main checkout (P6). A project with a shared batch and copies recovers each on its own.

**Fix tasks.** A fix task joins the batch it names and takes its placement (P4).

## 6. Does a copy ever write the main checkout?

Checked in the code, because success criterion 5 and the dev server depend on it.

| Step of a copy's life | Where it writes |
|---|---|
| Cut: `update-ref`, `worktree add`, `read-tree -m -u` | the common git dir and the copy (`git.ts`, `addWorktree`, under the main checkout's repo lock). Not the main checkout's index or files. |
| Seed copy | reads the main checkout; writes the copy. |
| Lanes, verify, gate | the copy; the sandbox denies the main checkout (`allCheckouts`). |
| `base-update` (merge of origin) | the copy's files and index. |
| Ship, push, PR | the copy's branch ref and the remote. |
| Removal and the sweep | the copy's directory and the common dir's `worktrees/` entry. |

`fetch` updates `refs/remotes/origin/*` in the common dir, never the main checkout's files. This is tested rather
than assumed: §9 compares the main checkout's HEAD, index and files before and after a copy's whole life.

**Concurrent git writes to the common dir (P6).** The daemon's own lock is `withRepoLock(realpathSync(repo))` in
`git/git.ts`. `addWorktree`, `switchNewBranch`, `switchBack` and `mergedCommit` all take it with the main checkout
as the key, so a copy's creation and a shared cut or switch back already run one at a time. A lane's commit in a
copy keys on the copy's own path and moves only that branch, under git's own ref locking; fetches are serialised
on the main checkout's path separately. The design adds no lock. A test runs a copy's creation and a shared cut
together and asserts both finish and both refs are right.

## 7. Security

**Seed.** W10 cloned the main checkout's ignored directories (`node_modules` by default) into a new worktree, on
the grounds that "in worktree mode no lane writes the main checkout, so the clone is the builder's own install".
That no longer holds: a shared lane writes the main checkout, and the lane profile's write rule is "the checkout"
(`03-trust-boundaries.md`, Write), `node_modules` included. A shared lane could edit a dependency, which a copy
cut afterwards would receive by clone and its gate would then run. This is the same exposure the builder's own
dev server and a shared batch's gate already have in Your folder; the new part is that it reaches a copy.

**(call)** Options: (a) accept, since the copy's `pnpm install --frozen-lockfile` runs after the seed and the
exposure already exists in Your folder; (b) skip the seed clone, and install, when the main checkout has an
unfinished shared batch; (c) deny a lane's writes to the seed directories in a shared checkout. (b) is the
smallest. This design recommends (b), to be settled before T2 builds the cut change.

Nothing else is new. A copy's lane profile is today's. The shared cut and the switch back keep their git rules
(decision 129 and `decisions/2026-10-29-shared-checkout-switch-back.md`).

## 8. Components and build tasks

| Unit | Change |
|---|---|
| `packages/db` | the migration and columns of §4; `insertTask` takes a placement and reason; `patchTask` refuses a placement change after a workstream; `patchProject` drops the idle-project test for the mode and keeps the `pull_request` one |
| `packages/contracts` | §4's fields |
| `apps/daemon/src/delivery/` | `startBatch` partitions by placement; the shared cut and `runningIn` count lanes in the main checkout only; `jobKey` takes the batch's kind; a clearer cross-placement dependency refusal |
| `apps/daemon/src/api`, `mcp/tools.ts`, `inbox/proposal-task.ts` | the shared proposal function; `create_task` accepts `workspaceMode` |
| `apps/desktop` | the badge, the drawer and sheet controls, `sheet-mode.ts` and `batch-panel.tsx` following the batch's kind, the project form's default and its `isolate` list |
| docs | `02-batch-delivery.md`, `03-trust-boundaries.md`, `docs/open-items.md` |

PR-sized build tasks, with what each depends on:

| Task | Delivers | Depends on |
|---|---|---|
| T1 | `db` and `contracts`: the migration, the task and project fields, the patch rules | none |
| T2 | the daemon: start by placement, the shared cut's and switch back's lane scoping, `jobKey` by batch kind | T1 |
| T3 | the proposal rule and the `isolate` setting, in `create_task`, accepted proposals and the API | T1 |
| T4 | the desktop: badge, controls, sheet and project form | T2, T3 |
| T5 | docs: `02-batch-delivery.md`, `03-trust-boundaries.md` (the seed call), `open-items.md` | T2 |

## 9. Testing

Red first in each task, named here by where it belongs.

- **T1.** The migration backfills `worktree` for unstarted tasks of a worktree-mode project and leaves the rest;
  a placement patch is refused once the task has a workstream, and for a `local` project.
- **T3.** The proposal rule as a table: one row per case (task area in `isolate`, `migration` risk, `dependency`
  risk, none, explicit placement, `local` delivery), each asserting placement and reason.
- **T2.**
  - A mixed start makes one shared batch and one batch per copy group.
  - A cross-placement dependency is refused with a card naming both.
  - A shared task and a copy's task on the same area launch in one tick; two shared tasks on overlapping areas do
    not; on disjoint areas they do.
  - A shared cut succeeds while a copy's lane runs, and is refused while a shared lane runs; the switch back does
    the same.
  - `jobKey` by batch kind (extends `jobs.test.ts`).
  - The main checkout's HEAD, index and files are untouched through a copy's whole life, with a shared batch open
    beside it.
  - A runner's cwd is `repoPath` for a shared task while copies are live.
  - A copy's creation and a shared cut together finish with the right refs.
- **T4.** The badge, the drawer control and the sheet render and send the right patch.
- **All.** The existing delivery, scheduler, runner and desktop suites pass unchanged.
- **Manual acceptance** (10db on itself, by the builder): a dev server open on the main checkout while a shared UI
  task and a copy's migration task run together.

## 10. Not covered

A port block per worktree; the planner choosing the lane count; changes to the switch back beyond P6; parallel ships;
a per-task choice of landing (that has its own record: `dec_01a18a8e`). Each goes to `docs/open-items.md` if it is
not there.

## 11. Calls to review

P2 (names, not globs; the reason stored), P3 (when a finished run frees the control), P4 (refuse, or move a chain),
and §7 (the seed after a shared lane could have written `node_modules`).
