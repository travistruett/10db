# The builder's hand-made worktrees are offered for removal once merged, and kept out of Spotlight on one answer

- **Date:** 2026-11-17

## Decision

- **10db's own worktrees** already leave with their batch (`retireWorktree`) and sit under a root that carries a
  `.metadata_never_index` marker. Nothing new there.
- **The folder beside a checkout where its builder makes worktrees by hand** (`<repo>-worktrees`, so
  `10db-worktrees` beside `10db`; `handMadeWorktreeFolder`) gets two Inbox cards per pull request project, looked for
  after a pull request watch round, at most every six hours:
  - **Remove Merged Worktrees**, listing each worktree git lists in that folder that is unlocked, whose branch's pull
    request GitHub reports merged with the local tip equal to, or an ancestor of, the pull request's head, that has no
    uncommitted change and no git-ignored file other than build output outside a directory the ignore rules match. One
    answer removes them; the answer looks again and removes only what still qualifies. The branches stay. Its fold
    key names the listed set, so Keep holds for that set and a newly merged worktree is offered on its own.
  - **Keep Spotlight Out**, shown while the folder has no `.metadata_never_index` file. The answer creates that one
    empty file in the folder and a second card says what changed, or that nothing did.
- **Nothing is removed without that answer.** The builder's own checkouts are theirs: a session may be open in one
  that merged, and a worktree is not an agent's leftover as a batch's is.
- **The git calls are scoped, not loosened.** `handMadeWorktreeChanges`, `handMadeWorktreeIgnoredFiles` and
  `removeHandMadeWorktree` take the same checks as 10db's own (a real directory, listed by git, a gitfile pointing
  into this repository's `worktrees`, no attributes file), with the folder in place of 10db's root, an unlocked
  entry in place of a 10db lock, and a single `--force`, so a locked worktree is refused by git as well.
- The overload card says, when `mds_stores`, `mdworker` or `fseventsd` is among the busy processes, that these two
  cards are what 10db offers.

## Why

The overload guard tripped 8 to 10 times a day with `fseventsd`, `mds_stores`, `com.docker.sailor` and `WindowServer`
the busiest, not 10db. 31 hand-made worktrees stood in `~/Projects/10db-worktrees`, each with its own `node_modules`.
10db had no record of them, so nothing removed them, and the Spotlight marker only covered its own root. Offering with
one answer fits "unattended work never waits": the card is raised and 10db goes on.

Turned down: removing them with no answer (a merged branch's worktree can still be open in a terminal or an editor,
and a rule of what is safe to delete in the builder's own checkouts is not 10db's to take); a Settings page (the offer
is one answer to one fact, which the Inbox already carries); asking the builder to run `worktree-sweep.sh`.

The effect on `fseventsd` and `mds_stores` CPU is not measured here: the lane sandbox that wrote this denies `ps`,
`top` and `fs_usage`, so before and after figures have to be taken on the builder's Mac with the app running.
