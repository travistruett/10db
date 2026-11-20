# Plan in Sessions S1: the move

## Brief

**What changes for you.**

- The Plan item leaves the rail. **New Plan** sits beside New Session (the Sessions panel's + menu, the session
  switcher, and ⌘⇧N) and opens a session with its Plan panel open beside the conversation.
- You talk, or drop a document, and the agent fills the panel as things are decided: no Propose button. You edit,
  pin and remove rows, open mock-ups, and press **Accept**. Accept is today's Convert, with the same cut list for a
  plan of more than five goals. It works while the agent is still answering and never stops the turn.
- Every link that opened a Plan now opens its session: the Board drawer's Open conversation, a goal's line,
  Factory's "Planned in …", Knowledge's provenance, the Re-plan card. The Record view opens from the panel's ⋯.
  Plan measures move to Settings › Planning.
- A Plan session runs as any session does: your setup, its sandbox, the judge. Plan's reviewers and researchers
  come along as 10db's own agents (`tendb-scope`, `tendb-engineering`, `tendb-rehearsal`, `tendb-researcher`,
  `tendb-code-researcher`).
- **Your existing plans:** a plan that put tasks or goals on the Board becomes an archived session, its plan
  intact. Every other plan is deleted.
- Not in S1: Show Plan on an ordinary session, Accept and Start, Undo Accept, live task states, the Review menu,
  approved mock-ups, files by content (slices 2 to 5).

**What it buys.** One place to talk. Planning runs with your setup, and the Plan screen's second conversation UI
goes away.

**What could go wrong, and how we'd know.**

- *The migration loses or breaks data.* A real-SQLite migration test seeds a plan that made tasks and one that made
  nothing, with Board tasks, Knowledge and sessions. It checks that the kept plan opens as an archived session and
  its tasks keep their `task_context`, that the unused plan and its conversation are gone, and that
  `foreign_key_check` is clean.
- *The agent can't read a dropped document.* The plan's folder is added to the session's file access (Task 3).
  The e2e drops a file into New Plan and checks the agent was told its path. The live Claude test
  (`test/shape-session.live.test.ts`) is re-run by hand.
- *A builder's agent forges a review.* `report_finding` is taken only from a subagent of one of 10db's reviewer
  types, and the reviewer is stamped from that type. A unit test runs it through the chat's confinement.
- *The panel churns.* The e2e pins a row, sends another "propose" message, and checks the pinned text survives the
  round.

**Calls you might disagree with.**

1. **`see_screen`'s `plan` screen takes no new parameter.** Today it always draws the asking conversation's own
   Plan. It now draws the asking session with its panel open. The spec's §7 says it "takes a session id", but it
   never needed one. *Cost if wrong:* a later parameter.
2. **A Plan session's model starts on the `plan` role's.** A chat with no pick already launches there.
   `shapes.effort` and `shapes.propose_unlocked` are dropped; the effort lives on the conversation, as a chat's
   does. The migration copies a kept plan's effort across.
3. **The dev-UI and screen tokens may read a conversation whose chat has a plan.** Today they may read only a
   Plan's. In S1 only New Plan sessions have one. *Cost if wrong:* a planning session's transcript is readable to
   the dev UI, as a Plan's is today.
4. **An imported plan arrives as a session with its rows pinned**, and the "imported, re-import to change it"
   refusals go. A re-import still updates the same plan by bundle id.
5. **`start_shape` from a terminal opens a New Plan session as a tab.** It doesn't arrive archived.
6. **Plan files of deleted plans stay on disk** under `<data>/shapes/<id>`. No sweep is added: they hold nothing a
   session reads. *Cost if wrong:* some disk until a later cleanup.
7. **Rehearse leaves the panel until slice 4.** Its engine stays, so the Review menu wires it back.

**Needed from you:** nothing.

---

> **For agentic workers:** read this Brief, Global constraints, Interfaces and your card
> (`2026-11-19-10db-plan-in-sessions-s1/task-<n>.md`). Work in `../10db-worktrees/plan-in-sessions-s1` on
> `feat/plan-in-sessions-s1`. Commit after every green step. Run related tests only:
> `pnpm --filter <pkg> exec vitest related <files> --run --maxWorkers=2`, plus typecheck and lint of the packages
> you touched. Before a push run `make precheck`, never `make check-changed` (a long-lived branch). **The branch
> typechecks after every task.** Between Tasks 2 and 4, daemon tests that run a Plan turn are expected red; run
> the db tests, the tests your card names, and typecheck.

