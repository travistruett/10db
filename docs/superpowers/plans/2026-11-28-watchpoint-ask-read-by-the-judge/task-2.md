# Task 2: a hit on a watchpoint set to Hold holds the pull request

Read the index's Brief and Global Constraints first. Size: Core (git merges, the shipper, recovery). Starts after
task 1 has merged. Only loudness Hold holds here; task 4 adds the judge's verdicts through the same code.

**Files:**

- New `apps/daemon/src/delivery/watchpoint-hold.ts`: `holdsMerge`, `watchpointHoldOf`, and the one function that
  says whether a workstream's landing can be held (its batch delivers by pull request) and names its root.
- `apps/daemon/src/delivery/ship.ts`: `heldForBuilder` and `ensureHeldCard`.
- `apps/daemon/src/delivery/pr-watch.ts`: beside `clearGuardrailHold`, withdraw the root's held Look cards.
- `apps/daemon/src/watchpoints/card.ts`: the held card, Merge, Send Back on a held card.
- `apps/daemon/src/delivery/guardrail-hold-card.ts`: `close` lifted to the module function
  `closeHeldPullRequest(ctx, rootId, prUrl)`, exported; its behavior is unchanged.
- `apps/daemon/src/inbox/service.ts`, `apps/daemon/src/daemon/start.ts`: the answer's after-commit step reaches the
  shipper, as `createGuardrailHoldAnswers` is wired.
- `apps/daemon/src/delivery/ship.test.ts`: extended.
- `docs/architecture/decisions/`: one file, "A watchpoint hold is derived from readings and answers, not stored".
- `AGENTS.md` in `delivery`, `watchpoints` and `inbox`: as built.

**Implements** (index, Interfaces): `watchpoint-hold.ts`, `heldForBuilder`, `closeHeldPullRequest`.
**Calls:** `holdRootOf`, `readGuardrailHold`, `disarmBeforePush`, `armApproved`, `patchCiOutOfMoves`
(`ci-stop.ts`), `WatchpointCardDetail`, `WatchpointChoice.Merge`.

**The seam.** `heldForBuilder` reads `readHold` (unchanged) and `watchpointHoldOf(db, root)`;
`held = guardrail.action === 'hold' || watchpoints.held`. Every site that tests `hold.action === 'hold'` today tests
`held` instead: `shipSteps` before the push and at step 4b, `catchUpSteps` (before its push and before
`mergeAgain`), `retryMerge` and `armApproved`. `showHold` still shows the guardrail reading alone. After each read,
`ensureHeldCard` raises the held Look card for every `waiting` entry with `cardOpen: false`, and writes the pull
request's URL into open ones that lack it.

**The card** (`card.ts`). `announceWatchpointReading` gives the workstream's one Look card `held` and the options
Merge and Send Back when a hit holds and the landing can be held; each watchpoint entry carries its `hash`. The body
names the other tasks waiting in the pull request. Where the landing can't be held the card is today's, with the
index's sentence for a Hold hit. `lookedAt` treats a holding hit as answered only for the same hash, so a changed
file asks again. Send Back keeps its label; its description reads "Close the pull request and file a task with your
note", and the body names the other tasks the close drops.

**Answers** (`applyWatchpointAnswer`, and its after-commit step).

- Merge: the answered card is the release, so nothing else is written. After the commit, with a pull request,
  `shipper.armApproved(rootId, prUrl)`; without one, the ship arms.
- Send Back with `held` and a pull request: the follow-up as today plus the URL and branch;
  `patchCiOutOfMoves(w, rootId, { dropped: true })`; after the commit, `closeHeldPullRequest`.
- The other Send Back rows are in the index's moment table.

**Provider parity.** Identical on every account kind; nothing here asks a model.

**State-table rows:** `watchpointHoldOf`'s four rules and the moment table.

**Test (extend `ship.test.ts`: real shipper, real git, fake gh).**

- (a) a run whose reading has a Hold hit ships: the pull request exists, no `prAutoMerge`, one card with Merge;
- (b) Merge: one `prAutoMerge`;
- (c) a catch-up that merges main's change to a watched file holds nothing;
- (d) a reading with `reads` or `shadow` and no hit does not hold;
- (e) a new shipper on the same database refuses `retryMerge`, and the card is open;
- (f) Send Back on the held card: `closePullRequest` once, and the follow-up names the pull request;
- (g) held with its card resolved by hand: the next ship raises it;
- (h) a later reading with `skipped` set does not arm.

Show (a) red before the hold exists.

`Value: protects=a held pull request is not armed or merged until the builder answers Merge; fails_when=a ship, a
catch-up, a retry, a restart, an unreadable reading or Send Back arms it or leaves it without a card, or main's
files or a hitless judge answer hold; why_new=git merges and recovery; no_claim=pass pull requests and local-copy
landings`.

**Spec:** watchpoints "S5, hold (Core, outline only)"; what-reaches-the-builder "3. The decision-rights table", row
"Watchpoint hit".
