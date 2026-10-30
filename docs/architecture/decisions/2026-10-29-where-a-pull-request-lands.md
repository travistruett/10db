# A task chooses where its pull request lands: its base branch, another branch, or held for the builder

- **Date:** 2026-10-29
- **Amends:** `decisions/2026-10-29-gate-with-base.md` (the base a gate merges in is the one the task named)

## Decision

Each task carries a landing, one of three, and the project carries the default new tasks start from.

| Landing                      | Batch `base_branch`         | Batch `auto_merge` | Pull request                                                 |
| ---------------------------- | --------------------------- | ------------------ | ------------------------------------------------------------ |
| `base` (the project default) | the project's `base_branch` | true               | against the base; GitHub merges it when required checks pass |
| `branch` (named, on origin)  | the named branch            | true               | against that branch, merged the same way                     |
| `hold`                       | the project's `base_branch` | false              | against the base; 10db never turns auto-merge on             |

- **Project default** (`projects.landing`: `merge` or `hold`, default `merge`) is read when a task is made, so a
  task keeps what it started with when the project's default changes later. Settings › General › When work is
  finished › When checks pass changes it; the row shows only for pull request delivery.
- **Task** (`tasks.landing`, `tasks.landing_branch`) is chosen in New Task and the task drawer, starting from the
  default. It is editable until the task has a workstream; after that the batch decides, and the card and drawer
  say what the batch does. A branch equal to the project's base behaves as `base`.
- **Batch** takes `base_branch` and `auto_merge` from its tasks when it is made. The worktree is cut from
  `origin/<base_branch>`, the base update before each gate merges `origin/<base_branch>`, and the pull request is
  opened against it: none of those read the project's base any more, only the batch's, so a feature-branch
  batch is gated with its own branch merged in.
- **Tasks that land differently never share a pull request.** In worktree mode each landing starts its own batch,
  and tasks that share a worktree (a dependency group) must land alike or the start is refused, naming both. In
  Your folder mode one batch holds one landing: a start of tasks that differ, and a task joining a batch that lands
  another way, are refused in plain words with the request, before anything is cut.
- **Auto-merge** is `gh pr merge <url> --auto --squash`, run after the pull request opens (or is found open again
  after a restart) and before the batch is recorded SHIPPED. It never merges by itself what GitHub has not been
  told to wait for: when the repository's `autoMergeAllowed` is false, or GitHub refuses (a pull request with
  nothing left to wait for, for one), the pull request stays open for the builder, the batch still ships, and a
  card says so. The repository-setting card has one fold key per project, so one stays open however many pull
  requests follow; a refusal's card has one per batch. A shutdown mid-call leaves the batch SHIPPING for recovery.
- **A branch origin lacks is refused before the task starts**: when the task is made or its landing changed (the API
  asks origin with `git ls-remote --heads` at the pinned fetch URL and answers 400, "origin has no branch named X.
  Create it on origin, or choose another place for this task to land."), and again at the cut, which raises a card
  with the same words and leaves no batch row, branch or checkout switch. An origin that cannot be asked is an error
  of its own, never taken for a missing branch. The project's own base branch is not asked about; its absence is
  the fetch's card, as before.

## Why

PR #130 waited with all eight checks green because nothing merged it. Merging belongs to GitHub, which already
waits for required checks, so 10db only has to ask once the pull request exists; the repository allows auto-merge
(`allow_auto_merge`) and squashes. Putting the choice on the task, not the batch, matches how the builder thinks
about work ("this goes to the feature branch"), and making the batch carry the result keeps one pull request one
policy.

Turned down:

- **Merging directly with `gh pr merge --squash` when GitHub says the pull request has nothing to wait for.** That
  merges work no check has seen; a card that says why is safer.
- **A project-wide landing only.** It cannot express a feature branch several tasks build up.
- **Resolving a task's landing at start from the project's current default.** A builder who flips the project to
  Hold would silently change tasks already filed; the default is read once, when the task is made.
- **Letting a started task change its landing.** Its batch already holds its branch and, soon, its pull request;
  changing one task's policy would change its siblings'.

Left open: the builder MCP's `create_task` and `edit_task` and the `10db-task` skill, which live on branches that
have not merged into this base, take `landing` through `TaskInput` and `TaskPatch` once they do; their loose
input shapes need the one field added then.
