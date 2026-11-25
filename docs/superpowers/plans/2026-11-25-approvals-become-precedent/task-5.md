# Task 5: candidates, the card and its answer

**Size: Core** (a permission the builder gives). Read the index's Brief and Global Constraints first. Needs
tasks 2–4.

## Files

- `packages/db/src/store/skipped-actions.ts`: `listDoubtSkips(db, projectId, since)`: skips of kind `classifier`
  with no `limit_name` and `summary_cut` false, with their run, task and whether the run is in a copy; and the
  same key's skips that do name a limit, for the warning.
- `packages/db/src/store/judge-calls.ts`: `listUnclearLimitCalls(db, projectId, since)`: `crosses_limit` rows
  answered `unsure`, with `state` and `probabilities`.
- `apps/daemon/src/trust/precedent-candidates.ts` (new): `precedentCandidates`. Group both lists by
  `programKey` and scope; drop keys with a `trust_precedents` row in any state; keep a key at the thresholds, or
  whose run failed `blocked` naming it, or with a skip approved through Run these now (`approvedSkipsForTask`).
  `kind` defaults to `` `<key>` with arguments like the examples ``; `runs` is the committed text through
  `callRuns` (null when it reads nothing); `topWorry` from the newest row's probabilities; `stoppedAtLimit` from
  the last 30 days.
- `apps/daemon/src/inbox/precedent-card.ts` (new): `precedentFoldKey`, `refreshPrecedentCard` (kind
  `permission`, tier `ask`, `closesWhen: BY_ANSWER`; title "Make n kinds of command routine in <project>?";
  rewords in place; resolves when no candidate is left), `applyPrecedentAnswer` (Approve → `insertPrecedent`
  with the candidate's examples, `runsHash` and the edited `kind`; Keep Skipping → a `declined` row; Report →
  nothing written), and the conflict card (fold key `precedent-conflict:<id>`, with Keep, Edit, Remove).
- With no Decisions account, Approve also stores each example through `grantTargetOf(null, example, 'Bash')`
  and `insertTrustGrant`, and the card's body carries the line from the spec.
- `apps/daemon/src/daemon/trust-services.ts`: the three routes. The answer route computes candidates, then in
  one write applies the answer and refreshes the card. PATCH to `revoked` or `active`, and a `kind` edit.
- Refresh points: after the skip recorder records a doubt skip (`trust/skip-recorder.ts`, through an injected
  callback, not an import of `inbox/`), after an answer, and once at start.
- `apps/daemon/src/delivery/skipped-card.ts`: `SkippedChoice.RunAndMakeRoutine` ('Run and Make Routine'),
  offered when every approvable skip names no limit and has a key; `applySkippedChoice` runs them as Run these
  now does and inserts their precedents in the same write.
- The changed-script notice: where the hook judge first sees `changedSince` for a precedent, `postNotice` (key
  `precedent-changed:<id>:<hash>`), with Remove and Keep (Keep stores the new hash through PATCH).

## Interfaces

Implements `precedent-candidates.ts`, `precedent-card.ts` and the HTTP block; calls the store.

## State-table rows

"No candidate", every "Offered" row, "Paused", "Any".

## Spec sections

"The proposal card"; "How a bad one is caught", points 1, 3 and 4; "Provider parity".

## Tests

One daemon test on a real SQLite file (`apps/daemon/src/inbox/precedent-card.test.ts`): seeded doubt skips
across two runs raise one card; an answer approving one kind and declining another writes both rows in the
answer's write and rewords the card; the same answer sent again writes nothing; a key with a limit skip is
offered with `stoppedAtLimit`. Value card: `protects=a standing approval exists only by the builder's answer,
once; fails_when=a row is written outside the answer, twice, or for a limit skip; why_new=permissions;
no_claim=that the judge then allows the kind (task 4)`.
