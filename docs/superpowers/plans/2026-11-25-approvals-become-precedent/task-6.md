# Task 6: desktop

**Size: Feature.** Read the index's Brief and Global Constraints first, and `apps/desktop/AGENTS.md` and
`apps/desktop/src/views/inbox/AGENTS.md`. Needs task 5.

## Files

- `apps/desktop/src/views/inbox/precedent-card.tsx` (new), chosen in `inbox-card.tsx` by the fold key's
  `precedent:` prefix: reads `GET /projects/:id/precedents`, and draws each candidate with its kind line (an
  editable text field), what it runs (a folded code block, or "10db can't read what this runs"), its calls, where
  they ran, the counts, the top worry, and the limit warning with the tick off. Each kind has a segmented choice
  (Approve, Keep Skipping, Report, Later; Approve by default unless warned). One button, **Save Answers**, posts
  `PrecedentAnswer` for every kind not on Later. Report copies the report to the clipboard.
- The conflict card draws with the standard option buttons; no new component.
- `apps/desktop/src/views/settings/project-trust-section.tsx` and a new `standing-approvals.tsx` beside it: the
  list from the same route (`active` and `paused` rows), each with its kind, scope ("In copies" or "Everywhere in
  this project"), examples, uses, last use and **Remove** (PATCH `revoked`). Copy in `trust-rows.ts`.
- `apps/desktop/src/views/settings/decision-numbers.ts`: a `crosses_limit` row with a `precedentId` reads
  "Allowed as routine".
- `apps/desktop/src/views/inbox/card-actions.tsx` needs no change for Run and Make Routine: the skip card shows
  its options as written.
- Query hooks beside the trust hooks that exist (`useSetLiveSystems`'s module).

## Before review

Open the app on this worktree (the `10db-dev-window` skill), seed skips through the daemon's test project, and
show the builder screenshots of the card and of Standing Approvals (the `screens` skill). Layout is yours to
pick; show it, then go on.

## Spec sections

"The proposal card" (what each kind shows); "How a bad one is caught", point 4.

## Tests

No unit or component test. Extend `apps/desktop/e2e/project-trust.spec.ts` once: with a precedent seeded through
the answer route, This Project › Trust lists it under Standing Approvals, and Remove takes it off the list.
