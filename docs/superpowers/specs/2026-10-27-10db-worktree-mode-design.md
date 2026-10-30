# 10db worktree mode: one worktree, one branch and one pull request per task

**Status:** written on 2026-10-27 without a design conversation, then revised after a plan-reviewer pass (Fable): the builder asked for sensible calls now
and a review at the end. Every call the builder has not made is marked **(call)** and listed in §13 for that
review.
**Extends:** `2026-10-21-10db-batch-delivery-design.md` (§9 "Later" names this) and
`2026-10-13-10db-factory-loop-design.md` (decision 13, §8 point 5).
**Keeps:** `2026-10-25-10db-lane-sandbox-design.md` and decisions 124–133 unchanged. Nothing here reopens the
sandbox; a worktree is one more checkout the existing rules already describe.

## 1. Intent

Today every lane of a project shares the project's one checkout. Two lanes can't edit the same area at once,
and most UI tasks claim `apps/desktop`, so 1–3 lanes building 10db mostly take turns. A batch holds the
checkout on its branch until it ships, so a second batch waits for the first.

Worktree mode gives each started task its own git worktree on its own branch, cut fresh from
`origin/<base_branch>`. Its lanes run there, its gate runs there, and it ships alone as its own pull request
through the existing shipping steps. Tasks in different worktrees never wait on each other's areas.

**Success means:**

1. In a `pull_request` project with `workspace_mode = worktree`, starting three independent tasks creates
   three worktrees and three branches, and their lanes run at the same time even when they claim the same
   area.
2. Each task ships alone: gate in its worktree, push of its branch, one PR titled after the task.
3. The main checkout is never switched, staged or written by the daemon in worktree mode. The builder can keep
   using it.
4. A daemon killed at any point while creating, using, shipping or removing a worktree recovers without
   commits on the wrong branch, a push of different content, a second PR, or a leaked worktree.
5. A lane in one worktree can't write the main checkout, another worktree, or any git state, exactly as it
   can't write another project today.
6. `shared` mode behaves exactly as today; its suites pass unchanged.

**Non-goals:** rebasing or updating an unmerged PR; stacked work (a task building on an unmerged one); port
allocation per worktree; worktrees in `local` delivery; Docker or database duplication per worktree.

**Anti-goals:** running anything the repository controls outside the sandbox to prepare a worktree (no
unsandboxed `pnpm install`, no setup script on the host); a worktree a lane can reach from another worktree;
deleting a directory the daemon didn't create.

## 2. Prior art

| Tool | Where | Base | Setup | Cleanup |
|---|---|---|---|---|
| Claude Code (`--worktree`, subagent `isolation: worktree`) | `.claude/worktrees/<name>` in the repo | fetch, then `origin/HEAD` (`worktree.baseRef: fresh`) | `.worktreeinclude` copies ignored files such as `.env`; deps are the agent's job | clean ones removed with their branch; a sweep skips worktrees without its marker; `git worktree lock` while running |
| Codex app | `$CODEX_HOME/worktrees`, configurable | the chosen branch's HEAD | setup script per environment, `.worktreeinclude` | keeps the 15 newest, removed on archive, snapshot first |
| Conductor | app-managed workspace dir | fetch, then the repo's base branch | `conductor.json` `setup` script; `.env` copied by it | archive script, then the dir goes |

What 10db takes: fetch then cut from `origin/<base>` (already the batch rule); an app-owned root outside the
repo; a marker so the sweep touches only its own worktrees; `git worktree lock` with a reason; copying
selected ignored files instead of running a setup command on the host. What it leaves: running setup scripts
outside a sandbox (the security rule in `apps/daemon/AGENTS.md` forbids it), per-workspace port blocks
(hazards cover shared resources for now).

## 3. Decisions

