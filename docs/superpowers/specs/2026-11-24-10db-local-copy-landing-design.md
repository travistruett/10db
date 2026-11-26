# 10db local copy landing: a separate copy for a Commit Directly project

**Status:** designed 2026-11-24, revision 2, not built. Size: Core (git, recovery, sandbox).
**From:** the lane isolation brief (`~/Agents/notes/10db/2026-11-24-lane-isolation-brief.md`, revision 5) and the
round-1 reviews (Fable and Astra, `~/Agents/notes/10db/2026-11-24-local-copy-spec-review-*-r1.md`).
**Extends:** `2026-10-27-10db-worktree-mode-design.md` (worktrees), `2026-10-29-10db-task-placement-design.md`
(placement per task). **Starts after:** lanes can run Ampsio's backend checks (10db-2b's lane-env work) and #813.
#811 has merged.

## Brief

**What changes for you.** A project that commits straight to a local branch (Ampsio: `build`, never pushed) can put
a task in a **separate copy**: its own branch, folder and database. 10db moves `build` to the copy's work only after
review accepts it and the full gate passes on the exact commit that lands. Your folder and `build` only ever receive
finished work. This is a **pilot**: one copy at a time, backend tasks, run once on a Claude lane and once on a Codex
lane. Its numbers decide what gets built next.

**What it buys.**
- Work that fails review never reaches `build`. AMP-147 left 11 commits there.
- Edits from your other sessions can't break the task's checks (AMP-119; 79 "Write outside every claim" cards).
- Measured numbers for parallel copies, the resource broker, nightly batches and the Here/Away presets.

**What could go wrong, and how we'd know.**
- **A save in your editor during the landing.** 10db lands only when your folder has no edits in the files it
  writes. A save in the moment between git's own check and its write can be overwritten, as with `git pull`. This
  is your decision (a), so reviewers don't reopen it.
- **A crash mid-landing.** A journal records each step. On restart 10db reads the branch, index and files together
  and finishes, retries, or leaves one card naming what it found. It never guesses.
- **Your folder is off `build`, or has edits where the landing writes.** The landing waits with one card and touches
  nothing.
- **Docker reach is unchanged** (your decision). A lane can still reach `amps_dev` through Docker, as it can today.

**Calls you might disagree with** (each with its cost if wrong).
1. **No secrets and no setup command.** 10db hands the copy one plain id, `TENDB_COPY_ID`. Ampsio's make targets name
   the copy's databases from it and create them on first use. Cost: Ampsio's make targets carry the provisioning.
2. **No `amps_dev` migration after a landing in the pilot.** You approved it. It's deferred, not refused. A landing
   that brings migrations raises one card telling you to apply them, which is what you do today. Cost: you migrate
   by hand during the pilot.
3. **No new Slack path.** The landing's after picture goes through today's picture and Slack pipeline, which can
   double-post after a crash mid-post, as it can today. Cost: an occasional double post.
4. **The before picture is the one taken when the task starts**, not at landing. Cost: if `build` moved during the
   task, the before shows the older `build`.
5. **A landing waits for `build` to be still for 10 minutes** after three races with it, rather than re-gating each
   time (Ampsio's gate takes about 18 minutes). Cost: a landing on a busy day waits longer.

**What's needed from you.** Nothing. Ampsio's side (§9) is an Ampsio task, and the one-line D-13 exception is
already decided.

## 1. Scope

In:
- separate copies for single tasks of a `delivery: local` project with `localCopies` on;
- landing onto the local base after review and a gate on the landing commit;
- a journal and recovery for every landing step;
- a teardown command run when the copy is retired.

Out, until the pilot's numbers say otherwise:
- parallel copies, Docker CPU sharing and the resource broker;
- batches of several tasks, and landing on a branch other than the base;
- `amps_dev` migration after a landing;
- the Here/Away presets, reading GitHub's repo rules, dependents on team repos;
- tasks that change a lockfile.

## 2. Settings and admission

New project fields (`ProjectInput`, `packages/contracts/src/entities.ts`):

| Field | Type | Default | Meaning |
|---|---|---|---|
| `localCopies` | boolean | false | Allows a separate copy for a task of a `delivery: local` project. |
| `copyTeardownCommand` | string or null | null | Run when a copy is retired (§3). Required when `localCopies` is on. |

Both are set in Settings › Delivery, shown only for local delivery: one switch and one command field.

Rules that change:
- The refine "A worktree per task needs pull request delivery" (`entities.ts:620`), the same check in
  `updateProject` (`store/projects.ts:250`), `placementFor` (`store/tasks.ts:362-374`) and `placementRefusal`
  (`store/tasks.ts:1349`) accept `delivery: local` with `localCopies` on.
- The project's default `workspaceMode` stays `shared`. The builder puts the pilot task in a copy with the task's
  placement control. A project default of `worktree` stays pull-request only.
- `startBatchApart` (`delivery/start.ts:269`) still refuses several tasks at once for a local project. One task in a
  copy starts.
- **Start routes by the task's placement, not the project's delivery.** Today a local project's start goes straight
  to `startTaskWithPlan` in your folder (`daemon/services.ts:547-551`). A task placed in a copy goes through
  `starter.startTask`, which cuts its batch, as a pull-request task does. The scheduler's checkout checks (missing
  worktree and wrong branch, `scheduler/scheduler.ts:534-554`; the branch snapshot, `scheduler.ts:640-649`) run for
  any batch with a worktree, read from the pinned batch, instead of only for pull-request projects. So a copy task
  can never launch in your folder.

