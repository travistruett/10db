# Plan in Sessions S1: the move

## Brief

**What changes for you.**

- **New Plan.** The Plan item leaves the rail. New Plan sits beside New Session: in the Sessions panel's + menu, in
  the session switcher, and on ⌘⇧N. It opens a session with its Plan panel open beside the conversation.
- **The panel fills as you talk.** You talk, or drop a document, and the agent fills the panel as things are
  decided; there is no Propose button. You edit, pin and remove rows, open mock-ups, and press **Accept**.
  - Accept is today's Convert, with the same cut list for a plan of more than five goals.
  - It works while the agent is still answering and never stops the turn.
- **Links open the session.** Every link that opened a Plan now opens its session, bringing it back first if it was
  archived. That covers the Board drawer's Open conversation, a goal's line, Factory's "Planned in …" and
  Knowledge's provenance. The Record view opens from the panel's ⋯. Plan measures move to Settings › Planning.
- **A Plan session runs as any session does:** your setup, its sandbox, the judge. Plan's reviewers and researchers
  come along as 10db's own agents (`tendb-scope`, `tendb-engineering`, `tendb-rehearsal`, `tendb-researcher`,
  `tendb-code-researcher`).
- **Your existing plans.** A plan that put tasks or goals on the Board becomes an archived session, its plan
  intact. Every other plan is deleted. Its sessions' usage and cost rows stay, so spending totals don't move.
- **Not in S1** (slices 2 to 5): Show Plan on an ordinary session, Accept and Start, Undo Accept, live task states,
  the Review menu, approved mock-ups, and files by content.

**What it buys.** One place to talk. Planning runs with your setup, and the Plan screen's second conversation UI
goes away.

**What could go wrong, and how we'd know.**

- _The migration loses or breaks data._ A real-SQLite migration test seeds a plan that made tasks and one that
  made nothing, with Board tasks, Knowledge and sessions. It checks:
  - the kept plan opens as an archived session, and its tasks keep their `task_context`;
  - the unused plan and its conversation are gone;
  - its session rows and their cost survive, and the account's spend is unchanged;
  - `foreign_key_check` is clean.
- _The agent can't read a dropped document._ The plan's folder is created before the session's sandbox and opened
  to it: to the file tools on Claude, and as a read-only kernel grant on Codex (Task 3). The e2e drops a file into
  New Plan and checks the agent names it. The live Claude test is rewritten for a chat with a plan (Task 4) and
  re-run by hand.
- _A builder's agent forges a review._ `report_finding` is taken only from a subagent of one of 10db's reviewer
  types, and the reviewer is stamped from that type. A unit test runs it through the chat's confinement.
- _The panel churns._ The e2e pins a row, sends another "propose" message, and checks the pinned text survives the
  round.

**Calls you might disagree with.**

