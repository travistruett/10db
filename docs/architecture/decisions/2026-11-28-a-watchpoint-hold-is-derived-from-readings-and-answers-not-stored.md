# A watchpoint hold is derived from readings and answers, not stored

- **Date:** 2026-11-28

## Decision

A pull request is held for the builder by a watchpoint when a task that lands in it has a holding hit in its newest readable watchpoint reading and no answered Look card releases that hit. Nothing about the hold is stored:

- `watchpointHoldOf` (`apps/daemon/src/delivery/watchpoint-hold.ts`) reads the members of the root batch and of its CI-fix batches (not cancelled, not left out), each one's newest watchpoint reading whose `skipped` is null, and the answered Look cards of that task.
- A hit holds when its watchpoint is set to Hold, or when its read acted and holds a merge. A reading's `reads` and `shadow` with no hit never hold.
- A holding hit is released by an answered Look card with Merge whose entry for the watchpoint carries the hit's `hash`. A hit with no hash, because its diff could not be read in full, is released by nothing in 10db: Merge on its card is refused, and the builder merges on GitHub or sends it back.
- A later reading with `skipped` set, or one that does not parse, never releases an earlier one; a later readable reading that hits nothing does.
- The shipper reads the hold only through `heldForBuilder`, together with the guardrail hold, at every site that arms, merges or pushes to a pull request: a ship, a catch-up, a merge retry and the approval that follows Merge. After each read `ensureHeldCard` raises the Look card of every waiting task that has none, so a held task always has an open card.
- Readings are taken by the runner over a run's own commits. A catch-up reads none, so main's files merged into the branch never hold.

## Why

A stored flag would have to be set, cleared and survive restarts, and every writer that could miss a case would leave a pull request armed or stuck. The readings and the builder's answers already exist and are durable, so deriving the hold from them gives the same answer after a restart, a retry or a lost write, and needs no migration. Keying a release to the hit's hash makes Merge approve the diff the builder was shown, so a later change to the files holds again. The guardrail hold stays a separate path-list reading (`2026-11-27-a-guardrail-change-is-held-by-a-path-list-the-judge-cannot-overrule.md`); the two meet only in `heldForBuilder`.

Turned down: a stored hold row (state to keep in step, and a place for a restart to lose it), and reading the diff again at each arming site (a catch-up's merged base would then hold the builder's own main).