| # | Decision | Why |
|---|---|---|
| W1 | `projects.workspace_mode` (`shared` · `worktree`, default `shared`) chooses the mode per project. `worktree` requires `pull_request` delivery. It changes only while the project has no unfinished batch. `tasks.workspace_mode` stays unused and is dropped later. **(call)** | A per-task mode would let a shared batch and worktrees share a project, and the shared cut's "no lane runs in the project" check would then need to tell them apart. One mode per project keeps every rule simple. Worktrees without a PR have no way to land. |
| W2 | The delivery unit stays the `batches` row: in worktree mode a batch is one task (or one dependency-linked group, W3) in one worktree on one branch with one PR. The one-unfinished-batch index applies to `shared` batches only. **(call)** | Cut, ship, Retry, Abandon, recovery, cards and the strip already work on a batch. A worktree batch reuses all of them; only "where the checkout is" changes. |
| W3 | A start of several tasks in worktree mode makes one batch per task. Tasks in the set linked by a dependency (directly or through others in the set) go in one batch, titled after the first task in the set's order that has no dependency inside it. **(call)** | A dependent task can't start until its dependency's code is on the base branch (batch delivery §5); grouping lets a chain start together and ship as one PR instead of being refused. |
| W4 | Worktrees live under `~/.10db/worktrees/<8 hex of the sha256 of the data dir's real path>/<project slug>-<last 6 hex of project id>/<branch leaf>`, a root the daemon owns (the hashed level keeps a development daemon and the app, which use different data dirs, out of each other's worktrees), outside every checkout, the data dir and the lane temp root. `TENDB_WORKTREE_ROOT` overrides it. The root is refused at start if it lies at or under a registered checkout, the data dir or the temp root. **(call)** | Inside the checkout, a worktree would be writable by the main checkout's lanes and gates, and every repo tool (tsc, vitest, eslint, the watcher) would see it. Under the data dir it would sit inside a protected path. A hidden dir in home is Codex's choice and easy to open in an editor. |
| W5 | The daemon creates the worktree with its pinned git, as plain data (each step probed on git 2.50 under the pin env: `GIT_DIR`/`GIT_WORK_TREE` at the main checkout for `update-ref` and `worktree add`, at the new worktree for `read-tree`): `update-ref` creates the branch at `origin/<base>` (CAS from nothing), `git worktree add --no-checkout --lock --reason '10db <batch id>' <path> <branch>`, a pin of the new worktree (W6), then `read-tree -m -u` from its HEAD. Hooks, attributes and filters stay off as on every daemon git call (decision 129); a base tree that uses filters is refused before the branch is made. | The same plumbing the shared cut uses (decision 129), so no repository code runs. The lock reason is the marker the sweep looks for (W12) and stops a builder's `git worktree prune` from dropping its metadata. |
| W6 | A worktree's pin is written at creation, not trusted on first use: its git dir (read from the new `.git` gitfile right after `worktree add`, before any lane exists; git names it after the path's leaf and suffixes it on a clash) must lie under the project's pinned common dir, and its common dir must be the project's, by device and inode. Pins are stored as `checkout_pin.<batch id>` and found by the batch's worktree path; `projectAt` resolves a worktree path to its project, so git refusals in a worktree raise the same cards. A batch worktree with no stored pin is refused (a new `GitTrustFailure`), never pinned on first use as an unknown path is today. The pin is deleted when the worktree is removed. | The daemon made it, so there is nothing for the builder to trust. Checking the common dir proves it is the project's repository. Keying by batch keeps the pin after a restart, which today's by-project lookup would lose. |
| W7 | Every place that uses `project.repoPath` for a workstream uses the workstream's checkout instead: its batch's `worktree_path` when set, else `project.repoPath`. One function in `delivery/` (`checkoutOf`) answers it. | One rule, one place. The map of consumers is §8. |
| W8 | Lanes, gates and MCP servers of a worktree batch get the worktree as their checkout. The list of registered checkouts every profile denies writes to gains every live worktree, and the main checkout of a worktree-mode project becomes "another checkout": denied as a whole, except its common git dir, which the existing linked-worktree rule already opens read-only (decision 130). | A worktree lane can then write only its worktree and its temp dir; git state stays read-only; another worktree is out of reach. No new sandbox rule: decisions 130–132 already describe a linked worktree's git dir, common dir and gitfile. |
| W9 | Area claims are scoped to the batch in worktree mode; hazard claims stay project-wide, except a hazard marked per copy, which is scoped like an area (amended by `docs/architecture/decisions/2026-10-29-per-copy-hazards-and-waiting-claims.md`: `harness` and `deps` are per copy, `migrations` stays project-wide). The watcher watches each live checkout (the main one in shared mode, each worktree in worktree mode), and its claim holders for a path are the batch's workstreams for areas and the project's for hazards. **(call)** | Areas exist to stop two lanes editing the same files in one checkout; separate worktrees can't collide. Hazards name shared resources (ports, a database, Docker) that a worktree doesn't duplicate. |
| W10 | A new worktree is seeded with APFS clones (copy-on-write) of the main checkout's git-ignored directories whose name is in `projects.worktree_seed` (directory names, not paths; default `["node_modules"]`), found with `git ls-files --others --ignored --exclude-standard --directory` (which lists them at the top level and inside tracked directories). The copy walks by `lstat`: directories are made, regular files cloned (`COPYFILE_FICLONE`), links copied as links and never followed, anything else (FIFOs, sockets, devices) skipped; it stops on the job's abort signal. Nothing runs. Cargo's `target` is not seeded by default; a project may add it. **(call)** | Measured in §6: a clone is valid as is (pnpm reports it up to date) and costs no disk until written, while an install can't run in a lane (pnpm 12) and may not run on the host (the security rule). In worktree mode no lane writes the main checkout (W8), so the clone is the builder's own install. |
| W11 | No automatic refresh. A worktree is cut from a fresh `origin/<base>` and never rebased; a PR that conflicts is the builder's, as in shared mode. **(call)** | Neither Claude Code, Codex nor Conductor rebases automatically. Rebasing an unmerged PR is already a "Later" item. |
| W12 | Cleanup: a batch reaching `SHIPPED` or `CLOSED` removes its worktree (the branch stays, pushed for `SHIPPED`); `ABANDONED` removes it when clean and keeps it, named on the card, when it has uncommitted changes; `FAILED` keeps it for the retry. At startup a sweep removes every worktree locked with a `10db ` reason whose batch is finished or gone, and prunes. The daemon deletes only directories under its root that git lists as its worktrees. **(call)** | Shipped work is on the remote and the local branch; the worktree is disposable. Uncommitted work is never thrown away without the builder. The marker and the root bound what the sweep may touch. |
| W13 | In worktree mode delivery jobs run in two queues per project, one for cuts and joins and one for ships and cleanup, each one at a time; lanes run in parallel. Shared mode keeps its single queue. **(call)** | A cut must not wait behind a 30-minute shipping gate, and three gates at once overload this machine. Parallel ships can come later behind a limit. |
| W14 | A batch's `worktree_path` is cleared in the transaction after its worktree is removed. A live worktree is one whose batch has `worktree_path` set, whatever the state (an unfinished batch, or an `ABANDONED` one kept for its changes). | One column says what exists, so recovery re-runs a removal whose clear didn't land (removal is idempotent), and the sandbox's list of checkouts is a query. |

