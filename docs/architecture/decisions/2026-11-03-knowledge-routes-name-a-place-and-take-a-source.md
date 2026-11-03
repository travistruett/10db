# The knowledge routes name a place, run dry runs by rolling back, and take a source

- **Date:** 2026-11-03
- **Amends:** the M3 plan's Task 10 (which put the project in a `?projectId=` query)

## Decision

**Route shape.** Follows main's conventions: collections under the project, records under their own id.

- `GET /projects/:projectId/knowledge` lists decisions and principles together (`q`, `kind`, `scope`, `area`,
  `history`, `limit`), builder-wide records included. Each item carries `kind: "decision" | "principle"`; a
  principle's own kind moves to `principleKind`, so the two never share a field name.
- `POST /projects/:projectId/decisions` and `/principles` create; `POST /decisions/:id/supersede|withdraw`,
  `POST /principles/:id/supersede|retire|withdraw` and `GET …/:id/provenance` act on a record;
  `GET /projects/:projectId/proposals` and `POST /proposals/:id/accept|reject` decide a principle proposal.
- A write names its place with `scope` and `area`, never a target object. The project comes from the URL on a create
  and from the record replaced on an edit; `projectId` in an edit body is only for moving a `you` record into a
  project. An edit names the fields it changes and keeps the rest.
- Shape's `/shapes/:shapeId/decisions/:decisionId/withdraw` stays, over the same `withdrawDecision`.

**Errors a script can act on.** 400 starts its message with the field (`area: …`), including an area the project
lacks; unknown fields in a body or query are refused by name. 404 is an unknown project or record; the project in a
create's URL must exist at any scope, so a `you` record can't be written through an unknown one. A 409 says what to
act on instead: supersede, retire and withdraw of a record that isn't current name the record that is live in its
place, walking back through `supersedes` past a withdrawn head, and say `none is current` when nothing is, so a
retired head is never named. A principle successor whose key another current principle already holds at the new scope
names that principle. A proposed principle names its proposal: withdrawing one directly would leave the proposal
pending with its principle gone, so nothing could decide it and its card could never close.

**Superseding a principle** is the store's explicit link, `supersedePrinciple`, and the successor may change
statement, kind, topic key and scope. Creating or accepting a principle keeps the topic-key rule: it replaces the
current one with that key and target.

**Dry runs run the write and roll it back.** `dryRun: true` on create, supersede, retire, withdraw and accept runs
the real function inside a transaction that is rolled back, so it meets every check the write meets (the same 400,
the same 409) and cannot drift from it. It answers 200 `{ dryRun, wouldWrite, replaces, restores }`: the item without
its id and source, the record that would stop being current as it is now, and the record a withdrawal would make
current again. A reject has none: it is the verdict that ends a proposal, and its effects are all on that proposal.

**Source.** Every write takes an optional `source: { via, sessionId?, cwd?, quote? }`, stored as the `ref` of a
`sources` row of kind `builder` in the write's own transaction. A create or supersede makes a record, whose
`source_id` is required, so one without a source still gets a bare row. A retire, a withdrawal and a verdict act on a
record that keeps its own source, so theirs goes in a nullable column of its own and is written only when named:
`retired_source_id`, `withdrawn_source_id` (on decisions too) and `confirmed_source_id`. A rejection is a withdrawal
of the proposed principle, so it uses `withdrawn_source_id`. A builder source's `sessionId` is the calling tool's, so
provenance reads it as `origin`, never as a 10db session. A principle's `quote` field wins over `source.quote`; the
quote shown in provenance is the principle's, else the source's. A superseding principle does not inherit a quote:
those are the words of one write, and the earlier ones stay on the record replaced. The provenance answer is per
record: source kind and ref, `origin`, quote, speaker, who and when, the record it superseded and the one that
superseded it, and any retire or withdrawal with its reason and source.

**Startup index check.** At start the daemon runs the integrity check on the decisions and principles search
indexes and rebuilds one that disagrees, logging each step. A check or rebuild that fails is logged and the daemon
keeps serving. It raises no Inbox card, since it asks the builder nothing
(`decisions/2026-10-31-notices-not-cards.md`). A rebuild that failed makes the list say `search.available: false`,
and a request with `q` then answers an empty list rather than an error. The Knowledge view, not built yet, is to show
that in one line.

## Why

A skill running in any session makes as few calls as possible, so one list answers both kinds and a dry run answers
"what would this replace" without a second lookup. Rolling back the real write keeps a dry run exact for free;
re-implementing the checks beside it would let the two disagree. Naming a place in words (`scope`, `area`) is what a
person says, and the server owns the target object. Putting the tool's own session id in a builder source's `ref`,
rather than a new column, keeps `sources` one table with a free-form `ref` for each kind.

Separate columns for a retire, a withdrawal and a confirmation keep each act's origin apart from the record's own:
a proposal keeps the agent that proposed it as its source while the builder's accept is recorded beside it. Each is
a nullable `ADD` of one column, so the table is not rebuilt and its full-text triggers stay.

Turned down: `?projectId=` on the routes (main puts the project in the path); a separate dry-run route per write (a
flag keeps the body identical to the real one); a Knowledge Inbox card for a broken index (nothing to answer);
failing the daemon's start on a broken index (search is a convenience, and the lists and the context pack's fallback
still work); carrying a source on the `events` row instead of a column (a provenance read would have to scan events,
and the source would not be on a `sources` row); overwriting the record's `source_id` on a retire or withdrawal
(that loses where the record itself came from); having the withdraw route reject a proposed principle's proposal
itself (the route would decide a proposal by a side door, with a reason in the wrong field).
