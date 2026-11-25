# Task 5: candidates, the card and its answer

**Size: Core** (a permission the builder gives). Read the index's Brief and Global Constraints first. Needs
tasks 2–4.

## Files

- `apps/daemon/src/trust/precedent-candidates.ts` (new): `precedentCandidates`.
  - Read `listDoubtSkips` and `listUnclearLimitCalls` for the window. Both carry `program_key`, written by the
    hook judge since task 4, so nothing is parsed from a summary and rows from before P1 are not counted.
  - Group by key and scope (`copy` when every row of the key ran in a copy, else `project`). Keep a key at the
    thresholds, or whose run failed `blocked` naming it, or with a skip approved through Run these now
    (`approvedSkipsForTask`).
  - `kind` defaults to `` `<key>` with arguments like the examples ``; `runs` and `runsHash` come from `callRuns`
    on the newest example through `read` (null when it reads nothing); `topWorry` from the newest row's
    probabilities; `stoppedAtLimit` from the same key's skips with a `limit_name` in the last 30 days.
  - It does not filter against `trust_precedents`: the card's write does.
- `apps/daemon/src/inbox/precedent-card.ts` (new):
  - `refreshPrecedentCard` (kind `permission`, tier `ask`, `closesWhen: BY_ANSWER`; title "Make n kinds of
    command routine in <project>?"). Inside its write it drops every candidate whose key and scope have a row in
    any state, then raises, rewords in place, or resolves when none is left.
  - `applyPrecedentAnswer`: Approve and Keep Skipping → `approvePrecedent` with the candidate's examples and
    `runsHash` and the edited `kind`; Report → nothing written. Then `refreshPrecedentCard` in the same write.
  - The conflict card (fold key `precedent-conflict:<id>`, with Keep, Edit, Remove), raised from
    `onPrecedentPaused`.
- `apps/daemon/src/daemon/trust-services.ts`: the three routes. GET answers `ProjectPrecedentsDto`: every row,
  each with `lastAllowedByPrecedent(db, id, 5)`, and the candidates less those with a row. The answer route
  computes candidates, then applies in one write. PATCH: `active` goes through `approvePrecedent` from any state;
  `revoked`, `kind` and `runsHash` through `setPrecedent`.
- With no Decisions account nothing is stored in a precedent's place and no `trust_grants` row is written.
- Refresh points, each computing candidates and then writing: after the skip recorder records a doubt skip
  (`trust/skip-recorder.ts`, through an injected callback, not an import of `inbox/`); after an answer; once at
  start; and every `PRECEDENT_REFRESH_MS` on the injected clock for a project with an open precedent card, which
  is what takes a 14-day-old kind off it.
- `apps/daemon/src/delivery/skipped-card.ts`: `SkippedChoice.RunAndMakeRoutine` ('Run and Make Routine'),
  offered when every approvable skip has `source = 'tendb_judge'`, no limit and a `program_key`;
  `applySkippedChoice` runs them as Run these now does and calls `approvePrecedent` for their kinds in the same
  write, which also brings back a declined or revoked kind.
- The changed-script notice, from `onPrecedentChanged`: `postNotice` (key `precedent-changed:<id>:<hash>`), with
  Remove and Keep (Keep sends PATCH `{ runsHash: <hash> }`).

## Interfaces

Implements `precedent-candidates.ts`, `precedent-card.ts` and the HTTP block; calls the store and the two
`HookJudgeContext` callbacks.

## State-table rows

"No candidate", every "Offered" row, "Declined, revoked", "Paused", "Any".

## Spec sections

"The proposal card"; "How a bad one is caught", points 1, 3 and 4; "Provider parity".

## Tests

One daemon test on a real SQLite file (`apps/daemon/src/inbox/precedent-card.test.ts`): seeded doubt skips of
10db's judge across two runs raise one card; an auto mode denial with no limit name is not on it; an answer
approving one kind and declining another writes both rows in the answer's write, writes no `trust_grants` row and
rewords the card; a refresh with candidates computed before that answer leaves the answered kinds off; the same
answer sent again changes nothing; approving the declined kind through PATCH makes it `active`. Value card:
`protects=a standing approval exists only by the builder's answer, never from an auto mode denial, and a
declined kind can be approved again; fails_when=a row or grant is written outside the answer, a stale refresh
re-offers a kind, or approve is a no-op on a declined row; why_new=permissions; no_claim=that the judge then
allows the kind (task 4)`.
