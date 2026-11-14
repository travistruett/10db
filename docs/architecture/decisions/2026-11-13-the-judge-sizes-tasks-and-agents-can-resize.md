# The judge sizes tasks, agents can resize them, and Light and Standard work ships with its goal

- **Date:** 2026-11-13
- **Amends:** `decisions/2026-11-13-work-is-sized-by-rigor-and-one-playbook.md`

## Decision

- **Rules first.** A kind's `impliedBy` names areas and hazards; a task whose areas include one gets the kind
  with source `rules` (seeded: migration ← `migrations`, dependency ← `deps`). Rules never store a rigor: a task
  they raise follows its project default lifted by its kinds, so removing a kind lowers it again.
- **The judge answers the rest**, off the request path, on `task.created` and on `task.changed` when the task's
  fingerprint (title, description, criteria, areas, goal) changed: `task_rigor` once and `task_kinds` once per kind
  not pinned, in parallel, at most 4 calls in flight. An answer applies only to an open task that has not started
  and is not joining a batch, under the same fingerprint and pins it was asked under; otherwise it is logged
  `stopped`. Pass pages and CI fixes are never judged. The start-up sweep sizes unsized tasks by rules and judges
  only those made in the last 24 hours.
- **Pins.** A rigor set from the Board, the API or the builder's MCP is the builder's (`builder`); one from a
  proposal or `resize_task` is an agent's (`agent`); the judge never changes either. A kind the builder takes
  off is kept in `kindsOff` and never comes back by rules or judge. A builder's change of a judged value records
  the call's outcome `overridden`, counted on Settings › Decisions.
- **Starting waits** for sizing in flight, at most `JUDGE_TIMEOUT_MS` (4 s), at the top of the Board's, the API's
  and the builder MCP's start, before any read; automatic starts don't wait.
- **`resize_task { rigor, why }`** is offered to Plan and Build sessions, refused on a Workbench page, on a
  builder-pinned rigor and below the kinds' minimum; it raises one Inbox notice, and the runner's re-plan at the
  next step end applies it.
- **Ships** is a row setting: Light and Standard ship with their goal, Careful and Critical alone. Tasks of one
  goal that ship with it, share a landing target and work in copies start as one batch; a later one joins the
  goal's open batch when it can and otherwise starts its own. Joining a goal never refuses a start, never takes an
  own-copy kind, and leaves `dependsOn`, Shape's landing groups and Your folder as they were.
- **A kind's skills** (craft skills) reach every step of its tasks: named in the brief on Claude, inlined on Codex.

## Why

Most tasks then get the right process without the builder choosing, and the `overridden` record shows how far to
trust the judge. One call per kind keeps the judge's single-answer interface. Treating a builder-MCP rigor as the
builder's own follows what it is: the builder's own session acting for them. A best-effort goal join keeps the
batch saving without ever turning into a refused start. Decisions run only on OpenRouter today, so a builder with
only a Claude or Codex plan gets rules-only sizing until decisions can run on a project's own account.
