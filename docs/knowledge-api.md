# The knowledge API

The builder's decisions and principles over HTTP, for a script or a skill that runs outside 10db (the builder's
`10db-knowledge` skill is the first). One request lists a project's decisions and principles together; the rest
record, supersede, retire and withdraw them, decide a principle proposal, and say where a record came from. These
are **your** routes: a managed session reaches knowledge through its own MCP tools instead.

The decision behind the shapes is
[decisions/2026-11-03-knowledge-routes-name-a-place-and-take-a-source.md](architecture/decisions/2026-11-03-knowledge-routes-name-a-place-and-take-a-source.md);
what a target, a state and a withdrawal mean is
[decisions/2026-11-03-knowledge-records-have-a-target-and-a-derived-state.md](architecture/decisions/2026-11-03-knowledge-records-have-a-target-and-a-derived-state.md).

## Reaching the daemon

Every route needs `Authorization: Bearer <token>`. The app keeps two files in its data directory (macOS:
`~/Library/Application Support/10db`):

- `daemon.json`: `{ "pid", "port", "protocolVersion", "startedAt" }`. The daemon listens on `http://127.0.0.1:<port>`.
- `ui-token`: the token, as plain text. Both change whenever 10db restarts, so read them on every run.

A development daemon keeps its data in its own directory (`.dev/data` for `pnpm dev`).

