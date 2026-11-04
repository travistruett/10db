# Knowledge is a top-level view with Principles, Decisions and Proposals tabs

- **Date:** 2026-11-03
- **Amends:** decision 17 (where the builder reads and edits knowledge)

## Decision

**Where.** Knowledge is a top-level view at `/knowledge`, beside Board, Factory, Inbox and Settings (spec §10), for the
project the shared project switcher has selected. It reads the knowledge routes
(`decisions/2026-11-03-knowledge-routes-name-a-place-and-take-a-source.md`) and holds no rule of its own.

**What it shows.**

- **Principles, Decisions and Proposals tabs.** The Proposals tab carries a count badge for the principles waiting for
  a verdict. A principle shows its kind in words, its topic key and its target; a decision its question, choice and
  rationale.
- **One search box and one scope select** shared by the Principles and Decisions tabs. The select holds All scopes,
  You, Project and each of the project's areas, so "one area" is a choice like the others. The box is debounced.
- **A History switch** that lists superseded, retired, withdrawn and proposed records with their state in words. It
  is off on the Proposals tab, whose records have no history.
- **A provenance drawer** for any record: where it came from, who confirmed it and when, what it replaced and what
  replaced it, and any retirement or withdrawal with its reason, from the provenance routes.
- **One line when search is down.** If the list answers `search.available: false`, the view says so instead of
  reporting that nothing was found.

**What the builder can do.** Record a decision or a principle; Edit one (it writes a successor and moves the old
record to History); Retire a principle; Withdraw a current record with a reason; and accept or reject a proposal.
Accepting may change the statement, kind, topic key and target first. Nothing is hard-deleted from the view. The view does not use the
routes' dry runs; they are for scripts and skills (`docs/knowledge-api.md`).

**The Inbox side.** A principle proposal's card shows its verdict options in words (scope choices), a resolved card
that proposed principles from the answer's note links to each by id (`/knowledge?principle=…`, which opens its
provenance in the Knowledge view even after the proposal was decided and left the Proposals tab), and a question
card has a "Record as a decision" control that sets the answer's `record` (a checkbox and a scope; the daemon's own
default stays product, design and engineering questions at project scope).

**Not here.** Bulk confirm for an import (there is no import yet), and facts.

## Why

Spec §10 lists Knowledge as a view of its own, filtered by scope. One list that mixes both kinds, with the state
worked out by the daemon, keeps the view from reimplementing what is current. Showing the Proposals count on the tab spares the builder from
finding that a rule waits for them only in the Inbox. The alternatives turned down were a Settings section (the
builder reads knowledge far more often than he changes a setting) and a separate page per kind (the search and scope
would be duplicated).
