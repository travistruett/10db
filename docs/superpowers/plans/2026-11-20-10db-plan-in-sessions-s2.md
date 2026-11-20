# Plan in Sessions S2: every session can grow a plan

## Brief

**What changes for you.**

- **Show Plan on any session.** The title row's **Plan** toggle is on every session now, not only New Plan's. On a
  session without a plan it makes one and opens the panel empty, ready for a dropped document or the next message.
  The ⋯ menu has **Show Plan** / **Close Plan** where File as Tasks was.
- **Every session can plan.** A session without a plan carries a short planning note: when the talk turns to
  deciding work for the Board, the agent proposes, or suggests you press Show Plan. Its first `propose_plan` gives
  the session its plan, and the panel opens beside the conversation with the rows. The full planning rules reach the
  agent at that moment. A question, a code edit or a chat that decides nothing grows no plan.
- **Rounds are marked on each row.** Each row gets the spec's state dot: proposed, new or changed this round, pinned,
  accepted. The round in the panel's head and the "N changes in round N" filter stay as built. Running and Done
  come with slice 3.
- **File as Tasks is gone.** Accept in the panel replaces it. "File this as a task" still works through the agent's
  own `create_task`.
- **Not in S2:** Accept and Start, Undo Accept and live task states (slice 3); the Review menu and approved mock-ups
  (slice 4); files by content and design review (slice 5).

**What it buys.** Planning starts from the conversation you're already in. You no longer have to know beforehand
that a talk will turn into a plan. An ordinary session pays about 100 words of prompt for it, not 2,000.

**What could go wrong, and how we'd know.**

- _Every chat sprouts a plan._ Only `propose_plan`, Show Plan and New Plan make one. The note asks for a plan only
  when work is being decided, and nothing in it turns a rule ("always …") into a principle. `note_heard` in a session
  with no plan writes nothing. The e2e sends ordinary messages to a plain session and checks that no panel appears
  until "propose it".
- _A plan made mid-session can't be read by the session that made it._ Every chat session opens its plan's folder
  at its start, even before the plan exists, because a new plan takes its chat's id (call 1). The fake agent now
  Reads each file it names through the session's own hook. So the e2e's drop after Show Plan, on a warm session,
  passes only if the hook allows that folder.
- _Two makers race._ Show Plan and a first `propose_plan` each make the plan in one write, and the second finds it
  there (`shapes_chat_unique`). There is one plan per chat.

**Calls you might disagree with.**

1. **A new plan's id is its chat's id under the `shp` prefix** (`planIdOfChat`). Every chat's session makes and opens
   `<data>/shapes/<that id>` before its sandbox starts, so a plan made mid-session is readable at once: on Claude
   through the file hook, on Codex through the kernel grant, with no restart. Archive removes the folder again when
   the chat has no plan and the folder is empty.
2. **The full planning rules arrive when a plan starts, not at every session's start** (the coordinator's ruling,
   logged in the ledger).
   - A session with a plan at its start (or resume) has the full rules in its system prompt, as in slice 1.
   - A session without one has a stub of about 100 words.
   - When a plan starts mid-session, the rules travel once: in the first passing `propose_plan`'s result, or, after
     Show Plan, ahead of the builder's next message.
   - Plan's agents (`tendb-*`) are listed from every session's start, because Claude fixes a session's agents at
     launch. Codex has none.
   - _Cost if wrong:_ a first round follows the rules a little more loosely. The fix would be restarting the session
     with the full prompt once a plan starts.
3. **Without a plan, Plan's tools that need rows are refused** with "This session has no Plan yet: propose_plan
   starts one." That covers `attach`, `write_spec`, `report_finding`, `resolve_finding` and `see_screen`.
   `similar_tasks` and `find_records` answer, but without their dimmed transcript line. `note_heard` answers and
   writes nothing. _Cost if wrong:_ the agent in a plain session can't screenshot 10db's screens until it proposes.
