# Task 4: the chat's hooks compose the plan's parts; the Plan owner goes

**Spec:** §3 How the agent plans: the prompt, New Plan's first line, the digest, one plan per session, and the
owner hooks. §1.1: the rows for opening the panel, a drop into a warm session, the context limit, Archive and a
branch. **Track:** A. Task 3's implementer takes this card.

## Files

### Create `apps/daemon/src/shape/plan-parts.ts`

It holds `createPlanParts` and `PlanParts` (index). Every part moves out of `shape/explore-owner.ts`; none is
rewritten. Each piece of the Plan owner, and what it becomes:

| Plan owner piece (`explore-owner.ts`) | Becomes |
| --- | --- |
| `spec()`'s system prompt and toolset agents (lines 550-590) | `systemPrompt` and `agents` (below) |
| `spec()`'s principles brief and digest parts | dropped: the chat's own spec adds both |
| `spec()`'s catch-up of the builder's earlier messages (lines 492-505) | `opening` |
| `FRESH_START_LINE` when there is no digest (lines 480-491) | `opening` (it marks where the read budget starts) |
| `preToolUse`'s read budget (lines 347-405), `postToolUse` (666), `toolFailed` (691) | `reads`; the chat's `judgeChatCall` verdict goes in first |
| `keepsResume` and `carriedTooMuch` (lines 427-446) | `keepsResume` |
| `limits` (line 418) | dropped: the chat's (the account kind's) |
| `onParked` → `announce` (line 414) | `announce` |
| `words` (`freshSession`, `startFailed`, line 410) | dropped: the chat's |
| `digest` (line 717) | `digest` |
| `outgoing` (lines 719-773) | `intake`; `sent(ctx)` does all its writes in the starter's push write |
| `onTurnEnded` (line 775) | `onTurnEnded`, without the Propose checks ("didn't propose", the empty plan after a Propose) |
| `describeModel`, `launchOf` | dropped: the chat's |

### Rewrite `shapeSystemPrompt` (`apps/daemon/src/shape/policy.ts`)

Rewrite it as spec §3 says. It is appended after the chat's prompt, so it covers planning only.

- **Drop:**
  - "You are Shape", "You are read-only …", and the Bash and `cd` paragraph, which the chat's prompt covers;
  - the "Before the builder presses Propose" block;
  - `proposeNote` (line 295).
- **Say:** call `propose_plan` with the whole plan as things are decided, never rewrite a pinned item, ask what is
  unclear, record decisions, and make a mock-up for UI work.
- **Keep:** landings, ceremony, pictures, `see_screen`, research, remembering, questions and standing rules, with the
  `tendb-` names.
- **With `web` false:** the research paragraph becomes `WITHOUT_AGENTS.web` plus its code-research line, and no
  researcher is named.

`agents(sandboxed, subagents, web)` is `shapeToolset(sandboxed).agents`, without `tendb-researcher` when `web` is
false, and `{}` without subagents.

### Compose the parts in `chatHooks` (`apps/daemon/src/chat/hooks.ts`)

`ChatHooksDeps` gains `plan?: PlanParts` and `subagentsOf(kind, model): boolean`. A chat without a plan is
unchanged. For a conversation whose chat has a plan (`planOfConversation`):

