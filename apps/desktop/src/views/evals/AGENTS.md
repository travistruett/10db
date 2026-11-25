# apps/desktop/src/views/evals

- Evals (`views/evals/`, `daemon/evals-queries.ts`) is the project's nav item after Knowledge. It shows what the
  daemon found of the selected project's evals at its checkout's HEAD (`GET /projects/:id/evals`, `EvalsDto`): it
  reads committed result files and never runs an eval or calls a model. 10db defines no eval format; the daemon
  reads each project's own (`apps/daemon/src/evals/`).
- Two tabs: Suites and No Eval. Suites is one raised table (`suite-table.tsx`): the suite and its bar in words
  (one dim line; the first definition path or the key when there is no bar), the last result per model
  (`result-marks.tsx` `ModelLine`: a dot, the model, gates passed and the gate furthest under its minimum in
  red), the last eight runs as dots (hollow red for failed), the cost of a run per model, p50 latency and the
  run's date. A status is text, never a pill (DESIGN.md, Tables). A cost the report lacks reads "unknown",
  never $0 (`eval-figures.ts`). The table lists every suite: a project has tens, so it isn't paged.
- Before an assessment (`assessedAt` null) a bordered line says the suites were found by file names and offers
  Copy the Ask, the sentence to paste in any Claude Code or Codex session that runs the `10db-task` skill's
  "Assess a project's evals" (it records the manifest through the CLI). Eval files found by name that no suite
  links to list under the table, folded past six.
- No Eval lists the manifest's gaps (LLM work with no eval, where, and why it counts); before an assessment it
  is an `EmptyState` with Copy the Ask, since only an agent can know.
- A row opens `SuiteDrawer` (`suite-drawer.tsx`, `GET /projects/:id/evals/:suiteKey?run=`): the bar; the gates
  of one run, failing first, with a model switch when the run has several (the failing model first); every run
  (newest first, eight shown), where a click shows that run whole; flaky cases across the last runs; and what
  the manifest says it covers, its definition and its free and live commands. The live command is shown, never
  run. A run picked in one suite is dropped when another opens.
- A `project` event refetches every evals query (`INVALIDATIONS`), since recording a manifest is the project's.
