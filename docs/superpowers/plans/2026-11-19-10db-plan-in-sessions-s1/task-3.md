# Task 3: tools and confinement in a chat with a plan

**Spec:** §3 How the agent plans (the first three bullets); §6 Files (the second bullet). **Track:** A, core (the
trust surface). Read `apps/daemon/src/shape/AGENTS.md` and `apps/daemon/src/chat/AGENTS.md` once and keep notes.

## Files

- `apps/daemon/src/mcp/server.ts` (lines 122-140): a non-lane session's tools come from its chat.
  - A chat with a plan (`sessionShapeId` non-null, now through the chat) gets `chatTools` and `shapeTools`
    together.
  - A chat without one gets `chatTools` only.
  - A session with neither stays 401.
  - Update the comment above it.
- `apps/daemon/src/shape/tools.ts`:
  - remove `BEFORE_PROPOSE`, the `proposeUnlocked` check (line 162) and `refusedOnImport` with its `IMPORTED`
    words (lines 83-105);
  - an imported plan's rows are pinned instead (Task 5).
- `apps/daemon/src/shape/confinement.ts`:
  - replace `SHAPE_REVIEWERS`, `SHAPE_RESEARCHER` and `SHAPE_CODE_RESEARCHER` with `PLAN_REVIEWERS`,
    `PLAN_RESEARCHER` and `PLAN_CODE_RESEARCHER` (the `tendb-` names);
  - export `judgePlanTool`, which is `judgeShapeTool` (line 380) with the stamp mapping `tendb-<x>` to the stored
    `ShapeReviewer` `<x>`;
  - `judgeAgentType` (line 268) and every other use of the old names follow;
  - `ShapeAccess` gains `planFilesDir`;
  - `fileAccessContext` (line 198) adds it to `readList` beside `filesDir`.
- `apps/daemon/src/shape/policy.ts`: `SHAPE_AGENTS` is keyed by the `PLAN_` names; the prompts that name an agent
  (`withAgents`, around line 200) use the new names.
- `apps/daemon/src/chat/confinement.ts` `judgeChatCall` (line 132): before the own-tool branch, a `mcp__10db__`
  call whose name is a Shape tool goes to `judgePlanTool`. It is allowed only when the session has a plan
  (`access.planFilesDir !== undefined`), and refused otherwise with "This session has no Plan."
- `apps/daemon/src/chat/hooks.ts`:
  - `access` (around line 467) gains `planFilesDir` when the chat has a plan;
  - `prepare` is given `planFiles`;
  - `chatProfile`'s `allowedTools` adds the Shape tools for a chat with a plan, so they never ask.
- `apps/daemon/src/shape/session-launch.ts`: `ShapePrepareInput.planFiles`.
- `apps/daemon/src/daemon/shape-session-tools.ts` (around line 327): pass `taskFiles: input.planFiles` to
  `forSession`. It is the lane sandbox's carve-out for file tools under the data directory
  (`sandbox/lane-sandbox.ts:198-202, 523-531`).

## Interfaces (implement, exactly)

From the index: `PLAN_REVIEWERS`, `PLAN_RESEARCHER`, `PLAN_CODE_RESEARCHER`, `judgePlanTool`,
`ShapeAccess.planFilesDir` and `ShapePrepareInput.planFiles`.

## Provider check

On a Codex account, `taskFiles` is said to open the folder to the file tools only. Read
`sandbox/lane-sandbox.ts` and the Codex adapter's sandbox build, and find out whether a Codex session can read
`<data>/shapes/<id>/<file>`. If it can't, don't widen the kernel profile: write it in your report, and Task 4
will name the file's text in the intake line instead.

## Tests (core: the trust surface)

Extend the chat's confinement test (`apps/daemon/src/chat/confinement.test.ts`, or the file that holds
`judgeChatCall`'s table) with one table, a row per case:

- a `report_finding` call from `agentType: 'tendb-engineering'` with an `agentId` is allowed, and `updatedInput`
  has `reviewer: 'engineering'` over a model-written `reviewer: 'scope'`;
- the same call from the main session (no `agentId`) is refused;
- from `agentType: 'scope'` (the old bare name) it is refused;
- `propose_plan` from the main session of a chat with a plan is allowed;
- `propose_plan` from a chat with no plan is refused with "This session has no Plan.";
- a `Read` of a file under `planFilesDir` is allowed, and one under another plan's folder is refused.

Prove each row red first against the current code (the old names, no plan branch).

## Steps

1. **Red.** Write the table, run it, and see it fail.
2. Make the changes above. Update the tests that assert the old agent names or the Propose gate: change what they
   expect, and delete a test only when the behaviour it guards is gone (the gate, the import refusal).
3. **Green.** Run `pnpm --filter @10db/daemon exec vitest related src/shape/confinement.ts src/shape/tools.ts src/shape/policy.ts src/chat/confinement.ts src/chat/hooks.ts src/mcp/server.ts --run --maxWorkers=2`,
   then typecheck and lint the daemon.
4. Commit: `feat(daemon): a chat with a plan has plan's tools, agents and folder, and no propose gate`. It carries:

   ```
   Value: protects=only 10db's reviewer subagents report findings in a session, stamped from their type;
     fails_when=the main session or an agent of another name writes a finding, or a session with no plan
     reaches propose_plan; why_new=the trust surface's confinement (core); no_claim=that the session's
     prompt or digest carries the plan (task 4)
   ```
