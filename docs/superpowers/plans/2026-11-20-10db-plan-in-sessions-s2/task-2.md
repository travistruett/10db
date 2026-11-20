# Task 2: every chat's session can plan

**Spec:** §3 How the agent plans ("slice 2 gives every session both"; "The session's profile wins"), as narrowed by
the index's call 2; §1.1 (the row "A turn runs | Builder opens the panel").
**Track:** A, core (the sandbox and the trust surface). Read `apps/daemon/src/chat/AGENTS.md` and
`apps/daemon/src/shape/AGENTS.md` once, and keep notes. Needs Task 1 (`planIdOfChat`).

## Files

### `apps/daemon/src/shape/policy.ts`

- **`PLANNING_STUB`**, exported through `shape/index.ts`, exactly:

  > Planning: the builder can plan in this session. When the conversation turns to deciding work for the Board
  > (goals, tasks, decisions to record), start a Plan with propose_plan, citing the builder's messages by their [m:ID],
  > or suggest the builder press Show Plan; 10db then gives you the planning rules. A question, a change you make to
  > the code yourself, or a talk that decides no work needs no plan. When the builder asks you to file one task, use
  > create_task.

  It has no standing-rules trigger: no "always"/"never" → principle, and no "propose as things are decided".
- **`owedPlanningRules(rules)`** returns:

  ```text
  [planning rules] This session now has a Plan. Follow these rules for it from now on.

  <rules>
  ```

- `shapeSystemPrompt` is unchanged. Only sessions with a plan read it, as in slice 1.

### `apps/daemon/src/chat/live-sessions.ts`

`ChatLive` gains `planRules: { take(): string | null } | null` (index Interfaces).

### `apps/daemon/src/chat/hooks.ts`

- **`chatProfile(sandboxed)`** (line 143) loses `hasPlan`. `allowedTools` always holds `PLAN_MCP_TOOLS`. Update the
  call at line 569 and the comment.
- **`spec()`** (from line 401), with `deps.plan` given:
  - **The folder** (lines 442-446): every chat gets
    `planFiles = deps.plan.filesDir(planOfConversation(state.db, conv.id) ?? planIdOfChat(chat.id))`, made before
    `prepare` as today. `prepare` gets `planFiles`, and `access` gets `planFilesDir`. Both are needed from the start:
    Codex's kernel grant is fixed at `prepare`, and Claude's hook reads `access` as built at `spec()`.
  - **The agents** (line 570): always `plan.agents(…)`. Claude fixes a session's agents at launch, so a plan that
    starts mid-session can launch its reviewers only if they were there from the start. Codex gets `{}` (no
    subagents).
  - **The prompt** (lines 564-568):
    - with a plan at start (`shapeId !== null`), as today: the full rules;
    - without one, `${chatSystemPrompt(webOn)}\n\n${PLANNING_STUB}`.
  - **The owed rules.** Without a plan at start:
    - compute `owedPlanningRules(plan.systemPrompt(launch.agentModels, subagents, web))` with the session's own
      values;
    - keep it in a hooks-level `Map<ConversationId, { sessionId: SessionId; take(): string | null }>` (one live
      session per conversation, as `holdingSession` is). `take()` answers the rules once, then null;
    - pass the same `take` as `deps.live.open(conv.id, { …, planRules })`;
    - `release` deletes the entry when it is still this session's.

    With a plan at start, there is no entry, and `planRules: null`.
  - **`opening`** (line 554) still runs only when the chat has a plan at the session's start, as today.
  - **`reads`** (line 542), resolved at each call:
    - keep a `Map<ShapeId, ReturnType<PlanParts['reads']>>`, filled on first use for an id;
    - `preToolUse`: with `planOf(conv)` null, the chat's verdict as is; else that id's `reads.preToolUse(req, verdict)`;
    - `postToolUse` and `toolFailed` likewise, a no-op with no plan;
    - give these hooks whenever `deps.plan` is given.
- **`outgoing`** (line 725): with a plan, `owed.get(conv.id)?.take()`, and the rules go first, ahead of the plan's
  intake lines.
  - The engine passes no session id, and needn't: the map is keyed by conversation.
  - This is the per-turn path both providers send through (`explore-starts.ts:128`, `explore-turns.ts:79`), so it
    works the same on Claude and Codex.
