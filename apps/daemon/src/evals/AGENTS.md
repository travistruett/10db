# apps/daemon/src/evals

- `evals/` reads a registered project's committed eval results and shows them. 10db defines no eval format: it
  reads each project's own, runs no eval and calls no model. Everything is read at HEAD through `Git.survey` (the
  tracked list) and `Git.surveyTexts` (object store, size-capped, nothing the repository configures runs), never the
  working tree. A result file that is not committed is not seen (ampsio's `evals/reports/` is gitignored, so its
  reports show only once the project commits them).
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
