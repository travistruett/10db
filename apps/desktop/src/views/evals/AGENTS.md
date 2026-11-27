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
- `assess-action.tsx` is the one **Assess Now** button (busy while an assessment runs, whoever started it). Where the
  daemon says it has no model to ask (`unavailable`: a Codex-only builder with no other account), the same place
  offers "Copy a Prompt for Your Own Session", the sentence to paste in a session that runs the `10db-task` skill's
  "Assess a project's evals", and says why. `AssessmentNotice` heads Suites with the state: assessing, unavailable,
  failed (the reason) or "Not assessed yet" with Assess Now. A project with no eval file and no result is the
  `NoEvals` empty state: New Eval (primary) and Assess Now. Eval files found by name that no suite links to list
  under the table, folded past six.
- No Eval lists the manifest's gaps (LLM work with no eval, where, and why it counts); before an assessment it
  is an `EmptyState` with Assess Now.
- A row opens `SuiteDrawer` (`suite-drawer.tsx`, `GET /projects/:id/evals/:suiteKey?run=`): the bar; the gates
  of one run, failing first, with a model switch when the run has several (the failing model first); every run
  (newest first, eight shown), where a click shows that run whole; flaky cases across the last runs; and what
  the manifest says it covers, its definition and its free and live commands. The live command is shown, and its Run is the one place 10db runs it (below). A run picked in one suite is dropped when another opens.
- A `project` event refetches every evals query (`INVALIDATIONS`), since recording a manifest is the project's.
- A model's line says the trials that got no answer apart from its gates ("1 provider error · 2 timeouts",
  `unansweredText`): availability is not quality, though those trials stay in every gate's denominator. When a
  suite's definition was committed more than 12 hours after its latest run (`definitionChangedAt`), Last Run
  adds "eval changed <date>" and the drawer says that run may not measure the eval as it is now; the drawer's
  runs mark "new eval" where the fingerprint changed.
- When HEAD has moved past the assessed commit and the manifest misses something (`drift`), Suites opens with a
  bordered "Changed since the last assessment" line: new eval files no suite links, new LLM calls with no eval and
  paths the manifest names that are gone, each listed, with Assess Now. It is information on the page only.
- No Eval says under each `where` whether the gap was `assessed` or `found at HEAD` by a call pattern, and above
  the table how many sites each pattern found, so a pattern that is too broad shows.
- By Model (`by-model.tsx`, `GET /projects/:id/eval-models`, fetched when the tab opens): one row per model, its
  suites passed of those it ran, the ones it failed, the cost of one run of each and p50. A row click picks the
  model, and "Compare with" (a `Select`) puts a second model beside it per suite (`model-compare.ts`: the suites
  where they differ first, and the cost difference over the suites both ran with a known cost). A result from an
  older eval says so in its cell. It reads results already on disk and never runs a model.
- New Eval (`new-eval-modal.tsx`, steps in `new-eval-steps.tsx`, state and rules in `new-eval-draft.ts`) is the app's
  first wizard and the pattern for the next: a 640 px `FormModal` with a compact Mantine `Stepper` (Goal, Examples,
  Checking, Models, Review), plain words with no "oracle", "arm" or "lane", a dim "why we ask" line under each
  question and Back/Next in the footer. Next stays shut until the step's minimum is met (`stepProblem`: a name and a
  sentence; 3 examples marked Good or Bad; a check and a bar; a model) and says why in the footer's tooltip and a
  dim line; Back keeps every answer, and a finished step's label returns to it. Review shows what the agent will
  build and Create Task files it through `POST /projects/:id/evals/tasks`; the success line links to the task on the
  Board. The button is in the page header, on each No Eval row (prefills the name, the gap's reason as evidence and
  its `where` path) and over a goal's proposed eval (`PlanEval`) in a Plan's Documents tab (objective as name and
  sentence; decision, oracle and baseline pass through; its models become the picked ids).
- Suggestions (`new-eval-suggest.tsx`, `eval-suggest-queries.ts`): "Tighten This" (before and after, Use This),
  "Suggest Cases" (5 proposals that arrive unmarked; the builder adds each and marks it Good or Bad, never the AI)
  and "Suggest a Check" (a check type and a one-line rule; never the bar). Each is one read of the project's
  account with no tool (`POST /projects/:id/evals/suggest`). Where the daemon says it has no model to ask
  (`GET /projects/:id/eval-suggest`: no account, or a Codex-only builder with no other account), the buttons are
  not drawn and one dim line says why; the wizard works the same by hand. Models come from `useModels` on the
  project's account with each one's score and price where known, plus a free-text id.
- Run (`live-run-modal.tsx`, `LiveRunControls`): beside a suite's live command in the drawer ("Run") and in a covered
  task's Evals block ("Run now"). The window (`GET .../evals/:suiteKey/live`) shows the command as stored, whether it
  runs in the builder's containers (and which env files compose may read) or which hosts it may reach, how Stop
  ends it, its time limit and the last run's cost ("unknown" when none). A refusal shows its reason and no Run
  (`docker_off` links to Settings › Allow Docker; `busy` with no running run means a stop command left by an
  interrupted run is still going). Run posts the hash the window showed; a `manifest_changed` 409 reloads the
  preview and says the window now shows what changed. A running run shows elapsed time and Stop; Stop answers at
  once and the run reads "Stopping" until its row settles. The end shows the state in words (text, never a pill),
  the exit code and the output's tail; an interrupted run whose stop command didn't run says the work in the
  containers may still be running. The window can close while a run goes: the drawer lists the last five runs, and
  a running one keeps its Stop. A suite whose manifest entry has no `live` says 10db doesn't know how the
  command runs yet and offers Assess Now (or the prompt to paste where 10db can't assess), no Run. `eval.live_run_changed` refetches the evals queries and the covered
  tasks' markers.
