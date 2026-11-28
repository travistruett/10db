# Task 4: a pull request out of CI fixes ends in the out-of-moves card

Read the index's Brief and Global Constraints first. Size: Core (the pull request watch; closes a pull request).
Starts after task 3 has merged.

**Files:**

- `apps/daemon/src/delivery/ci-stop.ts`: the `ci_out_of_moves.<root batch id>` setting, `stopCiFixing`,
  `clearCiStop`, the answers.
- `apps/daemon/src/delivery/ci-failure-action.ts` and its test; `apps/daemon/src/delivery/ci-fix.ts` (passes
  `ignoreFixesBefore`, and puts a stored note at the top of the fix task's description, then clears it).
- `apps/daemon/src/delivery/pr-watch.ts`: raises the due card; deletes the setting.
- `apps/daemon/src/delivery/cards.ts`: `prCards.ciOutOfMoves`; a `NOTICE_KEY` and notice for the pending stop.
- `apps/daemon/src/github/gh.ts` and its fake: `closePullRequest` (`gh pr close`).
- `apps/daemon/src/delivery/ci-stop.test.ts`: extended. `apps/daemon/src/inbox/AGENTS.md`: the invariant becomes
  "a stop has its card or its pending notice".

**Implements** (index, Interfaces): `ciOutOfMovesKey`, `CI_OUT_OF_MOVES_AFTER_MS`, `ciFailureAction`'s fifth
argument, `closePullRequest`. **Calls:** `outOfMovesFields` with `kind: Ci`, `createOutOfMovesAnswers`.

**The setting**, zod-parsed: `{ stoppedAt: string | null, ignoreFixesBefore: string | null, dropped: boolean,
note: string | null }`. It is deleted in the write that records the pull request Merged or Closed; that write
reads `dropped` first.

**`stopCiFixing`**, in the caller's write:

- `Limit` and `NoChange`: set `ciStopped`, withdraw `prCardKey.checks`, set `stoppedAt` from the write's clock, and
  call `setBatchNotice(w, root.id, …)` directly. `showNotice` opens its own write and must not be used here. No
  card.
- `NoLog` and `NoCut`: today's immediate `prCards.ciStopped`, unchanged.

**`pr-watch`**, each round, for a root with `ciStopped` of `Limit` or `NoChange` whose pull request is open: when
`stoppedAt` is missing or at least `CI_OUT_OF_MOVES_AFTER_MS` old, raise `prCards.ciOutOfMoves` under
`prCardKey.ciStopped(root.id)` and clear the notice, in one write. The fold key makes it once, also after a
restart. `clearCiStop` nulls `stoppedAt` and clears the notice, so a stop lifted inside the window raises nothing.

**`ciFailureAction`**, in this order: not failing or no head → wait; `root.ciStopped` → stop; an unfinished fix →
wait; `counted` = fixes created after `ignoreFixesBefore` (all of them when null); a `counted` fix with
`ciFixHead === head` → `NoChange`; `counted.length >= maxCiFixes` → `Limit`; no Actions job → `NoLog`; else fix.

**The answers.**

- More: set `ignoreFixesBefore` to now, lift the stop, rerun the failed jobs (what `createCiStopAnswers` does on
  Retry). Change: the same, with the note stored; refused without a note.
- Drop: set `dropped`, then `gh.closePullRequest`. The watch's next read records Closed, raises no "pull request
  closed" card because `dropped` is set, and `endFixesOfEndedPullRequests` ends the fix batches. A refused close
  raises `prCards.rerunFailed`'s kind of card saying why, and the out-of-moves card stays.

**State-table rows:** the CI row of the card table; `NoLog` and `NoCut` under "Other rows".

**Tests (extend two files).**

- `ci-failure-action.test.ts`: rows for `ignoreFixesBefore` (two old fixes and none since → fix; an old fix for
  this head → fix; a new one for this head → `NoChange`).
- `ci-stop.test.ts`, on its delivery harness with an injected clock: a `Limit` stop raises no card and sets the notice;
  29 minutes later the watch's step raises none; at 30 it raises one, and a second round raises no second;
  `clearCiStop` at 10 minutes means none at 30.

`Value: protects=a pull request out of CI fixes raises one out-of-moves card, 30 minutes after the stop, and More
lets fixes start again; fails_when=the card is raised at once, twice, never, or after the checks recovered, or
old fixes still count after More; why_new=recovery (the pull request watch's stop); no_claim=GitHub closing the
pull request, or the fix session's work`.

**Spec:** the "Pull request checks, CI, red base" row of "3. The decision-rights table" in the
what-reaches-the-builder spec.
