# A knowledge record has a target and a state derived on read, and only a current record can be withdrawn

- **Date:** 2026-11-03
- **Amends:** decision 17 (what "you, project or area scope" and "provenance on every write" mean in the tables)

## Decision

**Target.** A decision or a principle applies to a target: `you` (no project; it applies in every project),
`project`, or `area` (a project and one of its area names). `KnowledgeScope` in `packages/contracts/src/states.ts`
is the one vocabulary; Shape's `RecordScope` is the same values re-exported from it. The stored columns are
`scope`, `project_id` and `area`; `targetColumns` turns a `KnowledgeTarget` into them, and a `you` record has a
null `project_id`.

**State is derived, never stored.** `KnowledgeState` is worked out on read, in this order:

1. `withdrawn` if the record has a tombstone (`withdrawn_at` set);
2. for a principle, `proposed` while its stored status is `proposed`;
3. `superseded` if a successor that is not withdrawn (and, for a principle, not proposed) names it in
   `supersedes_id`;
4. `retired` for a principle whose stored status is `retired`;
5. otherwise `current`.

The stored `PrincipleStatus` (`proposed`, `confirmed`, `retired`) is only what the builder did; whether a
confirmed principle is still current depends on its successors. `decisions` and `principles` both index
`supersedes_id` (`decisions_supersedes_idx`, `principles_supersedes_idx`), since every read looks a successor up.

**Withdrawing.** Nothing is hard-deleted. A withdrawn record stays as a tombstone with `withdrawn_at`,
`withdrawn_by` and a required `withdrawn_reason`; search and the context pack skip it, and the history view shows
it. Only a current record, or a proposed principle (which rejecting its proposal withdraws), can be withdrawn;
anything else is a 409. Withdrawing a superseded link would make its predecessor current beside its successor,
so only the head of a chain can be withdrawn, and withdrawing the head makes the link before it current again.
No CHECK guards the withdrawn columns on either table: adding one to `decisions` rebuilds the table and drops its
full-text triggers, and `principles` follows the same rule so the code that writes the columns is the one place
that enforces the reason.

**Decisions supersede only by an explicit link.** A decision has no natural fixed key, so the builder's
Supersede action records a new decision whose `supersedes_id` names the old one, at any target. Re-scoping a
decision is a supersede. An agent's `record_decision` never supersedes.

**Provenance.** Every record has a `source_id` naming a `sources` row, written in the same transaction as the
record. A principle also keeps the quote and speaker it came from, who confirmed it and when, and why it holds
(`rationale`, nullable, shown beside the statement and not searched).

**Events.** A decision supersede emits the existing `decision.recorded` for the successor, and a withdrawal emits
`decision.withdrawn`; there is no `decision.changed`. Saving a principle emits `principle.saved`, and each
context-pack injection emits `context.packed`.

## Why

Spec §4 says knowledge status is derived on read and supersession uses fixed keys; §9 asks for provenance on
every write and a withdrawn tombstone rather than a silent delete. One rule for both tables keeps the pack,
search and the Knowledge view agreeing about what is current. Refusing to withdraw a middle link stops a chain
forking into two current records. The withdrawn columns are not constrained for the reason Shape's migration
0027 recorded: a CHECK rebuilds `decisions`, and the rebuild drops its triggers.

Turned down: storing a `state` column (it would drift from the successor links), and re-linking a withdrawn
record's successor to its predecessor (the builder can withdraw the newer records first instead).
