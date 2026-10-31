# 10db CI decides: a pull request's required checks decide whether a task ships, and the Mac runs a fast pre-check

**Status:** designed on 2026-10-31, not built. **Extends:** `decisions/2026-10-29-sandbox-is-the-boundary.md`
item 3 ("CI decides", designed only) and `decisions/2026-10-30-done-means-merged.md`. The decision this design
records is `decisions/2026-10-31-ci-decides-when-the-base-has-required-checks.md`. Calls the builder has not made
are marked **(call)** and listed in §8.

## 1. Intent

Today every task runs the changed-packages check after each implement step (`make check-changed` here, which runs
the tests of the changed packages and their dependents, and the full gate when it cannot place a file) and the
full gate (`make gate`, about seven minutes of CPU on this repository) before the push
(`apps/daemon/src/delivery/ship.ts`, step 2), and then GitHub runs the same checks on the pull request. On a Mac saturated by parallel lanes that second run is slower, flakier and buys
nothing GitHub does not already do. The integration branch `next` (`decisions/2026-10-30-integration-branch.md`)
was a stopgap for that slowness. Once CI is the gate, tasks land in main again and `next` is retired.

**What already holds on main**, and this design builds on unchanged:

- A batch that wants to merge arms GitHub auto-merge (`gh pr merge --auto --squash`, ship step 4b), which waits
  for the base's required checks. Where the base has none, GitHub answers "clean status" and 10db squash-merges at
  once (#174, `mergeNow` in `ship.ts`).
- A shipped task is In review while its pull request is open and Done once it merges (#156,
  `deriveBoardStatus` in `packages/db/src/store/tasks.ts`).
- The pull request watch (`delivery/pr-watch.ts`) reads every `SHIPPED` batch's pull request every two minutes
  (`gh pr view --json url,state,statusCheckRollup,headRefOid`) and raises a failing-checks card.
- Before each gate a batch takes its base and settles simple conflicts itself (#173).

So "a task ships when its required checks pass" is already GitHub's rule once 10db stops running the full gate in
front of it. What is missing is the fast check on the Mac, a fix when a required check fails, and the card saying
where CI stands.

**Success means** (the task's acceptance criteria, verbatim):

1. For a project whose repository has CI with required checks, a task ships when its pull request's required
   checks pass, and no full local gate runs. (§3, once the project sets its pre-check)
2. Before pushing, 10db runs a fast pre-check that takes under 2 minutes on this repository, set per project.
   (§3, §6 T2)
3. A failed required check starts a fix session that is given the failing job's name and log, and the fix is
   pushed to the same pull request. (§4)
4. A project without CI keeps its local gate as what decides, unchanged. (§3: nothing changes until a project
   sets a pre-check, and the safety net)
5. The task card shows whether CI is running, passed or failed, with a link to the run. (§5)
6. A design document for this is written and reviewed before any code. (this document)

**Non-goals:** a new batch state; reading the base's rulesets or branch protection; the integration branch, cuts
into main or anything about `next`; rerunning a flaky check automatically; merge queues; webhooks; third-party CI
beyond what `gh pr checks` reports; updating a pull request that falls behind or conflicts after it ships (still
the builder's, `docs/open-items.md`).

## 2. The shape

```
implement steps ──pre-check after each──▶ ship: base update, pre-check, push, PR, auto-merge
                                                     │
                       pull request watch (2 min) ◀──┘   batch SHIPPED, task In review
                         │ required checks
       ┌─────────────────┼──────────────────────┬───────────────────────────┐
    pending            passing               failing on head H          merged / closed
  "CI running"       "CI passed"        fix task + follow-up batch      Done / Blocked (#156)
                   (auto-merge merges)   cut from the PR's branch at H,
                                         pushed to the same PR
                                         (at most 2; then stop: Blocked + card)
```

No batch state is added. The batch that opened the pull request (the **root batch**) stays `SHIPPED` from its
push to the merge, as today. A fix is an ordinary task in its own batch (a **fix batch**) whose branch is the root
batch's branch, so its push lands on the same pull request.

## 3. The pre-check

- **A per-project command.** `projects.precheck_command` (text, null by default), set in Settings › General as
  "Pre-check command", beside the gate and changed-packages commands. Its help text: "Runs on the Mac in place of
  the gate when the pull request's base branch has required checks on GitHub. Leave it empty to keep running the
  gate."
- **Where it runs.** With a pre-check set and pull request delivery, the runner's per-step check
  (`runner.ts`, today `changedCheckCommand ?? gateCommand`) runs the pre-check, and ship step 2 runs it after the
  base update in place of `gateCommand`: same gate slot, sandbox, priority, timeout and overload hold. Without one,
  or with local delivery, both run exactly as today. A project with no `gateCommand` runs nothing, as today: a
  pre-check without a gate command is refused in Settings ("set a gate command first"), so a project that turns
  CI off by clearing its pre-check is back on its gate. **(call: the setting alone chooses; 10db does not read
  the base's rules before the push)**
- **A failure** is the gate's failure path with its card, titled "the pre-check failed", and nothing is pushed.
  The one-rerun rule for failures the batch couldn't have caused applies only when the log has failing tests, as
  today, so it never fires for a pre-check that runs none.
- **The safety net.** When the ship ran the pre-check (not the gate) and GitHub answers "clean status" to
  auto-merge, the ship reads `prRequiredChecks` (§4) before #174's merge at once. GitHub says "clean status" both
  when the base has no required checks and when they have already passed on this head (a ship retried after CI
  finished). `passing` → merge at once, as #174. `none` → 10db does not merge: it raises a card, "not merged:
  <base> has no required checks and only the pre-check ran", linking the pull request, and leaves it open for the
  builder. Anything else (pending, failing, unknown) → no merge and no card; auto-merge is left as GitHub has it
  and the watch takes over. This keeps criterion 4 true for a project that sets a pre-check by mistake: nothing reaches its base on
  the pre-check alone. A hold batch never arms auto-merge, so it gets no such answer and needs none: the builder
  merges it.
- **The pull request body** gains one line: "Checked on the Mac: <command> (pre-check). GitHub's required checks
  decide." or "Checked on the Mac: <command> (gate).", so a reviewer sees why no gate result is attached.
- **This repository's pre-check** is `make precheck`: `scripts/check-changed.mjs --precheck`, which runs format
  and lint of the changed files, typecheck of the changed packages and every package depending on one, and drift
  of the changed packages, and no tests, Rust checks or e2e. Where it cannot place a file (lockfile, a root config,
  CI, the Makefile) or has no base, it runs those four steps over every package, never `scripts/gate.sh`. On this
  branch's gate runs of 2026-10-30 those four steps over every package took 37 to 64 seconds; the tests alone took
  250 to 361, and the daemon's own tests are over two minutes, so no choice of tests by package fits criterion 2.
  CI runs every test. The lane still runs the tests of what it changed as it works (root `AGENTS.md`).

## 4. A failed required check

### The watch reads required checks

Each round, for every open pull request of a `SHIPPED` batch, the watch also runs
`gh pr checks <url> -R <repo> --required --json name,state,bucket,link,workflow,description`, once per pull
request: a root batch and its fix batches share one `pr_url`, so the watch groups `listWatchedPullRequests` by it
and makes one `prStatus` and one `prRequiredChecks` read per pull request. The `prStatus` read is recorded
(`recordPullRequestStatus`, `pr_state` and the rest) on every `SHIPPED` batch with that `pr_url`, so a fix task
reaches Done when the pull request merges and the watch stops reading its batch. The required checks and merge
state are stored on the root batch only, and the watch's cards for the pull request (failing checks, closed) are
keyed by the root, so none is raised twice. The required checks are stored as `pr_required`:

| gh says                                           | `pr_required.state` | Notes                                                          |
| ------------------------------------------------- | ------------------- | -------------------------------------------------------------- |
| every required check `pass` or `skipping`         | `passing`           |                                                                |
| any `pending`, or `cancel`, and none `fail`       | `pending`           | a cancelled run is usually one a newer push replaced           |
| any `fail`                                        | `failing`           | the failing jobs, with links                                   |
| "no required checks reported" (exit 1, on stderr) | `none`              | before GitHub lists the runs, or a base without required checks |
| any other error                                   | unchanged           | the watch's unknown read, as today                             |

The parser takes the exit code and both streams together; "none" is matched on stderr only, so a network or auth
failure is never read as no required checks. `gh pr view` also gains `mergeStateStatus`, stored as
`pr_merge_blocked` (`conflicts` for `DIRTY`, `behind` for `BEHIND`, else null): GitHub runs no workflow on a pull
request that conflicts, so the card says that rather than "CI running" (§5).

For a pull request whose required checks are `failing`, the fix path below replaces the watch's failing-checks
card; the card stays for a failing check that is not required. **(call)**

### When a fix starts

In the round that finds the root batch's pull request open, `failing` on head `H`, and not conflicting, one pure
function, `ciFailureAction(root, required, fixes) → wait | fix | stop(reason)`, decides. It is the single place a
decision model can later take over (§9); today it is these rules:

1. **A fix already running** (an unfinished fix batch for this root) → wait.
2. **Stop**, with no fix, when any of these holds: a fix for `H` already exists (the last fix changed nothing or
   did not fix it); two fixes have been made for this root (`maxCiFixes = 2`); or no failing check is a GitHub
   Actions job (a commit status or third-party check has no log 10db can read). A fix cut that was refused also
   stops, but from the cut itself (below). See "Stopping".
3. **Read each failing job's log**: `gh run view --job <id> -R <repo> --log-failed`, the job id taken from the
   check's link (`…/actions/runs/R/job/J`). If gh says the run is still in progress, no fix this round; the next
   round reads again. ANSI codes are stripped; the full log goes to `dataDir/logs/ci/<job>-<sha>.log` and the last
   300 lines, at most 64 KiB, are kept for the task.
4. **Make the fix, in one write**: a task "Fix CI: <job> on <pull request title>", with the failing job's name, its
   link and the excerpt in its description, acceptance criterion "<job> passes on the pull request", and the root
   batch's tasks' areas; and its fix batch, a worktree batch with `branch` = the root's branch, `base_branch` and
   `auto_merge` = the root's, `ci_fix_of` = the root's id and `ci_fix_head` = `H`. A unique index on
   `(ci_fix_of, ci_fix_head)` makes a repeated round or a restart unable to make a second fix for the same head.
   The task then starts in that batch through the ordinary start path.

Auto-merge stays armed. If a rerun passes while the fix runs, GitHub merges the pull request: CI passed, and the
fix is no longer needed (below). **(call: no disarm)**

### The fix batch

- **Cut from the pull request's branch.** `cutWorktree` (`delivery/worktree-cut.ts`) today names the branch
  `batchBranchName(title, id)` and creates it with a start point. For a fix batch it uses `batch.branch` (the
  root's) instead: it fetches the branch from origin, makes or fast-forwards the local branch to `H` (a ref update
  git refuses for a non-fast-forward or a branch checked out elsewhere), and adds the worktree on that existing
  branch with no start point. It leaves `made.branch` false, so a refusal never deletes the root's branch. The
  rest of the cut (seed, install, `OPEN`) is unchanged.
- **A refused fix cut stops fixing.** `refuse()` deletes the `CUTTING` row, and with it the unique
  `(ci_fix_of, ci_fix_head)` guard, so the next round would make the same fix again. So a fix cut's refusal also
  sets `ci_stopped = 'no_cut'` on the root in the same write as the delete, and its card is the stop card
  ("Stopping"), naming the cut's reason.
- **The fix session** is a lane like any other: its plan, review and per-step check (the pre-check, §3) are the
  task's.
- **Its ship** first reads the pull request (`prStatus`). Merged or closed: the batch ends `CLOSED` with nothing
  pushed. Then, if `git rev-list --no-merges H..<tip>` is empty, the fix changed nothing: the batch ends `CLOSED`
  with nothing pushed and the next watch round stops (step 2). Merges are left out because the per-step check's
  base update (#173, `beforeGate` in `runner.ts`) merges `origin/<base>` into the branch, so a fix that wrote
  nothing still has a new tip whenever the base has moved since `H`. Otherwise the ship's steps run as for any batch: base update (#173), pre-check, push (a
  fast-forward, never forced; a push refused because someone else pushed meanwhile is today's push card),
  `prView` finds the open pull request, auto-merge is re-armed where the root wanted it, `SHIPPED`.
- **When the pull request merges or closes** while a fix batch is `OPEN` or `FAILED`, the watch stops the fix:
  it calls `runner.cancel` for each live member (which ends the session, as a cancel from the Board does), then
  `shipper.abandon` for the batch, which runs in the ship queue and retires the copy (`afterEnd`). A copy left
  with uncommitted work raises today's kept-worktree card, which is expected here. A fix batch that is `CUTTING`
  or `SHIPPING` is left to its own step: the ship's first read above ends it `CLOSED`, and an `OPEN` batch the cut
  leaves behind is stopped on the next round.

### The Board

The root batch's tasks stay In review while the pull request is open (#156). The fix task is its own card: In
progress while it runs, then In review (its batch is `SHIPPED` with the same open pull request), Done when the pull
request merges. The fix task's description says the excerpt is the job's tail and links the job, and asks a session
that cannot find the cause there to ask the builder rather than guess.

### Stopping

When step 2 or a refused fix cut stops, one write sets `ci_stopped` on the root batch (the reason: `limit`,
`no_change`, `no_log` or `no_cut`)
and raises one card, `ci-stopped:<batch>`: "CI still failing on <pull request title>: <job>", naming each failing
check with its link, saying how many fixes ran, and offering **Retry**, which runs
`gh run rerun <run> --failed -R <repo>` for each failing Actions run. While `ci_stopped` is set and the pull
request is open, the root batch's finished tasks are **Blocked** (a new rule in `deriveBoardStatus`). `ci_stopped`
and the card are cleared in one write when a read finds the required checks `passing` or `pending` on a newer
head, or the pull request merges or closes (`decisions/2026-10-30-cards-close-when-their-cause-is-gone.md`). A
Retry that reruns the jobs therefore moves the task back to In review once the run starts. The builder can also
fix it by hand: a commit they push is a new head, which clears the stop; a failure on that head starts fixing
again, within the same limit of two.

### Recovery

The watch holds no state between rounds: each round decides from the stored rows and gh's answer. A fix is made in
one write (task and batch row, guarded by the unique index), and from then on it is an ordinary batch that start
and delivery recovery already handle. Stopping is one write with its card.

## 5. The task card (criterion 5)

#156's one pull request line on the card and in the drawer takes its checks part from `pr_required` when it is not
null and not `none`:

| State                                   | Line                                                  | Colour | Link                     |
| --------------------------------------- | ----------------------------------------------------- | ------ | ------------------------ |
| `pending`                               | Pull request open · CI running                        | blue   | first pending job        |
| `passing`, open (a hold batch)          | Pull request open · CI passed                         | green  | `<prUrl>/checks`         |
| `failing`, fix running                  | Pull request open · CI failed: <job> · fixing in "<fix task>" | red | the failing job    |
| `failing`, stopped                      | Pull request open · CI failed: <job> · stopped after <n> fixes | red | the failing job   |
| merged                                  | Merged · CI passed                                    | green  | `<prUrl>/checks`         |
| `pr_merge_blocked` set, open            | Pull request open · conflicts with <base> / behind <base> | red | the pull request       |

A pull request with `pr_required` null or `none` keeps #156's line from the rollup. Links open github.com pages
only, as the watch's cards do. A fix task's card shows the same line for the same pull request.

## 6. Data, gh and build tasks

**Contracts and db** (one migration, per `packages/db/AGENTS.md`):

- `projects.precheck_command` text null; `ProjectDto`/`ProjectInput`/`ProjectPatch.precheckCommand`, refused
  without a `gateCommand`.
- `batches.pr_required` JSON null: `{ state: pending | passing | failing | none, failing: Job[], pending: Job[] }`,
  `Job = { name, link: string | null, jobId: string | null, runId: string | null, description: string | null }`.
- `batches.pr_merge_blocked` text null (`conflicts` | `behind`).
- `batches.ci_fix_of` (BatchId, null) and `batches.ci_fix_head` (text, null), unique together where set.
- `batches.ci_stopped` text null (`limit` | `no_change` | `no_log` | `no_cut`).
- `deriveBoardStatus`: an open pull request with `ci_stopped` set places a finished task in Blocked.

**gh** (`apps/daemon/src/github/gh.ts`, each with a pure parser and fixtures): `prRequiredChecks`, `jobLog`
(with "not yet" while the run is in progress), `rerunFailed`, and `mergeStateStatus` added to `prStatus`. The
flags were read in gh 2.83.2's help; T3 runs each against a real pull request first and records what gh prints
for a passing, pending, failing and cancelled check, for a run still in progress, and for `gh pr merge --auto` on
a pull request whose auto-merge is already on (a fix ship re-arms it; if gh answers with an error, the fix ship
must treat that answer as armed, not raise the refused card).

**Build tasks**, each about one pull request, landing per the project default:

| #   | Task                                                                                                                                                                                                                                                                                                                         | Depends on |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| T1  | Contracts and db: the columns and index above, the DTO fields, the migration, the Blocked rule. | — |
| T2  | `make precheck` for this repository: `check-changed.mjs --precheck` (no tests, Rust or e2e; the four steps over every package where it cannot place a file), its timing measured on four kinds of change idle and under load, each under two minutes. | — |
| T3  | gh: the spike, then `prRequiredChecks`, `jobLog`, `rerunFailed`, `mergeStateStatus`, with parsers and fixtures. | — |
| T4  | The pre-check in the daemon and Settings: the setting and its refusal, the per-step check and ship step 2 running it, its failure card, the safety net on "clean status" (which reads `prRequiredChecks`), the pull request body line, `docs/architecture/02-batch-delivery.md`. | T1, T3 |
| T5  | The watch: one read per pull request grouped by `pr_url`, `pr_state` recorded on every batch sharing it, cards keyed by the root, `pr_required` and `pr_merge_blocked` stored on the root, and the card line of §5 on the desktop. | T1, T3 |
| T6  | A fix batch's cut and ship: the cut on the root's existing branch fast-forwarded to `H` (no start point, `made.branch` false), and the ship's two checks (merged or closed → `CLOSED`; no non-merge commits since `H` → `CLOSED`), tested against a real repo with a bare origin. | T1 |
| T7  | Starting a fix: `ciFailureAction`, the log read and excerpt (and waiting while the run is in progress), the task and fix batch in one write under the unique index, a refused fix cut stopping with `no_cut`. | T5, T6 |
| T8  | Stopping and ending a fix: the stop card with its rerun Retry, Blocked, clearing it; on merge or close, `runner.cancel` then `shipper.abandon`; the fix in `docs/architecture/02-batch-delivery.md`; the open-items line removed. | T7 |

**After T6 merges and is installed** (the builder, not a task): set this project's pre-check to `make precheck`,
set its default landing back to merge into main, retire `next`, and open the third lane.

## 7. Testing and security

Red first in each task. The table-driven cases that matter most:

- **Pre-check (T4):** pre-check set and pull request delivery → it runs after each step and at the ship, the gate
  never runs; pre-check unset, local delivery or no gate command → today's behaviour, byte for byte (criterion 4);
  pre-check fails → batch failed, nothing pushed; pre-check ran, GitHub says "clean status" and required checks are `none` → not merged, card
  raised; the same with required checks `passing` (a retried ship) → merged at once; the gate ran and GitHub says "clean status" → merged at once, as #174.
- **gh parsers (T3):** `gh pr checks` by exit code and stream (0, 1 with JSON, 8, 1 with the "no required checks"
  stderr, 1 with a network error), each bucket, a check with no Actions job, a job link's ids.
- **Watch (T5):** one gh read per pull request with a root and a fix batch, `pr_state` written on both and the fix task Done on merge; each row of §4's table; the line for
  each row of §5's.
- **Fix (T6 to T8), against a real git repo with a bare origin and a fake gh:** failing on `H` → one task and fix batch,
  and a second round or a restart makes none; run in progress → no fix until the log is ready; the fix batch's
  branch is at `H` and its push fast-forwards the pull request's branch; a fix that changes nothing, with the base moved since `H` → `CLOSED`, nothing
  pushed, then stop with `no_change`; a refused fix cut → root branch intact, stop with `no_cut`, and no second fix; a third failure → stop with `limit`; only non-Actions checks failing → stop with
  `no_log`; merged while the fix runs → task cancelled, batch abandoned, nothing pushed; stop then a passing read →
  `ci_stopped` cleared, card withdrawn, task back to In review; the excerpt's fence holds a log that prints
  backticks.

**Security.** The pre-check runs under the gate sandbox as any gate does. A fix session is a lane in its own copy.
The log excerpt is text a job printed: it goes into the task description inside a fenced block one backtick longer
than the longest run in it, under a line saying it is output to read, not instructions, capped at 300 lines and
64 KiB. Only https github.com links are kept. The full log is written by the daemon under `dataDir`, never by a
lane. Every gh call uses the builder's own account; no token is added.

## 8. Calls to review

- **The setting alone chooses the pre-check (§3).** 10db does not read the base's rulesets or branch protection
  before the push. The builder sets a pre-check on a project whose base has required checks; GitHub's "clean
  status" answer is the safety net for one set by mistake. Turned down: reading the rules before each ship, which
  needs classic-protection rights, a per-step cache and a failure path of its own.
- **A fix is a follow-up batch on the same branch (§4)**, not a reopened batch, so no batch state is added
  (builder's choice, 2026-10-31).
- **A project's pre-check is unset by default (§3)**, so every project keeps its gate until the builder sets one
  (builder's choice, 2026-10-31). Fixes and the CI line apply to any pull request with required checks, pre-check
  or not.
- **After two fixes, a fix that changed nothing, or no log: stop, Blocked, with a rerun card (§4)** (builder's
  choice, 2026-10-31).
- **Auto-merge stays armed during a fix (§4).** A rerun that passes merges the pull request and the fix is
  cancelled. Turned down: disarming and re-arming, which adds a failure path for a merge that CI has approved.
- **No automatic rerun before a fix.** A flaky required check costs a fix session that should find nothing and
  change nothing, which then stops with the rerun card. Turned down for now: a rerun first costs a full CI run each
  time (`docs/open-items.md`).
- **Required failures replace the failing-checks card (§4);** a failing check that is not required keeps it.

## 9. Where a decision model fits later

The builder's direction (2026-10-31) is for a fast, cheap System One model (TypeSafe's Jev, through OpenRouter)
to make the routine calls that now cost hours: how much work a task needs, which team and effort, and how much
checking it needs. This design keeps its rules deterministic so it can ship now, and leaves two seams shaped for
that model:

- **`ciFailureAction` (§4).** Given the failing job's name and log excerpt, "flaky, rerun" versus "real, fix" is
  a `choice` question with low stakes: a wrong rerun costs one CI run, a wrong fix one session that changes
  nothing. A model answer above a confidence floor could add a `rerun` action ahead of a fix. The log is
  untrusted text, and TypeSafe documents that Jev does not treat its state as hostile, so injected text can change
  its answer; the model therefore only chooses among the actions this function already allows, never adds one.
- **The pre-check (§3).** Which checks a given diff needs on the Mac is the same kind of call; the per-project
  command stays the floor.

Both are a separate design, built after this one, with its key handled as the Artificial Analysis key is.
