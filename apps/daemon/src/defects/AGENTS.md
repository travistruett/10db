# defects

- `file-defect.ts` files a defect that 10db finds in itself as a task in 10db's own project, inside the
  caller's write. Later self-healing rules that give up after repeats (a stuck run, a batch out of moves) reuse
  `fileDefect`; it is first called by the third repeat of a claim deadlock (`mcp/claim-deadlock-report.ts`).
- 10db's project is the first project not archived whose persisted checkout pin (`projectPinKey`, written by
  `daemon/checkout-pins.ts`) has a push URL naming `TENDB_REPOSITORY` on GitHub, compared case-insensitively.
  The pin is read rather than git because the filer runs inside a write. A checkout never pinned, a fork or a
  renamed repository reads as no project.
- A defect task's description opens with `Defect signature: <signature>`. An open task in that project whose
  first line is the same folds the repeat into it: `fileDefect` answers null and files nothing. A signature
  never names a task or run id, so the same defect in another run folds too.
- The task gets the project's first area, one acceptance criterion and the Icebox column; it is never started
  here and raises no card. `fileDefect` answers null when there is no 10db project, no area, or a fold; the
  caller then carries the report itself (the yield notice's body, for a claim deadlock).
