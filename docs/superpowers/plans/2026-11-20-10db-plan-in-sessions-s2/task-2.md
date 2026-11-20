# Task 2: every chat's session can plan

**Spec:** §3 How the agent plans ("slice 2 gives every session both"; "every session from slice 2"; "The session's
profile wins"); §1.1 (the row "A turn runs | Builder opens the panel").
**Track:** A, core (the sandbox and the trust surface). Read `apps/daemon/src/chat/AGENTS.md` and
`apps/daemon/src/shape/AGENTS.md` once, and keep notes. Needs Task 1 (`planIdOfChat`).

## Files

### `apps/daemon/src/chat/hooks.ts`

- **`chatProfile(sandboxed)`** (line 143) loses `hasPlan`. `allowedTools` always holds `PLAN_MCP_TOOLS`. Update the
  call at line 569 and the comment.
- **`spec()`** (from line 401):
  - **The folder** (lines 442-446): when `deps.plan` is given, every chat gets
    `planFiles = deps.plan.filesDir(planOfConversation(state.db, conv.id) ?? planIdOfChat(chat.id))`, made before
    `prepare` as today.
    - A slice-1 plan's minted id opens its own folder.
    - A chat with no plan opens the folder its plan will have.
    - `prepare` gets `planFiles`, and `access` gets `planFilesDir`, for every chat.
  - **The prompt and agents** (lines 564-572): with `deps.plan` given, `systemPrompt` is always
    `${chatSystemPrompt(webOn)}\n\n${plan.systemPrompt(launch.agentModels, subagents, web)}` and `agents` is always
    `plan.agents(…)`, whether or not a plan exists yet.
  - **`opening`** (line 554) still runs only when the chat has a plan at the session's start, as today.
  - **`reads`** (line 542): resolve the plan at each call, not once at the start:
    - keep a `Map<ShapeId, ReturnType<PlanParts['reads']>>`, filled on first use for an id;
    - `preToolUse`: with `planOf(conv)` null, the chat's verdict as is; else that id's `reads.preToolUse(req, verdict)`;
    - `postToolUse` and `toolFailed` likewise, a no-op with no plan;
    - give both hooks whenever `deps.plan` is given.

  `digest`, `keepsResume`, `outgoing`, `onParked` and `onTurnEnded` already resolve `planOf(conv)` per call. Leave
  them be, and check that none caches.
- Update the file's comments that say "a chat with a plan" where they now mean every chat.

### `apps/daemon/src/chat/confinement.ts`

- `NO_PLAN` (line 30) and its branch (lines 179-181) go. A Plan tool on 10db's server is always judged by
  `judgePlanTool`, which keeps the stamp: `report_finding` only from a `tendb-*` reviewer subagent.
- Update the comment at line 178.

### `apps/daemon/src/shape/policy.ts`

**`shapeSystemPrompt`** (line 236). Every session now reads it, so its opening changes from "This session is also
where the builder plans. …" to exactly:

> The builder may plan in any session. When the conversation decides work worth putting on the Board (goals, tasks,
> decisions), state it with propose_plan: that starts this session's Plan, which shows beside the conversation, and
> every later call restates it. A question, a change you make to the code yourself, or a talk that decides no work
> needs no plan; and when the builder asks you to file one task, create_task does that. Once the session has a Plan,
> echo what you have heard with note_heard as the builder talks.

Then:

- the "Planning:" paragraph keeps its rules (cite sources, restate everything, never rewrite a pinned item, ask the
  one question, sizes);
- drop its "not only when asked" if the opening already says it;
- the "Seeing the app" paragraph adds that `see_screen` needs the session's Plan;
- leave every other paragraph alone.

## Interfaces (implement, exactly)

From the index:

- `chatProfile(sandboxed: boolean): Omit<ExploreProfile, 'kind' | 'systemPrompt' | 'judge'>`;
- the folder rule `deps.plan.filesDir(planOfConversation(db, conv.id) ?? planIdOfChat(chat.id))`;
- the per-call `reads`.

Called: `planIdOfChat` (Task 1), `PlanParts.filesDir`, `PlanParts.reads`, `PlanParts.systemPrompt`,
`PlanParts.agents` (`apps/daemon/src/shape/plan-parts.ts`, unchanged).

## State rows (design)

- **A turn runs × Show Plan:** nothing in the session changes. The prompt, agents, allowed tools and folder were all
  there from the start.
- **A warm session started before its plan × a file is dropped:** it lands in the folder opened at start, readable to
  Claude's file hook (`planFilesDir`) and to Codex's kernel grant.
- **A warm session started before its plan × `propose_plan` or a reviewer's `report_finding`:** judged by
  `judgePlanTool`, never refused for want of a plan.
- **A plan made mid-session × the next Read of a plan file:** `reads` finds the plan at that call.

## Tests (core: the trust surface and the sandbox)

- `apps/daemon/src/chat/confinement.test.ts`, "refuses a Plan tool where the chat has no plan" (line 511): this
  behaviour goes, so delete the test. The table above it (the stamp, the main session refused, `propose_plan`
  allowed) stays as it is.
- `apps/daemon/src/chat/tool-policy.test.ts` calls `chatProfile(true)`. It stays green; check it.
- `apps/daemon/src/shape/policy.test.ts`: keep it green. If a test asserts the old opening's words, it follows the
  new opening.
- No new test. The e2e (Task 5) runs Show Plan, a dropped file and a plan made mid-session through the real daemon.

## Done when

- Related tests for `chat/hooks.ts`, `chat/confinement.ts` and `shape/policy.ts` are green
  (`--maxWorkers=2`), and the daemon's typecheck and lint pass.
- `knip` (from `make precheck`) has no unused `planIdOfChat`.
- Report: the SHA(s), and the comments you changed. Note for QA that `test/shape-session.live.test.ts`
  (`TENDB_LIVE_CLAUDE=1`) should be re-run by hand, since the confinement changed.