A task can go into a copy only when all of these hold. Otherwise placement is refused with the reason:
- the project has a gate command (a copy lands only after one);
- the task's rigor runs a review;
- the task lands on the base (`TaskLanding` kind `base`);
- no other copy of the project is unfinished (CUTTING, OPEN, SHIPPING or FAILED). A second copy task stays queued
  until the first is shipped or abandoned, and its row says which task it waits for.

Each run pins its placement, base and delivery when it starts (task placement spec). Settings changed later never
move running work. Every path below routes on the batch's pinned delivery, never the project's current one.

## 3. The copy's life

A local copy is a batch with a worktree, as a pull-request worktree batch is. Its states are `BatchState`'s own. A
journal row (§5) is written in the cut's transaction.

1. **Cut** (`delivery/worktree-cut.ts`). As for a pull-request worktree, except:
   - the branch starts at `refs/heads/<base>`, recorded as `batches.base_sha`;
   - no origin, fetch or `gh` check runs (`worktree-cut.ts:102-162` are pull-request only);
   - seed and install run as today (`worktree-seed.ts`, `worktree-dependencies.ts`).
   - the journal row pins the teardown: `teardown_command` is the project's `copyTeardownCommand` now, and
     `teardown_sha` is `base_sha`, the commit the copy's databases are made by. A ref,
     `refs/10db/copies/<batch id>/teardown`, keeps that commit reachable until the copy is retired.
   The cut makes nothing outside git and the worktree, so recutting a CUTTING row after a crash is safe.
2. **Open.** Lanes, reviewer sessions and takeovers of the task run in the copy. Every command they run carries
   `TENDB_COPY_ID` (§4). Step and final checks run in the copy, as they do for a worktree batch.
3. **Land** (§5) once the task's run is accepted by review and no workstream of the batch has work in hand.
4. **Retire** on SHIPPED or ABANDONED:
   - The pinned `teardown_command` runs through the gate runner, unslotted, in a fresh scratch worktree of the
     pinned `teardown_sha` (no seed, no install), never in the copy. It gets `TENDB_COPY_ID`. Later changes to
     `build` or to the setting can't break a copy's teardown, since the code that made its databases is the code
     that drops them.
   - Exit 0 is done. Then the worktree, the branch and the teardown ref go as today (`worktree-cleanup.ts`).
   - A failure leaves one card with the command's log and a Retry. The worktree stays until teardown succeeds.
   - The command must be idempotent. Recovery reruns it.

A FAILED batch keeps its copy and database for Retry, as worktree batches do now. It counts as the project's one copy.

## 4. The copy id

- **Value.** `copyIdOf(batchId)`: the first 12 hex digits of the SHA-256 of the batch id. It's lowercase hex, so
  it is safe as part of a Postgres name and needs no escaping. It is not a secret.