## 4. Data

Forward-only migration (`packages/db/AGENTS.md`, v0.1.0 is released).

**`projects` gains** `workspace_mode` (`shared` · `worktree`, default `shared`) and `worktree_seed` (JSON list
of relative paths, default `["node_modules"]`).

**`batches` gains** `worktree_path` (nullable; set in the `CUTTING` insert in worktree mode, before any git
side effect, so recovery knows what to remove).

**The unique index** `batches_one_unfinished` becomes partial on `worktree_path IS NULL` too, so a project
holds one unfinished shared batch and any number of worktree batches.

**`claims` gains** `scope` (text): the project id for hazards and for areas in shared mode, the batch id for
areas in worktree mode. The migration backfills `scope = project_id`. The active-claim unique index moves
from `(project_id, kind, name)` to `(scope, kind, name)`, and `acquireClaims` looks holders up by scope.

**Contracts:** `ProjectDto` gains `workspaceMode` and `worktreeSeed`; `BatchDto` gains `worktreePath`;
`ProjectViewDto` gains `openBatches: BatchDto[]` (every unfinished batch, newest first) and `currentBatch` is
defined as the newest unfinished batch, else the latest one (unchanged in shared mode); the desktop's
`sheetMode` always offers a new start in worktree mode, and fix tasks go through a batch's strip (amends
decision 122);
`POST /projects/:id/batches` answers `BatchDto[]` (one row in shared mode).

