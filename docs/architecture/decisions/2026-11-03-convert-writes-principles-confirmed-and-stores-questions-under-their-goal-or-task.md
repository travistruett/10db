# Convert writes principles confirmed and stores questions under their goal or task

- **Date:** 2026-11-03
- **Amends:** `decisions/2026-11-02-shape-session-and-convert.md` (it listed principles and questions as not converted yet)

## Decision

**Principles.** Convert writes a principle record as a confirmed principle through `insertPrinciple`. Converting
is the builder's own confirmation (Decision 17: agents only propose), so the principle's speaker and
`confirmed_by` are the builder's handle, and its source is a `builder` source naming the conversation and the
proposal key, as a converted decision's is.

- `PlanPrincipleRecord` gains an optional `principleKind` (`policy`, `heuristic` or `belief`; absent means
  `policy`) and an optional `topicKey` (absent means `topicKeyFrom(statement)`). The field is not called `kind`,
  because the record's `kind: 'principle'` already tells it from a decision.
- A principle replaces the current one with the same topic key and scope implicitly: `insertPrinciple` finds it
  through `currentPrincipleFor`. The record names no predecessor, so `validatePlan` refuses `supersedes` on a
  principle record ("a principle supersedes by topic key and scope"). The replaced principle answers
  `superseded` in the list route with history on and leaves search and `find_records`.
- An `area` principle must name an area the project has; Convert refuses it by name and writes nothing, as it
  refuses a task that depends on one not selected.

**Questions.** Convert stores a question record in `shape_questions` (text, the role or person it is for, its
source messages) and sends nothing; goals phase 3 sends them. `PlanQuestion` gains an optional `about`: the key
of the goal or task the question belongs to. Convert stores the question under that goal or task
(`shape_questions.goal_id` or `task_id`), refuses `about` naming a pending row that is not selected, and a
question with no `about` belongs to neither. Without a field naming it, nothing in a question says which goal or
task it is about. Shape's prompt and the `propose_plan` description tell the session to set `about`.

Remove Draft Goal takes back every question stored under the goal or one of its tasks, in the same transaction: the
row and its link are deleted and its proposal is pending again, so it converts anew with the goal and `about` still
means what it said. The links to the goal's tasks go too, including a task added by a later proposal, so a later
Convert cannot resolve a key to a cancelled task; a question about such a task is refused by name until it is
re-proposed.

**Links.** `shape_links` gains `principle_id` and `question_id`, and its CHECK now demands exactly one of its five
targets. The change is two generated migrations, as 0027 and 0028 were: 0039 adds `shape_questions` and the two
columns by `ALTER TABLE`, and 0040 rebuilds `shape_links` for the CHECK. drizzle-kit's rebuild copies every column
from the old table, so a column added in the same step would be read from a table that lacks it. Every existing link
survives the rebuild.

**Withdraw Principle….** The converted principle's row menu in the Proposed sidebar withdraws it, as Withdraw
Decision… does. `POST /shapes/:shapeId/principles/:principleId/withdraw` goes through `ApiServices` to the shape
service, which checks the conversation wrote the principle and calls `withdrawPrincipleRecord`, the function the
knowledge routes call. A principle a later one replaced cannot be withdrawn (409), so the view marks it
`superseded` and offers no menu item. The converted row's DTO carries `principleId`, `questionId`, `withdrawn` and
`superseded`.

**`find_records`** returns current principles beside decisions: `RecordHit` is a union on `kind`, and a principle
hit carries its statement, rationale, `principleKind`, topic key, scope, area and date. One query ranks both kinds
by `bm25`, each table's own score, so a close match in either comes first. The transcript's dimmed line cites a
principle as "Principle 2026-10-30 (policy, tests.no-sleeps): …".

**Briefing.** A Plan session that has nothing to resume (a new conversation, or one that moved on at 70% of its
context) starts with `principlesBrief`: the builder-wide and project policies and heuristics, packed into the lane
context pack's budget and worded by `renderRules`, so a rule reads the same to a lane and a conversation. Beliefs
and area principles are left out; the session finds area principles with `find_records`. A session resumed by id
heard the rules in its first turn. Shape's prompt tells the session to propose a principle record when the
builder states a rule with "always" or "never", and to call `find_records` first.

## Why

- Confirming at Convert follows Decision 17 (agents only propose, the builder confirms) and spares the builder a
  second card for a rule he has already approved by pressing Convert.
- Superseding by key and scope keeps one rule per key at a place, the invariant the knowledge routes hold; a
  `supersedes` id on a principle record would let a conversation break it.
- An explicit `about` costs one optional field and keeps a question tied to the row it is about; guessing from
  the shared source message would link a question to the wrong task whenever a message produced several.
- Reusing `withdrawPrincipleRecord` and `renderRules` keeps one word for a withdrawal and one reading of a
  rule across the knowledge routes, the lanes and Shape.
- A turned-down alternative was to brief every turn: a resumed session already holds the rules, and repeating
  them spends context on each turn for nothing.