**Spec:** `docs/superpowers/specs/2026-11-19-10db-plan-in-sessions-design.md`. S1 is §10 item 1 "The move". It builds
these sections:

- §1.1, the rows in the state table below;
- §2, all but the after-Accept states, Review ▾ and the Board preview's new home (it stays in the panel as built);
- §3, all of it;
- §5, the first two bullets (Accept as Convert; the cut list);
- §6, the second bullet (the plan's folder);
- §7, every row;
- §8, the first two bullets.

## Global constraints

- Code style and testing per `.claude/rules/code-style.md` and `.claude/rules/testing.md`. No new dependency.
- **Migrations are forward-only** (`packages/db/AGENTS.md`). The branch adds three, in order:
  1. generated: `shapes.chat_id`, nullable, with its unique index;
  2. custom (`drizzle-kit generate --custom --name plans_into_sessions`): the data move, its SQL written once and
     never edited after it lands;
  3. generated: the `shapes` rebuild that makes `chat_id` required and drops `effort` and `propose_unlocked`.

  Task 2 adds all three so tests run. Task 9, after the branch's last merge of `main`, renumbers them if `main`
  added migrations meanwhile. It deletes the branch's own three, regenerates 1 and 3, and puts 2's SQL back byte
  for byte under its new number.
- **One plan per chat** (`shapes_chat_unique`). A plan never owns a conversation again:
  - `shapeConversation(db, shapeId)` is the one way from a plan to its conversation, through `chats`;
  - `planOfConversation(db, conversationId)` is the one way back.
- **The chat's hooks own every explore conversation that isn't a task's.** The Plan owner (`createShapeOwner`
  registered as `ConversationOwnerKind.Shape`) is removed, and so is the enum value. A chat with a plan adds the
  plan's parts (`PlanParts`, below). The chat's sandbox, profile, judge and trust policy (`TrustSurface.Chat`) win
  everywhere. `judgeShapeCall` stays only as the chat's confinement already calls it (reads, Bash, web,
  project MCP).
- **The reviewer stamp is bookkeeping, not a limit.**
  - `report_finding` is allowed only from a subagent whose `agent_type` is one of `PLAN_REVIEWERS`, and the
    hook sets `reviewer` from it through `updatedInput`.
  - The main session's `report_finding` is refused, as today. Codex's in-session findings are slice 4.
- **No Propose gate.** `propose_plan` is never refused for want of a press. `proposeUnlocked` leaves contracts,
  schema and code.
- **Accept never stops a turn.** `ShapeConvertInput.interrupt` and Convert's "still answering" 409 go. Convert
  runs in one write as today, and starts are not held around it.
- **Copy is exact:**
  - "New Plan", with "⌘⇧N" in its tooltip and menu row;
  - "Accept" (was Convert) and "Accept N" (was "Convert N");
  - the panel's title "Plan";
  - the panel's close label "Close Plan";
  - the session title row's toggle "Plan" (aria-pressed).
- `PROTOCOL_VERSION` is bumped once (Task 1): `ConversationOwnerKind` and `ShapeDto` lose values, so an older
  desktop must not talk to this daemon.
- Docs are part of done. Task 9 writes:
  - the decision record;
  - the module notes in every `AGENTS.md` it changes;
  - the `docs/architecture/db-storage.md` entry.

## Provider parity

| Feature | Claude plan | Bedrock / API key | Codex plan |
| --- | --- | --- | --- |
| New Plan, the panel, edits, pins, Accept | 10db's own | same | same |
| Plan's tools (`/mcp`) beside the chat's | session's MCP | same | same |
| Plan's agents (`tendb-*`) | joined to the profile | same | none (no subagents); the prompt's `WITHOUT_AGENTS` lines, as today |
| Reading the plan's folder | the PreToolUse hook's file access | same | the sandbox's file-tools carve-out (`taskFiles`); Task 3 checks it on Codex and reports if the kernel still refuses |
| The migration | 10db's own | same | same |

No feature refuses a provider.

## Interfaces

### Contracts (Task 1)

