# Task 3: tools and confinement in a chat with a plan

**Spec:** §3 How the agent plans (the first three bullets); §6 Files (the second bullet); §7 (the import row).
**Track:** A, core (the trust surface). Read `apps/daemon/src/shape/AGENTS.md` and `apps/daemon/src/chat/AGENTS.md`
once, and keep notes.

## Files

### Tools

- **`apps/daemon/src/mcp/server.ts`** (lines 122-140). A non-lane session's tools come from its chat:
  - a chat with a plan (`sessionShapeId` is non-null, now through the chat) gets `chatTools` and `shapeTools`
    together;
  - a chat with no plan gets `chatTools` only;
  - a session with neither stays 401.

  Update the comment above it.
- **`apps/daemon/src/shape/tools.ts`.** Remove `BEFORE_PROPOSE`, the `proposeUnlocked` check (line 162), and
  `refusedOnImport` with its `IMPORTED` words (lines 83-105), at every call site.

### The import pin

- **`apps/daemon/src/shape/rounds.ts`:** add `PIN_IMPORTED` beside `PIN_WHOLE_ROW` (line 34). `withPins` (line 166)
  keeps a row that carries it as a whole, as it does `*`.
- **`apps/daemon/src/plan-record/import.ts`:**
  - an imported proposal is written with `pinned: [PIN_IMPORTED]` (around line 720);
  - a re-import's `held.pinned` (around line 316) counts only the builder's pins (any entry but `PIN_IMPORTED`).
    So a re-import may replace an import-pinned row, and keeps one the builder pinned.
- **Unpin and Restore:** the builder's Unpin and Restore on an import-pinned row clear the marker, as they clear `*`.

### Confinement

- **`apps/daemon/src/shape/confinement.ts`:**
  - replace `SHAPE_REVIEWERS` (line 26), `SHAPE_RESEARCHER` (line 41) and `SHAPE_CODE_RESEARCHER` (line 32) with the
    `PLAN_` constants;
  - export `judgePlanTool`: `judgeShapeTool` (line 380), with the stamp mapping `tendb-<x>` to the stored
    `ShapeReviewer` `<x>`;
  - `judgeAgentType` (line 268) and every other use of the old names follow;
  - `ShapeAccess` gains `planFilesDir`, and `fileAccessContext` (line 198) adds it to `readList` beside `filesDir`.
- **`apps/daemon/src/shape/policy.ts`:** `SHAPE_AGENTS` (line 105) is keyed by the `PLAN_` names, and the prompts that
  name an agent (`withAgents`, line 200) use the new names.
- **`apps/daemon/src/chat/confinement.ts` `judgeChatCall`** (line 132): before the own-tool branch (line 173), a
  `mcp__10db__` call whose name is a Shape tool goes to `judgePlanTool`. It is allowed only when the session has a
  plan (`access.planFilesDir !== undefined`); otherwise it is refused with "This session has no Plan."
- **`apps/daemon/src/chat/hooks.ts`:**
  - `access` (around line 467) gains `planFilesDir` for a chat with a plan;
  - `prepare` is given `planFiles`;
  - for a chat with a plan, `chatProfile`'s `allowedTools` adds the Shape tools, so they never ask.

### The plan's folder

- **It is made before `prepare`.** Call `mkdirSync(planFolder, { recursive: true })` in the hooks' `spec()`. The
  lane sandbox opens the folder only when it exists (`existsSync`, `sandbox/lane-sandbox.ts:524`), so a file
  dropped later lands inside a folder the warm session already has.
- **`apps/daemon/src/shape/session-launch.ts`:** `ShapePrepareInput.planFiles`.
- **`apps/daemon/src/daemon/shape-session-tools.ts`** (around line 327): pass `planFiles` to `forSession`.
- **`apps/daemon/src/sandbox/lane-sandbox.ts`:** `LaneSessionInput.planFiles`.
  - **The file tools:** it joins `openInside` (line 525), as `taskFiles`' folder does.
  - **The kernel:** a read-only grant of exactly that folder, appended to the profile's read grants beside
    `setupReads` (line 513). Never a write, and never its parent. This is what lets a Codex session read the file,
    since its reads are its commands'.

## Interfaces (implement, exactly)

From the index:

- `PLAN_REVIEWERS`, `PLAN_RESEARCHER`, `PLAN_CODE_RESEARCHER`, `judgePlanTool`;
- `ShapeAccess.planFilesDir`, `ShapePrepareInput.planFiles`, `LaneSessionInput.planFiles`;
- `PIN_IMPORTED`.

## State rows (design)

- **A round lands × the builder pins:** a pinned or import-pinned row is never rewritten.
- **A warm session × a file is dropped:** the folder was made before `prepare`, so the file is readable at once.

## Tests (core: the trust surface)

Extend `apps/daemon/src/chat/confinement.test.ts` with one table, a row per case:

- `report_finding` from `agentType: 'tendb-engineering'` with an `agentId` is allowed, and `updatedInput` has
  `reviewer: 'engineering'` over a model-written `reviewer: 'scope'`;
- the same call from the main session (no `agentId`) is refused;
- from `agentType: 'scope'`, the old bare name, it is refused;
- `propose_plan` from the main session of a chat with a plan is allowed;
- from a chat with no plan it is refused with "This session has no Plan.";
- a `Read` under `planFilesDir` is allowed, and one under another plan's folder is refused.

Prove each row red first, against the current code.

If the sandbox's own tests (`sandbox/*.test.ts`) assert the profile's read grants, add the plan folder to an
existing row there; don't add a new test.

## Steps

1. **Red.** Write the table, run it, and see it fail.
2. Make the changes above. Update the tests that assert the old agent names, the Propose gate or the import refusal:
   change what they expect where the behaviour moved, and delete them where it's gone.
3. **Green.** Run
   `pnpm --filter @10db/daemon exec vitest related src/shape/confinement.ts src/shape/tools.ts src/shape/policy.ts src/shape/rounds.ts src/plan-record/import.ts src/chat/confinement.ts src/chat/hooks.ts src/mcp/server.ts src/sandbox/lane-sandbox.ts src/daemon/shape-session-tools.ts --run --maxWorkers=2`,
   then typecheck and lint the daemon.
4. Commit: `feat(daemon): a chat with a plan has plan's tools, agents and folder, and no propose gate`. Carry this
   value card:

   ```
   Value: protects=only 10db's reviewer subagents report findings in a session, stamped from their type;
     fails_when=the main session or an agent of another name writes a finding, or a session with no plan
     reaches propose_plan; why_new=the trust surface's confinement (core); no_claim=that the session's
     prompt or digest carries the plan (task 4)
   ```
