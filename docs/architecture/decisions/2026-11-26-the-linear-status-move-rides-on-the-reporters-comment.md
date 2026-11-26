# The Linear status move rides on the reporter's comment, so the agent can't skip it

- **Date:** 2026-11-26
- **Amends:** `decisions/2026-11-25-the-daemon-authors-the-reporters-linear-comment.md`

## Decision

- `pick_linear_status` is gone. An owed update whose event has a default status move (`run_started`,
  `pr_opened`, `landed`) carries `status` in its `report_linear_post` call: `current`, the issue's status name
  from `get_issue`, and `statuses`, its team's statuses from `list_issue_statuses` as Linear lists them. With
  no steering note, 10db refuses that call without them, so the comment can't go out without the move being
  decided.
- 10db picks the move (`pickStatusMove`) and answers it in the same reply: `next` lists the Linear writes left,
  in order, `save_comment` with the text 10db built (when the agent carries the write) and then `save_issue`
  with `id` and the picked `state`. A direct run (10db writes the comment) answers only the `save_issue`. The
  guard still lets only a picked status through, and `verdict` records it as the row's `statusSet`.
- A team status may come with no position, and with any type. Linear's MCP server lists neither positions nor
  a fixed order (Ampsio's team lists In Review before In Progress, and a `duplicate` type). With no positions,
  the started status whose name says progress is the first, and the one whose name says review is the
  review-like one; a team whose names say neither moves no status on a landing. A type past started, or one
  10db doesn't know, is never moved to or from.

## Why

After #896, none of Ampsio's updates recorded a status, and AMP-84 was still Backlog after its local landing on
2026-11-26. The run's agent (the Efficient tier at low effort) read `get_issue` and `list_issue_statuses`, then
handed over its comment and stopped: it never called `pick_linear_status`, a step one numbered rule asked for
among twenty. It did make every call 10db's answers listed, on all 93 rows. So the move goes where the agent
already goes, as a call the answer lists, not as a separate step.

The pick also could not have worked on Linear's own lists: the schema required a position Linear doesn't give
and refused the `duplicate` type, and the brief's fallback (a status's place in the list) put In Review before
In Progress, which picks In Review for a run start and nothing for a landing.

Turned down: 10db setting the status itself through its own Linear client. Only an account whose Linear entry
carries an Authorization header has one; a Codex or claude.ai sign-in is held by the agent, so the agent still
makes the write there, and one path for every account keeps provider parity.
