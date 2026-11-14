# A Shape session runs through its own adapter entry, and Convert writes what the stores can today

- **Date:** 2026-11-02
- **Amends:** `decisions/2026-11-02-shape-is-an-sdk-session-in-10dbs-own-ui.md` (how the session and Convert are built in slice 1)

## Decision

**Built (Shape slice 1, part 2):**

- **The session.** A conversation's session starts through `SessionAdapter.startShape(ShapeSessionSpec)`, not
  the lane `SessionSpec`: a lane spec's `workstreamId`, sandbox, plugin and project MCP servers are lane-only,
  and a Shape session has none of them. `sessions/claude-session.ts` (the explore profile) runs the SDK with `settingSources: []`,
  `strictMcpConfig`, no plugin, permission mode `default`, a `canUseTool` that denies, `tools` listing `Read`,
  `Grep`, `Glob` and `Agent`, and `disallowedTools` naming `Edit`, `Write`, `NotebookEdit`, `Bash`, `Monitor`,
  `WebFetch` and `WebSearch`. It keeps the lane adapter's account preflight and its event mapping.
- **Confinement.** The PreToolUse hook is `judgeShapeCall` (`apps/daemon/src/shape/confinement.ts`). It reuses
  the lane file-access judge's real-path rules with the conversation's files directory as the one read-list
  entry, and treats only `inside` and `allowed` as ok: where a lane's answer is `ask`, this answers `deny`, so
  no card is raised. The hook is the only judge, since a call Claude Code settles before `canUseTool` is still
  judged.
- **Convert writes decisions with source kind `builder`**, because `SourceKind` has no `shape`, and a `you`
  decision gets `project_id` null. The ref names the conversation and the proposal key.
- **Landings, principles and questions are not converted yet.** Convert refuses a selected one by name; their
  tables come with slices 5 and 6.
- **`basis` accepts any Done task of the project** until `task_lane_times` exists (slice 3).
- **A change cannot set dependencies**, because `patchTask` has no `dependsOn`; a change that names them is
  refused by validation.
- **Search skips a superseded decision.** `searchDecisions` and `listRecentDecisions` leave out a decision a
  later, non-withdrawn one superseded, so a replaced decision stops reaching context packs.
- **A conversation moves to a fresh session past 70% of the context** (strictly past), seeded with a
  deterministic digest stored as a `digest` message. A session idle for 10 minutes closes and is resumed from
  `shapes.sdk_session_id`.

## Why

- Widening `SessionSpec.workstreamId` to optional rippled into the runner and every fake-adapter script for a
  session that needs none of the lane fields; a second, smaller entry keeps lanes unchanged.
- A Shape session must raise no card, and the broker's `ask` path does; a hook that only allows or denies
  makes the read-only guarantee checkable by a unit test and by the live test.
- Writing the nearest existing source kind avoids a schema change for a label; the ref keeps where it came
  from. Refusing what has no table yet is better than dropping it silently.