4. **A refused first `propose_plan` leaves no plan.** The write that would make it is rolled back with the refusal.
5. **Plain sessions still drop pictures only.** Documents go to a session with a plan, so Show Plan comes first.
   Files by content is slice 5.
6. **"Rounds marked in the panel" means the state dot.** The panel already shows each row's mark, the round and its
   filter. No round markers are added to the conversation.
7. **No migration and no `PROTOCOL_VERSION` bump.** The change adds one route and breaks none.

**Token ruling (yours, recorded):** the dev-UI and screen tokens keep reading a conversation once its chat has a
plan, and plain chats stay closed to them. **An agent's first `propose_plan`, or your Show Plan, therefore opens that
session's transcript to those tokens from then on.** Nothing changes in `screens/render-access.ts` or
`screens/dev-ui-access.ts`.

**Needed from you:** nothing.

---

> **For agentic workers:** read this Brief, Global constraints, Interfaces and your card
> (`2026-11-20-10db-plan-in-sessions-s2/task-<n>.md`). Work in `../10db-worktrees/plan-s23` on
> `feat/plan-in-sessions-s2-s3`. Commit after every green step, staging only your own paths. Run related tests only:
> `pnpm --filter <pkg> exec vitest related <files> --run --maxWorkers=2`, plus typecheck and lint of the packages you
> touched. Before a push run `make precheck`, never `make check-changed` (a long-lived branch). **The branch
> typechecks after every task.**

**Spec:** `docs/superpowers/specs/2026-11-19-10db-plan-in-sessions-design.md`. S2 is §10 item 2. It builds:

- §1, the Talking row (Show Plan) and the rule that a session has a Plan once the agent proposes or the builder opens
  the panel;
- §1.1, the row "A turn runs | Builder opens the panel";
- §2, the row's state dot (Running and Done wait for slice 3);
- §3, "slice 2 gives every session both" and "every session from slice 2", as narrowed by call 2;
- §7, the File as Tasks row.

## Global constraints

- Code style and testing per `.claude/rules/code-style.md` and `.claude/rules/testing.md`. No new dependency.
- **No migration.** `shapes.chat_id` and `shapes_chat_unique` exist. If a card finds it needs a schema change, it
  stops and reports.
- **A plan is made in exactly three ways:**
  - New Plan (`POST /chats` with `plan: true`, as built);
  - Show Plan (`POST /chats/:chatId/plan`);
  - a passing `propose_plan` in a session with none.

  Show Plan and `propose_plan` go through `ensurePlanOfChat` in one write. Import and `start_shape` keep
  `insertPlanSession`.
- **A plan's id.** Every plan written from now on has the id `planIdOfChat(chatId)`; `insertShape` takes it from its
  `chatId`. A kept plan from the migration already has it, since the migration derived its chat's id from the
  plan's. Plans New Plan made under slice 1 keep their minted ids. So code that has a plan reads its id with
  `planOfChat`/`planOfConversation`. Only the folder a session opens before any plan exists uses `planIdOfChat`.
- **What every chat's session gets at its start:**
  - Plan's agents (`PlanParts.agents`);
  - Plan's MCP tools, offered (`mcp/server.ts`) and allowed (`chatProfile`);
  - the plan's folder (`planFilesDir`, `planFiles`), the plan's own or `planIdOfChat`'s.
- **The prompt follows the plan.**
  - With a plan at the session's start, the system prompt is the full rules (`PlanParts.systemPrompt`).
  - Without one, it is `PLANNING_STUB`.
  - When a plan starts during that session, its rules are owed once, and the first of these takes them:
    1. a passing `propose_plan` answers them as `rules`;
    2. the next builder message's `outgoing` puts them ahead of its text.

  Both paths are 10db's own text, so they work the same on Claude and Codex.
- **The plan's row parts resolve the plan at each call**, never only at the session's start, so a plan made
  mid-session counts from the next call. They are `opening`, `digest`, `intake`, `reads`, `keepsResume`,
  `inlineSpent` and `onTurnEnded`.
