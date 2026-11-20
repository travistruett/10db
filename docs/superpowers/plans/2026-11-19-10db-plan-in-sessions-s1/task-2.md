# Task 2: db — a plan points at its chat; the migration

**Spec:** §8 Data (the first two bullets); §7 "Existing Plan conversations". **Track:** A, core (migrations). Read
`packages/db/AGENTS.md` first. Migrations are forward-only, and a column a rebuild needs comes in an earlier
migration.

## Files

- **`packages/db/src/schema.ts`.** `shapes` gets its final columns (index, "Database"), and `sessions` gets the
  relaxed `sessions_has_owner` (line 706).
- **`packages/db/src/store/shapes.ts`.**
  - `insertShape` takes `chatId` and writes no conversation.
  - Add `insertPlanSession`, `shapeConversation` (through `chats`), `planOfConversation`, `planOfChat` and
    `chatOfShape`.
  - `selectShapes` (line 27) joins `chats`, then `conversations`, for `model` and `effort`.
  - `shapeTokens` (line 141) follows the chat's conversation.
  - `toShapeDto` answers `proposeUnlocked: true` (interim, with a one-line comment; Task 7 removes it) and reads
    `effort` from the conversation.
- **`packages/db/src/store/shape-state.ts`.**
  - Every plan-file reader filters `item_id IS NULL`: `listShapeFiles` (line 322), `listUntoldShapeFiles` (line 327),
    `countShapeFiles`, and `getShapeFile` (line 312).
  - `getShapeFile` finds the plan through `planOfConversation`. It throws `NotFoundError` for a file with an
    `item_id` or a conversation with no plan.
  - Either `listFiles` and `listUntoldFiles` take a filter, or the shape readers filter what those return; pick the
    one that leaves `chat/` unaffected.
  - `patchShape` (line 73) loses `proposeUnlocked` and `effort`; an `effort` goes to `patchConversation`.
- **`packages/db/src/store/chats.ts` `insertChat`** (line 155).
  - It takes `tabPosition: number | null`; null writes a closed tab (`placeTab` already closes on null).
  - `title` stays required. `insertPlanSession` passes `input.title ?? CHAT_DEFAULT_TITLE`, and calls
    `setChatTitle(…, 'builder')` when it is given a title.
- **`packages/db/src/store/sessions.ts` `sessionShapeId`** (line 84): `planOfConversation(db, row.conversationId)`
  for a session with a conversation; null otherwise.
- **Readers of `sessions`** that assume a conversation or a workstream must handle a row with neither. Start with
  `grep -rn "conversationId" packages/db/src/store/sessions.ts packages/db/src/store/usage.ts apps/daemon/src/knowledge/provenance.ts`,
  then the session lists. List each reader you checked in your report.
- **The daemon**, the least that keeps it compiling. Behaviour is Tasks 4-5's.

  | Where | Change |
  | --- | --- |
  | `shape/service.ts` `create` (line 509), `startFromTerminal` (line 513) | `insertPlanSession` |
  | `plan-record/import.ts` (around line 613) | `insertPlanSession` |
  | `shape/service.ts:645` | the `proposeUnlocked` patch goes (the press stays until Task 4) |
  | `shape/service.ts:723` | the effort goes through `patchConversation` on `shapeConversation(…).id` |
  | `shape/explore-owner.ts:442` | `patchShape(…, { sdkSessionId: null })` stays; it patches the conversation |
  | `chat/service.ts` `dtoOf` | `planId` from `planOfChat` |
  | `shape/view.ts:250` | `chatId` from `chatOfShape` |
  | `knowledge/provenance.ts` | both `chatId`s, from `chatOfShape` where a shape is known |

  `test/shape-session.live.test.ts` imports `shapeSystemPrompt` and `judgeShapeCall` (lines 1-60), and must still
  compile. Task 4 rewrites it.
- **The three migrations**, under `packages/db/drizzle/` (index, Global constraints), made in this order:
  1. Temporarily make `chatId` nullable and keep `effort` and `proposeUnlocked`, with the relaxed sessions check
     already in. Run `pnpm --filter @10db/db generate`. This is migration 1: the column, the index and the
     `sessions` rebuild.
  2. In `packages/db`, run `pnpm exec drizzle-kit generate --custom --name plans_into_sessions`, and write the data
     move from the index's outline. Every statement ends with `--> statement-breakpoint`. This is migration 2.
  3. Put the final `shapes` back and run `generate`. This is migration 3. Check that the rebuild's
     `INSERT … SELECT` names only columns that exist by migration 2.