- **Stored** in the journal row, so recovery and teardown don't recompute it from a changed rule.
- **Handed** by one function, `withCopyId(env, copyId | null)` in `sandbox/command-env.ts`. It removes
  `TENDB_COPY_ID` from the merged env, then sets it only when `copyId` is given. Each builder applies it **last**,
  after the allowlisted env, `prepareCommandEnv` and any server's own env are merged. So the project's env, the
  builder's shell and an MCP server's `env` can never supply the name, and a command with no copy never has it.
  The builders:
  - Claude lanes, on any account (plan, API key, Bedrock): the env file the sandboxed shell sources
    (`lane-sandbox.ts`, `createLaneEnvFile`);
  - Codex lanes: `shellEnv` (`lane-sandbox.ts:571`), which `codex-lane-config.ts:65` sets as
    `shell_environment_policy.set`;
  - gate runs and the teardown: `gate-sandbox.ts`'s `commandEnv`;
  - the session's sandboxed MCP servers: `mcp-sandbox.ts:166`.
- `copyId` comes only from the journal row of the batch the command runs for: a session's batch (on every start
  and resume, reviewer and takeover sessions included), the gate's batch, or the copy being torn down. A session,
  gate or teardown of a copy batch whose journal row can't be read doesn't run, and raises one card. Without the id,
  Ampsio's targets would act on the folder's own databases.
- `TENDB_COPY_ID` joins `ALLOWED_NAMES` (`sandbox/env-allowlist.ts`), as `TENDB_SANDBOX` has. A name off the list
  becomes a `credentials.envVars` deny in the Claude profile (`lane-sandbox.ts:526`, `profile.ts:407`), while Codex
  and the gate would still get it, so the providers would differ.

## 5. Landing

Landing replaces the push and pull request in the batch's ship steps (`delivery/ship.ts` `shipSteps`), in the
project's ship queue (`delivery/jobs.ts`), one job at a time. The journal owns it: a resumed landing starts from the
journal's step, never from step 0.

**Journal.** A new table, `local_copies`, one row per copy batch:

| Column | Meaning |
|---|---|
| `batch_id` | the batch (primary key; deleted with the batch) |
| `copy_id` | §4 |
| `step` | `open`, `merging`, `gating`, `gated`, `promoting`, `landed`, `retiring`, `retired` |
| `base_tip` | T, the base the step expects |
| `candidate` | C, the commit that lands |
| `attempt` | races with the base so far |
| `wait` | null, `folder_off_base`, `edits_in_the_way`, `index_locked`, `base_moving` or `conflict` |
| `wait_detail` | the paths or branch the wait's card names |
| `retry_at` | when a timed wait checks again |
| `teardown_command` | the teardown command, pinned at the cut |
| `teardown_sha` | the commit the teardown runs from, pinned at the cut (§3) |
| `updated_at` | |

A step's row is written before it acts. Its outcome is written before the next step's intent.