- **The trust surface is unchanged.**
  - `report_finding` comes only from a `tendb-*` reviewer subagent, and the stamp comes from its type. On Codex the
    main session's call is refused, as today, and its `WITHOUT_AGENTS` lines say reviews need agents (slice 4 changes
    it).
  - Plan's read-only confinement does not run in a session.
  - The dev-UI and render tokens read a conversation only once its chat has a plan (`conversationHasPlan`). Both
    lists are GET-only, so the new POST needs no entry in either.
- **The security hook's "chat confinement instead of Plan's" note is by design** (spec §3). Acknowledge it in the
  commit body and move on.
- **Copy is exact:**
  - the title row's toggle stays "Plan" (`aria-pressed`), with the tooltip "Show Plan" or "Close Plan";
  - the ⋯ menu item reads "Show Plan" or "Close Plan";
  - the refusal of a Plan tool in a session with no plan: "This session has no Plan yet: propose_plan starts one.";
  - Show Plan on an archived chat: "This session is archived." (`CHAT_ARCHIVED`);
  - on a sealed chat: "This session's work moved to a task, so it has no Plan.";
  - a failed Show Plan: "Couldn't show the Plan: <reason>";
  - the row dot labels: "Proposed", "New this round", "Changed this round", "Moved to Earlier", "Pinned",
    "Accepted";
  - `PLANNING_STUB` (Task 2) and the owed rules' lead line (Task 2) as their cards give them.
- **Knip** ignores exports used in their own file (`knip.json`, `ignoreExportsUsedInFile`). Task 1's exports are used
  in `shapes.ts` and by `showPlan`, so Task 1 lands and pushes alone. `FILE_AS_TASKS_MESSAGE` and
  `SessionActions.onFileAsTasks` go in Task 4, with every use.
- Never `prettier --write` over `apps/daemon/src` as a whole (it rewrites the Codex-generated files). Name your
  files.
- A commit footer line stays under 100 characters (commitlint); wrap a Value card.
- Docs are part of done (Task 6).

## Provider parity

| Feature | Claude plan | Bedrock / API key | Codex plan |
| --- | --- | --- | --- |
| Show Plan, the panel, the state dot | 10db's own | same | same |
| Planning stub; full rules with a plan at start | system prompt | same | developer instructions (`codexDeveloperInstructions`) |
| Full rules when a plan starts mid-session | `propose_plan`'s result, or ahead of the next message (`outgoing`) | same | same |
| Plan's tools in every session | session's MCP | same | same |
| Plan's agents in every session | joined at launch; no `tendb-researcher` without the web | same | none (no subagents); the rules' `WITHOUT_AGENTS` lines |
| A plan made mid-session is readable | the file hook's `planFilesDir`, set at start | same | the read-only kernel grant of the folder, made at start |
| File as Tasks retired | Accept | same | same |

No feature refuses a provider. A Codex thread resumed after its plan started is given the full rules again as
developer instructions on `thread/resume`. Task 2 checks in the generated schema whether Codex honours them on
resume. If it doesn't, the rules are still in the thread's history from when they were owed.

## Interfaces

### db (Task 1) — `packages/db/src/store/shapes.ts`

```ts
/** The id a plan made for this chat takes: the chat's uuid under the plan's prefix. */
export function planIdOfChat(chatId: ChatId): ShapeId;
/**
 * The chat's plan, made if it has none, in the caller's write: titled as the chat is, `origin`
 * as given, no rows. Announces `shape.changed` and `chat.changed` when it makes one.
 */
export function ensurePlanOfChat(
  ctx: WriteContext,
  chatId: ChatId,
  origin: ShapeOrigin,
): { readonly shapeId: ShapeId; readonly made: boolean };
// insertShape: the row's id is planIdOfChat(input.chatId) in place of mintId('Shape').
```

`planIdOfChat` uses `idOfUuid('Shape', idUuid(chatId))` from `packages/contracts/src/ids.ts`. A chat id always has a
uuid, so a null from `idOfUuid` is a thrown `Error` with a name, never `!`.

### The route (Task 1)

