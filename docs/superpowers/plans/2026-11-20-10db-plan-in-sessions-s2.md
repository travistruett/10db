# Plan in Sessions S2: every session can grow a plan

## Brief

**What changes for you.**

- **Show Plan on any session.** The title row's **Plan** toggle is on every session now, not only New Plan's. On a
  session without a plan it makes one and opens the panel empty, ready for a dropped document or the next message.
  The ⋯ menu has **Show Plan** / **Close Plan** where File as Tasks was.
- **Every session can plan.** Every session starts with the planning instructions, Plan's tools and Plan's agents
  (`tendb-scope`, `tendb-engineering`, `tendb-rehearsal`, `tendb-researcher`, `tendb-code-researcher`). When a
  conversation decides work, the agent states it with `propose_plan`. That gives the session its plan, and the panel
  opens beside the conversation with the rows. A question, a code edit or a chat that decides nothing grows no plan.
- **Rounds are marked on each row.** Each row gets the spec's state dot: proposed, new or changed this round, pinned,
  accepted. The round in the panel's head and the "N changes in round N" filter stay as built. Running and Done
  come with slice 3.
- **File as Tasks is gone.** Accept in the panel replaces it. "File this as a task" still works through the agent's
  own `create_task`.
- **Not in S2:** Accept and Start, Undo Accept and live task states (slice 3); the Review menu and approved mock-ups
  (slice 4); files by content and design review (slice 5).

**What it buys.** Planning starts from the conversation you're already in. You no longer have to know beforehand
that a talk will turn into a plan.

**What could go wrong, and how we'd know.**

- _Every chat sprouts a plan._ Only `propose_plan`, Show Plan and New Plan make one. `note_heard` in a session with
  no plan writes nothing. The e2e sends ordinary messages to a plain session and checks that no panel appears until
  "propose it".
- _A plan made mid-session can't be read by the session that made it._ Every chat session opens its plan's folder
  at its start, even before the plan exists, because a new plan takes its chat's id (call 1). The e2e presses Show
  Plan on a warm session, drops a file, and checks the reply names it.
- _Two makers race._ Show Plan and a first `propose_plan` each make the plan in one write, and the second finds it
  there (`shapes_chat_unique`). There is one plan per chat.

**Calls you might disagree with.**

1. **A new plan's id is its chat's id under the `shp` prefix** (`planIdOfChat`). Every chat's session makes and opens
   `<data>/shapes/<that id>` before its sandbox starts. So a plan made in the middle of a session is readable at once,
   on Claude through the file hook and on Codex through the kernel grant, with no restart. _Cost if wrong:_ an empty
   folder per session.
2. **Without a plan, Plan's tools that need rows are refused** with "This session has no Plan yet: propose_plan
   starts one." That covers `attach`, `write_spec`, `report_finding`, `resolve_finding` and `see_screen`.
   `similar_tasks` and `find_records` answer, but without their dimmed transcript line. `note_heard` answers and
   writes nothing. _Cost if wrong:_ the agent in a plain session can't screenshot 10db's screens until it proposes.
3. **A refused first `propose_plan` leaves no plan.** The write that would make it is rolled back with the refusal.
4. **Plain sessions still drop pictures only.** Documents go to a session with a plan, so Show Plan comes first.
   Files by content is slice 5.
5. **"Rounds marked in the panel" means the state dot.** The panel already shows each row's mark, the round and its
   filter. No round markers are added to the conversation.
6. **Every session's system prompt grows by the planning instructions** (about 2,000 words, prompt-cached after the
   first turn).
7. **No migration and no `PROTOCOL_VERSION` bump.** The change adds one route and breaks none.

**Token ruling (yours, recorded):** the dev-UI and screen tokens keep reading a conversation once its chat has a
plan. Plain chats stay closed to them. Nothing changes in `screens/render-access.ts`.

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
- §3, "slice 2 gives every session both" and "every session from slice 2";
- §7, the File as Tasks row.

## Global constraints

- Code style and testing per `.claude/rules/code-style.md` and `.claude/rules/testing.md`. No new dependency.
- **No migration.** `shapes.chat_id` and `shapes_chat_unique` exist. If a card finds it needs a schema change, it
  stops and reports.
- **A plan is made in exactly three ways:**
  - New Plan (`POST /chats` with `plan: true`, as built);
  - Show Plan (`POST /chats/:chatId/plan`);
  - a passing `propose_plan` in a session with none.

  Each goes through `ensurePlanOfChat` in one write. Import and `start_shape` keep `insertPlanSession`.
- **A plan's id.** Every plan written from now on has the id `planIdOfChat(chatId)`; `insertShape` takes it from its
  `chatId`. A kept plan from the migration already has it, since the migration derived its chat's id from the
  plan's. Plans New Plan made under slice 1 keep their minted ids. So code that has a plan reads its id with
  `planOfChat`/`planOfConversation`. Only the folder a session opens before any plan exists uses `planIdOfChat`.
