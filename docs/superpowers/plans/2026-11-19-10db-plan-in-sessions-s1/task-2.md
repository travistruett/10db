# Task 2: db — a plan points at its chat; the migration

**Spec:** §8 Data (first two bullets); §7 "Existing Plan conversations". **Track:** A, core (migrations). Read
`packages/db/AGENTS.md` first: migrations are forward-only, and "a column a rebuild needs comes in an earlier
migration".

## Files

- `packages/db/src/schema.ts`: `shapes` gets its final columns (index "Database").
- `packages/db/src/store/shapes.ts`:
  - `insertShape` takes `chatId` and writes no conversation;
  - add `insertPlanSession`, `shapeConversation` through `chats`, `planOfConversation`, `planOfChat` and
    `chatOfShape`;
  - `selectShapes` joins `chats` then `conversations`, for `model` and `effort`;
  - `shapeTokens` follows the chat's conversation.
- `packages/db/src/store/shape-state.ts`:
  - `getShapeFile` (line 314) finds the plan through `planOfConversation` and throws `NotFoundError` when there is
    none;
  - `patchShape` loses `proposeUnlocked` and `effort`; the effort goes to `patchConversation`.
- `packages/db/src/store/sessions.ts`: `sessionShapeId` (line 84) is `planOfConversation(db, row.conversationId)`
  for a session with a conversation.
- `packages/db/src/store/chats.ts`: whatever the chat DTO reads gets `planId` (`planOfChat`).
- The three migrations under `packages/db/drizzle/` (index, Global constraints), made in this order:
  1. Temporarily make `chatId` nullable and keep `effort` and `proposeUnlocked`. Run
     `pnpm --filter @10db/db generate`; this is migration 1.
  2. Run `pnpm exec drizzle-kit generate --custom --name plans_into_sessions` in `packages/db` and write the
     data move (index, "The migration"); this is migration 2.
  3. Put the final schema back and run `generate` again; this is migration 3, the rebuild. Check the
     rebuild's `INSERT … SELECT` names only columns that exist by migration 2.
- Create `packages/db/src/migrations-plans-into-sessions.test.ts`. Use `migrationsBefore(dir, <migration 1's tag>)`
  as `migrations-conversations.test.ts` does.
- Daemon callers of `insertShape`, the least that keeps them compiling: they call `insertPlanSession` instead.
  - `shape/service.ts` `create` (line 509) and `startFromTerminal` (line 513);
  - `plan-record/import.ts` (around line 613).

  Their behaviour is Task 5's.
- The daemon's `chat/service.ts` `dtoOf` reads `planId` from the store.

## Interfaces (implement, exactly)

From the index: the `shapes` columns and `shapes_chat_unique`, `insertPlanSession`, `shapeConversation`,
`planOfConversation`, `planOfChat`, `chatOfShape`, and the migration outline.

- `insertPlanSession` writes, in the caller's write:
  - `insertConversation` with owner `{ kind: Chat, id: chatId }`, profile Explore, state IdleCold;
  - `patchConversation` for `model` and `effort` when given;
  - `insertChat`, with `mode: 'explore'`; its title is `input.title`, with `titleSource: 'builder'` when one is
    given, and null otherwise;
  - `insertShape`, titled `input.title ?? DEFAULT_SHAPE_TITLE`.

  It emits what `insertChat` and `insertShape` each emit today.

## State rows (design)

- The migration × a plan that fed the Board: it opens as an archived session with its plan.
- The migration × a plan that fed nothing: it and its conversation are gone.

## Tests (core: a migration)

One test file, one `describe`. Seed through the migrations before migration 1, with raw SQL as
`migrations-conversations.test.ts` does:

- **A**: a plan with a converted goal and task. It has a `shape_links` row, a `task_context` row and a
  `landing_groups` row; also proposals, an attachment with a revision, a finding, conversation items, a
  conversation file, an ended session on its conversation, and an `effort` of `high`.
- **B**: a plan with proposals, a conversation, items, an ended session, an entry with a version, a shadow answer,
  and one link to a **decision** only.
- One Board task not from any plan, one decision, one principle, and one ordinary chat with its conversation.

Migrate forward with the shipped folder, then assert:

- A's conversation has `owner_kind = 'chat'` and `effort = 'high'`.
- A chat row with that conversation is archived, has A's title and has `tab_position` null. `shapes.chat_id`
  names it.
- A's `task_context`, `landing_groups`, links, proposals, attachments, findings, items, file and session survive.
- B's shape, every row under it, its conversation, items and session are gone. The decision B linked to stays.
- The ordinary chat, the task, the decision and the principle are unchanged.
- `PRAGMA foreign_key_check` returns no row, and no conversation has `owner_kind = 'shape'`.

Prove it red first: run it against migration 2 left empty and watch it fail.

## Steps

1. **Red.** Write the test against the migrations as they are, and see it fail.
2. Make the schema and store changes and the three migrations as above.
3. **Green.** Run `pnpm --filter @10db/db exec vitest related src/store/shapes.ts src/store/shape-state.ts src/store/sessions.ts src/store/chats.ts src/migrations-plans-into-sessions.test.ts --run --maxWorkers=2`.
   Then typecheck and lint db, daemon and desktop. Daemon tests that run a Plan turn may be red until Task 4; say
   which in your report.
4. Commit in two steps:
   - schema, stores and the daemon callers: `feat(db): a plan belongs to a chat`;
   - migrations, `meta/` and the test: `feat(db): plans that fed the board become archived sessions; the rest
     are deleted`.

   The second carries:

   ```
   Value: protects=a database holding plans migrates with its tasks' plan context intact; fails_when=the
     move deletes a plan the Board depends on, keeps an unused one, or leaves a dangling reference;
     why_new=migrations (core); no_claim=that the daemon runs a moved plan (tasks 3-5)
   ```
