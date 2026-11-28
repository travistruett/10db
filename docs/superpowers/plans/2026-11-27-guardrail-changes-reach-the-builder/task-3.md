# Task 3: a pull request that touches a guardrail is held for the builder

Read the index's Brief and Global Constraints first. Size: Core (git merges, the shipper, the pull request watch).
Starts after task 2 has merged.

**Files:**

- New `apps/daemon/src/delivery/guardrail-hold.ts`: the rule, the setting, the pull request's base.
- `apps/daemon/src/delivery/ship.ts`: three call sites and the turn-off before a push.
- `apps/daemon/src/delivery/pr-watch.ts`: `landing.retryMerge` refused while held; the card withdrawn and the
  setting cleared when the pull request merges or closes.
- `apps/daemon/src/github/gh.ts` and its fake: `prDisableAutoMerge`; `closePullRequest` only if it is still
  absent.
- `apps/daemon/src/inbox/guardrail-card.ts`: the pull request card's fields and its answers.
- `apps/daemon/src/delivery/ship.test.ts`: extended.
- `apps/daemon/src/delivery/AGENTS.md`, `apps/daemon/src/inbox/AGENTS.md`: as built.

**Implements** (index, Interfaces): `holdRootOf`, `guardrailHoldKey`, `GuardrailHold`, `pullRequestBase`,
`holdAction`, `prDisableAutoMerge`, `closePullRequest`, `GuardrailPrChoice`.
**Calls:** `guardrailHits`, `GUARDRAIL_DIFF_DETAIL`, `git.mergeBase` (`git.ts`), `turnOnAutoMerge`.

**Reading the hold.** One function in `ship.ts`, used by every site below, for `root = holdRootOf(batch)` and the
head about to be pushed (or the pushed head, in `retryMerge`):

1. `base = pullRequestBase(git, checkout, root, head)`.
2. The changed paths of `base..head` and their diff, through the git module. `hits = guardrailHits(paths).length`;
   `diffHash` is the sha256 of the diff of the hit paths only, so an unrelated later commit does not ask again.
   A null base or a failed read gives `hits: null`.
3. `holdAction({ hits, diffHash, approved })`, with `approved` read from `guardrailHoldKey(root.id)` through
   `GuardrailHold`.

No judge call, watchpoint answer or card state is read here.

**Call sites.**

- `shipSteps`, step 4b (root ships and `fixPr` alike): on `hold`, skip `turnOnAutoMerge` and raise the card; this
  also runs when `batch.autoMerge` is false and there are hits, to raise the card.
- `retryMerge`: on `hold`, return before `turnOnAutoMerge`.
- `catchUpSteps`: read before its push; on `hold`, do not re-arm after it.
- `pr-watch.ts`: its `landing.retryMerge` call goes through `retryMerge`, so it is refused there. Check that no
  other path in the file arms or merges.

**Before a push while held.** In `shipSteps` and `catchUpSteps`, when the read answers `hold` and a pull request
already exists: `gh.prDisableAutoMerge({ repo, url }, call)` first, every time, whatever the in-memory
`autoMergeArmed` set holds (a restart forgets it). gh saying auto-merge is not enabled is success. Any other
failure stops before the push: `fail` with the step's own card in ship, `stop({ kind: 'other' })` in the
catch-up, which rewinds. Then remove the root from `autoMergeArmed`.

**The card.** Raised on the root batch's tasks, fold key `guardrail-hold:<rootId>`:

- title "A change to your `<label>` is ready"; with hits of several kinds, the first row's label and "and N
  more";
- the body names the pull request and the hit paths; `detail[GUARDRAIL_DIFF_DETAIL]` holds the hit paths' diff,
  capped as task 2 caps it, and `detail` holds the hash it was raised for;
- `decidedByBuilder(BuilderOwns.Guardrails)`, `closesWhen: BY_ANSWER`, options Merge and Close;
- a `hold` with `hits: null` says the diff could not be read and links the pull request instead of a diff.

A read that answers `hold` with a hash other than the open card's withdraws that card and raises it afresh.

**Answers.**

- Merge: in the answer's write, store `approved = <the card's hash>`. Then, as a job, read the hold again for the
  pull request's current head; `approved` arms it through `turnOnAutoMerge` for the root (which merges at once
  where auto-merge is unavailable, as today); `hold` (the head moved) raises the new card instead.
- Close: `closePullRequest`. The pull request watch then ends the root and its fix batches as it does for any
  closed pull request.
- When the watch sees the pull request merged or closed: withdraw the card and delete the setting, in that write.

**Provider parity.** Identical on every account kind; nothing here asks a model.

**State-table rows:** `holdAction`'s four rows, the pusher table and the moment table of the index.

**Test (extend `ship.test.ts`, on its real shipper, real git repo and fake gh).**

- (a) a batch that changes `.github/workflows/x.yml` ships: the pull request exists, the fake gh saw no
  `prAutoMerge` and no `prMerge`, and one card with Merge and Close is open on the batch's task;
- (b) answering Merge arms it: one `prAutoMerge`, and the setting holds the hash;
- (c) a held pull request, then a CI-fix batch with no guardrail change ships into it: still no `prAutoMerge`, and
  the card stays open;
- (d) a pull request armed and approved, then a push that changes the workflow again: `prDisableAutoMerge` is
  called before the push; when the fake fails it, the remote branch has not moved.

Show (a) red before the hold exists. `holdAction`'s rows are pure; add them to task 1's `guardrails.test.ts`
only if (a) to (d) leave a row unexercised.

`Value: protects=a pull request touching a guardrail path is never armed or merged by 10db until the builder
answers Merge for that exact diff; fails_when=a ship, a CI-fix batch, a catch-up or a merge retry arms it, a new
guardrail diff rides an old approval, or a push lands while auto-merge is still on; why_new=permissions and git
merges (the shipper); no_claim=a pass's pull request or a local-copy landing, which are not held`.

**Spec:** "3. The decision-rights table", row "A change to a guardrail"; "2. Who decides", "Doubt goes up", third
item.
