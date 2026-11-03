# Shape forces a spec for large or risky efforts, reviewers report through a stamped subagent, and Convert rehearses first

- **Date:** 2026-11-02
- **Amends:** `decisions/2026-11-02-shape-session-and-convert.md` (the agent gate in §5.2 and Convert)

## Decision

**Built (Shape slice 4):**

- **The ceremony rule** (`shape/ceremony.ts`): a loose L task, a goal of XL, more than 5 tasks, or a task in a
  one-way path forces `spec`. The builder pins `direct` ("Skip spec"); the row then reads "spec skipped by you",
  and "Use spec" unpins. A task's content hash ignores `ceremony`, so pinning it neither re-rehearses a task nor
  answers a question.
- **One-way paths are an app setting**, `shape.oneWayPaths.<projectId>` (`GET/PUT /projects/:id/one-way-paths`,
  Settings › General), as `shape.jev.<projectId>` is, not a project column (a column would change `ProjectDto`,
  its generated schemas and every fixture). While unset, the goals spec's 10db paths that exist among tracked
  files apply. A task is one-way when its area or hazard holds a tracked file matching a glob; so a catch-all
  area makes every task in it one-way, which the builder can pin to `direct`.
- **Only a subagent can report.** Subagents share the session's MCP connection, so a handler cannot tell them
  apart. The PreToolUse hook returns `updatedInput` with `reviewer` set from `agent_type` (scope, engineering,
  rehearsal), overwriting whatever the model wrote; `report_finding` with no reviewer is refused.
- **`report_finding` has a `final` flag.** The rehearsal's mark for a task (per task hash) is written only by a
  `final` report: a none, or the last question. An interrupted rehearsal leaves no mark, so Convert asks again.
- **A rehearsal turn has its own message kind**, `rehearse`, so Jev's Propose counting and citations ignore it. It
  queues after the messages already waiting.
- **Opening Convert with an unrehearsed task** (no mark at its current hash) asks for one rehearsal turn, once per
  opening. "Rehearsing n tasks…" shows, and Convert Anyway stops the turn and converts. Findings and open
  questions warn and never block Convert.
- **Questions sit under their task** in the sidebar and the modal; Dismiss is the builder's, and a builder edit
  to a task answers that task's rehearsal questions.
- **The question-card measure** (Settings › Decisions › Questions) counts started, non-cancelled tasks of projects
  that have a converted task, a card once per task it targets: converted tasks against the others.
- Migration 0033: `shape_findings`, `shape_rehearsals`, `shape_attachments`. The spec and the proposed eval are
  stored as attachments and linked at Convert.

## Why

- A hook is the only place that sees which subagent is calling; a tool input the model writes cannot be trusted.
- An app setting follows `shape.jev` and avoids changing the project contract for a list of globs.
- Hashing without `ceremony` keeps a pin on a decision (skip or use a spec) from being mistaken for an edit of
  the work itself.

## Trade-offs

- A rehearsal goes after queued messages rather than jumping the queue.
- Tracked files are cached 30 s per checkout so the view does not run `git ls-files` on every refresh.
- Findings reach the session through the Agent result (the reviewers list ids in their last message), not as
  injected notes.

## Not done

- The proposed eval's screen; slice 5.
- `apps/daemon/test/shape-session.live.test.ts` (needs `TENDB_LIVE_CLAUDE=1`) is not extended with the
  stamped-reviewer and agent-definition checks; run it after the next SDK upgrade.
