# A worktree batch's branch takes its base as origin has it before every gate

- **Date:** 2026-10-29
- **Supersedes:** `decisions/2026-10-27-worktree-never-rebased.md`, and the worktree mode spec's W11

## Decision

Before each gate of a batch's work, the verify gate of every task in it and the shipping gate alike, the
daemon fetches the batch's base branch once (`git fetch` in the project's checkout, the network timeout, the
gate's abort signal) and then:

- **Worktree mode** (`workspace_mode = worktree`): merges `origin/<base>` into the batch's branch in its
  worktree with `Git.mergeIntoBranch`, never a rebase. Up to date when the branch holds it, a fast-forward when
  the branch has nothing of its own, else a merge commit `Merge origin/<base> into <branch>` with the branch as
  first parent, made from `merge-tree --write-tree` with no attributes (so no merge driver runs), signed as
  the builder's config says, then `read-tree -m -u` and a compare-and-swap `update-ref`, inside the
  checkout's lock. The batch's `base_sha` becomes the merged base, and so does the `base_head` of every
  task in it that started where the batch did, so their changes read against the base they will merge onto.
  When the merge changed `pnpm-lock.yaml`, the worktree's install runs again (`worktree-dependencies.ts`). The
  shipping gate then pushes the branch it tested, merge and all.
- **Shared mode** (Your folder, the builder's own checkout): never merges, switches or writes anything. The
  gate runs on the branch as it is, and when `origin/<base>` has commits the branch lacks, the gate's
  evidence says how many and that a failure they fix shows until the builder merges the base.
- **Work outside a batch** (local delivery) has no base and fetches nothing.

Nothing that keeps the base out fails the gate or the ship: the gate runs on the branch as it is, and a note
heads its evidence (and so the fix session's prompt) and the shipping gate's failure card, saying why:

| Case                                                            | Note, and what else happens                                |
| --------------------------------------------------------------- | ---------------------------------------------------------- |
| The fetch fails (offline, a timeout, origin refused)            | "couldn't fetch"; the cause is logged                      |
| A conflict with the base                                        | names the files; one card per batch (`base-conflict:<id>`) |
| Uncommitted changes where the base would write (a sibling lane) | names the files; the next gate tries again                 |
| The base's tree asks for a filter, or git refuses               | names the cause; a filter refusal raises its own card      |
| The install after a merge fails                                 | the merge stands; the note names the install's log         |

A conflict is the builder's, as a conflicting pull request already was: the card names the files, the
command to merge by hand in the worktree, and that the next gate tests the result; or the pull request
carries the conflict. `Git.commitsSince` follows first parents, so a task's commits never include the
commits a merge brought in.

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

A crash between `read-tree` and `update-ref` leaves the base's changes as uncommitted edits on the old tip,
never a branch whose files the checkout doesn't hold. A shutdown during the install after a merge leaves the
merge in place, and the next gate finds the branch up to date and does not install again.