**Leaving and re-entering.** Any transition of the batch to FAILED or back to OPEN (a gate failure, a merge fix, a
refusal) resets the journal to `step: open`, clears C and the wait, and sets `attempt` to 0. There is one exception:
an interrupted landing (§8 row G) fails the batch with the journal kept at `promoting`, T and C, because its Retry
needs them. Retry of that batch goes SHIPPING and resumes the landing at `promoting`, which runs the classifier
again (`ship.ts:1400-1403`'s `toShipping` then `resume`). Abandon is refused while the journal is at `promoting`:
the folder may hold files of C, so it is settled first. Every entry at
`gating`, `gated` or `promoting`, live or at recovery, first checks that the copy's head is still C, and goes back
to step 2 if it isn't.

**Steps.**

1. **Preconditions.** The task's run is accepted by review. No workstream of the batch has work in hand. The copy
   is clean on its branch (the private-index status check). The diff from `base_sha` touches no path of the
   project's `deps` hazard; if it does, the batch fails with a card saying the pilot doesn't land lockfile changes.
2. **Merging.** Read T = `refs/heads/<base>` in your folder. If the copy's head contains T, C is the head. Otherwise
   T is merged into the copy's branch, in the copy, with `Git.mergeIntoBranch` (`resolve: { generated }`, as
   `base-update.ts` does). That takes the copy's lock, not your folder's.
   - Base update for a local copy reads the local base and never fetches (`base-update.ts:1287-1297,1615`).
   - A conflict holds the landing (`wait: conflict`) and goes to the task as a merge fix, as `sendToMerge` does for
     a pull-request batch. The fix's run must be accepted by review again before the landing restarts. A merge
     10db settles by itself (generated files, both sides' added lines) needs no new review: the gate covers it.
   - Write `step: gating` with T and C.
3. **Gating.** If the batch's last passing gate ran on C, skip to step 4. Otherwise run the full gate in the copy, as
   step 2 of `shipSteps` does, in the gate slot. The gate is bound to C: the copy's head is C and the copy is clean
   before the gate starts and after it ends. If either check fails, the gate counts for nothing and the batch fails
   with "the gate changed the copy". The gate's log stays in the data dir, as today. A failure takes today's
   gate-failure card and fix loop. A pass writes `step: gated`.
4. **Promoting.** Write `step: promoting`. Then `Git.promoteFastForward` (below) on your folder with T and C. Its
   outcomes:

   | Outcome | What 10db does |
   |---|---|
   | `promoted` | `step: landed` |
   | `base_moved` | `attempt + 1`, back to step 2. On the fourth race, `wait: base_moving` with one card, "build keeps moving; the landing waits for it to be still for 10 minutes". `retry_at` is 10 minutes after the last base change. Each base change pushes it back. |
   | `off_base` | `wait: folder_off_base`, one card naming the branch your folder is on |
   | `in_the_way` | `wait: edits_in_the_way`, one card naming the files |
   | `index_locked` | `wait: index_locked`, retried every 30 s. After 10 minutes, one card saying another git holds your folder's index |
   | `filters` | the batch fails with a card naming the paths whose git filters 10db won't run |
   | `unclear` | read the folder (§8's classifier) and act on its row |

   A wait's card is withdrawn when the landing goes on. Waits recheck when the folder watcher reports a change to
   HEAD, the base ref or a named path, and every minute. All waits live in the journal, so a restart keeps them.
5. **Landed.** One write: the batch goes SHIPPED and the journal's `step: landed`, in one transaction, so
   neither is ever found without the other. Then:
   - if T..C touches a path of the project's `migrations` hazard, one card: "This landing brought migrations into
     build: <paths>. Apply them to your dev database before you use the app." Its key is the batch, so a rerun
     raises it once;
   - the after picture (§6);
   - `step: retiring`, and retirement (§3).

**`Git.promoteFastForward({ repo, branch, expected: T, candidate: C })`**, a new operation in `git/git.ts`. It
takes your folder's repo lock once, and calls nothing else that takes it (`withRepoLock` isn't re-entrant,
`git.ts:1474`). Inside the lock, in order:
1. `refs/heads/<branch>` isn't symbolic and equals T; else `base_moved`.
2. HEAD is the symbolic ref `refs/heads/<branch>`; else `off_base`.
3. C descends from T; else `base_moved`. Only a fast-forward lands. Nothing is ever merged in your folder.
4. No path in T..C needs a filter; else `filters`.
5. `update-index -q --refresh`, then the check for your edits in the written paths (`changes`,
   `untrackedInTheWay`). Any hit is `in_the_way`. The refresh comes first, so a file touched but unchanged doesn't
   block.
6. `read-tree -m -u T C`. A refusal naming `index.lock` is `index_locked`. Any other failure is `unclear`.
7. `update-ref --no-deref <ref> C T`, compare-and-swap on the branch.
8. If the swap fails, read the ref again. If it's still T, HEAD is still the branch, and the index's tree is C's,
   put the files back with `read-tree -m -u C T` and answer `base_moved`. Otherwise touch nothing and answer
   `unclear`. The branch moved under files 10db wrote, so only §8's classifier and a person may decide.

The residual window (decision (a)): `read-tree` checks each file against the refreshed index, then writes it. A save
between those two moments is overwritten. This is the same as `git pull`, and no test claims otherwise.

## 6. Pictures and Slack

- **Before.** `takesPictures` (`pictures/picture-routes.ts:74-82`) counts a task in a local copy as it counts a
  Your-folder task. Its before is taken at first launch, as theirs is. Your folder still shows `build` then, so the
  before shows the stack as the task found it. `before-rule.ts` doesn't change.
- **After.** A copy task's after is asked when its batch goes SHIPPED by a landing, not when its workstream goes
  DONE. Start-up's catch-up asks afters for copy tasks shipped in the last hour that have none, as it does for
  Your-folder tasks done in the last hour.
- **Slack** posts the after through today's `onAfterCapture` → `announceTask` path. Its receipts, retries and
  start-up catch-up stay as they are, including a possible double post after a crash mid-post (call 3).
- **Stack readiness.** The after can be taken before `make watch` has synced the landed files into the stack.
  Today's Your-folder afters share that risk. The pilot measures it (§13). A fix waits for the numbers.
- Sharing turned off, no routes, and a failed dev login behave as they do today.

## 7. Dependents

A task in a copy can reach Done before its work lands. `dependenciesDone` (`store/tasks.ts`) counts a Done task
whose latest batch is a local copy that hasn't shipped as not done. Its dependents wait for the landing, except a
dependent whose own latest run is in that same copy: the dependency's work is already on its branch, so it starts,
and the copy lands both together. A pull-request batch has no such wait, so the case doesn't arise there.

## 8. Recovery

**The folder classifier.** One function reads your folder for T and C, and is used both live (`unclear`) and at
start-up. With W the paths T..C writes, it reads HEAD, R = `refs/heads/<base>`, and each W path's index entry and
file, against both T and C:

| Row | What it reads | What it means | What 10db does |
|---|---|---|---|
| A | HEAD isn't `refs/heads/<base>` | you switched branch | `wait: folder_off_base` |
| B | R is C, or descends from C | landed (later edits and commits are yours) | `step: landed`, go on |
| C | R is T; W's index and files match T | nothing written | retry step 4 |
| D | R is T; W's index and files match C; nothing staged in W besides C's | crashed between `read-tree` and `update-ref` | compare-and-swap T → C; a race is row G |
| E | R descends from T, not from C; W's index and files match R | build moved; nothing of 10db's written | back to step 2 |
| F | R is T or descends from T, not from C; W's index matches R; some W files differ from both R and C | your edits, nothing of 10db's written | `wait: edits_in_the_way`, naming those files |
| G | anything else | mixed index or files, or build moved under files 10db wrote | the batch fails (`BatchFailure` for an interrupted landing) with the journal kept at `promoting` (§5), and one card naming the paths and refs, with a Retry that runs the classifier again. Nothing in your folder is touched; the copy keeps the work |

10db never runs `read-tree`, a reset or a checkout on your folder at recovery, except for the swap in row D. Row G is
the only one a person settles: they put the folder in a state of rows B to F, then press Retry.

**At start-up** (`delivery/recover.ts`), by journal step:

| Step | Recovery |
|---|---|
| CUTTING batch | recut as today. `cuttableAgain` tests the branch against `refs/heads/<base>` for a local copy, not `refs/remotes/origin/<base>` (`recover.ts:140`) |
| `open` | the batch is recovered as an OPEN worktree batch today |
| `merging` | if the copy's head contains T, record C and go to `gating`; else redo step 2. A half-written copy is made whole first (`ensureWorktreeWhole`) |
| `gating` | a surviving gate process is ended (`recover.ts` step 2), then the gate reruns on C. If the copy's head isn't C any more, back to step 2 |
| `gated` | step 4 |
| `promoting` | the classifier |
| any wait | restored from the journal. `retry_at` holds for `base_moving`; the others recheck at once |
| `landed` | the migrations card by its key, then retire. Pictures catch up by themselves (§6) |
| `retiring` | the pinned teardown reruns from `teardown_sha` |

A SHIPPING local-copy batch goes to `shipper.resume`, which routes it to the landing, starting from the journal's
step. A SHIPPED copy's worktree is removed only after its teardown succeeds (`recover.ts` step 5 calls the copy's
retirement).