## 5. Lifecycle in worktree mode

The batch states and transitions are unchanged (batch delivery §4). What each step does differs:

**Start** (`POST /tasks/:id/start`, `POST /projects/:id/batches`). A task start always makes a new batch of
one; it never joins. A set start groups by W3. Each group is inserted `CUTTING` with its `worktree_path` and
its workstreams, `QUEUED`, in one transaction per group, and cut in the background job. The launch rule holds
them until the batch is `OPEN`. Inserting the workstreams here is what makes a second start of the same task
refused ("already running") while its cut is in flight; a refused or interrupted cut cancels them in the
transaction that deletes the row, which leaves the task startable again. The request-time checks are today's (status,
parked, already running, unfinished dependencies outside the group). Starting while another batch of the
project is `CUTTING` or `SHIPPING` is allowed.

**Fix tasks.** `POST /projects/:id/batches` with `{ title, taskIds, batchId }` adds the tasks to that batch when
it is `OPEN` or `FAILED` (reopening `FAILED`), as a join does today. The batch's card and strip offer "Add a
fix task" which picks an open task. Without `batchId`, a start never joins.

**Cut** (worktree mode). The checks, in order, each refusal deleting the `CUTTING` row and removing anything
already made: `origin` exists; origin's push URL matches the pin and names a GitHub repo; `git fetch origin
<base>`; `gh` installed and signed in; dependencies merged; the base tree uses no filters; the worktree path
does not exist yet. Not checked: lanes running in the project, the main checkout's branch or cleanliness.
Then W5's steps, then the seed copy (W10), then one transaction sets `branch`, `base_sha`, `repo`, moves to
`OPEN` and inserts the workstreams.

**Launch rule.** A worktree batch's workstream launches when the batch is `OPEN`, `base_sha` is set, the
worktree exists, is pinned, and its HEAD is `batch.branch`. As today, a running daemon that finds the worktree
missing or switched waits with one folded card naming the path; startup recovery fails the batch (§7).

**Ship.** The steps of batch delivery §6 with the worktree as the checkout: step 0 checks the worktree's
branch and cleanliness; the gate runs in the worktree under the gate sandbox; the push and PR are unchanged.
The PR title is `<prefix>: <batch title>`, the task's title for a batch of one.

**After ship.** `SHIPPED` and `CLOSED` remove the worktree (`git worktree remove --force --force <path>`, which
also drops a locked entry whose directory is gone; prune alone skips locked entries), in the ship queue, after
the state is recorded; then W14's clear and the pin's deletion. `CLOSED` then deletes the branch, no longer
checked out, when its tip is still `base_sha` (`update-ref -d` with the old value); recovery re-runs both.

**Retry** of a `FAILED` worktree batch makes sure its worktree is whole first: a worktree that exists, is on
the branch and has an `index` in its git dir is kept; anything else at the path or in git's list is removed
with `remove --force --force` and the worktree is made again from the existing branch (W5 without the
`update-ref`, plus the seed). A worktree with no `index` is a half-made one (a crash between `worktree add` and
`read-tree`). Shipping does this as its first step; a reopen does it in a cut-queue job before
`FAILED → OPEN`, so the launch rule never sees a missing worktree.

**Abandon** cancels as today, then removes the worktree if `git status` is clean; otherwise it keeps it and the
card says "uncommitted changes kept in <path>; remove it with `git worktree remove --force <path>`".

## 6. Dependencies in a fresh worktree

_Measured on this machine on 2026-10-27; numbers below._

| Step | Wall clock | Note |
|---|---|---|
| `git worktree add` | 0.23 s | |
| `pnpm install --frozen-lockfile`, warm store, unsandboxed | 2.6 s | not allowed: runs repository-controlled install scripts on the host, and pnpm 12 can't install inside a lane (`03-trust-boundaries.md`, the store lock dir) |
| APFS clone (`cp -Rc`) of the 8 ignored `node_modules` dirs (651 MB) | 12.9 s at load 13–18 | then `pnpm install --frozen-lockfile --offline` reports "Lockfile is up to date" in 0.6 s: the clone is complete |
| `pnpm --filter @10db/desktop sidecar` | 2.4 s | already the first step of `make rust-check`, so the gate makes it in the worktree |
| cold `cargo clippy` + `cargo test`, own target | 31.6 s + 27.6 s, 2.7 GB | |
| same, `target` cloned from the main checkout (8.3 GB, 9.2 s to clone) | 5.9 s + 8.1 s | the workspace crate rebuilds (its fingerprint holds the path); third-party crates hit. Measured with the builder's own `CARGO_HOME`; a lane's is per lane (decision 126), so a lane may rebuild those too |

Conclusions:

- `node_modules` is seeded by clone (W10). When the base branch's lockfile is newer than the main checkout's
  install, the worktree's lanes meet today's pnpm hazard card, which says to run the install outside the lane;
  the card names the worktree's path.
- `target` is not seeded by default: 9 s of cloning for a saving lanes may not see. A project adds `target` to
  its seed when it pays.
- The sidecar, `.gate/` logs and Playwright's browsers (a per-user cache) need nothing per worktree.
- `mise` asked for no trust of the new path in the measurement; the measurement ran under `/private/tmp`, so the
  first worktree under the root is checked by hand in acceptance (§10).

## 7. Recovery

At startup, in today's order (workstream recovery, then batch recovery, then the scheduler), plus:

- A `CUTTING` worktree batch: remove the worktree at `worktree_path` if git lists it (`remove --force
  --force`); an unlisted directory there is removed only when empty, else left and named on the card; cancel
  its workstreams, delete the row and the pin, card as today. A branch left by the crash is left alone, as in shared mode, and the next cut uses a new name.
- An `OPEN`, `SHIPPING` or `FAILED` worktree batch whose worktree is missing, unpinned, or on another branch
  fails with a card naming the path; Retry recreates it (§5).
- A `SHIPPED` or `CLOSED` batch whose `worktree_path` is still set (a crash between recording the state and
  W14's clear) has its removal, clear, pin deletion and, for `CLOSED`, branch deletion re-run. So does an
  `ABANDONED` one whose worktree is clean.
- The sweep (W12): for each worktree-mode project, `git worktree list --porcelain` in the main checkout; every
  entry under this daemon's root (the hashed level of W4) locked with reason `10db <batch id>` whose batch
  has no row or a cleared `worktree_path` is removed with `remove --force --force`; then `git worktree prune`.
  Entries without the marker, or under another data dir's level, are never touched.

Every removal re-checks that the path is under the root by real path, is a directory, not a link, and is
listed by git as a worktree of the project's repository, before `git worktree remove`.

## 8. Components

| Unit | Change |
|---|---|
| `packages/db` | the columns and indexes in §4; `insertBatch` takes `worktreePath`; `findUnfinishedBatch` is shared-only; `listUnfinishedBatches`; claims take `scope` |
| `packages/contracts` | §4's fields, `BatchStartInput.batchId`, the array answer |
| `apps/daemon/src/git/` | `addWorktree`, `removeWorktree`, `listWorktrees`, `pruneWorktrees`, `pinWorktree`; `checkout-pins` keyed by batch for worktrees |
| `apps/daemon/src/delivery/` | `checkoutOf`; the worktree cut, grouping (W3), the seed copy, the launch rule, ship's checkout, cleanup, the sweep, recovery and cards |
| `apps/daemon/src/runner/`, `mcp/tools.ts`, `recovery/`, `verify/` | the workstream's checkout from `checkoutOf` instead of `project.repoPath` (cwd, guard, file tools, commit, handoff, step-end diff, gate, the session's `.mcp.json`). Approvals keep reading the main checkout's `.mcp.json` in `daemon/services.ts`; a session matches its worktree's servers against them as it does today |
| `apps/daemon/src/sandbox/` | no rule changes; callers pass the worktree as the project checkout and every live worktree in `checkouts` |
| `apps/daemon/src/scheduler/` | the launch rule per batch, not per project; area claims scoped by W9 |
| `apps/daemon/src/daemon/` | the worktree root (env, refusal at start), the sweep at startup; the root joins `createGit`'s lane roots (`laneRoots`) and every live worktree (W14) joins the `checkouts` handed to the lane, gate and MCP sandboxes; `checkout-pins.ts` and `git-refusal.ts` resolve a worktree path to its project (W6) |
| `apps/daemon/src/watcher/` | one watch per live checkout; holders by scope (W9) |
| `apps/desktop` | the project form's workspace mode and seed; one compact strip per open batch (the worktree path is in the copy button's tooltip); "Add a fix task" |
| docs | `02-batch-delivery.md`, `03-trust-boundaries.md` (worktree as a checkout), `docs/security.md` (one line), `docs/open-items.md`, and the decisions in the format `main` uses |

## 9. Security

Nothing new runs outside the sandbox. The daemon's new git calls (`worktree add/remove/list/prune`,
`update-ref`) run with decision 129's config, so no hook, filter or fsmonitor runs. The seed copy reads only
the main checkout, which in worktree mode no lane can write (W8), copies links as links, and never follows
one; a seed entry is a directory name (no `/`, not `.` or `..`, not `.git`), checked when saved.
Removal deletes only what git lists as the project's worktree under the root (§7). A lane's profile is
today's with the worktree as its checkout: it can't write the main checkout, another worktree, the worktree's
own git dir, its gitfile or the common dir (decisions 130–131).

## 10. Testing

Real git in temp repos with a bare `origin`; fixtures turn off maintenance (`testing.md`).

- **Table-driven cut checks** in worktree mode: one row per refusal, asserting the card, that the row is gone,
  and that no worktree, directory or lock is left.
- **Concurrency:** three task starts make three worktrees and branches; their workstreams launch in one tick
  with the same area claimed; a hazard still serializes them.
- **Grouping (W3):** a set with a chain and an independent task makes two batches.
- **Ship:** a worktree batch gates in its worktree, pushes its branch to the bare origin, records the PR and
  removes the worktree; the main checkout's HEAD, index and files are untouched (compare before and after).
- **Recovery:** a batch left after each cut step, each ship step and between `SHIPPED` and removal recovers
  with one PR, the bare origin at the same SHA, and `git worktree list` holding only live batches.
- **Sweep:** a 10db-locked orphan is removed; an unlocked worktree and one outside the root are untouched.
- **Sandbox:** the lane profile for a worktree batch denies writes to the main checkout, a sibling worktree,
  the worktree's git dir and gitfile, and the common dir (profile assertions; the Seatbelt suite gains one
  probe).
- **Shared mode:** the existing delivery, scheduler and runner suites pass unchanged.
- **Desktop:** the strips render one per open batch; the project form saves the mode.
- **Manual acceptance** (10db on itself, by the builder): three UI tasks run at once in three worktrees and
  ship three PRs; `mise` needs no trust prompt for a worktree under the root.

## 11. Not covered

Ports per worktree; a setup command run in the sandbox; parallel ships; rebasing; per-task mode choice;
dropping `tasks.workspace_mode`. Each goes to `docs/open-items.md`.

## 12. Builder's original questions

| Question (handoff) | Answer here |
|---|---|
| Where worktrees live; cleanup after merge, cancel and failure | W4, W12 |
| Area claims between worktrees; cutting and refreshing against `origin/main` | W9; §5 cut, W11 |
| Shared `node_modules`/`target`: install per task vs sharing | W10 and §6, measured |

## 13. Calls to review

W1 (mode per project), W2 (batch row is the unit), W3 (dependency grouping), W4 (`~/.10db/worktrees`), W9
(areas per batch), W10 (seed by clone), W11 (no auto refresh), W12 (cleanup rules), W13 (two queues per project), W14 (`worktree_path` cleared on removal).