```ts
// packages/contracts/src/conversation.ts
export const ConversationOwnerKind = { Chat: 'chat', Task: 'task' } as const; // Shape removed (Task 4)

// packages/contracts/src/chat.ts — ChatDto gains, after `work`:
  /** The session's Plan; null while it has none. */
  planId: ShapeId.nullable(),
// ChatCreateInput gains:
  /** New Plan: the session starts with its Plan. */
  plan: z.boolean().optional(),

// packages/contracts/src/shape-view.ts — ShapeViewDto gains, beside `conversationId`:
  /** The session the Plan belongs to. */
  chatId: ChatId,
// ShapeOfDto gains:
  /** The session that holds that Plan; null when none did. */
  chatId: ChatId.nullable().default(null),

// packages/contracts/src/shape.ts
// ShapeDto: `proposeUnlocked` removed (Task 4, with the gate).
// ShapeConvertInput: `interrupt` removed (Task 5).
```

`ConversationOwnerKind.Shape`, `proposeUnlocked` and `interrupt` are removed in the tasks that remove their last
use, so each task typechecks. Task 1 only adds.

### Database (Task 2)

```ts
// packages/db/src/schema.ts, shapes — the final columns
chatId: text('chat_id').$type<ChatId>().notNull().references((): AnySQLiteColumn => chats.id),
// effort and proposeUnlocked removed; index:
uniqueIndex('shapes_chat_unique').on(t.chatId),

// packages/db/src/store/shapes.ts
/** A new session with its Plan: the conversation, the chat row and the shape, in the caller's write. */
export function insertPlanSession(
  ctx: WriteContext,
  input: {
    readonly projectId: ProjectId;
    /** Null: the chat is titled from its first message, and the plan follows it. */
    readonly title: string | null;
    readonly origin: ShapeOrigin;
    readonly tabPosition: number | null;
    readonly model?: string | null;
    readonly effort?: Effort | null;
    readonly state?: ShapeState;
    readonly round?: number;
    readonly bundleId?: string | null;
    readonly bundleOrigin?: BundleOrigin | null;
    readonly importedAt?: string | null;
  },
): { readonly chat: ChatRow; readonly shape: ShapeDto };
/** The conversation a plan's session holds; every plan has one. */
export function shapeConversation(db: DbReader, id: ShapeId): ConversationRow;
/** The plan of a conversation's chat, or null. */
export function planOfConversation(db: DbReader, id: ConversationId): ShapeId | null;
/** The plan of a chat, or null. */
export function planOfChat(db: DbReader, id: ChatId): ShapeId | null;
/** The chat a plan belongs to. */
export function chatOfShape(db: DbReader, id: ShapeId): ChatId;
```

`insertShape` stops writing a conversation and takes `chatId`; `insertPlanSession` is its only caller.
`sessionShapeId` resolves through `planOfConversation`. `ShapeDto.model` and `.effort` are read from the chat's
conversation.

### The migration (`plans_into_sessions`, Task 2), outline

```sql
-- A plan fed the Board when a task_context or landing_groups row names it, or a link names a goal or task.
-- 1. Each such plan gets an archived chat over the conversation it owned.
INSERT INTO chats (id, project_id, conversation_id, title, title_source, mode, task_id, pass_id,
                   tab_position, created_at, updated_at, last_activity_at, archived_at)
SELECT 'cht_' || substr(s.id, 5), s.project_id, c.id, s.title, 'builder', 'explore', NULL, NULL,
       NULL, s.created_at, <now>, s.updated_at, <now>
FROM shapes s JOIN conversations c ON c.owner_kind = 'shape' AND c.owner_id = s.id
WHERE <fed the Board>;
-- 2. Its conversation becomes the chat's, carrying the plan's effort (one UPDATE: expressions read the old row).
UPDATE conversations SET owner_kind = 'chat', owner_id = 'cht_' || substr(owner_id, 5),
       effort = coalesce(effort, (SELECT effort FROM shapes WHERE id = conversations.owner_id))
WHERE owner_kind = 'shape' AND owner_id IN (SELECT id FROM shapes WHERE <fed the Board>);
UPDATE shapes SET chat_id = 'cht_' || substr(id, 5) WHERE <fed the Board>;
-- 3. Every other plan goes, children first: shape_entry_versions, shape_entries, shape_shadow_answers,
--    shape_findings, shape_rehearsals, shape_attachment_revisions, shape_attachments, shape_links,
--    shape_questions, shape_proposals; then of its conversation: conversation_files, conversation_items,
--    skipped_actions and handoffs of its sessions, its sessions, the conversation; then the shape.
--    (`sessions_has_owner` forbids nulling a Plan session's conversation, so its rows go.)
DELETE FROM … WHERE shape_id IN (SELECT id FROM shapes WHERE chat_id IS NULL);
-- 4. Nothing may still name a deleted row, and no conversation may still be owned by 'shape'.
```