| Route | S2 |
| --- | --- |
| `POST /chats/:chatId/plan` | `ensurePlanOfChat(ctx, id, ShapeOrigin.App)`; 200 `ChatDto` (its `planId` set); idempotent; 409 for an archived or sealed chat |

```ts
// apps/daemon/src/chat/service.ts — ChatService gains
  /** Show Plan: the chat's plan, made if it has none; no turn starts. Refused for an archived or sealed chat. */
  showPlan(id: ChatId): ChatDto;
// apps/daemon/src/api/services.ts — ApiServices gains
  showChatPlan(id: ChatId): ChatDto;
```

### The session (Task 2)

```ts
// apps/daemon/src/shape/policy.ts
/** What a session with no plan is told about planning. */
export const PLANNING_STUB: string;
/** The full rules handed to a session whose plan started after it did, with their lead line. */
export function owedPlanningRules(rules: string): string;

// apps/daemon/src/chat/live-sessions.ts — ChatLive gains
  /** The planning rules this session is owed, taken once; null when its prompt already had them. */
  readonly planRules: { take(): string | null } | null;

// apps/daemon/src/chat/hooks.ts — chatProfile loses its second parameter: Plan's tools are always allowed.
export function chatProfile(
  sandboxed: boolean,
): Omit<ExploreProfile, 'kind' | 'systemPrompt' | 'judge'>;
```

- `spec()` takes the folder as `deps.plan.filesDir(planOfConversation(db, conv.id) ?? planIdOfChat(chat.id))`, before
  `prepare`, for every chat (when `deps.plan` is given). It sets `access.planFilesDir` and passes `planFiles`.
- `systemPrompt`:
  - with a plan at start, `chatSystemPrompt(webOn)` plus `plan.systemPrompt(…)`, and `planRules: null`;
  - without one, `chatSystemPrompt(webOn)` plus `PLANNING_STUB`, and `planRules` owes
    `owedPlanningRules(plan.systemPrompt(…))`, computed with the session's own `agentModels`, `subagents` and `web`.