## 9. Ampsio's side (an Ampsio task, its own process)

1. **AGENTS.md D-13.** One line: 10db may create private branches and worktrees for its copies. Sessions still never
   create or switch branches.
2. **Names**, when `TENDB_COPY_ID` is set (it must match `^[0-9a-f]{12}$`, or the target refuses):
   - the copy's app database `amps_lane_<id>`. It has no "test" in it, so the test runner can never drop it
     (`test_utils/run_tests.py`, `is_run_database_name`);
   - test runs `amps_test_lane_<id>_<run>`, with the runner's worker suffixes, dropped when pytest exits as today;
   - `DATABASE_URL`, `DATABASE_OWNER_URL` and `DATABASE_SUPPORT_URL` all name `amps_lane_<id>`, with the dev roles and
     passwords `.env` already uses. pgbouncer routes any database name (`* = host=db`). `DATABASE_ADMIN_URL` is
     unchanged.
3. **Created on first use** by any copy-aware target: `CREATE DATABASE amps_lane_<id> TEMPLATE <the migrated test
   template>`, found the way `database_template.ensure_template` finds it. "Already exists" counts as success. A clone
   doesn't carry database-level grants (`database_template.py:268-272`), so the target then runs
   `GRANT CONNECT, TEMPORARY ON DATABASE amps_lane_<id>` to the dev roles, as the folder's database has them. No role is created or altered, and no password changes: `prepare_roles_and_database` touches
   cluster-wide roles, so it isn't used.
