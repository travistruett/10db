# apps/desktop/src/views/evals

- Evals (`views/evals/`, `daemon/evals-queries.ts`) is the project's nav item after Knowledge. It shows what the
  daemon found of the selected project's evals at its checkout's HEAD (`GET /projects/:id/evals`, `EvalsDto`): it
  reads eval files at HEAD and result files in the checkout (projects keep them out of git), and never runs an
  eval or calls a model. 10db defines no eval format; the daemon
  reads each project's own (`apps/daemon/src/evals/`).
- The header's SegmentedControl (Evals | Models, as Factory's Live | Metrics) picks the page. Evals is four stat
  tiles (`StatTile`, `shell/stat-tile.tsx`, shared with Factory's glance) over one raised table (`evals-table.tsx`,
  25 a page with `usePaging`). The tiles are toggle filters (`aria-pressed`, outlined in their colour; the active one
  clears itself): Passing, Failing, Not Run Yet (suites with no results) and No Eval (LLM work with no eval plus eval
  files no suite runs). Tiles show once there is a suite, gap or unlinked file; a project with none is the
  `NoEvals` empty state. Rows, unfiltered, in order: failing suites, passing, not run, gaps, unlinked files.
  - A suite row: the suite and its bar in words (one dim line; the first definition path or the key when there is no
    bar), the last result per model
    (`result-marks.tsx` `ModelLine`: a dot, the model, gates passed and the gate furthest under its minimum in
    red), the last eight runs as dots (hollow red for failed, with a thin rule before a run whose eval's fingerprint
    changed, so a dot is read against runs of the same eval), the cost of a run per model, p50 latency and the
    run's date. A status is text, never a pill (DESIGN.md, Tables). A cost the report lacks reads "unknown",
    never $0 (`eval-figures.ts`). Only a suite row opens the drawer.
  - A gap row (LLM work with no eval): its label, why it counts under it, "No eval yet" with the `where` path and
    whether it was `assessed` or `found at HEAD`, and New Eval (prefills the behavior, the gap's reason as evidence
    and its `where` path). With the No Eval filter on, a line above the table says how many sites each call
    pattern found, so a pattern that is too broad shows.
  - An unlinked file row (found by file name, no suite uses it): the path and a dim line; no button of its own,
    since the notice above the table carries Assess Now and assessing links it. Before an assessment the No Eval
    tile counts files alone, says "not assessed" (a dash when there are none), and its filter opens with a line
    saying so; an assessed project with nothing there reads "Every LLM task has an eval."
- The byline under the title is only when the evals were last assessed ("Assessed 2 hours ago", the exact time and
  commit in a tooltip; "Assessing…"; "Not assessed yet"). It never names a commit or says no model ran. The
  first read shows `EvalsSkeleton` (`evals-skeleton.tsx`): tile placeholders over the table's real headings and five
  rows shaped like the data, after `page-loading.tsx`'s delay.
- `assess-action.tsx` is the one **Assess Now** button (busy while an assessment runs, whoever started it). Where the
  daemon says it has no model to ask (`unavailable`: a Codex-only builder with no other account), the same place
  offers "Copy a Prompt for Your Own Session", the sentence to paste in a session that runs the `10db-task` skill's
  "Assess a project's evals", and says why. `AssessmentNotice` heads the Evals page with the state: assessing, unavailable,
  failed (the reason) or "Not assessed yet" with Assess Now. A project with no eval file and no result is the
  `NoEvals` empty state: New Eval (primary) and Assess Now.
- A suite row opens `SuiteDrawer` (`suite-drawer.tsx`, `GET /projects/:id/evals/:suiteKey?run=`). From the top: the title and
  meta, the bar, and a verdict in plain words for the shown run (`runVerdict` in `eval-figures.ts`: which models pass
  every gate and how many each misses, counts instead of names past three models, "Cheapest that passes" when a
  passing model's cost is known, never $0 for an unknown one); an actions row, the suite's Run
  (`LiveRunControls`, with `SweepActions` beside Run) or a dim line saying 10db doesn't know how to run it yet; Gates, one run's gates failing first, with a `Select` of models ("name · 7/10 gates",
  failing first, searchable past six) when the run has several; History (every run, newest first, eight shown,
  a click shows that run whole); Flaky Cases; and Setup (what it covers, its definition, its free and live
  commands). Each section has one dim line saying what it is. The live command is shown, and its Run is the one
  place 10db runs it (below). A run picked in one suite is dropped when another opens.
- A `project` event refetches every evals query (`INVALIDATIONS`), since recording a manifest is the project's.
- A model's line says the trials that got no answer apart from its gates ("1 provider error · 2 timeouts",
  `unansweredText`): availability is not quality, though those trials stay in every gate's denominator. When a
  suite's definition was committed more than 12 hours after its latest run (`definitionChangedAt`), Last Run
  adds "eval changed <date>" and the drawer says that run may not measure the eval as it is now; the drawer's
  runs mark "new eval" where the fingerprint changed.
- When HEAD has moved past the assessed commit and the manifest misses something (`drift`), the Evals page opens with a
  bordered "Changed since the last assessment" line: new eval files no suite links, new LLM calls with no eval and
  paths the manifest names that are gone, each listed, with Assess Now. It is information on the page only.
- Models (`by-model.tsx`, `GET /projects/:id/eval-models`, fetched when the page opens; paged at 25 only past 25 models): one row per model, its
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
  Board. The button is in the page header, on each gap row (prefills the name, the gap's reason as evidence and
  its `where` path) and over a goal's proposed eval (`PlanEval`) in a Plan's Documents tab (objective as name and
  sentence; decision, oracle and baseline pass through; its models become the picked ids).
- Switch: a sweep that ends Found (`try-models-modal.tsx`, `SweepWindow`) offers "Switch to <model>", which files the
  task through `POST /projects/:id/evals/:suiteKey/switch` (the daemon finds the slot) and then links it on the Board.
  It needs a Found sweep, which the e2e daemon cannot run (no live command), so no flow clicks it.
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
- Model sweeps (`sweep-actions.tsx`, `try-models-modal.tsx`): beside Run, a suite whose live settings take models
  (`preview.models`) offers **Try Other Models** and **Find Cheapest Passing**; one that doesn't says "This suite's command
  doesn't take models from 10db yet" with **Let 10db Pick Models**, which files a `pick_models` New Eval task in one click.
  The modal runs three stages. The picker lists `GET .../candidates` (model, intelligence, output price per million,
  estimate, last result here; searchable past 40; at most 10 picks). Try starts with none picked; Find Cheapest preselects
  the known estimates under today's cheapest pass. Both ask for the most to spend, by default three times the latest
  run's cost to the next dollar (Try: one such run per picked model, at least three). The confirm window is the Run
  window's parts (`Notes`, `REFUSAL_WORDS`, a refusal and no Start) over `GET .../live?models=a,b`, whose hash Start
  posts with the models in that order, and says "Estimated $x, cap $y; one run can cost more than its estimate." The sweep
  window shows a line a step (model, state in words, cost), spent of cap and Stop, and ends with the verdict and its
  reason in words. The drawer finds a running or recent sweep through `sweeps/latest` and offers it again as a button on
  the row; `eval.sweep_changed` refetches the evals queries.