- `agents` is always `plan.agents(…)`.
- `reads` resolves the plan per call (Task 2's card).
- `outgoing` with a plan takes `planRules` and puts it first.
- `apps/daemon/src/chat/confinement.ts`: `NO_PLAN` and its branch go. A Plan tool is always judged by
  `judgePlanTool`.
- `ChatService.archive` removes `<data>/shapes/<planIdOfChat(id)>` when the chat has no plan and the folder is empty.

### The tools (Task 3)

```ts
// apps/daemon/src/mcp/shape-tools.ts
export type ShapeToolsFor = (session: {
  readonly sessionId: SessionId;
  readonly chatId: ChatId;
  readonly conversationId: ConversationId;
  readonly projectId: ProjectId;
}) => ShapeToolHandlers;

// apps/daemon/src/shape/tools.ts
export function createShapeToolHandlers(
  deps: ShapeToolDeps,
  chat: {
    readonly chatId: ChatId;
    readonly conversationId: ConversationId;
    readonly sessionId: SessionId;
    readonly projectId: ProjectId;
  },
): ShapeToolHandlers;
// ShapeToolDeps gains
  /** Takes the planning rules the calling session is owed, once (`ChatLive.planRules`). */
  readonly owedRules?: (conversationId: ConversationId, sessionId: SessionId) => string | null;
/** The words of a Plan tool called in a session with no plan. */
export const NO_PLAN_YET = 'This session has no Plan yet: propose_plan starts one.';
```

- `mcp/server.ts` `conversationTools(deps, session)` loses `shapeId`. A chat's session gets `chatTools` and
  `shapeTools` together, always. `sessionShapeId` stays (`knowledge/provenance.ts` uses it).
- Each handler resolves `planOfChat(db, chat.chatId)` at its call.
  - `propose_plan` makes the plan with `ensurePlanOfChat` in the same write as the reconcile. A refusal on a plan it
    just made throws inside the write, so the plan rolls back. A pass adds `rules` (from `owedRules`) to its answer
    when the session is owed them.
  - `note_heard` with no plan answers `{ heard: 0 }` and writes nothing.
  - `similar_tasks` and `find_records` read `chat.projectId`, and write their line only when there is a plan.
  - `attach`, `write_spec`, `report_finding`, `resolve_finding` and `see_screen` reject with
    `InvalidError(NO_PLAN_YET)` when there is no plan.

### The desktop (Task 4)

```ts
// apps/desktop/src/daemon/chat-queries.ts
/** Show Plan: POST /chats/:chatId/plan, answering the chat with its planId. */
export function useShowPlan(): UseMutationResult<ChatDto, Error, ChatId>;
// apps/desktop/src/views/sessions/session-menu.tsx — SessionActions: onFileAsTasks goes; gains
  /** Show Plan or Close Plan, by `planOpen`; only the session's own title row gives it. */
  readonly onTogglePlan?: () => void;
  readonly planOpen?: boolean;
// apps/desktop/src/views/sessions/plan/proposal-text.ts
/** The row's state for its dot (spec §2): accepted, else this round's mark, else pinned, else proposed. */
export function rowDot(row: ShapeProposalDto): { readonly label: string; readonly color: string };
```

## State table

Design, not a test list.

| While | Event | Then | Task |
| --- | --- | --- | --- |
| A turn runs | Builder presses Show Plan | The plan is made in its own write, the panel opens empty and the turn goes on. The session owes the full rules: a passing `propose_plan` in this turn answers them, or the next message carries them | 1, 2, 4 |
| A plain session | The agent's `propose_plan` passes | The plan is made and reconciled in one write, and its answer carries the full rules. `chat.changed` brings `planId`, and the panel opens with the rows | 2, 3, 4 |
| A plain session | The agent's first `propose_plan` is refused | The write rolls back: no plan, no line, no rules taken; the agent gets every error | 3 |
| Show Plan's write and a first `propose_plan` | Both land | Each runs `ensurePlanOfChat` in its own write; the second finds the first's plan; one plan | 1, 3 |
| Show Plan | Pressed twice, or two windows | Idempotent: one plan, 200 each time | 1, 4 |
| Show Plan | The chat is archived, or sealed into a task | 409 with the index's words; the desktop draws no Show Plan there | 1, 4 |
| Show Plan | The request fails | The toggle stays off; the tab says "Couldn't show the Plan: <reason>" | 4 |
| The chat is in the builder's terminal | Show Plan | The plan is made and the panel opens. The terminal's agent is told nothing. After Hand Back, the next session starts with the plan and the full rules | 1, 2 |
| A warm Claude session started before its plan | A file is dropped after Show Plan | It lands in `<data>/shapes/<planIdOfChat>`, which the hook's `planFilesDir` named at start; the next intake names it, and a Read is allowed | 2, 3 |
| A warm Codex session started before its plan | A file is dropped after Show Plan | Same folder; its commands read it through the read-only kernel grant made at `prepare` | 2 |
| A warm session started before its plan | The agent calls `propose_plan` again, or a reviewer reports | Judged by `judgePlanTool` as any plan tool; no "no Plan" refusal | 2 |
| A Codex main session | It calls `report_finding` | Refused by `judgePlanTool`, as today; the full rules' `WITHOUT_AGENTS` lines say reviews need agents (slice 4) | 2 |
| A plan made mid-session | The session Reads a file it read before the plan existed | Those earlier Reads were never counted in the plan's read budget. **Accepted:** the budget counts from the plan's start | 2 |
| A plain session | The agent calls `note_heard` | Answered, nothing written; no panel | 3 |
| A plain session | The agent calls `attach`, `write_spec`, `report_finding`, `resolve_finding` or `see_screen` | Refused with `NO_PLAN_YET` | 3 |
| A plain session | The builder drops a document | Refused as today (pictures only); Show Plan first | 4 |
| A session with a plan | It moves to a branch | `relocate` closes the warm session; `spec()` runs again with the same folder (the plan's id); the full rules are in its system prompt | 2 |
| A session with a plan from Show Plan, no rows | Daemon restart | The plan persists. The next session has the full rules, and the panel opens (it has a plan) | 2 |
| A plan made mid-session | Context limit or a model change | The fresh session has the full rules in its system prompt, and its digest carries the plan's rows after the chat's | 2 |
| A chat with no plan | Archive | The chat folder goes as built, and the empty `<data>/shapes/<planIdOfChat>` goes too. A folder with anything in it stays | 2 |
| Builder closed the panel | A round lands | The panel stays closed (the builder's choice holds); the toggle reads "Show Plan" | 4 |
| A sealed chat or a removed project with a plan | The title row draws | The Plan toggle and ⋯ item stay (the plan can still be read); with no plan, no Show Plan | 4 |

## Tracks

Two tracks, one integration branch (`feat/plan-in-sessions-s2-s3`), at most two implementers at once, a fresh one
per card.

- **Track A, daemon and db.** Task 1, then Task 2, then Task 3. Task 3 relies on Task 2's `ChatLive.planRules` and
  per-call resolution, so they run in order. Task 1 lands and pushes alone.
- **Track B, desktop and e2e.**
  - Task 4 starts once Task 1 is on the branch (the route is real). It runs beside Task 2. Its click-through, on the
    real daemon with the fake adapter, waits for Task 3.
  - Task 5 (the e2e) needs Tasks 3 and 4.
- **Start the daemon code review as soon as Task 3 lands**, in parallel with Task 5.
- **Task 6** (docs and the decision record) runs last.
- **Order with the cap of two:** 1 → (2 ∥ 4) → 3 → (daemon review ∥ 5) → desktop review → 6.

## Tasks

| # | Track | Task | Card |
| --- | --- | --- | --- |
| 1 | A | db and route: `planIdOfChat`, `insertShape` takes it, `ensurePlanOfChat`, `ChatService.showPlan` (refusing archived and sealed), `POST /chats/:chatId/plan` | `task-1.md` |
| 2 | A | the session: `PLANNING_STUB` or the full rules by the plan at start; rules owed once (`ChatLive.planRules`, `outgoing`); agents, tools and folder from start; `reads` per call; `NO_PLAN` goes; Archive removes the empty derived folder | `task-2.md` |
| 3 | A | the tools: Plan's tools offered to every chat's session; handlers resolve the plan per call; `propose_plan` makes it and answers the owed rules; `NO_PLAN_YET`; tool descriptions; the fake Reads the files it names | `task-3.md` |
| 4 | B | desktop: Show Plan on every session (toggle and ⋯), `useShowPlan`, File as Tasks retired, the row state dot | `task-4.md` |
| 5 | B | e2e: a plain session grows a plan (Show Plan, a file, propose) in `sessions.spec.ts`; File as Tasks' step typed | `task-5.md` |
| 6 | — | docs: module notes, the decision record a-plan-takes-its-chats-id, stale File as Tasks lines | `task-6.md` |

## Review focus

- **The folder before the plan.** `spec()` opens `planIdOfChat(chat.id)` for a chat with no plan. Check:
  - a slice-1 plan with a minted id opens its own folder, never the derived one;
  - nothing writes under the derived id before `ensurePlanOfChat`;
  - Archive removes only an empty derived folder of a chat with no plan.
- **The rollback.** A refused first `propose_plan` must leave no `shapes` row, no `shape.changed` or `chat.changed`
  event, and the owed rules untaken. The throw happens inside `state.write`.
- **Owed rules, once.** Whether `propose_plan`'s answer or `outgoing` takes them, they go out exactly once per
  session. A session with a plan at its start owes none.
- **Tokens.** No reader of `conversationHasPlan` changed. A plain chat's conversation stays unreadable to the dev-UI
  and render tokens until it has a plan.
- **Per-call resolution.** `reads`, `intake` and `onTurnEnded` must pick up a plan made during the session. No hook
  may cache "no plan" at the session's start.