`<now>` is `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`, as `0083_skip_listings_backfill.sql` writes it. The ID
prefixes are `shp`, `cht` and `cnv` (`packages/contracts/src/ids.ts`). Task 2 checks the length of `'shp_'`
against `mintId` before it trusts `substr(…, 5)`.

### Plan's parts in a chat (Tasks 3-4)

```ts
// apps/daemon/src/shape/plan-parts.ts — what a chat with a plan adds; extracted from explore-owner.ts.
export interface PlanParts {
  /** Appended to the chat's system prompt: Shape's prompt rewritten (no read-only, no Propose). */
  systemPrompt(agentModels: readonly string[], subagents: boolean): string;
  /** 10db's planning agents, named `tendb-*`; {} without subagents. */
  agents(sandboxed: boolean, subagents: boolean): Readonly<Record<string, ShapeAgentDefinition>>;
  /** The plan's folder, which the session reads as it reads its chat folder. */
  filesDir(shapeId: ShapeId): string;
  /** The plan's rows as they stand, for a fresh session's digest, after the chat's own. */
  digest(shapeId: ShapeId): string;
  /** The lines that go ahead of a turn's message: edits, notes, mis-sized tasks, untold files. */
  intake(
    shapeId: ShapeId,
    conv: ConversationRow,
    session: { readonly fresh: boolean; readonly limits: PictureLimits },
  ): { readonly lines: string; readonly images: OutgoingMessage['images']; sent(): void };
  /** The plan's checks at a turn's end: a turn that failed, a rehearsal that didn't read every task. */
  onTurnEnded(shapeId: ShapeId, end: TurnEnd): void;
}
export function createPlanParts(deps: PlanPartsDeps): PlanParts;

// apps/daemon/src/shape/confinement.ts
export const PLAN_REVIEWERS = ['tendb-scope', 'tendb-engineering', 'tendb-rehearsal'] as const;
export const PLAN_RESEARCHER = 'tendb-researcher';
export const PLAN_CODE_RESEARCHER = 'tendb-code-researcher';
/** A Plan tool call from a chat's session: allowed, refused, or report_finding with `reviewer` stamped. */
export function judgePlanTool(call: ShapeCall): ShapeVerdict;

// ShapeAccess gains
  /** A plan's folder, readable as `filesDir` is; absent for a session with no plan. */
  readonly planFilesDir?: string;
// ShapePrepareInput gains
  /** The plan's folder, kept open to the session's file tools as a task's pictures are. */
  readonly planFiles?: string;
```

`OutgoingMessage` is `conversation/delivery-rules.ts`'s (what `outgoingMessage` returns). `ShapeReviewer`
(`packages/contracts/src/shape.ts`) keeps its short values (`scope`, `engineering`, `rehearsal`), which the stored
`reviewer` holds. The agent names are `tendb-` plus that value, and the stamp strips the prefix.
`SHAPE_REVIEWERS`, `SHAPE_RESEARCHER` and `SHAPE_CODE_RESEARCHER` are replaced by the three `PLAN_` constants.

### Routes

| Route | S1 |
| --- | --- |
| `POST /chats` `{ …, plan: true }` | creates the session with its plan (`insertPlanSession`); 201 `ChatDto` with `planId` |
| `POST /projects/:projectId/shapes` | removed (New Plan replaces it) |
| `POST /shapes/:id/convert` | no 409 while a turn runs; no `interrupt` |
| `POST /shapes/:id/propose` | removed |
| `GET /tasks/:id/shape`, `GET /goals/:id/shape` | `ShapeOfDto` with `chatId` |
| `POST /shapes/:id/resume` | unchanged; writes into the plan's session, which the card's Open opens |
| `POST /projects/:projectId/plans/import` | creates a session with its plan; rows pinned |
| builder tool `start_shape` | creates a New Plan session, open as a tab |
| conversation routes | a chat's; the dev-UI and screen tokens read a conversation whose chat has a plan |