| Hook | With a plan |
| --- | --- |
| `spec` | the system prompt, agents, opening and read budget (below) |
| `digest` | `chatDigest(…)`, a blank line, then `plan.digest(shapeId)`, leaving out a part that is empty |
| `outgoing` | the plan's `intake(…)` lines go ahead of the message's text; its images and blocks join the message's, one list each, under the one budget `heldInlineBytes` measures; `sent(ctx)` calls the plan's (the chat's own is a no-op) |
| `keepsResume` (new on the chat) | `plan.keepsResume(…)` with a plan; true otherwise |
| `onParked` (new on the chat) | `plan.announce(shapeId)` |
| `onTurnEnded` | `touchChat` as today, then `plan.onTurnEnded(shapeId, end)` |

In `spec`:

- `systemPrompt` is `chatSystemPrompt(webOn)` + "\n\n" + `plan.systemPrompt(launch.agentModels, subagents, web)`.
  - `webOn` is the argument `chatSystemPrompt` gets today.
  - `web` is `webOn && judge === JudgeKind.Native`, because the chat's confinement refuses the web tools otherwise
    (`chat/confinement.ts:160-163`).
- `profile.agents` is `plan.agents(…)`.
- `parts` gains `plan.opening(…)` before `start.first.text`.
- `preToolUse` is `plan.reads(…).preToolUse(req, judgeChatCall(…))`, and `postToolUse` and `toolFailed` are the
  plan's.

### New Plan's first-message line

`opening` returns the exact line from the index's Copy, ahead of the catch-up. It does so for a plan of
`origin: 'app'` whose conversation holds no agent message yet. `start_shape` and imported plans get no line: their
first notice already says where they came from.

### `apps/daemon/src/shape/service.ts`

- Remove `engine.register(ConversationOwnerKind.Shape, createShapeOwner(…))` (line 488).
- Build the `PlanParts` here and expose them as `planParts`.
- `propose`, `send`, `redo` and `sendNow` go: messages reach the chat's route.
- `heard` (line 377) becomes `heard(conversationId, itemId)`, for the chat service.
- `planConversations`, `turnsInProgress` and `runningTurns` read the chats that have a plan.

### `apps/daemon/src/chat/service.ts`

- After a builder message is queued on a chat with a plan, call `deps.planHeard?.(conversationId, itemId)`. Wire it
  to `shape.heard` in `start.ts`.
- When a chat with a plan is renamed (`setChatTitle`), the plan's title follows it.

### `apps/daemon/src/shape/explore-owner.ts`

Delete what moved, and the file if nothing is left. Where a behaviour stayed (intake, the read budget,
`keepsResume`, the rehearsal check), its test's assertions move to `plan-parts.test.ts`; delete the rest.

### `apps/daemon/src/daemon/start.ts`

Around line 1890, pass `plan: shape.planParts`, `subagentsOf` and `planHeard` to `chatHooks` and to the chat
service.

### Remove `ConversationOwnerKind.Shape` (`packages/contracts/src/conversation.ts`)

Fix every switch and comparison the typecheck names, among them:

- `daemon/conversation-services.ts:123`: `ownerOf` drops the `shape` owner;
- `chat/conversation-files.ts:50`;
- `conversation/explore-engine.ts:92`;
- `api/app.ts:353-371`: `shapeOwnedOrNone` and `planConversation` become "a conversation whose chat has a plan",
  through `planOfConversation`;
- `packages/db`, for its last uses.

### Retire `JudgeDecision.ShapeReady`

- `shape/jev.ts` stops asking it (lines 38, 115, 177), and its `readyTruth` goes.
- `shape-measures.ts:52` and the judge config's defaults stop listing it.
- A decision's settings row that a stored config names must still parse. If `judge.ts`'s config schema rejects an
  unknown key, keep the value in the enum with `// retired: nothing asks it`, and drop it from every list that
  asks. Say which you did.

### The fake (`apps/daemon/src/sessions/fake-plan-script.ts`, lines 117-150)

The fake and Task 8 agree on this script:

- A message's `[m:ID]` goes into `ids` **before** anything else, so a first message can be cited.
- A message matching `/\bpropose\b/i` calls `propose_plan` with the scripted draft citing `ids`, as the Propose
  branch does today, and replies "Here is the plan."
- Any other message calls `note_heard` as today. When the turn's message holds intake lines `[file] <path>
  (<name>)`, the reply ends with "I have <name>." for each.
- "pressed Propose" no longer triggers anything.

### The live test (`apps/daemon/test/shape-session.live.test.ts`)

- Rewrite it to run a chat with a plan, built through `chatHooks` with `plan`.
- Assert the confinement rows it asserts today, with the `tendb-` names and `judgeChatCall`.
- Drop what belonged to read-only Plan alone: refused edits now ask Here or On a New Branch.

It runs by hand (`TENDB_LIVE_CLAUDE=1`), never in CI. Run it once if a Claude login is available, and say whether
you could.

## Interfaces (implement, exactly)

`PlanParts` and `createPlanParts`, from the index. `PlanPartsDeps` is what the moved code needs: `state`, `log`,
`filesDir`, `clock`, `turnOf`, `announce`, `limitsFor` and `contextLimitPct`.

## State rows (design)

| Row | Design |
| --- | --- |
| A turn runs × the panel opens | Nothing is injected; the prompt holds the instructions from the session's start. |
| A warm session × a file is dropped | The next turn's `intake` names it (`listUntoldShapeFiles`). |
| The context limit × a fresh session | The digest carries the plan's rows after the chat's text. |
| Archive | `chat/service.ts:423` removes only `<data>/conversations/<id>`; the plan's folder and rows stay. Check this, and change nothing. |
| A move to a branch | The plan follows the chat id. |

## Tests

None new. Move or update the existing tests as above.

## Steps

1. Move the parts into `plan-parts.ts`, with the shape service still building them. Typecheck.
2. Compose them in `chatHooks` and remove the owner registration. Then remove `ConversationOwnerKind.Shape` and
   `ShapeReady`.
3. The fake script, the opening line and the live test.
4. Run
   `pnpm --filter @10db/daemon exec vitest related src/shape/plan-parts.ts src/chat/hooks.ts src/chat/service.ts src/shape/service.ts src/shape/jev.ts src/daemon/conversation-services.ts src/api/app.ts src/sessions/fake-plan-script.ts --run --maxWorkers=2`
   and the db's related tests. Then typecheck and lint daemon, db, contracts and desktop.
5. Commit each green step:
   - `refactor(daemon): plan's session parts move out of its engine owner`;
   - `feat(daemon): a chat with a plan runs plan's prompt, digest, intake and read budget`;
   - `feat(contracts): a conversation is a chat's or a task's`;
   - `test(daemon): the fake plans from a message, and the live test runs a chat with a plan`.
