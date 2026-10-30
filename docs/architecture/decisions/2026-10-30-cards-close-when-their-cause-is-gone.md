# A flag that reports a failed action is closed by 10db once the action succeeds

- **Date:** 2026-10-30

## Decision

- **The card says what makes it stale.** A flag raised for a failed action carries
  `detail.resolvesWhen` (`CardResolvesWhen` in `packages/contracts/src/card-resolution.ts`), one of:
  `tasks_started` (a refused start: its `taskIds`), `batch_shipped` (a batch that did not ship: its `batchId`)
  and `checkout_trusted` (a refusal that offers to trust a checkout: its real `repo` path).
  `forTasks` sets the first on every refused start, `failWith` in the shipper sets the second on every "not
  shipped" card, and the git refusal handler sets the third on the cards that offer Trust (a moved checkout, a
  changed origin).
- **Who closes it.** The success path of the same action: the cut or join that opens the batch and inserts the
  tasks' workstreams (`resolveStartCards`), the transition to `SHIPPED` (`resolveShipCards`), and
  `Git.retrust` after it pinned the checkout (`onTrusted`, wired to `createCheckoutTrustedHandler`). A refused
  start's card closes only once every task it names has started since the card was raised, so a start of one
  of two refused tasks leaves it open. Cards of other tasks, batches and checkouts are never touched.
- **How it is marked.** `InboxService.resolve(id, reason)` moves an open card to `RESOLVED` and writes
  `detail.resolution = { by: '10db', reason }` in the same write, keeping the rest of the detail. A card that is
  no longer open is left as it was. No schema change and no migration: `detail` is already free-form JSON.
  `CANCELLED` stays what `withdraw` means (a question a later change made moot, which the builder never needs
  to see again); a resolved card is one the builder may want to look back at.
- **Where the builder sees it.** The Inbox has an Open | Resolved switch. The Resolved view lists the 100 most
  recent `RESOLVED` cards, newest first, each saying "Resolved by 10db: <reason>", "Answered: <choice>" or
  "Resolved".

## Why

- On 2026-10-29 two "Batch not started: 10db won't run git…" flags and a "not shipped: the gate failed" card
  stayed open after the next Start or the retried ship succeeded, and the orchestrator dismissed each by hand.
- The card is raised where the failure is known, so it states its own end condition there; the success path
  only has to ask "which open cards say this happened?", with no matching on titles.
- `RESOLVED` with a reason, rather than `CANCELLED`, keeps the history honest: the builder can see that 10db,
  not they, closed it, and why.
- Not done: cards whose cause the builder fixes outside 10db with no event to observe (a config key, a dirty
  checkout shown in a git refusal) stay until dismissed, as before.
