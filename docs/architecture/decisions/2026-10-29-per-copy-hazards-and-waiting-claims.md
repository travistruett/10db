# A hazard is held per copy or per project, and a refused claim waits

- **Date:** 2026-10-29
- **Amends:** W9 of `docs/superpowers/specs/2026-10-27-10db-worktree-mode-design.md` ("hazard claims stay
  project-wide") and `decisions/2026-10-27-worktree-claims-scope.md`

## Decision

**Scope.** A hazard has a `scope`: `copy` or `project` (`HazardDef.scope` in `packages/contracts`, read by
`hazardScope`). A `copy` hazard is exclusive within one copy of the repository, which is a worktree batch's
worktree, or the project's checkout when the batch has no worktree (In Your folder mode every task shares one
copy, so nothing changes there). A `project` hazard is exclusive across every task of the project. The claim row
is scoped exactly as an area's is: its batch id when the batch has a worktree, else the project id
(`copyHazardNames` names the per-copy ones; `acquireClaims` takes them as `copyHazards`). The scheduler's launch
claims, the MCP `request_claim` and the watcher's holders and foreign-write check all go through that one rule.

| Hazard       | Scope     | Why                                                                                                                    |
| ------------ | --------- | ---------------------------------------------------------------------------------------------------------------------- |
| `harness`    | `copy`    | `AGENTS.md`, `.claude/**` and `.codex/**` are tracked files each worktree has its own version of.                      |
| `deps`       | `copy`    | `package.json`, the lockfiles and `node_modules` are each worktree's own; a clash is settled at merge.                 |
| `migrations` | `project` | Running a migration changes a database every copy shares, and two PRs numbering the next migration collide at merge.   |
| any other    | `project` | A hazard the builder adds names something nobody decided to duplicate (a port, Docker, a database): shared until said. |

A stored hazard with no `scope` (every project made before this) takes its stock namesake's scope, else
`project`; nothing is migrated, and Settings writes the scope out the next time the builder saves the project's
areas and hazards. Settings shows a "Held per copy" checkbox on each hazard.

**`deps` in full.** The install commands (`pnpm add`, `pnpm install`, `npm ci`, `cargo update` and the rest) are
per copy too, not one at a time per machine. A worktree has its own `node_modules` (seeded by clone, then
installed from its own lockfile, `2026-10-28-worktree-dependency-install.md`), a lane's package caches and
`CARGO_HOME` are its own under its temp dir (decision 126), and pnpm keeps the shared store consistent with its own
locks. The daemon already runs several worktree installs at once, outside the gate slots, and accepted that.
`npm ci` deleting `node_modules` reaches only its own copy. A lane that edits `package.json` still cannot run an
install in its sandbox (`2026-10-28-worktree-dependency-install.md`, "Not done"); that is unchanged and is not a
claim question.

**`.claude/**` and `.codex/**`.** No separate guard. Nothing shared lives there in worktree mode: a worktree lane
edits its own tracked copy, and the main checkout's is denied to it as a whole. What must never be edited by a lane
(`.claude/settings.json`, `.claude/hooks`, `.claude/skills`, `.claude/settings.local.json`) is refused by the
sandbox's `denyWrite` list and the guard's protected paths, whichever claims the lane holds. The claim only orders
two tasks that share a copy.

**Waiting.** `request_claim` no longer returns when another task holds the claim. It raises one card ("Waiting for
hazard harness") whose body names the holder's task, says this task is waiting and continues when the claim
frees, and gives the reason. The call polls every two seconds (`claimPollMs`), takes the claim when it frees
(the card is then withdrawn) and returns `granted: true`, so the agent never carries on without it. If the holder
changes meanwhile, the card is reworded. The wait ends with an error telling the agent to end its turn when the
session stops (the card is withdrawn). The scheduler's launch claims already waited: the task stays `QUEUED`
until its claims are free, with no card.

The one case that still returns `granted: false` is a deadlock: the holder is itself waiting, directly or through
other waiters, for a claim this task holds. Waiting would never end, so the call returns at once with a "Claim
deadlock" card naming both tasks, and the agent decides (finish and release, or `ask_human`). The holder's wait is
known from its open wait card (`detail.waitingFor`, `detail.heldBy`).

## Why

The first task to reach the end of its work took `harness`, so every other task in another worktree was refused
for the docs the repo requires of it, with a card offering only Dismiss and an agent left to decide alone what to
do without the claim. The claim stood for a resource the two tasks never shared: each had its own `AGENTS.md`.
Hazards exist for shared resources (W9), so the cut is by what is shared, and it is the builder's to change per
hazard rather than a rule by name.

Rejected: dropping `harness` and `deps` from the default hazards (the guard then no longer prompts for a claim in
shared mode, where the copy is shared); a per-machine lock for installs (it is the queue this removes, for a risk
the store's locks already cover); a wait that parks the session after the human-wait minutes (the card is a flag
no answer resumes, and a parked session would never be woken when the claim frees, so the wait stays inside the
tool call and the workstream stays `RUNNING`); pushing the release to the waiter (a poll is one cheap read per
waiting task, with no new channel between the claims store and the MCP handlers).

Not done: the Board's proposal (`picker/pick.ts`) still treats two tasks that name the same hazard as clashing,
since it does not yet know which batch a pick will join; the builder can still start both. A waiting task shows no
state of its own, only its card.