Find the project from the repository you are in: `GET /projects` answers an array of projects, each with `id`,
`name`, `repoPath` and `areas` (`[{ "name", … }]`); take the one whose `repoPath` holds your working directory (a
lane's worktree lives elsewhere, but a builder session runs in the repository). Everything below takes that `id` (`prj_…`).

```sh
BASE="http://127.0.0.1:$(jq .port "$DATA/daemon.json")"
AUTH="Authorization: Bearer $(cat "$DATA/ui-token")"
curl -s -H "$AUTH" "$BASE/projects"
```

Bodies are JSON with `Content-Type: application/json`. Times are ISO 8601 strings. Ids are `dec_…` (decision),
`pri_…` (principle), `prp_…` (proposal), `src_…` (source) and `prj_…` (project).

## Vocabulary

| Word       | Values                                                                                                                                                    |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scope`    | `you` (the builder's own: applies in every project), `project`, or `area` (one of the project's areas; `area` names it).                                  |
| `kind`     | An item is a `decision` or a `principle`. A principle's own kind, `principleKind`, is `policy` (must), `heuristic` (prefer) or `belief` (context).        |
| `state`    | Worked out on read: `current`, `superseded`, `retired` (principles), `withdrawn`, or `proposed` (a principle waiting in the Inbox).                       |
| `topicKey` | A principle's key, such as `testing.no-sleeps`: lowercase words joined by `.` or `-`, at most 80 characters. One current principle holds a key per place. |
| `source`   | Optional on every write: `{ "via": "claude_code", "sessionId": "…", "cwd": "…", "quote": "…" }`. Only `via` is required. See [Sources](#sources).         |
| `dryRun`   | Optional `true` on every create, supersede and accept: nothing is written, and the answer says what would be. See [Dry runs](#dry-runs).                  |

A record's target is its `scope` plus `projectId` (null for `you`) and `area` (null unless scope is `area`). A write
names the place with `scope` and `area`; the project comes from the URL (a create) or from the record replaced.

## Errors

Every refusal is JSON.

| Status | Body                                                             | Means                                                                                                                  |
| ------ | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 400    | `{ "error": "invalid", "message": "area: …" }`                   | A domain refusal. The message **starts with the field**: `area: Billing has no area named xx`, `projectId: …`.         |
| 400    | `{ "error": "invalid", "issues": [{ "path": "…", "message" }] }` | The body or query is malformed: `path` is the field (a misspelled one is named too, since unknown fields are refused). |
| 401    | `{ "error": "unauthorized" }`                                    | No or a wrong token. Read `ui-token` again.                                                                            |
| 404    | `{ "error": "not_found", "message": "…" }`                       | No such project, decision, principle or proposal.                                                                      |
| 409    | `{ "error": "conflict", "message": "…" }`                        | The record is not in a state for this. The message **names the record that is current** (`dec_…` / `pri_…`).           |

A 409 is final for that request: nothing was written. Read the named record and decide again.

## List and search

`GET /projects/:projectId/knowledge`

One call answers a project's decisions and principles together, **builder-wide (`you`) records included**.

| Query     | Default | Meaning                                                                                                                                             |
| --------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `q`       | none    | Search text. Words are matched anywhere in a decision's question, choice and rationale, or a principle's statement and topic key. Best match first. |
| `kind`    | both    | `decision`, `principle`, or one principle kind (`policy`, `heuristic`, `belief`; this leaves decisions out).                                        |
| `scope`   | all     | `you`, `project` or `area`.                                                                                                                         |
| `area`    | all     | One area's records. An area the project lacks is a 400 naming it.                                                                                   |
| `history` | `0`     | `1` also returns superseded, retired, withdrawn and proposed records. Default: current records only.                                                |
| `limit`   | `100`   | 1 to 500.                                                                                                                                           |

Without `q` the newest come first; with `q` the best matches of each kind alternate, so neither buries the other.

```json
{
  "items": [
    {
      "kind": "principle",
      "id": "pri_…",
      "projectId": "prj_…",
      "scope": "project",
      "area": null,
      "statement": "Tests never sleep; they wait on a condition.",
      "rationale": "A fixed sleep is slow when it is long and flaky when it is short.",
      "principleKind": "policy",
      "topicKey": "testing.no-sleeps",
      "status": "confirmed",
      "state": "current",
      "supersedesId": null,
      "supersededById": null,
      "sourceId": "src_…",
      "sourceQuote": "never sleep in a test",
      "speaker": "builder",
      "confirmedBy": "builder",
      "confirmedAt": "2026-11-03T10:00:00.000Z",
      "retiredAt": null,
      "retiredReason": null,
      "withdrawnAt": null,
      "withdrawnReason": null,
      "createdAt": "2026-11-03T10:00:00.000Z",
      "updatedAt": "2026-11-03T10:00:00.000Z"
    },
    {
      "kind": "decision",
      "id": "dec_…",
      "projectId": "prj_…",
      "scope": "area",
      "area": "api",
      "question": "How do routes name a project?",
      "choice": "In the path.",
      "rationale": "…",
      "decidedBy": "builder",
      "supersedesId": null,
      "supersededById": null,
      "state": "current",
      "sourceId": "src_…",
      "withdrawnAt": null,
      "withdrawnReason": null,
      "createdAt": "2026-11-03T09:00:00.000Z",
      "updatedAt": "2026-11-03T09:00:00.000Z"
    }
  ],
  "truncated": false,
  "search": { "available": true, "message": null }
}
```

Every item has `kind` (`decision` or `principle`), `id`, `scope`, `area`, `state`, `createdAt` and its text: a
decision's `question`, `choice` and `rationale`; a principle's `statement`, `principleKind`, `topicKey` and
`rationale` (null when none was given). `projectId` is null for a `you` record. `truncated` is true when more
matched than `limit`.

**Search can be unavailable.** If a search index was damaged and the daemon could not rebuild it at start,
`search` is `{ "available": false, "message": "Search is unavailable: …" }` and a request with `q` answers an
empty `items`. A list without `q` still works. Say so to the person rather than reporting "nothing found".

## Decisions

### Record a decision

`POST /projects/:projectId/decisions` → **201** with the decision item (the shape above, `kind: "decision"`).

| Field       | Required             | Meaning                                                         |
| ----------- | -------------------- | --------------------------------------------------------------- |
| `question`  | yes                  | What was decided, 1 to 2000 characters.                         |
| `choice`    | yes                  | The answer, 1 to 2000.                                          |
| `rationale` | yes                  | Why, 1 to 4000.                                                 |
| `scope`     | no                   | `you`, `project` or `area`. Default `project`.                  |
| `area`      | with `scope: "area"` | The area's name. Refused (400, `area: …`) with any other scope. |
| `source`    | no                   | See [Sources](#sources).                                        |
| `dryRun`    | no                   | See [Dry runs](#dry-runs).                                      |

A decision never replaces another on its own; to change one, supersede it.

### Supersede a decision (Edit)

`POST /decisions/:id/supersede` → **201** with the new decision, whose `supersedesId` is `:id`. The old one
becomes `superseded` and leaves the default list.

Name the fields to change; the rest are kept: `question`, `choice`, `rationale`, `scope`, `area`, `source`,
`dryRun`. At least one of the first five is required (400 otherwise). Changing `scope` moves the decision: `scope:
"area"` needs `area`; moving a `you` decision into a project needs `projectId` (a `prj_…`) too.

409 if `:id` is not current, naming the current decision: `Decision dec_a is superseded; only a current decision can
be superseded (the current one is dec_b)`.

### Withdraw a decision

`POST /decisions/:id/withdraw` with `{ "reason": "…" }` (required, 1 to 2000 characters). → **200** with the
decision item, now `withdrawn`, with `withdrawnAt` and `withdrawnReason`. Nothing is deleted: the tombstone shows
with `history=1`.

Only the current record of a chain can be withdrawn. 409 if it is already withdrawn, or if a later decision
supersedes it (`A later decision (dec_b) supersedes this one; withdraw that one first (the current one is dec_c)`).
Withdrawing the current record makes the one before it current again.

(Shape's `POST /shapes/:shapeId/decisions/:decisionId/withdraw` still works; it is the same store function.)

### Provenance of a decision

`GET /decisions/:id/provenance`: see [Provenance](#provenance).

## Principles

### Create a principle

`POST /projects/:projectId/principles` → **201** with the principle item (`kind: "principle"`). It is confirmed at
once, by the builder.

| Field                               | Required | Meaning                                                            |
| ----------------------------------- | -------- | ------------------------------------------------------------------ |
| `statement`                         | yes      | One rule, phrased as an instruction, 1 to 500 characters.          |
| `kind`                              | no       | `policy`, `heuristic` or `belief`. Default `heuristic`.            |
| `topicKey`                          | no       | Default: made from the statement.                                  |
| `rationale`                         | no       | Why the rule holds, 1 to 2000.                                     |
| `quote`                             | no       | The builder's own words, up to 2000. Falls back to `source.quote`. |
| `scope`, `area`, `source`, `dryRun` | no       | As for a decision.                                                 |

**A current principle with the same `topicKey` at the same target is replaced** by the new one, not refused: the
old becomes `superseded` and the new one's `supersedesId` names it. (A target is the scope, the project and, for
`area`, the area.) A dry run says which one it would replace.

### Supersede a principle (Edit)

`POST /principles/:id/supersede` → **201** with the new principle; its `supersedesId` is `:id`.

The successor may change `statement`, `kind` (the principle's kind), `topicKey`, `rationale`, `quote`, `scope` and
`area`; what the body leaves out is kept from the principle replaced. Name at least one of `scope`, `area`,
`statement`, `kind`, `topicKey`, `rationale`. Moving a `you` principle into a project needs `projectId`. Also
`source` and `dryRun`.

409 in two cases, each naming the record:

- `:id` is not current: `Principle pri_a is superseded; only a current principle can be superseded (the current one is pri_b)`.
- The successor's key already has a current principle at the new scope: `Principle pri_c already holds the key
testing.no-sleeps at that scope; supersede or retire it first`. Edit or retire `pri_c` first.

### Retire a principle

`POST /principles/:id/retire` with `{ "reason": "…" }` (required). → **200** with the principle, now `retired`
(`retiredAt`, `retiredReason`). A retired principle is no longer injected anywhere, and stays in history. 409 if it
is not current, naming the current one.

### Withdraw a principle

`POST /principles/:id/withdraw` with `{ "reason": "…" }` (required). → **200** with the principle, `withdrawn`. For a
mistaken record, not a changed mind (that is retire or supersede). 409 if it is already retired, superseded or
withdrawn, if a later principle supersedes it (naming the current one), or if withdrawing it would make an earlier
principle current beside one that now holds its key (naming that one).

### Provenance of a principle

`GET /principles/:id/provenance`: see [Provenance](#provenance).

## Proposals

A managed session or 10db's answer detector can **propose** a principle. It waits in the Inbox as a proposal, state
`proposed`, and is injected nowhere until it is accepted.

- `GET /projects/:projectId/proposals?status=pending` (`pending` default, `accepted`, `rejected`) → an array of
  proposals: `{ id, projectId, kind: "principle", title, body, status, rationale, principle, sourceId, createdAt,
updatedAt }`, where `principle` is the proposed principle (a `PrincipleDto`: `kind` there is `policy`,
  `heuristic` or `belief`). Other proposal kinds are answered in the Inbox and are left out.
- `POST /proposals/:id/accept` → **200** with the proposal, now `accepted`, and its principle `confirmed`. The body
  is optional; a field given replaces the proposal's before it is confirmed: `scope`, `area`, `statement`, `kind`,
  `topicKey`, `note` (≤ 4000), and `dryRun`. As on create, a current principle with the same key and target is
  replaced.
- `POST /proposals/:id/reject` with an optional `{ "note": "…" }` → **200** with the proposal, `rejected`; its
  principle is withdrawn.

409 if the proposal is not pending. 400 `proposal: …` for a proposal that is not a principle's.

## Dry runs

`"dryRun": true` on a create, supersede or accept runs every check the real write runs, then writes nothing (not
the record, not its source row). It answers **200** (a real write answers 201):

```json
{
  "dryRun": true,
  "wouldWrite": {
    "kind": "principle",
    "scope": "project",
    "area": null,
    "statement": "…",
    "principleKind": "policy",
    "topicKey": "testing.no-sleeps",
    "state": "current",
    "supersedesId": "pri_…",
    "…": "…"
  },
  "replaces": { "kind": "principle", "id": "pri_…", "state": "current", "statement": "…", "…": "…" }
}
```

- `wouldWrite` is the item as it would be stored, without `id` or `sourceId`.
- `replaces` is the record the write would supersede, **as it is now**: the one `:id` names on a supersede, or on a
  create and an accept the current principle with that topic key and target. It is `null` when the write replaces
  nothing.
- A write that would be refused answers the same 400 or 409 a real one would, so a dry run is the way to ask "would
  this work, and what does it replace?" before writing.

Retire and withdraw have no dry run: they change one named record in one way.

## Sources

`source` is an optional object on every write:

```json
{
  "via": "claude_code",
  "sessionId": "9c1f…",
  "cwd": "/Users/me/Projects/app",
  "quote": "never sleep in a test"
}
```

`via` (required, ≤ 60) names the tool; `sessionId` (≤ 200) is that tool's own session id, not one of 10db's; `cwd`
and `quote` (the builder's own words, ≤ 2000) are optional. Unknown fields are refused. The daemon stores them as
a `sources` row of kind `builder`, written in the same transaction as the record. A write without `source` still
gets a bare `builder` source row, so every record has provenance.

## Provenance

`GET /decisions/:id/provenance` and `GET /principles/:id/provenance` answer where a record came from and what has
happened to it:

```json
{
  "id": "pri_…",
  "kind": "principle",
  "state": "superseded",
  "sourceKind": "builder",
  "sourceRef": {
    "via": "claude_code",
    "sessionId": "9c1f…",
    "cwd": "/Users/me/Projects/app",
    "quote": "never sleep in a test"
  },
  "origin": { "via": "claude_code", "sessionId": "9c1f…", "cwd": "/Users/me/Projects/app" },
  "recordedAt": "2026-11-03T10:00:00.000Z",
  "by": "builder",
  "quote": "never sleep in a test",
  "speaker": "builder",
  "confirmedBy": "builder",
  "confirmedAt": "2026-11-03T10:00:00.000Z",
  "supersedes": null,
  "supersededBy": "pri_…",
  "retired": null,
  "withdrawn": null,
  "inbox": null,
  "session": null
}
```

| Field                        | Meaning                                                                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `sourceKind`, `sourceRef`    | The `sources` row as stored. Kinds include `builder` (this API, and the builder's own screens), and others for answered cards and sessions. |
| `origin`                     | For a builder source with a `via`: the tool, its `sessionId` and `cwd` (null when absent). Null for every other source.                     |
| `recordedAt`, `by`           | When the source was written, and who made the record (`builder`, or an agent's name).                                                       |
| `quote`, `speaker`           | The words the record came from and who said them. A decision's quote is the source's `quote`.                                               |
| `confirmedBy`, `confirmedAt` | Principles: who confirmed it and when.                                                                                                      |
| `supersedes`, `supersededBy` | The record this one replaced, and the one that replaced it (null when none).                                                                |
| `retired`, `withdrawn`       | `{ "at", "by", "reason" }` when it was retired or withdrawn; null otherwise.                                                                |
| `inbox`                      | The Inbox card a record answers (`id`, `title`, `choice`, `note`); null otherwise.                                                          |
| `session`                    | A 10db session (`id`, `workstreamId`, `taskTitle`) that wrote the record; null for a builder source.                                        |

## Recipes

Find what a project already decided about a topic, current records only:

```sh
curl -s -H "$AUTH" "$BASE/projects/$PRJ/knowledge?q=queue+retries"
```

Record a principle the builder just said, with where it came from, after checking what it would replace:

```sh
BODY=$(jq -n --arg s "$SESSION" --arg c "$PWD" '{statement: "Tests never sleep; they wait on a condition.",
  kind: "policy", topicKey: "testing.no-sleeps", rationale: "Sleeps are slow or flaky.",
  source: {via: "claude_code", sessionId: $s, cwd: $c, quote: "never sleep in a test"}}')
# What it would replace (200, nothing written):
echo "$BODY" | jq '. + {dryRun: true}' | curl -s -H "$AUTH" -H 'Content-Type: application/json' -d @- "$BASE/projects/$PRJ/principles"
# Write it (201):
echo "$BODY" | curl -s -H "$AUTH" -H 'Content-Type: application/json' -d @- "$BASE/projects/$PRJ/principles"
```

Change a principle's scope to one area and tighten its statement (the key stays):

```sh
curl -s -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"scope":"area","area":"api","statement":"API tests never sleep."}' "$BASE/principles/$PRI/supersede"
```

Retire and withdraw:

```sh
curl -s -H "$AUTH" -H 'Content-Type: application/json' -d '{"reason":"The queue was removed."}' "$BASE/principles/$PRI/retire"
curl -s -H "$AUTH" -H 'Content-Type: application/json' -d '{"reason":"Recorded in the wrong project."}' "$BASE/decisions/$DEC/withdraw"
```

## At start

The daemon checks the decisions and principles search indexes against their tables when it starts. An index that
disagrees is logged (`daemon.log`) and rebuilt. If a rebuild fails the daemon logs that too and **keeps serving**:
the list route then reports `search.available: false` (see above), which the Knowledge view shows in one line. No
Inbox card is raised, because the builder has nothing to answer.
