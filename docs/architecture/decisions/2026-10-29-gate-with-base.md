# A worktree batch's branch takes its base as origin has it before every gate

- **Date:** 2026-10-29
- **Supersedes:** `decisions/2026-10-27-worktree-never-rebased.md`, and the worktree mode spec's W11

## Decision

Before each gate of a batch's work, the verify gate of every task in it and the shipping gate alike, the
daemon brings the batch's base in. It does so inside the gate's run, once the gate holds its slot and before
its sandbox or command starts (`GateRequest.beforeStart`), so no other gate's merge or install changes the tree
under a running gate. It fetches the base branch once (`git fetch` in the project's checkout, the network
timeout, the gate's abort signal; fetches of one checkout run one at a time, so two never race for the same
ref) and then:

- **Worktree mode** (`workspace_mode = worktree`): merges `origin/<base>` into the batch's branch in its
  worktree with `Git.mergeIntoBranch`, never a rebase. Up to date when the branch holds it, a fast-forward when
  the branch has nothing of its own, else a merge commit `Merge origin/<base> into <branch>` with the branch as
  first parent, made from `merge-tree --write-tree` with no attributes (so no merge driver runs), signed as
  the builder's config says, then `read-tree -m -u` and a compare-and-swap `update-ref`, inside the
  checkout's lock. Nothing is written while an uncommitted, untracked or git-ignored file lies where the merge
  would write, at a path it writes, under one or holding one, since `read-tree` treats an ignored file as
  disposable.
- **The batch's base moves with it, only forward.** When the branch holds a base that descends from the
  batch's `base_sha` (merged, or merged by the builder's own hand), `base_sha` becomes that base. Each task
  in the batch moves its start (`base_head`) to match: one that started where the batch did moves to the base
  itself; one that started later (a linked task, a fix task) moves to the merge of its start with the base,
  a commit `Git.mergedCommit` keeps at `refs/10db/starts/<workstream id>`. Its changes then read against the
  base they will merge onto. A base branch forced back or sideways moves nothing.
- **The worktree's packages follow its lockfile.** The lockfile blob each install of the worktree's packages
  ran from is recorded (`worktree_lockfile.<batch id>`, by the cut, a Retry's rebuild and the gate). Before
  each gate, when the `pnpm-lock.yaml` at the worktree's HEAD is another blob, the install runs again, so a
  merge, a hand merge, or an earlier install that failed or was stopped all end in a matching install.
- **The shipping gate** then pushes the branch it tested, merge and all.
- **Shared mode** (Your folder, the builder's own checkout): never merges, switches, installs or writes
  anything. The gate runs on the branch as it is, and when `origin/<base>` has commits the branch lacks, the
  gate's evidence says how many and that a failure they fix shows until the builder merges the base.
- **Work outside a batch** (local delivery) has no base and fetches nothing.

Nothing that keeps the base or the install out fails the gate or the ship, and nothing in it throws: the gate
runs on the branch as it is, and a note heads its evidence (and so the fix session's prompt) and the shipping
gate's failure card, saying why:

| Case                                                               | Note, and what else happens                                |
| ------------------------------------------------------------------ | ---------------------------------------------------------- |
| The fetch fails (offline, a timeout, origin refused)               | "couldn't fetch"; the cause is logged                      |
| A conflict with the base                                           | names the files; one card per batch (`base-conflict:<id>`) |
| Uncommitted, untracked or ignored files where the base would write | names them; the next gate tries again                      |
| The base's tree asks for a filter, or git refuses                  | names the cause; a filter refusal raises its own card      |
| The install fails, or can't run                                    | the merge stands; the note names the install's log         |
| A later task's start can't be merged with the base                 | it keeps its start, logged; its changes include the base's |

A conflict is the builder's, as a conflicting pull request already was. The card names the files and two ways
out: GitHub's Update branch and Resolve conflicts once the pull request is open, or a hand merge in the worktree,
`git -C <worktree> -c core.hooksPath=/dev/null merge origin/<base>`, quoted for pasting. The command turns the
repository's hooks off because lanes write in the worktree, so its hook config (lefthook's, husky's) is theirs
to choose. The next gate tests the result, and once an update finds the branch holding the base the card is
withdrawn. `Git.commitsSince` and the commit tool's search for a retried operation follow first parents, so a
task's commits never include the commits a merge brought in, nor does a squash-merged pull request's trailer
pass for a lane's earlier commit.

## Why

A task's branch was gated as it was cut. The areas task's branch was 10 commits behind main; its gate failed
`bundle.test.ts`, already fixed on main, and a git-hook test, and every fix session that night spent itself
on failures the task neither caused nor could fix. Gating the branch with its base merged in tests what the
pull request would merge, and puts main's fixes in front of the fix session too, since its checkout is the one
gated. That is GitHub's own "Update branch", a merge, not a rebase: no commit a lane made is rewritten, so
the lanes' idempotent commits, the handoffs that name them and an open pull request all stay valid.

Turned down:

- **Gating a merge result elsewhere** (a throwaway worktree of the merge): a second checkout, seed and
  install per gate, and a fix session would fix code it can't see.
- **Rebasing**: rewrites the lanes' commits and needs a force push once a pull request exists, which 10db
  never does.
- **A conflict as a fix session's work**: a lane can't record a merge. Its sandbox denies the git dir, and the
  daemon's commits for it have one parent and only its own files. The session would spend a fix attempt it
  can't succeed at, the failure item 146 names.
- **Merging into the builder's own checkout** in shared mode: it would rewrite their working branch, index
  and files under them.
- **Failing the gate when offline**: the gate still tests the task's own work; the note says what it lacked.
- **Merging before the gate's slot**: a sibling gate waiting for the slot would change the files of the gate
  running in the same worktree.

Left open:

- A crash between `read-tree` and `update-ref` leaves the base's changes as uncommitted edits on the old tip,
  never a branch whose files the checkout doesn't hold; nothing yet notices and finishes or undoes it, so a
  lane would see them as uncommitted changes.
- When the worktree's own index has fallen out of step with its branch, every gate's merge stops with the
  same "not uptodate" note until something resets it.