- `digest`, `keepsResume`, `onParked` and `onTurnEnded` already resolve `planOf(conv)` per call. Leave them, and check
  that none caches.
- Update the file's comments that say "a chat with a plan" where they now mean every chat.

### `apps/daemon/src/chat/confinement.ts`

- `NO_PLAN` (line 30) and its branch (lines 179-181) go. A Plan tool on 10db's server is always judged by
  `judgePlanTool`, which keeps the stamp: `report_finding` only from a `tendb-*` reviewer subagent. A Codex main
  session's call is refused, as today.
- Update the comment at line 178.

### `apps/daemon/src/chat/service.ts` (Archive)

- After the chat folder's `rmSync` in `archive` (line 447): when `planOfChat(state.db, id)` is null, remove
  `join(deps.dataDir, 'shapes', planIdOfChat(id))` with `rmdirSync` (non-recursive). Ignore `ENOENT` and
  `ENOTEMPTY`; rethrow anything else.
  - A chat with no plan has nothing in that folder (uploads and screens need a plan), so it is empty.
  - Unarchive's next session makes it again.

### Codex resume

Check `apps/daemon/src/sessions/codex-generated/` for whether `thread/resume`'s `developerInstructions` replaces the
thread's. Say in your report which holds. If it doesn't, nothing changes: the owed rules are already in the thread's
history. Task 6 writes it into `chat/AGENTS.md` from your report.

## Interfaces (implement, exactly)

From the index:

- `PLANNING_STUB`, `owedPlanningRules(rules: string): string`;
- `ChatLive.planRules`;
- `chatProfile(sandboxed: boolean)`;
- the folder rule `deps.plan.filesDir(planOfConversation(db, conv.id) ?? planIdOfChat(chat.id))`;
- the per-call `reads`, and `outgoing` taking the owed rules.

Called: `planIdOfChat` (Task 1), `PlanParts.filesDir`, `PlanParts.reads`, `PlanParts.systemPrompt`,
`PlanParts.agents` (`apps/daemon/src/shape/plan-parts.ts`, unchanged).

## State rows (design)

- **A turn runs × Show Plan:** the session's prompt, agents, tools and folder don't change. The rules are owed: a
  passing `propose_plan` in this turn answers them (Task 3), or the next message carries them.
- **A plain session × a passing `propose_plan`:** its answer takes the rules, and the next message carries none.
- **Warm Claude or Codex session started before its plan × a file dropped:** read through `planFilesDir` (Claude) or
  the kernel grant (Codex), both set at start.
- **A Codex main session × `report_finding`:** refused, as today.
- **A plan made mid-session × a Read of a file read before the plan:** **Accepted:** the budget counts from the plan's
  start.
- **Moved to a branch, restart, context limit or model change:** the next `spec()` finds the plan, so the full rules
  are in its system prompt and nothing is owed. The folder is the same.
- **The chat is in the builder's terminal × Show Plan:** the terminal's agent is told nothing. After Hand Back, the
  next session starts with the plan.
- **Archive of a chat with no plan:** the empty derived folder goes.

## Tests (core: the trust surface and the sandbox)

- `apps/daemon/src/chat/confinement.test.ts`, "refuses a Plan tool where the chat has no plan" (line 511): this
  behaviour goes, so delete the test. The table above it (the stamp, the main session refused, `propose_plan`
  allowed) stays as it is.
- `apps/daemon/src/chat/tool-policy.test.ts` calls `chatProfile(true)`. It stays green; check it.
- `apps/daemon/src/shape/policy.test.ts` must stay green.
- No new test. The e2e (Task 5) runs Show Plan, a dropped file (Read through the hook by the fake, Task 3) and a plan
  made mid-session through the real daemon.

## Done when

- Related tests for the files above are green (`--maxWorkers=2`). The daemon's typecheck and lint pass, and `knip` is
  clean.
- Report: the SHA(s), the comments you changed, and the Codex resume finding. Note for QA that
  `test/shape-session.live.test.ts` (`TENDB_LIVE_CLAUDE=1`) should be re-run by hand, since the confinement changed.