- **Every chat's session gets Plan's parts:**
  - the prompt (`PlanParts.systemPrompt`);
  - the agents (`PlanParts.agents`);
  - Plan's MCP tools offered (`mcp/server.ts`) and allowed (`chatProfile`);
  - the plan's folder (`planFilesDir`, `planFiles`).

  It gets them whether or not its chat has a plan yet. The parts that read rows still run only for a chat with one:
  `opening`, `digest`, `intake`, `reads`, `keepsResume`, `inlineSpent`, `onTurnEnded`. They resolve the plan at each
  call, never only at the session's start, so a plan made mid-session counts from the next call.
- **The trust surface is unchanged.**
  - `report_finding` comes only from a `tendb-*` reviewer subagent, and the stamp comes from its type.
  - Plan's read-only confinement does not run in a session.
  - The dev-UI and render tokens read a conversation only once its chat has a plan (`conversationHasPlan`).
- **The security hook's "chat confinement instead of Plan's" note is by design** (spec §3). Acknowledge it in the
  commit body and move on.
- **Copy is exact:**
  - the title row's toggle stays "Plan" (`aria-pressed`), with the tooltip "Show Plan" or "Close Plan";
  - the ⋯ menu item reads "Show Plan" or "Close Plan";
  - the refusal of a Plan tool in a session with no plan: "This session has no Plan yet: propose_plan starts one.";
  - a failed Show Plan: "Couldn't show the Plan: <reason>";
  - the row dot labels: "Proposed", "New this round", "Changed this round", "Moved to Earlier", "Pinned",
    "Accepted".
- **Knip.**
  - `ensurePlanOfChat` is used by Task 1's own `showPlan`.
  - `planIdOfChat`'s export has no user outside `packages/db` until Task 2, so nothing is pushed between Tasks 1
    and 2. Task 1 says so in its report.
  - `FILE_AS_TASKS_MESSAGE` and `SessionActions.onFileAsTasks` go in Task 4, with every use.
- Never `prettier --write` over `apps/daemon/src` as a whole (it rewrites the Codex-generated files). Name your
  files.
- A commit footer line stays under 100 characters (commitlint); wrap a Value card.
- Docs are part of done (Task 6).

## Provider parity

| Feature | Claude plan | Bedrock / API key | Codex plan |
| --- | --- | --- | --- |
| Show Plan, the panel, the state dot | 10db's own | same | same |
| Planning prompt and Plan's tools in every session | session's MCP | same | same |
| Plan's agents in every session | joined to the profile | same; no `tendb-researcher` without the web | none (no subagents); the prompt's `WITHOUT_AGENTS` lines |
| A plan made mid-session is readable | the file hook's `planFilesDir`, set at start | same | the read-only kernel grant of the folder, made at start |
| File as Tasks retired | Accept | same | same |

No feature refuses a provider.

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
| `POST /chats/:chatId/plan` | `ensurePlanOfChat(ctx, id, ShapeOrigin.App)`; 200 `ChatDto` (its `planId` set); idempotent |

```ts
// apps/daemon/src/chat/service.ts — ChatService gains
  /** Show Plan: the chat's plan, made if it has none; nothing else changes and no turn starts. */
  showPlan(id: ChatId): ChatDto;
// apps/daemon/src/api/services.ts — ApiServices gains
  showChatPlan(id: ChatId): ChatDto;
```

### The session (Task 2) — `apps/daemon/src/chat/hooks.ts`

```ts
// chatProfile loses its second parameter: Plan's tools are always allowed.
export function chatProfile(
  sandboxed: boolean,
): Omit<ExploreProfile, 'kind' | 'systemPrompt' | 'judge'>;
```

- `spec()` takes the folder as `deps.plan.filesDir(planOfConversation(db, conv.id) ?? planIdOfChat(chat.id))`, before
  `prepare`, for every chat (when `deps.plan` is given). It sets `access.planFilesDir` and passes `planFiles`.
- `systemPrompt` is always `chatSystemPrompt(webOn)` plus `plan.systemPrompt(…)`, and `agents` always
  `plan.agents(…)`, when `deps.plan` is given.
- `reads` resolves the plan per call:
  `preToolUse(req) => { const id = planOf(conv); return id === null ? verdict : plan.reads(id, access, limits).preToolUse(req, verdict) }`,
  and likewise `postToolUse` and `toolFailed`. Build `plan.reads(id, …)` once per id, not per call.
- `apps/daemon/src/chat/confinement.ts`: `NO_PLAN` and its branch go. A Plan tool is always judged by
  `judgePlanTool`.

### The tools (Task 3)

```ts
// apps/daemon/src/mcp/shape-tools.ts
export type ShapeToolsFor = (session: {
  readonly sessionId: SessionId;
  readonly chatId: ChatId;
  readonly projectId: ProjectId;
}) => ShapeToolHandlers;

// apps/daemon/src/shape/tools.ts
export function createShapeToolHandlers(
  deps: ShapeToolDeps,
  chat: { readonly chatId: ChatId; readonly projectId: ProjectId },
): ShapeToolHandlers;
/** The words of a Plan tool called in a session with no plan. */
export const NO_PLAN_YET = 'This session has no Plan yet: propose_plan starts one.';
```

