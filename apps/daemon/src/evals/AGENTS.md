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
