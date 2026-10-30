# A flag that reports a failed action is closed by 10db once the action succeeds

- **Date:** 2026-10-30

## Decision

- **The card says what makes it stale.** A flag raised for a failed action carries
  `detail.resolvesWhen` (`CardResolvesWhen` in `packages/contracts/src/card-resolution.ts`), one of:
  `tasks_started` (a refused start: its `taskIds`), `batch_shipped` (a batch that did not ship: its `batchId`)
  and `checkout_trusted` (a refusal that offers to trust a checkout: its real `repo` path).
  `forTasks` sets the first on every refused start: the checks in the cut and the join, the "tasks depend on
  unfinished work" refusal in the request (naming the blocked tasks), and the "10db stopped while cutting the
  branch" card startup recovery raises. `failWith` in the shipper sets the second on every "not shipped" card,
  and the git refusal handler sets the third on the cards that offer Trust (a moved checkout, a changed
  origin).
- **A cut that a restart cut short still names its tasks.** A worktree batch's workstreams are inserted with
  its `CUTTING` row, so recovery reads them before deleting the row. A shared batch inserts its workstreams
  only once the branch is cut, so its start records the task ids in the app setting `cutting_tasks.<batchId>`
  in the same write as the `CUTTING` row (`delivery/cutting-tasks.ts`); the cut drops it when the batch opens
  or is refused, and recovery when it deletes the row. An app setting, like the batch's `checkout_pin.<id>`,
  rather than a column: no migration for a value that lives only while a cut runs.
- **Who closes it.** The success path of the same action: the cut or join that opens the batch and inserts the
  tasks' workstreams (`resolveStartCards`), the transition to `SHIPPED` (`resolveShipCards`), and the checkout
  being trusted again (`onTrusted`, wired to `createCheckoutTrustedHandler`). A refused start's card closes only
  once every task it names has started since the card was raised, so a start of one of two refused tasks leaves
  it open. Cards of other tasks, batches and checkouts are never touched.
- **When a checkout is trusted again.** Either the builder's Trust answer pinned it (`Git.retrust`), or the
  builder put the checkout back (`git remote set-url origin <the pinned URL>`, a moved `.git` returned) and a
  later git call finds it exactly as pinned: the pin check passes and origin's fetch and push URLs are the
  pinned ones. `Git` keeps an in-memory set of the checkouts refused for a moved git dir or a changed origin,
  seeded at startup from the open `checkout_trusted` cards (`refusedTrustCheckouts`). Only a call for a
  checkout in the set reads origin's URLs again; every other call costs one lookup. `onTrusted` is told once
  per refusal, and the checkout leaves the set.
- **How it is marked.** `InboxService.resolve(id, reason)` moves an open card to `RESOLVED` and writes
  `detail.resolution = { by: '10db', reason }` in the same write, keeping the rest of the detail. A card that is
  no longer open is left as it was. No schema change and no migration: `detail` is already free-form JSON.
  `CANCELLED` stays what `withdraw` means (a question a later change made moot, which the builder never needs
  to see again); a resolved card is one the builder may want to look back at.
- **Where the builder sees it.** The Inbox has an Open | Resolved switch. The Resolved view asks for
  `GET /inbox?state=RESOLVED&recent=100`: the daemon returns at most that many, the most recently updated first
  (`recent` is 1 to 1000; without it the list is whole, as before). Each says "Resolved by 10db: <reason>",
  "Answered: <choice>" or "Resolved".

## Why

- On 2026-10-29 two "Batch not started: 10db won't run git…" flags and a "not shipped: the gate failed" card
  stayed open after the next Start or the retried ship succeeded, and the orchestrator dismissed each by hand.
- The card is raised where the failure is known, so it states its own end condition there; the success path
  only has to ask "which open cards say this happened?", with no matching on titles.
- A trust problem is fixed as often in a terminal as by pressing Trust, and once it is, Trust on the old card
  fails with a mismatch. Checking on the next passing call, rather than scanning the inbox on every git call,
  keeps the common path free.
- `RESOLVED` with a reason, rather than `CANCELLED`, keeps the history honest: the builder can see that 10db,
  not they, closed it, and why.
- The resolved list only grows, so the daemon, not the client, cuts it to the most recent.
- Not done: cards whose cause the builder fixes outside 10db with no event to observe (a config key, a dirty
  checkout shown in a git refusal) stay until dismissed, as before. So does the "left behind" card recovery
  raises when a cut it removes left a non-empty directory at the worktree path: only moving that directory
  settles it, and a later start of the same tasks uses a new path.