- `mcp/server.ts` `conversationTools(deps, session)` loses `shapeId`. A chat's session gets `chatTools` and
  `shapeTools` together, always.
- Each handler resolves `planOfChat(db, chat.chatId)` at its call.
  - `propose_plan` makes the plan with `ensurePlanOfChat(ctx, chatId, ShapeOrigin.App)` in the same write as the
    reconcile and its line. A refusal throws inside the write, so a plan it made is rolled back, and the refusal is
    then answered as today.
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
| A turn runs | Builder presses Show Plan | The plan is made in its own write. The panel opens empty and the turn goes on. The prompt, tools and folder were there from the start, so nothing is injected. The next message's intake carries the plan's lines | 1, 4 |
| A plain session | The agent's `propose_plan` passes | The plan is made and reconciled in one write. `chat.changed` brings `planId`, and the panel opens with the rows (open by default for a session with a plan) | 3, 4 |
| A plain session | The agent's first `propose_plan` is refused | The write rolls back: no plan, no line; the agent gets every error | 3 |
| Show Plan's write and a first `propose_plan` | Both land | Each runs `ensurePlanOfChat` in its own write; the second finds the first's plan; one plan | 1, 3 |
| Show Plan | Pressed twice, or two windows | Idempotent: one plan, 200 each time | 1, 4 |
| Show Plan | The request fails | The toggle stays off; the tab says "Couldn't show the Plan: <reason>" | 4 |
| A warm session started before its plan | A file is dropped after Show Plan | It lands in `<data>/shapes/<planIdOfChat>`, which the session opened at its start; the next intake names it | 2, 4 |
| A warm session started before its plan | The agent calls `propose_plan` again, or a reviewer reports | The hook judges it as any plan tool (`judgePlanTool`): the folder was set at start, so no "no Plan" refusal | 2 |
| A plain session | The agent calls `note_heard` | Answered, nothing written; no panel | 3 |
| A plain session | The agent calls `attach`, `write_spec`, `report_finding`, `resolve_finding` or `see_screen` | Refused with `NO_PLAN_YET` | 3 |
| A plain session | The builder drops a document | Refused as today (pictures only); Show Plan first | 4 |
| A session with a plan from Show Plan, no rows | Daemon restart | The plan persists; the session reopens with its panel open (it has a plan) | — |
| A plan made mid-session | Context limit or a model change | The fresh session's digest carries the plan's rows after the chat's | 2 |
| Builder closed the panel | A round lands | The panel stays closed (the builder's choice holds); the toggle reads "Show Plan" | 4 |
| A session with a plan | The builder archives it | As built: the plan, its folder and links stay | — |
| A handed-off (sealed) chat or a removed project | The title row draws | No Plan toggle and no Show Plan item | 4 |

## Tracks

Two tracks, one integration branch (`feat/plan-in-sessions-s2-s3`), at most two implementers at once, a fresh one
per card.

- **Track A, daemon and db.** Task 1, then Task 2, then Task 3. Task 2 (session wiring) and Task 3 (tool handlers)
  touch different files, but Task 3 relies on Task 2's per-call resolution. Run them in order.
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
| 1 | A | db and route: `planIdOfChat`, `insertShape` takes it, `ensurePlanOfChat`, `ChatService.showPlan`, `POST /chats/:chatId/plan` | `task-1.md` |
| 2 | A | the session: every chat's session gets the prompt (rewritten for every session), agents, Plan's tools allowed and its plan's folder; `reads` resolved per call; `NO_PLAN` goes | `task-2.md` |
| 3 | A | the tools: Plan's tools offered to every chat's session; handlers resolve the plan per call; `propose_plan` makes it; `NO_PLAN_YET`; tool descriptions | `task-3.md` |
| 4 | B | desktop: Show Plan on every session (toggle and ⋯), `useShowPlan`, File as Tasks retired, the row state dot | `task-4.md` |
| 5 | B | e2e: a plain session grows a plan (Show Plan, a file, propose) in `sessions.spec.ts`; File as Tasks' step typed | `task-5.md` |
| 6 | — | docs: module notes, the decision record a-plan-takes-its-chats-id, stale File as Tasks lines | `task-6.md` |

## Review focus

- **The folder before the plan.** `spec()` opens `planIdOfChat(chat.id)` for a chat with no plan. Check that a slice-1
  plan with a minted id opens its own folder, never the derived one, and that nothing writes rows under the derived
  id before `ensurePlanOfChat`.
- **The rollback.** A refused first `propose_plan` must leave no `shapes` row and no `shape.changed` or `chat.changed`
  event. The throw happens inside `state.write`.
- **Tokens.** No reader of `conversationHasPlan` changed. A plain chat's conversation stays unreadable to the dev-UI
  and render tokens until it has a plan.
- **Per-call resolution.** `reads`, `intake` and `onTurnEnded` must pick up a plan made during the session. No hook
  may cache "no plan" at the session's start.
