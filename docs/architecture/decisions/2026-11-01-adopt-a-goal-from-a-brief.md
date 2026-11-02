# A goal brief is imported, checked in full first, and kept in 10db only

- **Date:** 2026-11-01
- **Amends:** the goals design (`docs/superpowers/specs/2026-10-29-10db-goals-design.md` §11 and §14, "the brief in the repository")

## Decision

**Built:** `POST /projects/:projectId/goals/adopt`, `GET /projects/:projectId/goals` and `GET /goals/:goalId`.

- The body is `{ path }` (an absolute file the daemon reads, at most 1 MiB) or `{ text }`, never both, and an
  optional `dryRun`. The daemon splits the front matter, parses it with the `yaml` package (pinned at 2.9.1,
  as `tests/repo` already pins it), checks the shape with `GoalBrief`, then the rules that need the project
  (`apps/daemon/src/goals/brief.ts`): unique task keys, every `depends_on` and every `task` or `merged`
  criterion naming a key, no dependency cycle (a task on itself included), every area in the project, and
  every named accepting person existing.
- A refusal is a 400 with `{ errors: [{ path, message }] }` listing every error at once, `path` in plain words
  ("Task 3, depends on"). A dry run that finds nothing wrong answers 200 with `GoalAdoptPreview` (title, task
  keys, criteria count); one that finds something answers the same 400 an adoption would. Neither writes.
- A valid brief is written by `insertGoal` in one transaction: the goal in `draft`, its criteria `unproven`,
  its tasks on the Board (planned, with `goal_id`) and their `task_deps`. A YAML syntax error answers its first
  error only, since the rest echo it.
- **The brief is import only (the builder, 2026-10-30).** Nothing is written into the repository. The brief's
  content is kept in 10db with the goal as the rows it produced: title, objective, "cares most", the notes
  below the front matter (`goals.description`), criteria and tasks. 10db does not store the original file
  text a second time; a brief's `people` are proposals and are not written in phase 1.

## Why

- One list of errors lets the builder fix a brief in one pass, which the spec's refusal sheet needs.
- Checking before writing, and writing in one transaction, leaves nothing behind for a refusal; `insertGoal`
  repeats the key, cycle, area and person checks, so a caller that skips the daemon's cannot write a half goal.
- Storing the rows, not the file, avoids two copies of one brief that edits to the goal would let drift apart.
  If the builder wants the original text back (to re-adopt or diff), a `brief` column is a forward migration.
