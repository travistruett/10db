# apps/daemon/src/evals

- `evals/` reads a registered project's eval results and shows them. 10db defines no eval format: it reads each
  project's own and runs no eval. Reading calls no model and writes nothing; only the assessor (below) asks one. Definitions and the manifest's path checks are read
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
- The manifest is an app setting (`evals-manifest:<project id>`, `manifest-store.ts`), recorded by 10db's assessor or an
  agent (`evals <projectId> <file>` in the agent skill) and never a file in the repository. `service.ts` records it only
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
  touched suite with the live command; no card is made for a suite alone. The manifest is written only by the builder and their own sessions: the daemon's data dir, which holds the
  UI token the CLI needs, is a protected read for lanes (`sandbox/protected-reads.ts`), so a lane can't reach the
  route; the snapshot additionally keeps the globs fixed for the run. A snapshot's `baseAt` is the time it is taken
  (the run's start), not the base commit's time, so a result written after earlier work landed counts as before. The
  same lines close the no-gate check card, the pass check card and the skipped/config card.
- Definition changes (`definition-change.ts`): `classifyDefinitionChange(path, patch)` reads one definition file's unified
  patch by line patterns (bar lowered: a `minimum_rate`/`min_rate`/`threshold` number that went down; cases removed;
  golden changed; grader changed; model judge added; else `unclassified`) and names the line each kind came from. It
  is pure and calls no model, so it is the same on every provider. A manifest `bar` edit is an app setting, not a
  patch line, and is not read. The watchpoints' eval source (`watchpoints/eval-definition-source.ts`) uses it.
- New Eval (`new-eval-task.ts`, `POST /projects/:id/evals/tasks`, `NewEvalRequest`): files a normal task on the
  project's account, "Write the eval for <behavior>", through the ordinary task-create path (`createTask`). Its brief
  holds the six rationale sections (Decision, Evidence, Oracle, Coverage and bar, Models, Execution), the paths
  the behavior lives in, the project's eval skills and a few existing suites as format examples, and forbids the
  live command and any paid model call. The skills are the tracked `.claude/skills/*/SKILL.md` and
  `.agents/skills/*/SKILL.md` at HEAD whose front matter name or description mentions evals; the brief gives
  each one's name and file path, so a Claude or Codex lane uses it by name or reads the file. With none, it points
  at the existing eval files. The task's areas are those the `where` paths fall in, else the catch-all or the first
  area. It reads, files a task and runs nothing.
- Assessing (`assess.ts`, `assess-prompt.ts`, `assess-triggers.ts`; modelled on `hazards/`): `createEvalsAssessor`
  picks files at HEAD (the project's eval skills, eval definition files, `claude plugin eval` prompts, the files the
  stock call patterns find, root `AGENTS.md`/`Makefile`/`package.json`/`README.md`; at most 60 files, 48 KB each, 300 KB
  in all, 400 lines of 240 characters each) through `Git.survey`/`surveyTexts`/`grepAt`, gives them as numbered data
  lines to the area namer's model (no tool; a Codex-only builder is asked on the default non-Codex account, and with
  none the state is `unavailable`), parses an `EvalManifest` with zod and records it through `EvalsService.record`,
  whose path checks stay the gate. An unusable answer, one with no suite and no gap, a refusal or a slow model records
  nothing and keeps the reason for the page (`status`: `idle`, `assessing`, `failed`, `unavailable`; in memory, cleared
  by the next run). `unavailable` is only for a model that can't be asked at all (`NO_DEFAULT_ACCOUNT`, or
  `CODEX_NO_QUESTIONS` with no other account); any other failure is `failed` and Assess Now stays. A manifest
  records its `source`: a scheduled run only fills an empty manifest or replaces one 10db recorded (`auto`), and asks
  nothing when HEAD is the commit already assessed; the builder's Assess Now may replace any, and a manifest with no
  source is an agent's. One run per project is joined. `subscribeEvalAssessment` schedules one (`SCHEDULE_MS` later,
  bursts joined) on `ProjectCreated` and on a `CommitRecorded` whose paths include an eval definition, a `claude plugin eval`
  case or a skill folder named for evals; a commit to model-calling code alone doesn't (that would
  cost a call per code commit), Assess now covers it. `POST /projects/:id/evals/assess` runs one and answers the page;
  `ProjectChanged` is emitted when a run starts and when it fails (a recorded manifest emits it itself).