- **Create `packages/db/src/migrations-plans-into-sessions.test.ts`.** Give it a constant `MIGRATION`, migration
  1's tag, and use `migrationsBefore(dir, MIGRATION)` as `migrations-conversations.test.ts` does.

## Interfaces (implement, exactly)

From the index: the `shapes` columns, `shapes_chat_unique` and the `sessions` check; `insertPlanSession`,
`shapeConversation`, `planOfConversation`, `planOfChat` and `chatOfShape`; and the migration outline.

`insertPlanSession` writes, in the caller's write:

1. `insertConversation`, with owner `{ kind: Chat, id: chatId }`, profile Explore and state IdleCold;
2. `patchConversation`, for `model` and `effort` when given;
3. `insertChat`;
4. `insertShape`, titled `input.title ?? DEFAULT_SHAPE_TITLE`.

`DEFAULT_SHAPE_TITLE` is in `apps/daemon/src/shape/service.ts:270`, and a db store can't import the daemon. Either
move the constant into the db store, or have the caller pass the title. Each step emits what it emits today.

## State rows (design)

- **The migration × a plan that fed the Board:** it opens as an archived session with its plan, and its queued
  starters stop being starters.
- **The migration × a plan that fed nothing:** it and its conversation are gone, and its sessions stay with no
  conversation.

## Tests (core: a migration)

One test file, one `describe`. Seed through the migrations before migration 1, with raw SQL as
`migrations-conversations.test.ts` does:

- **Plan A**, which fed the Board:
  - a converted goal and task: a `shape_links` row, a `task_context` row and a `landing_groups` row;
  - proposals, an attachment with a revision, and a finding;
  - conversation items, among them a queued `shape_event` with a `prompt` and no `pushed_at`;
  - a plan file (`item_id` null) and an ended session;
  - `effort = 'high'`.
- **Plan B**, which fed nothing:
  - proposals, a conversation and items;
  - an entry with a version, and a shadow answer;
  - an ended session with `cost_usd = 1.25`;
  - one link, to a **decision** only.
- **Neither plan's:** one Board task, one decision, one principle, and an ordinary chat whose conversation holds a
  pasted picture (a `conversation_files` row with an `item_id`).

Migrate forward with the shipped folder, then assert:

- **Plan A is kept:**
  - its conversation has `owner_kind = 'chat'` and `effort = 'high'`;
  - an archived chat over it has A's title and `tab_position` null, and `shapes.chat_id` names it;
  - its `task_context`, `landing_groups`, links, proposals, attachments, findings, items, file and session survive;
  - its queued starter has no `$.prompt` left, and is still in the transcript.
- **Plan B is gone:** its shape, every row under it, its conversation and its items. Of what it touched:
  - its session survives, with `conversation_id` null and `cost_usd = 1.25`;
  - `accountSpendUsd` for its account, over a window that holds the session, is the same before and after;
  - the decision it linked to stays.
- **The rest:** the ordinary chat, its picture, the task, the decision and the principle are unchanged.
- **Integrity:** `PRAGMA foreign_key_check` returns no row, and no conversation has `owner_kind = 'shape'`.

Prove it red first: run it with migration 2 empty, and watch it fail.

## Steps

1. **Red.** Write the test against the migrations as they are, and see it fail.
2. Make the schema and store changes, the daemon compile fixes and the three migrations.
3. **Green.** Run
   `pnpm --filter @10db/db exec vitest related src/store/shapes.ts src/store/shape-state.ts src/store/sessions.ts src/store/chats.ts src/migrations-plans-into-sessions.test.ts --run --maxWorkers=2`.
   Then typecheck and lint db, daemon and desktop. Daemon tests that run a Plan turn may be red until Task 4; list
   which in your report.
4. Commit in two steps:
   - schema, stores and the daemon callers: `feat(db): a plan belongs to a chat`;
   - migrations, `meta/` and the test:
     `feat(db): plans that fed the board become archived sessions; the rest are deleted`. It carries this value
     card:

     ```
     Value: protects=a database holding plans migrates with its tasks' plan context and its sessions' cost
       intact; fails_when=the move deletes a plan the Board depends on, keeps an unused one, drops a session's
       cost, or leaves a dangling reference; why_new=migrations (core); no_claim=that the daemon runs a moved
       plan (tasks 3-5)
     ```