4. **Copy-aware targets.** `make t`, backend `make lint`, `make migration`, `make migrate`, `verify-backend` and
   `gate.sh` run in a one-off container from the backend image when `TENDB_COPY_ID` is set. The container mounts
   the copy's `amps/backend` read-write and the virtualenv read-only, uses the copy's names, and joins the stack's
   network. They never `exec` into the `amps` stack. In your folder nothing changes. The gate runs every check it
   runs in your folder, against the copy's files; its frontend checks use the copy's own seeded tree.
5. **Refused in a copy**, with a message saying so: `make api-client`, the frontend-paired helpers, and anything
   that changes a lockfile or the virtualenv.
6. **`make copy-teardown`** (the project's `copyTeardownCommand`): ends connections to and drops `amps_lane_<id>`
   and every `amps_test_lane_<id>_*`, `IF EXISTS`. It touches no other name.
7. **Pilot tasks** are backend tasks that change no lockfile and need no API-client regeneration. Ideally they add
   no migrations; if one does, §5's card covers it.

## 10. Provider parity

- **Same everywhere.** The copy, its id, the gate, landing and recovery are 10db's, not the model's. The id reaches
  Claude lanes (plan, API key, Bedrock) through the env file and Codex lanes through `shellEnv`, both from
  `withCopyId`, so no provider can differ.
- **Unattended.** Every wait and refusal above is a card, the same on every account. The project never moves to
  another account.
- **The pilot** runs on a Claude plan lane and a Codex lane. API-key and Bedrock lanes are checked before any preset
  ships.

## 11. Trust and limits

- **What runs unjudged.** The gate and the teardown run through the gate runner, outside the judge, as gates do
  today. The teardown runs from the base's tip: the builder's commits plus landed work that passed review and the
  gate. `build` can still hold unreviewed commits from shared-folder tasks, as it does today.
- **Docker reach is unchanged** (the builder's decision). With `sandboxDocker` on, a lane and a gate get the engine
  (`sandbox/lane-sandbox.ts:477`, `gate-sandbox.ts:281`) and can reach any database or folder. The judge is the
  guard, as in the shared folder. This spec adds no reach.
- **No new secrets.** The copy id is a name, not a credential. Postgres roles are cluster-wide and stay as they are.
- **Coordination.** Copy tasks take area claims scoped to their batch (W9), and hazard claims (`migrations` is
  project-wide) as today.

## 12. Tests

Following `.claude/rules/testing.md`: git and recovery are core. Each commit that adds a test carries its value card.

1. **`promoteFastForward` in a real git repository:**
   - an edit in a written path answers `in_the_way` and writes nothing;
   - a file touched but unchanged doesn't block (refresh before check);
   - a commit on the base between `read-tree` and `update-ref` answers `unclear` and leaves the files alone.
2. **The classifier as one table test** in a real repository: rows A to G, each from a real folder state.
3. **One wiring test:** a resumed copy session's Claude env file, its Codex `shellEnv`, an MCP server whose own env
   sets `TENDB_COPY_ID` to something else, and its gate env all carry the journal's id; the Claude profile's
   `credentials.envVars` denies don't name it; and a shared-folder gate whose project env sets it gets none.
4. **One e2e flow extended** (`apps/desktop/e2e/loop.spec.ts`, real daemon and app, local delivery already): with
   `localCopies` on, a task is put in a separate copy from its placement control, runs, and its commit reaches the
   folder's base only after its gate.

No other test is added. Waits, cards and the pictures hookup are checked by the pilot itself.

## 13. Measurement (a script, not product code)

The script lives in the coordinator's scratch, not the repo. It reads SQLite read-only, and samples `docker stats`
every 5 s for the whole task. Per pilot task it reports:
- outcome, and refusals (`skipped_actions`);
- gate wait, from `waitedMs` (`verify/gate-slots.ts:172`);
- wall time, and time from landing to SHIPPED;
- peak Docker CPU and memory;
- disk used by the copy's worktree and databases (`du`, `pg_database_size`);
- how long after promotion its after picture was taken;
- cleanup readback after retirement: no worktree, no branch, no `amps_lane_<id>` or `amps_test_lane_<id>_*`
  database.

Baseline: the shared-folder profile (`2026-11-24-ampsio-lane-profile.md`).

## 14. Decisions this records

One file each under `docs/architecture/decisions/` when built:
- a Commit Directly project may use separate copies behind `localCopies`, one at a time in the pilot;
- a copy lands only after review and a gate on the exact commit, by fast-forward only;
- a landing accepts git's own editor-save window, the same as `git pull` (the builder's decision (a));
- Docker reach for copies is unchanged in the pilot (the builder's decision);
- `amps_dev` migration after a landing is deferred from the pilot.

## Appendix: round-1 findings and what revision 2 did

| Finding | Resolution |
|---|---|
| Fable 1, Astra 1: the outer lock deadlocks; a merge could land an ungated commit | `promoteFastForward`: one lock, fast-forward only, bound to T and C, refresh before check (§5) |
| Fable 2: promotion outcomes with no card | the outcome table (§5) |
| Fable 3, Astra 5: recovery gaps | the journal owns the landing; the classifier; the step table (§8) |
| Fable 4, Astra 6: Slack reposts | no new path; today's behavior, as call 3 (§6) |
| Fable 5, Astra 7: the env allowlist refuses the keys | one non-secret id added after filtering (§4) |
| Fable 6, Astra 9: after-landing can't run in the gate sandbox | migration deferred; a card (§5 step 5) |
| Fable 7: editor-save claim overstated | the window stated; the builder's decision (a) |
| Fable 8, Astra 4: test names, roles, aliases | `amps_lane_<id>`, `amps_test_lane_<id>_<run>`, every alias, no role changes (§9) |
| Fable 9, Astra 10: no e2e | one flow extended (§12.4) |
| Astra 2: secrets through stdout and arguments | no secrets (§4, §11) |
| Astra 3: provisioning before any record | nothing is made at the cut; Ampsio creates on first use; teardown required and idempotent (§2, §3, §9) |
| Astra 8, Fable 11: origin, fetch and guards; review after a conflict fix | pinned local delivery at every entry point; review again after a conflict fix (§2, §3, §5) |
| Fable 10: rollback after a hand commit | rollback only when the ref is T and the index holds C (§5 step 8) |
| Fable 12, 13: secrets and trust wording | no secrets; §11 rewritten |
| Fable 14: a landing-time before is dropped | the before at task start (§6, call 4) |
| Fable 15: gate thrash | 10 quiet minutes after three races (§5, call 5) |
| Fable 16: Done before landed | `dependenciesDone` waits for the landing (§7) |
| Fable 17: tests; reviewer and takeover sessions | four tests (§12); those sessions carry the id (§3, §4) |
| Fable 18: scratch gate logs vanish | the gate runs in the copy; logs stay in the data dir (§5 step 3) |
| Fable r2 B1: the copy id off the allowlist is a Claude deny | `TENDB_COPY_ID` joins `ALLOWED_NAMES`; the wiring test checks the denies (§4, §12.3) |
| Fable r2 B2: classifier's last row stuck | row F waits on your edits; row G fails the batch with a Retry (§8) |
| Fable r2 B3: the journal isn't reset after a fix | leaving SHIPPING resets it; re-entry checks the head is C (§5) |
| Astra r2 3: teardown runs moving code | command and revision pinned at the cut, the revision kept by a ref (§3) |
| Astra r2 5: row G's failure clears C | row G keeps the journal at `promoting`; Retry resumes there; no Abandon meanwhile (§5, §8) |
| Astra r2 7: the id from another source | `withCopyId` strips the name and sets it last, from the journal only; gates and teardown refuse without it (§4) |
| Astra r2 8: a copy task starts in your folder | start routes by placement; the scheduler's checkout checks read the pinned batch (§2) |
| Astra: the brief's deferred items | §1 Out |
