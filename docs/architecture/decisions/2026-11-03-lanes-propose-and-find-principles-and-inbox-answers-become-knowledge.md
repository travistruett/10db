# Lanes propose and find principles, and inbox answers become decisions and proposed principles

- **Date:** 2026-11-03
- **Amends:** decision 17 (agents only propose principles; the builder confirms with a scope)

## Decision

**`find_knowledge` (K6).** It searches the project's current decisions and current confirmed principles, the
builder's own (`you`) records included, across all of the project's areas, and labels each hit with its `scope`
and `area`. It takes an optional `kind`: `any` (the default), `decision` or `principle`. Its `limit` applies to
each shelf: up to `limit` decisions and up to `limit` principles. History never reaches an agent: a proposed,
superseded, retired or withdrawn record is not returned. Its output gains `principles` (an older recorded result
without it parses with `[]`). The context pack, which an agent does not ask for, stays strict about scope; a lane
searching on purpose may need a neighbouring area's record, and the label lets it judge.

**`propose` with kind `principle` (K7).** It takes an optional `principle` draft (statement, kind, topic key,
scope, area, quote, rationale). Without one, the body is the statement when it is a valid one (at most 500
characters), else the call is refused. A draft on any other kind of proposal, or an area the project does not
have, is refused. 10db stores a `proposed` principle, a pending proposal linked to it, and one Inbox card whose
options are the stable values `accept_project`, `accept_you`, `accept_area` (only when the draft names an area)
and `reject`; the card recommends the verdict for the draft's own scope. Its result gains `principleId` (`null`
for other kinds). Until the card is answered, the principle is `proposed` and `find_knowledge` does not return it.
Answering the card runs one function inside the answer's transaction: an accept confirms the principle at the
chosen target (an area target must be one of the project's areas), a reject withdraws it with the answer's note as
the reason, or "Rejected in the Inbox" when the answer has no note or a blank one. A second verdict on a decided
proposal is a conflict and changes nothing. `record_decision` still takes project or area scope only, now checking
that the area exists.

**Decisions from answers (K8).** An answered question card is recorded as a decision as before (a product, design or
engineering question, at project scope), unless the answer says otherwise: `record: null` records nothing, and
`record: { scope, area }` records it at that target for a question in any category (`you` has no project, so
every project finds it). The recording runs in the answer's transaction, so an area the project lacks refuses the
answer and the card stays open. An answer that is "Park the task" records no decision and proposes no principle.

**Always and never (K9).** Until a PM agent exists, a deterministic detector turns each sentence of an answered
question's note that contains the word "always" or "never" (a whole word, at least three words long) into a
principle proposal: kind `policy`, topic key made from the sentence, scope `project`, the sentence as the quote,
speaker `me`, at most three per answer. Each raises the same card as an agent's proposal. The PM agent will later
propose through the same path.

## Why

Spec §6, §9 ("with a choice of scope"; "Inbox answers become decisions"; "The PM proposes principles from
always/never statements in answers") and §7. Agents only propose, and a principle that is not confirmed reaches no
agent, so the builder's scope choice is the only way one becomes current. The verdict values stay stable, like
permission choices, so the UI can show words. Withdrawing a rejected principle keeps the status vocabulary at the
spec's three and still records who and why. A word rule is predictable, and nothing it proposes applies without
the builder's confirmation. Changes to the tool contracts are additive and `PROTOCOL_VERSION` is unchanged.
