# apps/desktop/src/views/evals

- Evals (`views/evals/`, `daemon/evals-queries.ts`) is the project's nav item after Knowledge. It shows what the
  daemon found of the selected project's evals at its checkout's HEAD (`GET /projects/:id/evals`, `EvalsDto`): it
  reads eval files at HEAD and result files in the checkout (projects keep them out of git), and never runs an
  eval or calls a model. 10db defines no eval format; the daemon
  reads each project's own (`apps/daemon/src/evals/`).
- Three tabs: Suites, By Model and No Eval. Suites is one raised table (`suite-table.tsx`): the suite and its bar in words
  (one dim line; the first definition path or the key when there is no bar), the last result per model
  (`result-marks.tsx` `ModelLine`: a dot, the model, gates passed and the gate furthest under its minimum in
  red), the last eight runs as dots (hollow red for failed, with a thin rule before a run whose eval's fingerprint
  changed, so a dot is read against runs of the same eval), the cost of a run per model, p50 latency and the
  run's date. A status is text, never a pill (DESIGN.md, Tables). A cost the report lacks reads "unknown",
  never $0 (`eval-figures.ts`). The table lists every suite: a project has tens, so it isn't paged.
- The byline under the title says what is found and when it was assessed ("Assessed 2 hours ago", the exact time and
  commit in a tooltip; "Assessing…"; "Not assessed yet"). It never names a commit or says no model ran.
- `assess-action.tsx` is the one **Assess now** button (busy while an assessment runs, whoever started it). Where the
  daemon says it has no model to ask (`unavailable`: a Codex-only builder with no other account), the same place
  offers "Copy a prompt for your own session", the sentence to paste in a session that runs the `10db-task` skill's
  "Assess a project's evals", and says why. `AssessmentNotice` heads Suites with the state: assessing, unavailable,
  failed (the reason) or "Not assessed yet" with Assess now. A project with no eval file and no result is the
  `NoEvals` empty state: New Eval (primary) and Assess now. Eval files found by name that no suite links to list
  under the table, folded past six.
- No Eval lists the manifest's gaps (LLM work with no eval, where, and why it counts); before an assessment it
  is an `EmptyState` with Assess now.
- A row opens `SuiteDrawer` (`suite-drawer.tsx`, `GET /projects/:id/evals/:suiteKey?run=`): the bar; the gates
  of one run, failing first, with a model switch when the run has several (the failing model first); every run
  (newest first, eight shown), where a click shows that run whole; flaky cases across the last runs; and what
  the manifest says it covers, its definition and its free and live commands. The live command is shown, never
  run. A run picked in one suite is dropped when another opens.
- A `project` event refetches every evals query (`INVALIDATIONS`), since recording a manifest is the project's.
- A model's line says the trials that got no answer apart from its gates ("1 provider error · 2 timeouts",
  `unansweredText`): availability is not quality, though those trials stay in every gate's denominator. When a
  suite's definition was committed more than 12 hours after its latest run (`definitionChangedAt`), Last Run
  adds "eval changed <date>" and the drawer says that run may not measure the eval as it is now; the drawer's
  runs mark "new eval" where the fingerprint changed.
- When HEAD has moved past the assessed commit and the manifest misses something (`drift`), Suites opens with a
  bordered "Changed since the last assessment" line: new eval files no suite links, new LLM calls with no eval and
  paths the manifest names that are gone, each listed, with Assess now. It is information on the page only.
- No Eval says under each `where` whether the gap was `assessed` or `found at HEAD` by a call pattern, and above
  the table how many sites each pattern found, so a pattern that is too broad shows.
- By Model (`by-model.tsx`, `GET /projects/:id/eval-models`, fetched when the tab opens): one row per model, its
  suites passed of those it ran, the ones it failed, the cost of one run of each and p50. A row click picks the
  model, and "Compare with" (a `Select`) puts a second model beside it per suite (`model-compare.ts`: the suites
  where they differ first, and the cost difference over the suites both ran with a known cost). A result from an
  older eval says so in its cell. It reads results already on disk and never runs a model.
- New Eval (`new-eval-modal.tsx`): a button in the page header, one on each No Eval row (prefills the behavior, the
  gap's reason as evidence and its `where` path) and one over a goal's proposed eval (`PlanEval`) in a Plan's
  Documents tab (objective, decision, oracle, models and baseline prefill it). The modal files a task through
  `POST /projects/:id/evals/tasks` and then links to it on the Board; the lane drafts the eval and never runs
  the live arm.
