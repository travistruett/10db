# apps/daemon/src/evals

- `evals/` reads a registered project's eval results and shows them. 10db defines no eval format: it reads each
  project's own, runs no eval, calls no model and writes nothing. Definitions and the manifest's path checks are read
  at HEAD through `Git.survey` (the tracked list). Results are read from the checkout's working tree
  (`result-files.ts`), because projects keep them out of git (ampsio's `evals/reports/` is gitignored): only
  `.json` files under each tracked `X/evals/reports` and `X/evals/lane-pipeline/baselines`, found with `readdir`
  entries that are real files (a symlink is never followed), at most 2,000 files, 1 MB each and 32 MB in all; past a
  cap the rest are counted as skipped. The cache key is HEAD plus the result files' count and newest mtime, so a new
  local report shows on the next open.
- `markers.ts` is the rule table over tracked paths: gate reports (`evals/reports/<task>/<UTC time>.json`),
  lane-pipeline baselines (`evals/lane-pipeline/baselines/<rigor>.json`), definition files by name (listed as
  unlinked until a manifest links them) and `claude plugin eval` cases (`<evals dir>/<case>/prompt.md`, one suite per
  evals dir, no results read). `gate-report.ts` and `lane-pipeline.ts` are the adapters: each has its own loose zod
  schema of only the fields read and maps to `ParsedRun` (`run-summary.ts`). A file that fails its schema is
  counted, logged at debug and left out, never thrown. A new format is a marker, an adapter and a case in
  `read-results.ts`.
- `read-results.ts` keeps the parsed results per checkout while HEAD stays put (memory only). `build.ts` lays the
  manifest over them: the list's order, the unlinked files, the drawer and its flaky cases (a source case with a
  failed and a passed trial over the last eight runs).
- The manifest is an app setting (`evals-manifest:<project id>`, `manifest-store.ts`), recorded by an agent
  (`evals <projectId> <file>` in the agent skill) and never a file in the repository. `service.ts` records it only
  when every `definitionPaths` entry is tracked at HEAD and every `coveredPaths` glob holds a tracked file (matched as
  a hazard's glob, `guard`'s `classifyPath`); else it answers the untracked names and keeps nothing. A recording emits
  the project's change event.
- It imports `git` (types), `guard`, `events` (types), `log` (types) and `@10db/db`.
- Availability is kept apart from quality: a gate report's `outcomes` other than `ok` and `validation_failed`
  (the model answered, malformed) are a model's `unanswered` trials. A trend point is `evalChanged` when its
  fingerprint differs from the run before it. `definitionChangedAt` is the last commit of a suite's definition
  paths (`Git.lastChangedAt`, read once per HEAD) when it is more than 12 hours after the latest run: a run
  is often committed with its eval soon after, which isn't a change.
- Call sites (`call-sites.ts`): the manifest's `callPatterns` (how the project marks a unit of LLM work, such as
  `@register_task`) are searched at HEAD with `Git.grepAt` (`git grep -E` on the commit's objects, binary files
  skipped, no textconv, a partial clone not read, at most `MAX_CALL_SITES` lines across the patterns). With no
  pattern recorded the stock SDK table (`STOCK_CALL_PATTERNS`) runs instead. Nothing is searched before an
  assessment. A site outside every suite's `coveredPaths` (matched as a hazard's globs), not in an eval definition
  file and not in a file an assessed gap names, is a `found` gap beside the manifest's `assessed` ones. A commit's
  sites and files are read once and kept (the newest 16 reads), so a new HEAD costs one search: about 20 ms for one
  recorded pattern on orgtools, about 0.7 s for the six stock ones.
- Drift (`drift.ts`): once HEAD moves past the manifest's commit, the page says what the manifest misses: unlinked
  eval files the assessed commit didn't track, uncovered sites it didn't have (by label, path and line text, so a
  line that only moved isn't new), and manifest paths HEAD no longer tracks. It raises no Inbox item. A commit that
  can't be read any more counts no site as new.
- By Model (`models.ts`, `GET /projects/:id/eval-models`, not under `/evals/` where `models` would be a suite key):
  each model's newest result per suite, its cost for one run of each (unknown if any is) and the median of its p50s.
  A result from a run whose fingerprint differs from the suite's newest run is `olderEval`. Compare is the UI's join.
- Covered tasks (`coverage.ts`, `task-coverage.ts`): the runner records an `eval_coverage` evidence row (no
  migration) as a run's first session starts: each manifest suite with `coveredPaths` as the manifest stood, and
  the time of the commit the run branched from, so a lane that edits the manifest mid-run cannot drop its own
  marker. After the gate (`evalCoverageAfter`, beside `reviewForcedAfter`, and in `finishWithoutGate`) the run's own
  changed files are matched against that snapshot as a hazard's globs match (`matchedSuites`) and a newer row
  records the matches, the last commit's time and what each suite last showed before. `coverageOf` (pure) reads a
  suite's runs by time: before is the newest run older than the branch point, after the first newer than the last
  commit; `not_run`, `passing`, `failing`, `regressed` (a model that passed before fails after) and `eval_changed`
  (the fingerprints differ). `GET /projects/:id/eval-markers` (card markers) and `GET /tasks/:id/eval-coverage`
  (the drawer) read the newest row per task and the results as they are now, so a result that lands later changes
  the marker with no event. The run's one Inbox card, the acceptance card when one is raised, gains a line per
  touched suite with the live command; no card is made for a suite alone. Not built: a lane's manifest write held
  as a proposal. The HTTP API carries one token for the builder's UI and every agent's CLI, so a lane's `PUT
/projects/:id/evals/manifest` can't be told from the builder's; the snapshot is what keeps a lane from dropping
  its own marker.
