# 02 Batch delivery

- **Status:** Locked
- **Scope:** How finished work leaves the machine: `local` delivery, and `pull_request` delivery with one branch and one pull request per batch.
- **Summary:** The design is `docs/superpowers/specs/2026-10-21-10db-batch-delivery-design.md`; its decisions and the plan's are rows 77–85 of `decisions.md`. Changes are new rows that name what they supersede.

## Where it lives

| Module                                         | Job                                                                                                                                    |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/db` `batches`                        | one row per batch; a partial unique index allows one unfinished batch (`CUTTING`, `OPEN`, `SHIPPING`, `FAILED`) per project            |
| `apps/daemon/src/delivery/`                    | starting (cut, join, dependency checks), shipping, the ship trigger, Ship anyway, Retry, Abandon, the launch rule and startup recovery |
| `apps/daemon/src/git/`                         | `currentBranch`, `remoteUrl`, `fetch`, `switchNewBranch`, `push`                                                                       |
| `apps/daemon/src/github/`                      | the `Gh` interface over the `gh` CLI                                                                                                   |
| `apps/daemon/src/guard/`                       | agents never push in `pull_request` projects, and run only an allowlist of read-only `gh` commands                                     |
| `apps/desktop/src/views/board/batch-strip.tsx` | the batch strip on the board; Settings' General form and the new-project form hold the delivery fields                                 |

Settings shows the base branch and the PR title prefix in either delivery, because it checks both fields whatever the delivery and an error must never be hidden; the new-project form shows them only for pull requests.

## Lifecycle

CUTTING → OPEN → SHIPPING → SHIPPED | CLOSED | FAILED; FAILED → SHIPPING | OPEN | ABANDONED; OPEN → ABANDONED. A refused or interrupted cut deletes its CUTTING row.

## Starting

- A start answers at once with what the daemon can check without git or the network: `400` for a batch start in a `local` project (a task start there runs as before) or an invalid body; `404` for an unknown project or task; `409` while the project's batch is `CUTTING` or `SHIPPING`, for a task that is not open, already running or parked in a human column, and for an unfinished dependency outside the batch. The parked check runs before any git work, so a refused start never leaves a fresh branch checked out.
- A task or batch title refuses control characters such as a newline when the task is created or edited and when a batch starts, because the title becomes the pull request's title and GitHub would refuse it only after the push.
- The git and `gh` checks run after the answer, in a background job, one at a time per project. A new batch runs the cutting checks (no lane running in the project, a clean checkout, `origin`, a fetch of the base branch, `gh` installed and signed in, the GitHub repository, dependencies merged on the base) and then cuts `10db/<slug>-<8 hex>` from `origin/<base branch>`. A join checks the branch and the dependencies, and reopens a `FAILED` batch.
- Each background refusal is one inbox card whose `detail.taskIds` names the refused tasks. A join refused for its branch, an error or a shutdown also carries `detail.batchId` (one refused for unmerged dependencies does not). A refused new batch's `CUTTING` row is deleted. A joined task arrives instead as a `workstream.created` event with its `batchId`.

## Shipping

- The ship trigger moves an `OPEN` batch to `SHIPPING` when its last member settles (`DONE` or `CANCELLED`); startup runs the same check. A member is a task's latest workstream in the batch.
- Ship anyway, on a failed member's card or on the strip, ships a batch whose members are all `DONE`, `CANCELLED` or `FAILED`. While any member still runs, waits or is queued, it is refused with the unfinished work named, in an `OPEN` or a `FAILED` batch alike, and it never reopens a batch; a refusal on the card keeps the card open.
- Retry on a failed member's card runs that workstream again in its batch. Retry on the strip acts on a `FAILED` batch: it ships settled work and otherwise reopens the batch (`FAILED → OPEN`) so the unfinished work runs and the batch ships itself.
- Abandon takes an `OPEN` or `FAILED` batch none of whose workstreams is running (in a lane, `TAKEN_OVER`, or `WAITING_HUMAN` with its session still live), cancels its unfinished members and raises a card naming the finished tasks and the local branch that holds their code.

## Recovery

At startup, after workstream recovery and before the scheduler starts:

- Each `CUTTING` row is deleted, which emits `batch.updated` with `to: null`, with a "Batch not started" card. A cut stopped by a shutdown ends here too, because shutdown leaves its row for startup. That card has `detail.batchId` but no `detail.taskIds`, since a `CUTTING` row has no workstreams to name: a client tells that its tasks were refused from the `to: null` event, not from the card.
- An orphaned shipping gate is killed by its pid and start time.
- An `OPEN` or `SHIPPING` batch whose branch is not checked out fails with a wrong-branch card.
- A `SHIPPING` batch re-runs shipping from the first step, and an `OPEN` batch whose members all settled ships.

## Guard

- In a `pull_request` project an agent's `git push` is denied. In every project an agent runs only an allowlist of read-only `gh` commands, and `gh auth status --show-token` (or `-t`, alone or in a flag cluster) is denied in both delivery modes because it prints the token.
- The guard reads a command's literal words. A flag held in a shell variable passes (`T=-t; gh auth status $T`), as a force flag held in one passes the `git push` rule in a `local` project. The guard is defense in depth for a cooperative agent, not a sandbox.

## Invariants

- The batch row exists before any git side effect; the branch is checked before every launch and every ship.
- The daemon switches branches only when no lane runs in the project; agents never do.
- Shipping steps (branch and clean check, commit count, gate, push, find-or-create PR, record) are each safe to repeat; recovery re-runs them from the first.
- Every network call runs in the login environment with prompts off, a timeout and an abort signal.
- Every refusal the request can't answer is an inbox card that says what to fix, and nothing is pushed.

## Not covered

- A fork whose clone also has an `upstream` remote. `gh repo view` without `-R` picks the base repository by remote priority (`upstream`, then `github`, then `origin`), so the batch would record the parent repository while the push goes to `origin`. `docs/open-items.md` tracks it with the spec's §9 "Later" items.
