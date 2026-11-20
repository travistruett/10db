# Task 4: the chat's hooks compose the plan's parts; the Plan owner goes

**Spec:** §3 How the agent plans (the prompt, the digest, one plan per session, the owner hooks); §1.1 (the
"opens the panel", context-limit, Archive and branch rows). **Track:** A. This goes to Task 3's implementer.

## Files

- Create `apps/daemon/src/shape/plan-parts.ts` with `createPlanParts` and `PlanParts`, from the index. Each part
  is moved out of `shape/explore-owner.ts`, not rewritten:
  - `systemPrompt` is `shapeSystemPrompt` (`policy.ts:228`), rewritten as below;
  - `agents` is `shapeToolset(sandboxed).agents` when `subagents`, and `{}` otherwise;
  - `filesDir` is `shapeFilesDir(filesDir, shapeId)`;
  - `digest` is `buildDigest(state.db, shapeId)` (`shape/digest.ts`);
  - `intake` is `intakeText` and `unreadableOf`, with the untold-file, notes, mis-sized and converted logic of
    the owner's `outgoing`;
  - `onTurnEnded` is the owner's `onTurnEnded` (line 775) without the Propose checks ("didn't propose", the empty
    plan after a Propose), with its rehearsal check and `announce`.
- `apps/daemon/src/shape/policy.ts` `shapeSystemPrompt`, rewritten as spec §3 says. It is appended after the
  chat's prompt, so it is about planning only:
  - drop "You are Shape", "You are read-only …" and the Bash and `cd` paragraph, which the chat's prompt covers;
  - drop the "Before the builder presses Propose" block;
  - say to call `propose_plan` with the whole plan as things are decided, never to rewrite a pinned item, to ask
    what is unclear, to record decisions, and to make a mock-up for UI work;
  - keep landings, ceremony, pictures, `see_screen`, research, remembering, questions and standing rules as they
    are, with the `tendb-` agent names;
  - remove `proposeNote` (line 295).
- `apps/daemon/src/chat/hooks.ts` `chatHooks`: `ChatHooksDeps` gains `plan?: PlanParts` and
  `subagentsOf(kind, model): boolean`. For a conversation whose chat has a plan (`planOfConversation`):
  - **spec**:
    - `systemPrompt` is `chatSystemPrompt(…)` + "\n\n" + `plan.systemPrompt(launch.agentModels, subagents)`;
    - `profile.agents` is `plan.agents(sandboxed, subagents)`;
    - `access.planFilesDir` is `plan.filesDir(shapeId)` (Task 3 reads it).
  - **digest**: `chatDigest(…)`, then a blank line, then `plan.digest(shapeId)`, leaving out an empty part.
  - **outgoing**: the plan's `intake(…)` lines go ahead of the message text. Its images join the message's in one
    `images` list, under the one budget `heldInlineBytes` already measures, and `sent` calls both.
  - **onTurnEnded**: `touchChat` as today, then `plan.onTurnEnded(shapeId, end)`.
  - A chat without a plan is unchanged.
  - If Task 3 found Codex can't read the plan's folder, a text file's intake line carries its text instead,
    within the read budget (`shape/read-budget.ts`).
- `apps/daemon/src/shape/service.ts`:
  - remove `engine.register(ConversationOwnerKind.Shape, createShapeOwner(…))` (line 488);
  - build the `PlanParts` there and export it on the service (`planParts`);
  - `propose` goes; `send`, `redo` and `sendNow` go, because messages reach the chat's route;
  - `heard` (line 377) is exposed as `heard(conversationId, itemId)` for the chat service to call;
  - `planConversations`, `turnsInProgress` and `runningTurns` read the chats that have a plan.
- `apps/daemon/src/shape/explore-owner.ts`: delete what moved, and the file if nothing is left. Its test goes too,
  for the behaviours that moved: `plan-parts` keeps the same assertions where they still apply.
- `apps/daemon/src/daemon/start.ts` (around line 1890): pass `plan: shape.planParts` and `subagentsOf` to
  `chatHooks`. The chat service calls `shape.heard` after a message is queued on a chat with a plan.
- `packages/contracts/src/conversation.ts`: remove `ConversationOwnerKind.Shape`, and fix every exhaustive
  switch the typecheck names:
  - `daemon/conversation-services.ts:123` (`ownerOf`: the `shape` owner goes; messages to a chat with a plan
    are the chat's);
  - `chat/conversation-files.ts:50`;
  - `conversation/explore-engine.ts:92`;
  - `api/app.ts:359, 368`: `shapeOwnedOrNone` and `planConversation` become "a conversation whose chat has a
    plan", through `planOfConversation`;
  - `knowledge/provenance.ts:84`;
  - `packages/db` (the last `Shape` uses).
- `packages/contracts/src/shape.ts`: `ShapeDto.proposeUnlocked` goes. Regenerate contracts.
- `apps/daemon/src/sessions/fake-plan-script.ts` (line 120): the scripted plan session proposes when the builder's
  message contains "propose" (`/\bpropose\b/i`), not on "pressed Propose". Keep everything else.

## Interfaces (implement, exactly)

`PlanParts` and `createPlanParts`, from the index. `PlanPartsDeps` is what the moved code needs:

- `state`, `log`, `filesDir`, `clock`;
- `turnOf`, `announce`, `limitsFor`.

## State rows (design)

- *A turn runs × the panel opens.* Nothing is injected; the prompt holds the instructions from the session's start.
- *Context limit × a fresh session.* The digest carries the plan's rows after the chat's, so the next round
  restates them.
- *Archive.* `chat/service.ts:423` removes only `<data>/conversations/<id>`. The plan's folder and rows stay
  (check it; change nothing).
- *Move to a branch.* The plan follows the chat id.

## Tests

None new. Existing tests of the hooks, the shape service and the tools are updated to the new owner. Delete
those that only exercised the Plan owner's registration or Propose. Keep any assertion of a behaviour that
moved: the digest, intake and rehearsal checks.

## Steps

1. Move the parts into `plan-parts.ts`, with the shape service still building them. Typecheck.
2. Compose them in `chatHooks`, and remove the owner registration. Then `ConversationOwnerKind.Shape` and
   `proposeUnlocked`.
3. The fake script trigger.
4. Run `pnpm --filter @10db/daemon exec vitest related src/shape/plan-parts.ts src/chat/hooks.ts src/shape/service.ts src/daemon/conversation-services.ts src/api/app.ts src/sessions/fake-plan-script.ts --run --maxWorkers=2`,
   the db's related tests, and typecheck and lint daemon, db, contracts and desktop.
5. Commit each green step:
   - `refactor(daemon): plan's session parts move out of its engine owner`;
   - `feat(daemon): a chat with a plan runs plan's prompt, digest and intake`;
   - `feat(contracts): a conversation is a chat's or a task's`.