1. **`see_screen`'s `plan` screen takes no tool parameter.** Today it draws the asking conversation's own Plan;
   it now draws the asking session's transcript and panel. It does that from reads a render token already has
   (`/shapes/:id`, the conversation's items), and the render request carries the chat id. The spec's §7 said it
   takes a session id; it never needed one.
2. **A Plan session's model starts on the `plan` role's,** where a chat with no pick already launches.
   `shapes.effort` and `shapes.propose_unlocked` are dropped; the effort lives on the conversation, as a chat's
   does. The migration copies a kept plan's effort across.
3. **The dev-UI and screen tokens may read a conversation whose chat has a plan**, as they read a Plan's today.
   In S1 only New Plan sessions have one. See "Before slice 2".
4. **An imported plan arrives as a session whose rows carry an import pin.**
   - Rounds never rewrite an import-pinned row.
   - A re-import updates the same plan by bundle id, and holds back only what you pinned yourself.
   - The "imported, re-import to change it" refusals go.
5. **`start_shape` from a terminal opens a New Plan session as a tab.**
6. **Plan files of deleted plans stay on disk** under `<data>/shapes/<id>`. No sweep is added. _Cost if wrong:_
   some disk until a later cleanup.
7. **Rehearse leaves the panel until slice 4.** Its engine stays.
8. **Jev's "has the builder said enough to propose" shadow is retired** (`JudgeDecision.ShapeReady`). What it
   predicted, a Propose press, no longer happens.
9. **On an account whose session has no web** (Bedrock or an API key on 10db's judge, where Claude's auto mode
   can't run), the planning prompt says it has no web, and the researcher agent is left out.

**Needed from you:** nothing.

### Before slice 2

Slice 2 gives every session a plan. Then call 3 (the dev UI and screen tokens read a conversation whose chat has a
plan) covers every chat's transcript. Decide before slice 2 is planned whether those tokens keep reading
conversations, or the screen draws from a narrower read.

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
- §2, all but the after-Accept states, Review ▾ and Accept ▾'s second item;
- §3, all of it;
- §5, the first two bullets (Accept as Convert; the cut list);
- §6, the second bullet (the plan's folder);
- §7, every row;
- §8, the first two bullets.

## Global constraints

- Code style and testing per `.claude/rules/code-style.md` and `.claude/rules/testing.md`. No new dependency.
- **Migrations are forward-only** (`packages/db/AGENTS.md`). The branch adds three, in order:
  1. Generated:
     - `shapes.chat_id`, nullable, with its unique index;
     - the `sessions` rebuild that relaxes `sessions_has_owner` to allow an ended session with neither a
       workstream nor a conversation.

     The relaxed check has to come before migration 2 nulls a conversation id; SQLite checks it on the
     `UPDATE`.
  2. Custom (`drizzle-kit generate --custom --name plans_into_sessions`): the data move. Its SQL is written once
     and never edited after it lands.
  3. Generated: the `shapes` rebuild that makes `chat_id` required and drops `effort` and `propose_unlocked`.

  Task 2 adds all three so tests run. Task 9 renumbers them after the branch's last merge of `main`, if `main` added
  migrations meanwhile.
- **Only one open pull request adds migrations at a time** (AGENTS.md). Before Task 5 opens the draft pull request,
  check `gh pr list --state open` for another open pull request that touches `packages/db/drizzle/`. If one exists,
  open the draft anyway and report the conflict.
- **One plan per chat** (`shapes_chat_unique`). A plan never owns a conversation again:
  - `shapeConversation(db, shapeId)` is the one way from a plan to its conversation, through `chats`;
  - `planOfConversation(db, conversationId)` is the one way back.
- **A plan's files are the conversation's files with `item_id IS NULL`.** A picture pasted with a message carries
  its `item_id` and is never a plan file. Every plan-file reader filters on it: list, count, untold, and get by id.
- **The chat's hooks own every explore conversation that isn't a task's.**
  - The Plan owner (`createShapeOwner`, registered as `ConversationOwnerKind.Shape`) is removed, and so is the
    enum value.
  - A chat with a plan adds the plan's parts (`PlanParts`, below).
  - The chat's sandbox, profile, judge and trust policy (`TrustSurface.Chat`) win everywhere.
- **The reviewer stamp is bookkeeping, not a limit.**
  - `report_finding` is allowed only from a subagent whose `agent_type` is one of `PLAN_REVIEWERS`, and the hook
    sets `reviewer` from it.
  - The main session's `report_finding` is refused, as today. Codex's in-session findings are slice 4.
- **No Propose gate.** `propose_plan` is never refused for want of a press.
- **Accept never stops a turn.** Convert's "still answering" 409 goes, and so does its stop. Convert runs in one
  write, as today.
- **Contract removals have one owner.** `ShapeDto.proposeUnlocked` and `ShapeConvertInput.interrupt` stay in the
  contracts until Task 7, which removes them from contracts, daemon and desktop together. Until then:
  - the daemon answers `proposeUnlocked: true`;
  - the daemon ignores `interrupt`.
- **Copy is exact:**
  - "New Plan", with "⌘⇧N" in its tooltip and menu row;
  - "Accept" (was Convert) and "Accept N" (was "Convert N");
  - the panel's title "Plan" and its close "Close Plan";
  - the title row's toggle "Plan" (aria-pressed);
  - New Plan's first-message line (Task 4): "The builder opened this session to plan. Turn what they bring into
    goals and tasks as it is decided."
- `PROTOCOL_VERSION` is bumped once (Task 1).
- Docs are part of done (Task 9).

## Provider parity

| Feature | Claude plan | Bedrock / API key | Codex plan |
| --- | --- | --- | --- |
| New Plan, the panel, edits, pins, Accept | 10db's own | same | same |
| Plan's tools (`/mcp`) beside the chat's | session's MCP | same | same |
| Plan's agents (`tendb-*`) | joined to the profile | same; no `tendb-researcher` when the session has no web | none (no subagents); the prompt's `WITHOUT_AGENTS` lines, as today |
| The web in planning | auto mode's | 10db's judge: none, and the prompt says so (call 9) | the Web switch, as a chat's |
| Reading the plan's folder | the PreToolUse hook's file access and the file tools' carve-out | same | a read-only kernel grant of exactly that folder |
| The migration | 10db's own | same | same |

No feature refuses a provider.

## Interfaces

### Contracts

```ts
// Task 1 — packages/contracts/src/chat.ts. ChatDto gains, after `work`:
  /** The session's Plan; null while it has none. */
  planId: ShapeId.nullable(),
// ChatCreateInput gains:
  /** New Plan: the session starts with its Plan. */
  plan: z.boolean().optional(),

// Task 1 — packages/contracts/src/shape-view.ts. ShapeViewDto gains, beside `conversationId`:
  /** The session the Plan belongs to. */
  chatId: ChatId,
// ShapeOfDto gains:
  /** The session that holds that Plan; null when none did. */
  chatId: ChatId.nullable().default(null),

// Task 1 — packages/contracts/src/knowledge.ts. ProvenanceDto: `session` gains `chatId: ChatId.nullable()`
// beside `shapeId`; `conversation` gains `chatId: ChatId.nullable()` beside `id`.

// Task 1 — packages/contracts/src/shape-screens.ts. ScreenRenderRequest gains:
  /** The asking session, for the plan screen; absent for every other screen. */
  chatId: ChatId.optional(),

// Task 4 — packages/contracts/src/conversation.ts
export const ConversationOwnerKind = { Chat: 'chat', Task: 'task' } as const;

// Task 7 — packages/contracts/src/shape.ts: ShapeDto.proposeUnlocked and ShapeConvertInput.interrupt removed.
// Task 4 — packages/contracts/src/judge.ts: JudgeDecision.ShapeReady retired (see Task 4 for how).
```

### Database (Task 2)

```ts
// packages/db/src/schema.ts, shapes — the final columns
chatId: text('chat_id').$type<ChatId>().notNull().references((): AnySQLiteColumn => chats.id),
// effort and proposeUnlocked removed; index:
uniqueIndex('shapes_chat_unique').on(t.chatId),
// sessions — the check
check('sessions_has_owner', sql`${t.conversationId} IS NOT NULL OR ${t.workstreamId} IS NOT NULL OR ${t.endedAt} IS NOT NULL`),

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

// apps/daemon/src/shape/rounds.ts, beside PIN_WHOLE_ROW
/** An imported row: rounds keep it as a whole, and a re-import may still replace it. */
export const PIN_IMPORTED = 'import';
```

### The migration (`plans_into_sessions`, Task 2), outline

Each statement ends with `--> statement-breakpoint`. `<now>` is `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`, as
`0083_skip_listings_backfill.sql` writes it. Ids are `<prefix>_<uuid>` (`mintId`, `packages/contracts/src/ids.ts`),
so a chat id is `'cht' || substr(s.id, instr(s.id, '_'))`. `<fed>` is: a `task_context` or `landing_groups` row
names the shape, or a `shape_links` row of it has a `goal_id` or `task_id`.

```sql
-- 1. Each plan that fed the Board gets an archived chat over the conversation it owned.
INSERT INTO chats (id, project_id, conversation_id, title, title_source, mode, task_id, pass_id,
                   tab_position, created_at, updated_at, last_activity_at, archived_at)
SELECT 'cht' || substr(s.id, instr(s.id, '_')), s.project_id, c.id, s.title, 'builder', 'explore', NULL, NULL,
       NULL, s.created_at, <now>, s.updated_at, <now>
FROM shapes s JOIN conversations c ON c.owner_kind = 'shape' AND c.owner_id = s.id
WHERE <fed>;
-- 2. Only shapes whose chat was written: the chat names the plan, and the conversation becomes the chat's,
--    with the plan's effort (one UPDATE: its expressions read the old row).
UPDATE shapes SET chat_id = 'cht' || substr(id, instr(id, '_'))
WHERE 'cht' || substr(id, instr(id, '_')) IN (SELECT id FROM chats);
UPDATE conversations
SET owner_kind = 'chat', owner_id = 'cht' || substr(owner_id, instr(owner_id, '_')),
    effort = coalesce(effort, (SELECT effort FROM shapes WHERE id = conversations.owner_id))
WHERE owner_kind = 'shape' AND owner_id IN (SELECT id FROM shapes WHERE chat_id IS NOT NULL);
-- 3. A kept conversation's starters that never reached a turn (a queued Propose or Rehearse) stop being
--    starters, so Reopen starts nothing: `turnStarter` (packages/db/src/store/conversation-items.ts:275) reads a
--    shape_event as one only while its body has `$.prompt`. The row stays in the transcript.
UPDATE conversation_items SET body = json_remove(body, '$.prompt', '$.rehearsing')
WHERE kind = 'shape_event' AND pushed_at IS NULL
  AND delivered_at IS NULL AND conversation_id IN (SELECT conversation_id FROM chats
  WHERE id IN (SELECT chat_id FROM shapes WHERE chat_id IS NOT NULL));
-- 4. Every other plan goes, its children first:
--    shape_entry_versions, shape_entries, shape_shadow_answers, shape_findings, shape_rehearsals,
--    shape_attachment_revisions, shape_attachments, shape_links, shape_questions, shape_proposals.
--    Then, of its conversation: conversation_files, conversation_items, and sessions.conversation_id set to NULL
--    (the rows, their cost, skipped_actions and handoffs stay); the conversation; the shape.
--    "Other" is `chat_id IS NULL OR chat_id NOT IN (SELECT id FROM chats)`.
DELETE FROM … WHERE shape_id IN (SELECT id FROM shapes WHERE chat_id IS NULL OR chat_id NOT IN (SELECT id FROM chats));
-- 5. Anything still owned by 'shape' (a conversation without its shape) goes the same way.
```

### Plan's parts in a chat (Tasks 3-4)

```ts
// apps/daemon/src/shape/plan-parts.ts — what a chat with a plan adds; moved out of explore-owner.ts.
export interface PlanParts {
  /** Appended to the chat's system prompt: Shape's prompt rewritten (no read-only, no Propose). */
  systemPrompt(agentModels: readonly string[], subagents: boolean, web: boolean): string;
  /** 10db's planning agents, named `tendb-*`; {} without subagents; no researcher without the web. */
  agents(sandboxed: boolean, subagents: boolean, web: boolean): Readonly<Record<string, ShapeAgentDefinition>>;
  /** The plan's folder, made if missing, which the session reads as it reads its chat folder. */
  filesDir(shapeId: ShapeId): string;
  /** The prompt parts a session that never heard the plan starts with: New Plan's line, then the builder's
   *  earlier messages it was never sent (the catch-up), as the owner's spec() built them. */
  opening(shapeId: ShapeId, conv: ConversationRow, start: ExploreStart): readonly string[];
  /** The plan's rows as they stand, for a fresh session's digest, after the chat's own. */
  digest(shapeId: ShapeId): string;
  /** The lines that go ahead of a turn's message: edits, notes, mis-sized tasks, untold files. */
  intake(
    shapeId: ShapeId,
    conv: ConversationRow,
    item: ConversationItemRow,
    session: { readonly fresh: boolean; readonly digest: string | null; readonly limits: PictureLimits },
  ): {
    readonly lines: string;
    readonly images: OutgoingMessage['images'];
    readonly blocks: readonly ConversationFileId[];
    sent(ctx: WriteContext): void;
  };
  /** The read budget's hooks for the session's own Reads (§5.4 of the Plan spec), after the chat's verdict. */
  reads(shapeId: ShapeId, access: ShapeAccess, limits: PictureLimits): {
    preToolUse(req: ShapeToolRequest, verdict: ShapeVerdict): ShapeVerdict;
    postToolUse(req: ShapeToolRequest): void;
    toolFailed(req: ShapeToolRequest): void;
  };
  /** False when resuming would resend more pictures than this account takes (carriedTooMuch). */
  keepsResume(shapeId: ShapeId, limits: PictureLimits, accountLabel: string): boolean;
  /** The plan's checks at a turn's end: a turn that failed, a rehearsal that didn't read every task. */
  onTurnEnded(shapeId: ShapeId, end: TurnEnd): void;
  /** Tells the panel the plan changed, for what no row records (a parked start). */
  announce(shapeId: ShapeId): void;
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
// ShapePrepareInput (shape/session-launch.ts) and LaneSessionInput (sandbox/lane-sandbox.ts) gain
  /** The plan's folder: open to the file tools, and a read-only kernel grant of exactly it. */
  readonly planFiles?: string;
```

- `OutgoingMessage` is `conversation/delivery-rules.ts`'s.
- `ShapeReviewer` (`packages/contracts/src/shape.ts`) keeps its short values (`scope`, `engineering`,
  `rehearsal`), which the stored `reviewer` holds. Each agent's name is `tendb-` plus that value, and the stamp
  strips the prefix.
- What the Plan owner had and the chat doesn't take:
  - its `words` (the chat's own are used);
  - its `limits` (the chat's, from the account kind);
  - `NOTHING_TO_ASK` (the chat's).

### Routes

| Route | S1 |
| --- | --- |
| `POST /chats` `{ …, plan: true }` | creates the session with its plan (`insertPlanSession`); 201 `ChatDto` with `planId` |
| `POST /projects/:projectId/shapes`, `POST /shapes/:id/propose` | removed |
| `POST /shapes/:id/convert` | no 409 while a turn runs; `interrupt` ignored until Task 7 removes it |
| `GET /tasks/:id/shape`, `GET /goals/:id/shape` | `ShapeOfDto` with `chatId` |
| `POST /shapes/:id/resume` | unchanged; nothing in the daemon or desktop calls it today (`grep -rn resumeShape`), so no card is retargeted |
| `POST /projects/:projectId/plans/import` | creates a session with its plan; rows import-pinned |
| builder tool `start_shape` | creates a New Plan session, open as a tab |
| conversation routes | a chat's; the dev-UI and screen tokens read a conversation whose chat has a plan |

## State table (spec §1.1 rows and the ones S1 adds)

Design, not a test list.

| While | Event | Then | Task |
| --- | --- | --- | --- |
| A turn runs | Accept | Convert writes the rows as they stand in one write; the turn goes on; a round after it shows as new or changed rows | 5 |
| A `tendb-rehearsal` subagent runs | Accept converts its task | Nothing is dropped. The subagent's `report_finding` on a task no longer pending is answered "the task changed", and it stops (its prompt says so); the task's mark stays unwritten. Task 5 makes `reportFinding` answer that if it doesn't | 5 |
| Builder edits a row | A round changes it | The editor keeps the builder's text and says "The agent changed this"; Save pins the builder's version | 6 |
| A round lands | Builder pins or removes a row | Last write wins per row; a pinned or import-pinned row is never rewritten | 3 |
| A turn runs | Builder opens the panel | The panel shows; the prompt already holds the planning instructions | 4, 6 |
| A warm session | A file is dropped | It lands in the plan's folder, which the sandbox opened when the session started (the folder is made before `prepare`); the next turn's intake names it | 3, 4 |
| Context limit or model change | A fresh session starts | Its digest carries the chat's text, then the plan's rows | 4 |
| A session with a plan | Archive | The chat folder goes; `<data>/shapes/<id>` and every plan row stay; Reopen shows them | 4 |
| A session with a plan | Moves to a branch | The plan follows the chat id | 4 |
| A New Plan tab is creating its chat | A second send or drop | It waits for the one create, then goes in order | 6 |
| A New Plan tab is creating its chat | The tab is closed | The create finishes, and the chat is closed (`tabPosition` null), so Recently closed holds it | 6 |
| A New Plan tab is creating its chat | The create fails | The tab stays fresh with its draft and files, says why, and offers Try Again | 6 |
| A plan's session is archived | Its bundle is imported again | The plan is updated by bundle id; the chat stays archived; the answer names it; Open brings it back | 5 |
| A turn runs | Its bundle is imported again | The import writes in its own write; the turn goes on; later rounds keep import-pinned rows | 5 |
| A link to a plan | The session is archived | It is brought back (unarchived and given a tab), then opened | 7 |
| The migration | A plan fed the Board | It opens as an archived session with its plan; its queued starters stop being starters | 2 |
| The migration | A plan fed nothing | It and its conversation are gone; its sessions stay with no conversation | 2 |

## Tracks

Two tracks, one integration branch (`feat/plan-in-sessions-s1`), one pull request.

- **Track A, daemon and db (core).** Tasks 1-5 in order, one fresh implementer per task. Task 4 changes what Task 3
  built (the same hooks), so it goes to Task 3's implementer.
- **Track B, desktop and e2e.** Tasks 6-8, one implementer for the track.
  - It starts once Task 2 is on the branch: from then on `planId` and `GET /shapes/:id` are real, read through the
    chat.
  - Task 6 builds against them. Rows from a turn need Task 4, so Task 6's click-through waits for Task 5.
  - Task 7 needs Task 5.
  - Task 8 needs Tasks 5-7.
- **Where they first run together:** Task 6's final step, against the real daemon on the fake adapter. Before
  review, Task 8's e2e runs the whole flow.
- **Task 9** (docs and migration renumbering) runs last, after the branch's final merge of `main`.

## Tasks

| # | Track | Task | Card |
| --- | --- | --- | --- |
| 1 | A | contracts: `planId`, `plan`, `chatId` on the view, `ShapeOfDto`, `ProvenanceDto` and the render request; `PROTOCOL_VERSION` | `task-1.md` |
| 2 | A | db: `shapes.chat_id`, stores through the chat, plan files by `item_id IS NULL`, `insertPlanSession`, the three migrations and their test | `task-2.md` |
| 3 | A | tools and confinement: both tool sets, `tendb-` agents, the reviewer stamp in the chat's hook, the plan's folder (made first; file tools; Codex kernel grant), no Propose gate, the import pin | `task-3.md` |
| 4 | A | hooks: the chat composes `PlanParts`; the Plan owner, `ConversationOwnerKind.Shape` and `ShapeReady` retired; New Plan's line; the fake; the live test | `task-4.md` |
| 5 | A | routes and services: New Plan, `start_shape`, import, Convert without the 409, provenance and `ShapeOfDto` chat ids, the plan screen's request | `task-5.md` |
| 6 | B | the Plan panel in a session, New Plan and ⌘⇧N, Accept (no "still answering"), Heard so far, the New Plan tab's create | `task-6.md` |
| 7 | B | the Plan view goes; links open the session (unarchive first); Record under the session; measures to Settings; the plan screen; `proposeUnlocked` and `interrupt` removed everywhere | `task-7.md` |
| 8 | B | e2e: New Plan flow in `sessions.spec.ts`, with Remove Draft Goal and row keys; Plan rows of `see-screen` and `window-csp` moved; `shape.spec.ts` gone | `task-8.md` |
| 9 | — | docs, decision record, module notes, db-storage; migrations renumbered and the test's tag updated | `task-9.md` |

## Review focus

- **The migration's kept/deleted split.** A plan whose only link is a decision or principle is deleted. Its
  Knowledge records stay, because `decisions` and `principles` don't reference `shapes`. Task 2's test has that row.
- **A session with neither a workstream nor a conversation.** Every reader of `sessions` that assumes one or the
  other (usage, provenance, the session lists) must handle neither. Task 2 lists the readers it checked.
- **A builder's own agent named `tendb-scope`.** It passes the stamp, which is accepted (spec §3: the stamp is
  bookkeeping). Nothing tests for it.
- **The chat's `outgoing` with a plan and a picture.** The plan's intake images and the message's pictures share one
  budget (`heldInlineBytes`), one `images` list and one `blocks` list.
- **A chat with a plan on Codex.** `subagents` is false, so `agents()` returns `{}` and the prompt names no agent
  (`WITHOUT_AGENTS`). The kernel grant opens exactly the plan's folder.
