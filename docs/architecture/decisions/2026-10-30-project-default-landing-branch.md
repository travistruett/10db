# A project can make a named branch the default landing for new tasks

- **Date:** 2026-10-30
- **Amends:** `decisions/2026-10-29-where-a-pull-request-lands.md` (the project default was merge or hold only)

## Decision

The project default for where a new task lands (`projects.landing`) is `merge`, `branch` or `hold`. `branch` names the
branch in `projects.landing_branch` (`ProjectDto.landingBranch`), such as an integration branch; it is null for the
other two and the daemon clears it when the default changes away from `branch`.

- **A task made without a landing** takes the default: `taskLandingFor(project)` gives `base`, `{ kind: 'branch',
branch }` or `hold`. It is applied in the one place tasks are written (`insertTask`, and the task a proposal
  becomes), so the desktop form, the builder MCP's `create_task` and `POST /projects/:id/tasks` all get it. A task
  made with a landing keeps it. As before, the default is read once, when the task is made.
- **The builder MCP's `create_task`** takes `landing` (it was dropped before the daemon saw it); omitting it means the
  project default.
- **A branch origin lacks is refused in plain words**, as a task's landing is: `PATCH /projects/:id` (and
  `POST /projects`) ask origin with the same call and answer 400, "origin has no branch named X. Create it on origin,
  or choose another place for new tasks to land." A default naming no branch is refused in the contract ("Name the
  branch new tasks land in"). Nothing is asked for a local-delivery project or for the project's own base branch.
- **Settings › General › When work is finished** shows a third choice, "Merge into a branch", and a "New tasks land
  in" field under it.

## Why

The builder wants every task of this phase to land in `next`; setting each task by hand missed those filed from the
form or the MCP. Keeping the choice on the project and resolving it when the task is made leaves tasks already filed
where they were when the default changes.

Turned down: a separate setting for the integration branch (it is one more place that must agree with the default),
and resolving the default when the batch is cut (a change of default would move filed tasks).
