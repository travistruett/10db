# Architecture records

- `NN-*.md`: numbered sections. Each opens with Status (Draft | Locked), Scope and Summary. A
  Locked section changes only through a new decision that says what it supersedes.
- `decisions.md`: append-only log, `| # | Decision | Why |`. A row that replaces an earlier one
  says "Supersedes N". Never edit or renumber a row.
- `open-questions.md`: questions with no answer yet, each with who or what can answer it.
- `proposals/`: changes under discussion. `reviews/`: review reports. `research/`: spike results
  and vendor research, each claim marked VERIFIED (with a source) or UNKNOWN.

The full first-slice design is
[../superpowers/specs/2026-10-13-10db-factory-loop-design.md](../superpowers/specs/2026-10-13-10db-factory-loop-design.md).
Implementation plans are in [../superpowers/plans/](../superpowers/plans/).