## State table (spec §1.1 rows S1 touches)

Design, not a test list.

| While | Event | Then | Task |
| --- | --- | --- | --- |
| A turn runs | Accept | Convert writes the rows as they stand in one write; the turn goes on; a round after it shows as new or changed rows | 5 |
| Builder edits a row | A round changes it | The editor keeps the builder's text and says "The agent changed this"; Save pins the builder's version | 6 |
| A round lands | Builder pins or removes a row | Last write wins per row; a pinned row is never rewritten (`rounds.ts`, unchanged) | 3 |
| A turn runs | Builder opens New Plan's panel | The panel shows; the prompt already holds the planning instructions | 4, 6 |
| Context limit or model change | A fresh session starts | Its digest carries the chat's text and then the plan's rows, so the next round restates them | 4 |
| A session with a plan | Archive | The chat folder goes; `<data>/shapes/<id>` and every plan row stay; Reopen shows them | 4 |
| A session with a plan | Moves to a branch | The plan stays with the chat (it follows the chat id, not the folder) | 4 |
| The migration | A plan fed the Board | It opens as an archived session with its plan | 2 |
| The migration | A plan fed nothing | It and its conversation are gone | 2 |

## Tracks

Two tracks, one integration branch (`feat/plan-in-sessions-s1`), one pull request.

- **Track A, daemon and db (core).** Tasks 1-5 in order, one fresh implementer per task. Task 4 changes what
  Task 3 built (the same hooks), so it goes to Task 3's implementer.
- **Track B, desktop and e2e.** Tasks 6-8, one implementer for the track. It starts once Task 1 has landed on the
  branch.
  - Task 6 builds against the contracts and the existing `/shapes/:id` view.
  - Task 7 needs Task 5.
  - Task 8 needs Tasks 5-7.
- **Where they first run together:** Task 6's final step merges the branch, once Task 5 is on it, and clicks
  through New Plan against the real daemon on the fake adapter. Before review, Task 8's e2e runs the whole flow.
- **Task 9** (docs and migration renumbering) runs last, after the branch's final merge of `main`.

## Tasks

| # | Track | Task | Card |
| --- | --- | --- | --- |
| 1 | A | contracts: `planId`, `plan`, `chatId` on the view and `ShapeOfDto`; `PROTOCOL_VERSION` | `task-1.md` |
| 2 | A | db: `shapes.chat_id`, the stores through the chat, `insertPlanSession`, the three migrations and their test | `task-2.md` |
| 3 | A | tools and confinement: one tool set for a chat with a plan, `tendb-` agents, the reviewer stamp in the chat's hook, the plan's folder readable, no Propose gate | `task-3.md` |
| 4 | A | hooks: the chat composes `PlanParts`; the Plan owner and `ConversationOwnerKind.Shape` removed; the fake proposes on "propose" | `task-4.md` |
| 5 | A | routes and services: New Plan, `start_shape`, import, resume, Convert without the 409, the screen and token guards | `task-5.md` |
| 6 | B | the Plan panel in a session, New Plan and ⌘⇧N, Accept, Heard so far | `task-6.md` |
| 7 | B | the Plan view removed; every link retargeted; Record under the session; measures to Settings | `task-7.md` |
| 8 | B | e2e: `sessions.spec.ts` New Plan flow; Plan rows of `shape`, `see-screen` and `window-csp` moved | `task-8.md` |
| 9 | — | docs, decision record, module notes, db-storage; migrations renumbered after the last main merge | `task-9.md` |

## Review focus

- **The migration's kept/deleted split.** A plan whose only link is a decision or principle (no goal, task,
  `task_context` or landing group) is deleted. Its Knowledge records stay, because `decisions` and `principles` don't
  reference `shapes`. Task 2's test has that row.
- **A builder's own agent named `tendb-scope`.** It passes the stamp. This is accepted (spec §3: the stamp is bookkeeping),
  and nothing tests for it.
- **The chat's `outgoing` with a plan and a picture.** The plan's intake images and the message's pictures share
  one budget (`heldInlineBytes`). Task 4 adds them to the same `images` list, never two.
- **A chat with a plan on Codex.** `subagents` is false, so `agents()` returns `{}`, and the prompt names no agent
  (`WITHOUT_AGENTS`).
