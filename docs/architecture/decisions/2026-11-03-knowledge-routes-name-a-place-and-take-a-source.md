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
lacks; unknown fields in a body or query are refused by name. 404 is an unknown project or record. 409 names the
current record: supersede, retire and withdraw of a record that isn't current, and a principle successor whose key
another current principle already holds at the new scope.

**Superseding a principle** is the store's explicit link, `supersedePrinciple`, and the successor may change
statement, kind, topic key and scope. Creating or accepting a principle keeps the topic-key rule: it replaces the
current one with that key and target.

**Dry runs run the write and roll it back.** `dryRun: true` on create, supersede and accept runs the real function
inside a transaction that is rolled back, so it meets every check the write meets (the same 400, the same 409) and
cannot drift from it. It answers 200 `{ dryRun, wouldWrite, replaces }`: the item without its id and source, and
the record it would replace read as it is now. Retire and withdraw have none.

**Source.** Every write takes an optional `source: { via, sessionId?, cwd?, quote? }`, stored as the `ref` of a
`sources` row of kind `builder` in the write's own transaction (a write without one still gets a bare row). A
builder source's `sessionId` is the calling tool's, so provenance reads it as `origin`, never as a 10db session. A
principle's `quote` field wins over `source.quote`; the quote shown in provenance is the principle's, else the
source's. The provenance answer is per record: source kind and ref, `origin`, quote, speaker, who and when, the
record it superseded and the one that superseded it, and any retire or withdrawal with its reason.

**Startup index check.** At start the daemon runs the integrity check on the decisions and principles search
indexes and rebuilds one that disagrees, logging each step. A check or rebuild that fails is logged and the daemon
keeps serving. It raises no Inbox card, since it asks the builder nothing
(`decisions/2026-10-31-notices-not-cards.md`). A rebuild that failed makes the list say `search.available: false`,
and a request with `q` then answers an empty list rather than an error; the view shows it in one line.

## Why

A skill running in any session makes as few calls as possible, so one list answers both kinds and a dry run answers
"what would this replace" without a second lookup. Rolling back the real write keeps a dry run exact for free;
re-implementing the checks beside it would let the two disagree. Naming a place in words (`scope`, `area`) is what a
person says, and the server owns the target object. Putting the tool's own session id in a builder source's `ref`,
rather than a new column, keeps `sources` one table with a free-form `ref` for each kind.

Turned down: `?projectId=` on the routes (main puts the project in the path); a separate dry-run route per write (a
flag keeps the body identical to the real one); a Knowledge Inbox card for a broken index (nothing to answer);
failing the daemon's start on a broken index (search is a convenience, and the lists and the context pack's fallback
still work).
