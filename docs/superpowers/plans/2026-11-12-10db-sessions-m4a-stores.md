# 10db Sessions M4a: the conversation stores and the migration — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Plan's transcripts and the tasks' threads live in one store (`conversations`, `conversation_items`,
`conversation_files`), moved there by one forward migration that keeps every id, and the delivery half of the
lane messages and the thread service is a `conversation/` library; the builder sees no change, and it survives a
restart.

**Architecture:** Generated migrations make the tables and rebuild what referenced the old ones; one `--custom`
migration copies the rows, numbering each conversation's items by `seq`. The old Plan and thread repositories keep
their names and signatures (`insertShapeMessage`, `listTaskThread`, `getTaskMessageRow`…) and become adapters over
the generic conversation repositories, so `shape/service.ts`, `thread/service.ts`, the runner and the real-rung
tests do not change. The daemon gains a `conversation/` module, below `pass`, holding the picture modules, the
delivery rules and the message intake.

**Tech Stack:** TypeScript, Drizzle on SQLite (better-sqlite3, WAL), drizzle-kit 0.31.11, zod 4, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-11-10db-sessions-design.md` (v3): §9.1, §9.2, §6.1 (the library), §6.2
(rules 1–4), §4 (module order), §13 (Real SQLite rows), §14 (the M4a record). Research:
`docs/architecture/research/2026-11-11-sessions-research.md` T1 §1, §5 (B, C, D), §6.

**Needs:** M2c merged, so M2b's seam too: `ToolCallView` (`packages/contracts/src/tool-call-view.ts`, with
`harnessTool`, nullable `durationMs` and `parentId`, `other.inputPreview` at most `PREVIEW_CHARS` = 200) and
`AgentSessionCore` (`apps/daemon/src/sessions/types.ts`, M2b Task 2), which this plan gives `conversationId` (M2b
call 2). Runs alone: the roadmap runs M4a, M4b and M4c one at a time.

## Global Constraints

- Branch `feat/sessions-m4a`, in `../10db-worktrees/sessions-m4a`:
  `git worktree add ../10db-worktrees/sessions-m4a -b feat/sessions-m4a origin/main`.
- Read `AGENTS.md`, `.claude/rules/code-style.md`, `.claude/rules/testing.md`, `packages/db/AGENTS.md`,
  `packages/contracts/AGENTS.md` and `apps/daemon/AGENTS.md` (its Modules section) before Task 1.
- File:line citations are to `main` at c4da899. M2a–M2c move some daemon lines (`shape/service.ts`,
  `runner/runner.ts`, `sessions/*`); find the code by the name the step gives. `packages/db` lines are unmoved.
- Migrations are forward-only (`packages/db/AGENTS.md`). Generate with `pnpm --filter @10db/db generate --name <name>`;
  the copy is `pnpm --filter @10db/db exec drizzle-kit generate --custom --name conversation_copy`, written by hand
  once. Never edit a generated file, never regenerate or delete a migration. Each task below generates its
  migration once, from a schema the task's test already pins.
- A column a rebuild must copy is added by `ALTER TABLE` in an earlier migration than the rebuild (the 0027/0028
  rule): `sessions.conversation_id` comes in 0066, and `sessions` is rebuilt in 0068.
- `migrateDatabase` switches `foreign_keys` off around the migrations and runs `foreign_key_check` after
  (`packages/db/src/database.ts:101-127`); a dangling reference throws `MigrationIntegrityError`. Every seed in a
  migration test is written with `foreign_keys = ON`, so a violation after migrating is the migration's.
- Ids are kept. `ConversationItemId` reads `cvi_`, `shm_`, `tmg_`; `ConversationFileId` reads `cvf_`, `sfl_`,
  `tfl_`. `mintId` mints only `cvi_` and `cvf_` for them, `cnv_` for a conversation and `cht_` for a chat.
- Order is `conversation_items.seq`, never the id: a new `cvi_` id sorts before every `shm_` and `tmg_` id as text.
  Files order by `created_at`, then `id`.
- No behaviour change. These stay unmodified and green: `apps/daemon/src/runner/pass-lane.test.ts`,
  `apps/daemon/test/crash-recovery.test.ts`, `apps/daemon/src/shape/confinement.test.ts`,
  `apps/desktop/e2e/shape.spec.ts`, `apps/desktop/e2e/workbench.spec.ts`. Because `pass-lane.test.ts` names
  `TaskMessageId` and `getTaskMessageRow`, those names stay. `runner/lane-messages.test.ts`, `thread/thread.test.ts`
  and `thread/session-text.test.ts` change only as Task 7 lists (id-kind renames, and the table a raw-SQL line
  names); their assertions stay, and they are the coverage Tasks 10 and 11 rely on.
- Code never orders messages by comparing ids as text, since a new `cvi_` id sorts before every migrated one: it
  compares `seq`, or position in a `seq`-ordered list. Task 7 ends with
  `grep -rnE "\.id [<>]=? |[Ii]d [<>]=? [a-z]+\.[a-zA-Z]*[Ii]d\b" apps/daemon/src apps/desktop/src packages/db/src`
  answering nothing.
- Code style: `as const` objects, no `enum`, no constructor parameter properties, no `any`, no `!`, no `as` outside a
  validated boundary (with a comment), zod at every boundary (a JSON body read from SQLite is one), exhaustive
  switches, no grab-bag files.
- Every new test is seen to fail first, for the reason named in its step. One commit per task; each commit names its
  paths (`git add a b && git commit -m '…'`), single-quoted, Conventional Commit, scope `db`, `daemon`, `contracts`
  or `docs`. Each commit that adds a tested behaviour carries its value card as a second `-m`, and every message
  ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (a last `-m`).
- Per task, run only the changed packages' checks (`make check-changed`). `make gate` once, in Task 12.

## Calls made here

Each is marked **(call)** where it is used.

1. **The `chats` table is created here**, with no repository: §9.1 lists it with the others and M5a writes it.
2. **A migrated conversation's id is `cnv_` plus its owner's UUID** (`shp_<u>` → `cnv_<u>`, `tsk_<u>` → `cnv_<u>`):
   SQL can't mint a UUIDv7, the owner's UUID is one, and owners never share a UUID.
3. **Migrated Plan builder messages are delivered at their own `created_at`**, and so is every Plan builder message
   the Task 6 adapter writes: Plan's queue lived in memory and died with each process, so none is waiting. Without
   this, M4b's engine would read every old Plan message as queued.
4. **A Plan `tool` line is a finished `other` call of 10db's own:** `{ kind: 'other', id: <call id>, harnessTool:
   '10db.plan', status: 'done', title: <the whole line>, startedAt: <created_at>, durationMs: null, parentId: null,
   name: '10db.plan', inputPreview: <its first 100 code points> }`. The whole line stays in `title` because Plan's
   read budget parses it back (`conversation/inline-budget.ts` after Task 9). `inputPreview` is cut at 100 code
   points, in SQL (`substr` counts code points) and in TypeScript (`[...line].slice(0, 100).join('')`), because
   zod's 200 counts UTF-16 units and an emoji is two. A migrated line's call id is its row id; a line the Task 6
   adapter writes gets a fresh UUID, since `insertItem` mints the item id. The adapter reads `title` back.
5. **A task's `reply` becomes `agent_message`**; its `message` and `notice` keep their kinds and authors.
6. **`conversation_files.item_id` is nullable**: Plan's files belong to the conversation, not to a message.
7. **`conversation_items.turn_id` keeps its foreign key to `pass_turns`** (a task's turn); explore conversations leave
   it null.
8. **The 32 KB body cap is not applied here.** The spec (§6.2, §9.1) caps new items and copies migrated bodies as
   they are, and the old services write what they wrote before. The cap is M4b's Task 8, with the engine, which
   writes the first bodies that can outgrow it.
9. **The sessions check is named `sessions_has_owner`**: `conversation_id IS NOT NULL OR workstream_id IS NOT NULL`. A
   lane session of a task that has a conversation names both, set at insert, as the copy sets it.
10. **`ShapeMessageId`, `TaskMessageId`, `ShapeFileId` and `TaskFileId` stay as names of the new ids** (aliases in
    `ids.ts`), so the old services and the real-rung tests compile unchanged. M4b's Plan task retires the two Shape
    names; the two Task names stay while `pass-lane.test.ts`, which must not change, names `TaskMessageId`.
11. **`screens/file-check.ts` moves into `conversation/` too**, with `shape/dropped-files.ts`'s budget verdicts and
    `runner/thread-pictures.ts`: the moved picture code imports them, and `conversation` sits below `screens`,
    `shape` and `runner`. §4 names only three files (spec gap 1).
12. **The delivery library takes the owner's words for a message** (`messageText`), so `builderMessageText` and its
    "task's thread" wording stay in `thread/`; and it resolves its conversation lazily, since a lane can start
    before its task has one.
13. **"The delivery half of `thread/service.ts`"** is read as the intake: limits, pictures on disk first, the rows in
    one write, and removing the files a failed write left. The pass's refusals and the Ready-turn mark stay in
    `thread/` until M4c moves the routes.
14. **The module order gains `conversation` only.** `chat` joins the line in M5a, when the module exists.
15. **Generated migration names:** `0066_conversation_tables`, `0067_conversation_copy` (custom),
    `0068_session_conversation`, `0069_shadow_answer_items`, `0070_pass_turn_items`, `0071_drop_old_transcripts`.
    These follow the stakeholder questions build, which takes 0063–0065 and merges first (its plan's "Building
    beside Sessions"). If that build merges after M4a instead, it renumbers, and these go back to 0063–0068
    seeded from 0061.
16. **`AgentSessionCore.conversationId` is `ConversationId | null`.** Plan's explore spec always names its
    conversation; a lane names its task's, or null while the task has no thread. The explore profile keeps
    `shapeId` (M2b call 3) until M4b's engine builds Plan's spec.

## Review Focus

1. **A new item after the migration lands on a copied `seq`.** `next_seq` must be one past the copied rows, or the
   unique index throws on the builder's first message after the upgrade. Pinned in Task 3 (the copy's `next_seq`)
   and Task 6 (a message written after a migrated transcript gets `n + 1` and lists last).
2. **A transcript mixing migrated and new ids lists out of order, or a digest drops the migrated history.** `cvi_…`
   sorts before `shm_…` and `tmg_…`, and `shape/service.ts:1022` and `thread/session-text.ts:64` compare ids as
   text. Pinned in Task 6 (Plan's list and its never-spoke start) and Task 7 (the thread and its digest), each with
   a migrated-prefix row written before a new one.
3. **A lane session that names both its workstream and its task's conversation is counted twice in usage.** Pinned
   in Task 5's usage table across the three owners.
4. **A message pushed before migration 0060 (no `push_uuids`) is consumed under its row's own uuid after the
   upgrade.** `idOfUuid('TaskMessage', …)` found it; the lookup must too. Pinned in Task 4 and Task 7.
5. **A builder message taken back after a refused push leaves a `seq` gap.** The next message still gets a fresh
   `seq` and lists last, and a file kept for it is ordered by time. Pinned in Task 7.

## File structure

| Path | Job |
| --- | --- |
| `packages/contracts/src/ids.ts` | ID kinds read several prefixes; the four new kinds |
| `packages/contracts/src/conversation.ts` (new) | owner kinds, profiles, states, item authors and kinds, item bodies |
| `packages/db/src/schema.ts` | the four tables, `sessions.conversation_id`, the rebuilt references |
| `packages/db/drizzle/0066…0071` (generated, one custom) | the migrations |
| `packages/db/src/migrations-conversations.test.ts` (new) | the seeded-0065 migration test |
| `packages/db/src/store/conversations.ts` (new) | conversation rows: insert, read by id or owner, patch |
| `packages/db/src/store/conversation-items.ts` (new) | items: insert with `seq`, list, delivery marks, push-uuid lookup |
| `packages/db/src/store/conversation-files.ts` (new) | files: insert, list, marks |
| `packages/db/src/store/transcript-kinds.ts` (new) | the pure maps between Plan's and the thread's rows and items |
| `packages/db/src/store/shape-state.ts`, `shapes.ts`, `task-thread.ts`, `sessions.ts`, `usage.ts`, `pass-turns.ts`, `pass-previews.ts` | adapters over the new stores |
| `apps/daemon/src/conversation/` (new module) | picture modules, delivery rules and delivery, intake |
| `apps/daemon/src/runner/lane-messages.ts` | calls the library |
| `apps/daemon/src/thread/service.ts` | calls the intake |
| `docs/architecture/decisions/<date>-one-conversation-store-keeps-ids-and-orders-by-seq.md` (new) | the S18 record |

---

### Task 1: Conversation ids and vocabularies

**Files:**
- Modify: `packages/contracts/src/ids.ts:7-12` (`idSchema`), `:14-58` (`ID_SCHEMAS`), `:60-104` (`ID_PREFIX`), the
  exports at the end
- Create: `packages/contracts/src/conversation.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/src/domain.test.ts` (extend `describe('ids')`), `packages/contracts/src/conversation.test.ts`

**Interfaces:**
- Consumes: `ToolCallView` (M2c), `InboxItemId`, `Timestamp`.
- Produces:
  - `ConversationId` (`cnv`), `ConversationItemId` (`cvi`, reads `shm`, `tmg`), `ConversationFileId` (`cvf`, reads
    `sfl`, `tfl`), `ChatId` (`cht`); `mintId('Conversation' | 'ConversationItem' | 'ConversationFile' | 'Chat')`;
    `idOfUuid('ConversationItem', uuid)` answers a `cvi_` id. The old `ShapeMessage`, `TaskMessage`, `ShapeFile` and
    `TaskFile` kinds stay until Tasks 6 and 7.
  - `ConversationOwnerKind = { Chat: 'chat', Shape: 'shape', Task: 'task' }`,
    `ConversationProfile = { Explore: 'explore', Lane: 'lane' }`,
    `ConversationState` (the ten §6.7 states, `IdleCold: 'idle_cold'` … `Sealed: 'sealed'`),
    `ConversationItemAuthor = { Builder: 'builder', Agent: 'agent', System: 'system' }`,
    `ConversationItemKind` (the ten §6.2 kinds: `message`, `agent_message`, `reasoning`, `tool_call`, `notice`,
    `digest`, `card`, `plan`, `shape_event`, `turn_marker`), `TurnMarker = { SendNow: 'send_now' }`.
  - `ConversationItemBody`, an object of zod schemas `satisfies Record<ConversationItemKind, z.ZodType>`:
    `message`, `agent_message`, `reasoning`, `notice`, `digest`: `{ text: string }`; `tool_call`: `ToolCallView`;
    `card`: `{ inboxItemId: InboxItemId }`; `plan`: `{ steps: { text: string; status: 'pending' | 'in_progress' |
    'completed' }[] }` (the values of M2c's `PlanStepStatus`, which lives in the daemon); `shape_event`: `{ kind: ShapeEventKind; text: string }` where `ShapeEventKind` is
    `propose | rehearse | edit | event | screen`; `turn_marker`: `{ marker: TurnMarker; resolvedAt: Timestamp |
    null }`.
  - `parseItemBody(kind, json): ConversationItemBody[kind]` (throws `InvalidError` naming the kind).

- [ ] **Step 1: Write the failing tests.** In `domain.test.ts`'s `describe('ids')`, add a table:

```ts
it.each([
  ['ConversationItemId', 'cvi', true], ['ConversationItemId', 'shm', true], ['ConversationItemId', 'tmg', true],
  ['ConversationItemId', 'sfl', false], ['ConversationFileId', 'cvf', true], ['ConversationFileId', 'sfl', true],
  ['ConversationFileId', 'tfl', true], ['ConversationFileId', 'shm', false], ['ConversationId', 'cnv', true],
  ['ChatId', 'cht', true],
] as const)('%s reads the prefix %s: %s', (schema, prefix, accepted) => {
  expect(SCHEMAS[schema].safeParse(`${prefix}_0199f1c2-7a3b-7c4d-8e5f-0123456789ab`).success).toBe(accepted);
});
it.each([['ConversationItem', 'cvi'], ['ConversationFile', 'cvf'], ['Conversation', 'cnv'], ['Chat', 'cht']] as const)(
  'mints %s under %s only', (kind, prefix) => {
    expect(mintId(kind).startsWith(`${prefix}_`)).toBe(true);
    expect(idOfUuid(kind, idUuid(mintId(kind)))?.startsWith(`${prefix}_`)).toBe(true);
  });
```

  `SCHEMAS` is a local record of the four exported schemas. In `conversation.test.ts`, one table row per item kind:
  a valid body parses, and `{}` is refused naming the kind.

- [ ] **Step 2: Run them and watch them fail.** Run:
  `pnpm --filter @10db/contracts exec vitest run src/domain.test.ts src/conversation.test.ts`.
  Expected: FAIL, `ConversationItemId` is not exported.

- [ ] **Step 3: Implement.** `idSchema(prefixes: readonly [string, ...string[]], brand)` builds
  `^(?:a|b|c)_<UUID_V7>$` for several prefixes and, for one, exactly today's `^<prefix>_<UUID_V7>$`, byte for byte,
  so no generated JSON schema of an existing id changes. Every existing kind passes a one-element list. `ID_PREFIX`
  keeps one prefix per kind, the one `mintId` uses. Export the four schemas and types beside the others. Write
  `conversation.ts` with the vocabularies above, each an `as const` object with its derived type; export it from
  `index.ts`.

- [ ] **Step 4: Run them and watch them pass.** Same command. Expected: PASS. Then
  `pnpm --filter @10db/contracts generate` and `git status packages/contracts/generated`: no file changed (no schema
  is registered yet, and every one-prefix pattern is unchanged). Then `make check-changed`.

- [ ] **Step 5: Commit.**

```bash
git add packages/contracts/src/ids.ts packages/contracts/src/conversation.ts packages/contracts/src/index.ts packages/contracts/src/domain.test.ts packages/contracts/src/conversation.test.ts && git commit -m 'feat(contracts): conversation ids that read the legacy message and file prefixes' -m 'Value: protects=a migrated shm_/tmg_/sfl_/tfl_ id parses as a conversation id while only cvi_/cvf_ are minted; fails_when=a legacy prefix is dropped or minted again; why_new=the ids table covers one prefix per kind; no_claim=no row is read through these yet'
```

---

### Task 2: The conversation tables

**Files:**
- Modify: `packages/db/src/schema.ts` (new tables after `taskFiles`, `:1381`; `sessions`, `:605-658`)
- Create: `packages/db/drizzle/0066_conversation_tables.sql` and its snapshot (generated)
- Test: `packages/db/src/schema.test.ts` (new `describe('the conversation tables')`)

**Interfaces:**
- Consumes: Task 1's ids and vocabularies.
- Produces: `schema.conversations`, `schema.conversationItems`, `schema.conversationFiles`, `schema.chats`;
  `schema.sessions.conversationId`. Columns:

```ts
export const conversations = sqliteTable('conversations', {
  id: text('id').$type<ConversationId>().primaryKey(),
  projectId: text('project_id').$type<ProjectId>().notNull().references(() => projects.id),
  ownerKind: text('owner_kind').$type<ConversationOwnerKind>().notNull(),
  /** A ShapeId, TaskId or ChatId, by `owner_kind`. */
  ownerId: text('owner_id').notNull(),
  profile: text('profile').$type<ConversationProfile>().notNull(),
  accountId: text('account_id').$type<AccountId>().notNull().references(() => accounts.id),
  model: text('model'),
  providerSessionId: text('provider_session_id'),
  /** §6.7; null for a task, whose state is the runner's. */
  state: text('state').$type<ConversationState>(),
  contextPct: real('context_pct'),
  nextSeq: integer('next_seq').notNull().default(1),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [uniqueIndex('conversations_owner_unique').on(t.ownerKind, t.ownerId),
           index('conversations_project_idx').on(t.projectId)]);

export const conversationItems = sqliteTable('conversation_items', {
  id: text('id').$type<ConversationItemId>().primaryKey(),
  conversationId: text('conversation_id').$type<ConversationId>().notNull().references(() => conversations.id),
  seq: integer('seq').notNull(),
  author: text('author').$type<ConversationItemAuthor>().notNull(),
  kind: text('kind').$type<ConversationItemKind>().notNull(),
  /** Parsed with `ConversationItemBody[kind]` on read. */
  body: text('body', { mode: 'json' }).$type<Json>().notNull(),
  turnId: text('turn_id').$type<PassTurnId>().references((): AnySQLiteColumn => passTurns.id),
  partial: integer('partial', { mode: 'boolean' }).notNull().default(false),
  pushedAt: text('pushed_at'),
  pushUuids: text('push_uuids', { mode: 'json' }).$type<string[]>().notNull().default([]),
  deliveredAt: text('delivered_at'),
  handedBackAt: text('handed_back_at'),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [uniqueIndex('conversation_items_seq_unique').on(t.conversationId, t.seq)]);

export const conversationFiles = sqliteTable('conversation_files', {
  id: text('id').$type<ConversationFileId>().primaryKey(),
  conversationId: text('conversation_id').$type<ConversationId>().notNull().references(() => conversations.id),
  itemId: text('item_id').$type<ConversationItemId>().references(() => conversationItems.id),
  name: text('name').notNull(), mediaType: text('media_type').notNull(), size: integer('size').notNull(),
  /** Null for a file copied from Plan, which never hashed its files. */
  sha256: text('sha256'),
  storedPath: text('stored_path').notNull(),
  inlineSent: integer('inline_sent', { mode: 'boolean' }).notNull().default(false),
  toldAt: text('told_at'), unreadableToldAt: text('unreadable_told_at'),
  createdAt: createdAt(),
}, (t) => [index('conversation_files_conversation_idx').on(t.conversationId, t.createdAt, t.id)]);
```

  `chats` (spec §7.1) **(call 1)**: `id` ChatId, `project_id` → projects, `conversation_id` → conversations (not
  null), `title`, `title_source` (`agent` | `builder`), `mode` (`explore` | `hands_on`), `task_id` → tasks,
  `pass_id` → passes, `tab_position` integer nullable, `created_at`, `updated_at`, `last_activity_at`,
  `archived_at`. `sessions` gains `conversationId: text('conversation_id').$type<ConversationId>()
  .references((): AnySQLiteColumn => conversations.id)` and an index `sessions_conversation_idx`; its CHECK and
  `shape_id` are untouched here.

- [ ] **Step 1: Write the failing test.** In `schema.test.ts` (it migrates a fresh file database): a conversation
  row and two items at `seq` 1 and 1 → the second insert throws `/UNIQUE constraint failed/`; a second conversation
  for the same `(owner_kind, owner_id)` throws `/UNIQUE constraint failed/`; `PRAGMA table_info(sessions)` lists
  `conversation_id`; the old `sessions_one_owner` CHECK still refuses a session with neither owner.

- [ ] **Step 2: Run it and watch it fail.** `pnpm --filter @10db/db exec vitest run src/schema.test.ts`. Expected:
  FAIL, `no such table: conversations`.

- [ ] **Step 3: Write the schema and generate.** Add the tables and the column above, then
  `pnpm --filter @10db/db generate --name conversation_tables`. Read the SQL: it must create four tables and their
  indexes and add `sessions.conversation_id` by `ALTER TABLE … ADD … REFERENCES conversations(id)`, with no
  `__new_sessions` rebuild. If drizzle-kit wrote a rebuild, the schema change is wrong: delete the two new files
  (they have never been committed), fix the schema and generate again.

- [ ] **Step 4: Run it and watch it pass.** Same command, then `pnpm --filter @10db/db exec vitest run` (the
  store template rebuilds from the new migration hash) and `make check-changed`. Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add packages/db/src/schema.ts packages/db/src/schema.test.ts packages/db/drizzle/0066_conversation_tables.sql packages/db/drizzle/meta/0066_snapshot.json packages/db/drizzle/meta/_journal.json && git commit -m 'feat(db): the conversation, item, file and chat tables' -m 'Value: protects=seq is unique per conversation and one conversation per owner; fails_when=either unique index is lost; why_new=no table held a conversation before; no_claim=nothing is copied or written yet'
```

---

### Task 3: The data copy, tested from a seeded 0065 database

**Files:**
- Create: `packages/db/drizzle/0067_conversation_copy.sql` (`--custom`, written by hand once) and its snapshot
- Create: `packages/db/src/store/transcript-kinds.ts`, `transcript-kinds.test.ts`
- Create: `packages/db/src/migrations-conversations.test.ts`
- Create: `docs/architecture/decisions/<today>-one-conversation-store-keeps-ids-and-orders-by-seq.md`
- Modify: `packages/db/AGENTS.md` (a bullet after the migration 0065 one)

**Interfaces:**
- Consumes: Task 2's tables; `migrateDatabase`, `openDatabase`, `DB_MIGRATIONS_DIR` (`packages/db/src/index.ts`);
  the `migrationsBefore(tag)` helper pattern from `packages/db/src/migrations-model-ids.test.ts:28-43`.
- Produces: migrated rows in the new tables; the test file Tasks 5–8 extend; and, in `transcript-kinds.ts` (pure),
  the maps the SQL is checked against while it can still change, which Tasks 6 and 7 then use:
  - `shapeItemOf(m: { author: ShapeMessageAuthor; kind: ShapeMessageKind; body: string; createdAt: string },
    callId: string): { author: ConversationItemAuthor; kind: ConversationItemKind; body: Json }` (`callId` names a
    tool line's call, call 4)
  - `shapeMessageOf(item: ConversationItemRow): { author; kind; body: string } | null`: a `tool_call` whose
    `harnessTool` is `'10db.plan'` reads back as `tool` with its `title` as the body; null for what Plan has no word
    for (`reasoning`, `plan`, `card`, `turn_marker`, and any other tool call, which M4b's engine writes)
  - `taskItemOf(m: { author: TaskMessageAuthor; kind: TaskMessageKind; body: string })` and
    `taskMessageOf(item)`, the same pair for threads
  - `planLinePreview(line: string): string`: the first 100 code points (call 4)

- [ ] **Step 1: Make the empty custom migration.** `pnpm --filter @10db/db exec drizzle-kit generate --custom --name conversation_copy`.
  It writes an empty `0067_conversation_copy.sql` and a snapshot equal to 0066's. Neither is committed until Step 7,
  so the SQL can change until the test and the maps agree with it.

- [ ] **Step 2: Write the failing tests.** `transcript-kinds.test.ts`: one row per `ShapeMessageKind` ×
  `ShapeMessageAuthor` (27 rows), `shapeMessageOf({ ...item, ...shapeItemOf(m, 'c') })` equals `{ author, kind, body }`
  of `m`; one row per `TaskMessageKind` × `TaskMessageAuthor` for the task pair; `planLinePreview` of 150 emoji
  answers 100 of them and parses as `other.inputPreview`.

  `migrations-conversations.test.ts` copies the shipped migrations cut before `0066_conversation_tables`
  (`migrationsBefore`), migrates a temp-dir database to there, seeds it with `foreign_keys = ON`, then runs
  `migrateDatabase(db)` to the head. Seed, with minted ids, minting the rows of different owners alternately so
  their ids interleave (a copy that partitions or joins on the wrong column then mixes them):

  - accounts `A` and `B`; project `P` on `A`, project `P2` on `B`.
  - shape `S1` in `P` (`sdk_session_id 'sdk-1'`, `model 'claude-opus-5-5'`) with, in id order, twelve
    `shape_messages`: builder `text`, claude `text`, claude `tool` (`Read · src/a.ts`), note `notice`, note `digest`,
    note `propose`, note `rehearse`, note `edit`, note `event`, claude `screen` (a JSON body), a claude `tool` line of
    300 characters, and a claude `tool` line of 150 emoji. Two `shape_files`: one told and inline, one with
    `unreadable_told_at`. Two Shape sessions: an older one on `A`, the latest on `B`.
  - shape `S2` in `P` with no messages, files or sessions.
  - shape `S3` in `P2` with three messages whose ids interleave with `S1`'s, one file, and no session.
  - a `shape_proposals` row whose `source_message_ids` names `S1`'s first and third messages; a `shape_questions`
    row naming the second; a `shape_shadow_answers` row on the first.
  - task `T1` in `P` with workstream `W1` and a lane session on `A`; a batch and pass `PA` holding `T1`;
    `task_messages`: builder `message` M1 (pushed, `push_uuids ['u-1']`, delivered), agent `reply` R1 with `turn_id`
    → `pass_turns` row `PT1` (whose `message_id` is M1), system `notice` N1, builder `message` M2 pushed under no
    uuid and not delivered; one `task_files` row on M1 with its `sha256`; a `pass_preview_marks` row with
    `notice_id` N1.
  - task `T3` in `P` with workstream `W3`, an older session on `A` and the latest on `B`, and two messages whose ids
    interleave with `T1`'s, one with a file.
  - task `T2` in `P` with workstream `W2` and a session, and no messages.

  Assertions, each its own `it`:

```ts
it('makes one conversation per shape and per task with a thread, under its owner’s uuid', () => {
  expect(rows(Conv, 'SELECT * FROM conversations ORDER BY owner_kind, created_at')).toEqual([
    { id: cnv(S1), project_id: P, owner_kind: 'shape', owner_id: S1, profile: 'explore', account_id: B,
      model: 'claude-opus-5-5', provider_session_id: 'sdk-1', state: 'idle_cold', next_seq: 13, /* … */ },
    { id: cnv(S2), project_id: P, owner_kind: 'shape', owner_id: S2, account_id: A, model: null, next_seq: 1, /* … */ },
    { id: cnv(S3), project_id: P2, owner_kind: 'shape', owner_id: S3, account_id: B, next_seq: 4, /* … */ },
    { id: cnv(T1), project_id: P, owner_kind: 'task', owner_id: T1, profile: 'lane', account_id: A, state: null,
      next_seq: 5, /* … */ },
    { id: cnv(T3), project_id: P, owner_kind: 'task', owner_id: T3, account_id: B, next_seq: 3, /* … */ },
  ]);
});
```

  where `cnv(id)` is `'cnv_' + idUuid(id)`. Then:
  - Each conversation holds exactly its owner's rows, at `seq` 1…n in its own old id order: `S1` `[1..12]`, `S3`
    `[1..3]`, `T1` `[1..4]`, `T3` `[1..2]`; no item of `S3` or `T3` is in `S1` or `T1`.
  - Each copied Plan row equals `shapeItemOf(old row, old row id)` and each task row `taskItemOf(old row)`, field by
    field, so the hand SQL and the code agree on every kind, author and body. That covers: `S1`'s (author, kind)
    `builder/message, agent/agent_message, agent/tool_call, system/notice, system/digest`, then `system/shape_event`
    four times, `agent/shape_event`, `agent/tool_call` twice; each tool body parses with `ToolCallView` as an `other`
    call with `harnessTool: '10db.plan'`; the 300-character line keeps all 300 in `title`; the emoji line's
    `inputPreview` is 100 emoji and parses **(call 4)**; R1 is an `agent_message` **(call 5)**.
  - Only Plan builder messages have `delivered_at`, equal to their `created_at` **(call 3)**; T1's R1 keeps `turn_id`
    PT1, and M1's and M2's `pushed_at`, `push_uuids` and `delivered_at` are as seeded.
  - Files keep their ids and their conversation: `S1`'s and `S3`'s have `item_id` and `sha256` null and their told,
    inline and unreadable marks; `T1`'s and `T3`'s have their message as `item_id` and their `sha256`.
  - `sessions.conversation_id` is `cnv(S1)` for both Shape sessions, `cnv(T1)` for `W1`'s, `cnv(T3)` for both of
    `W3`'s, and null for `W2`'s.
  - Every id in `shape_proposals.source_message_ids` and `shape_questions.source_message_ids` (read with
    `json_each`) is a `conversation_items` row of `cnv(S1)`; the shadow answer's `message_id`,
    `pass_turns.message_id` and `pass_preview_marks.notice_id` are `conversation_items` rows.

- [ ] **Step 3: Run them and watch them fail.**
  `pnpm --filter @10db/db exec vitest run src/store/transcript-kinds.test.ts src/migrations-conversations.test.ts`.
  Expected: FAIL, `transcript-kinds` does not exist and `conversations` is empty.

- [ ] **Step 4: Write the copy.** This SQL is the decision; write it as given, then make the test pass:

```sql
-- Authored once, never regenerated. Moves Plan's transcripts and the tasks' threads into the conversation tables,
-- keeping every row's id, so the JSON lists and the references that name a message stay valid. Order is `seq`,
-- numbered in the old id order; a conversation's id is `cnv_` and its owner's UUID.
INSERT INTO `conversations` (`id`, `project_id`, `owner_kind`, `owner_id`, `profile`, `account_id`, `model`,
  `provider_session_id`, `state`, `context_pct`, `next_seq`, `created_at`, `updated_at`)
SELECT 'cnv_' || substr(s.`id`, instr(s.`id`, '_') + 1), s.`project_id`, 'shape', s.`id`, 'explore',
  COALESCE((SELECT x.`account_id` FROM `sessions` x WHERE x.`shape_id` = s.`id`
            ORDER BY x.`started_at` DESC, x.`id` DESC LIMIT 1), p.`account_id`),
  s.`model`, s.`sdk_session_id`, 'idle_cold', NULL,
  (SELECT COUNT(*) FROM `shape_messages` m WHERE m.`shape_id` = s.`id`) + 1, s.`created_at`, s.`updated_at`
FROM `shapes` s JOIN `projects` p ON p.`id` = s.`project_id`;
--> statement-breakpoint
INSERT INTO `conversation_items` (`id`, `conversation_id`, `seq`, `author`, `kind`, `body`, `turn_id`, `partial`,
  `pushed_at`, `push_uuids`, `delivered_at`, `handed_back_at`, `created_at`, `updated_at`)
SELECT m.`id`, 'cnv_' || substr(m.`shape_id`, instr(m.`shape_id`, '_') + 1),
  ROW_NUMBER() OVER (PARTITION BY m.`shape_id` ORDER BY m.`id`),
  CASE m.`author` WHEN 'claude' THEN 'agent' WHEN 'note' THEN 'system' ELSE m.`author` END,
  CASE m.`kind` WHEN 'text' THEN CASE m.`author` WHEN 'builder' THEN 'message' ELSE 'agent_message' END
    WHEN 'tool' THEN 'tool_call' WHEN 'notice' THEN 'notice' WHEN 'digest' THEN 'digest' ELSE 'shape_event' END,
  CASE WHEN m.`kind` IN ('text', 'notice', 'digest') THEN json_object('text', m.`body`)
    WHEN m.`kind` = 'tool' THEN json_object('kind', 'other', 'id', m.`id`, 'harnessTool', '10db.plan',
      'status', 'done', 'title', m.`body`, 'startedAt', m.`created_at`, 'durationMs', NULL, 'parentId', NULL,
      'name', '10db.plan', 'inputPreview', substr(m.`body`, 1, 100))
    ELSE json_object('kind', m.`kind`, 'text', m.`body`) END,
  NULL, 0, NULL, '[]',
  CASE WHEN m.`author` = 'builder' AND m.`kind` = 'text' THEN m.`created_at` END,
  NULL, m.`created_at`, m.`created_at`
FROM `shape_messages` m;
--> statement-breakpoint
INSERT INTO `conversation_files` (`id`, `conversation_id`, `item_id`, `name`, `media_type`, `size`, `sha256`,
  `stored_path`, `inline_sent`, `told_at`, `unreadable_told_at`, `created_at`)
SELECT f.`id`, 'cnv_' || substr(f.`shape_id`, instr(f.`shape_id`, '_') + 1), NULL, f.`name`, f.`media_type`,
  f.`size`, NULL, f.`stored_path`, f.`inline_sent`, f.`told_at`, f.`unreadable_told_at`, f.`created_at`
FROM `shape_files` f;
--> statement-breakpoint
INSERT INTO `conversations` (`id`, `project_id`, `owner_kind`, `owner_id`, `profile`, `account_id`, `model`,
  `provider_session_id`, `state`, `context_pct`, `next_seq`, `created_at`, `updated_at`)
SELECT 'cnv_' || substr(t.`id`, instr(t.`id`, '_') + 1), t.`project_id`, 'task', t.`id`, 'lane',
  COALESCE((SELECT x.`account_id` FROM `sessions` x JOIN `workstreams` w ON w.`id` = x.`workstream_id`
            WHERE w.`task_id` = t.`id` ORDER BY x.`started_at` DESC, x.`id` DESC LIMIT 1), p.`account_id`),
  NULL, NULL, NULL, NULL,
  (SELECT COUNT(*) FROM `task_messages` m WHERE m.`task_id` = t.`id`) + 1,
  (SELECT MIN(m.`created_at`) FROM `task_messages` m WHERE m.`task_id` = t.`id`),
  (SELECT MAX(m.`created_at`) FROM `task_messages` m WHERE m.`task_id` = t.`id`)
FROM `tasks` t JOIN `projects` p ON p.`id` = t.`project_id`
WHERE EXISTS (SELECT 1 FROM `task_messages` m WHERE m.`task_id` = t.`id`);
--> statement-breakpoint
INSERT INTO `conversation_items` (`id`, `conversation_id`, `seq`, `author`, `kind`, `body`, `turn_id`, `partial`,
  `pushed_at`, `push_uuids`, `delivered_at`, `handed_back_at`, `created_at`, `updated_at`)
SELECT m.`id`, 'cnv_' || substr(m.`task_id`, instr(m.`task_id`, '_') + 1),
  ROW_NUMBER() OVER (PARTITION BY m.`task_id` ORDER BY m.`id`), m.`author`,
  CASE m.`kind` WHEN 'reply' THEN 'agent_message' ELSE m.`kind` END, json_object('text', m.`body`), m.`turn_id`,
  0, m.`pushed_at`, m.`push_uuids`, m.`delivered_at`, NULL, m.`created_at`, m.`created_at`
FROM `task_messages` m;
--> statement-breakpoint
INSERT INTO `conversation_files` (`id`, `conversation_id`, `item_id`, `name`, `media_type`, `size`, `sha256`,
  `stored_path`, `inline_sent`, `told_at`, `unreadable_told_at`, `created_at`)
SELECT f.`id`, 'cnv_' || substr(f.`task_id`, instr(f.`task_id`, '_') + 1), f.`message_id`, f.`name`, f.`media_type`,
  f.`size`, f.`sha256`, f.`stored_path`, f.`inline_sent`, NULL, NULL, f.`created_at`
FROM `task_files` f;
--> statement-breakpoint
UPDATE `sessions` SET `conversation_id` = 'cnv_' || substr(`shape_id`, instr(`shape_id`, '_') + 1)
WHERE `shape_id` IS NOT NULL;
--> statement-breakpoint
UPDATE `sessions` SET `conversation_id` = (SELECT c.`id` FROM `conversations` c JOIN `workstreams` w
  ON c.`owner_kind` = 'task' AND c.`owner_id` = w.`task_id` WHERE w.`id` = `sessions`.`workstream_id`)
WHERE `workstream_id` IS NOT NULL;
```

- [ ] **Step 4b: Write `transcript-kinds.ts`** with the signatures above, so both tests can pass together.

- [ ] **Step 5: Run them and watch them pass.** Same command. Expected: PASS. A row that disagrees between the SQL
  and `shapeItemOf` or `taskItemOf` is fixed now, before 0067 is committed and frozen. Then
  `pnpm --filter @10db/db exec vitest run` and `make check-changed`.

- [ ] **Step 6: Write the decision record.** `docs/architecture/decisions/<today>-one-conversation-store-keeps-ids-and-orders-by-seq.md`:

```markdown
# One conversation store keeps every message's id and orders by seq

- **Date:** <today>

## Decision

- Plan's transcripts and files (`shape_messages`, `shape_files`) and the tasks' threads (`task_messages`,
  `task_files`) move into `conversations`, `conversation_items` and `conversation_files`, by one forward `--custom`
  migration (0067) between generated ones. The old tables are dropped (0071).
- Every row keeps its id. `ConversationItemId` reads `cvi_`, `shm_` and `tmg_`; `ConversationFileId` reads `cvf_`,
  `sfl_` and `tfl_` (`packages/contracts/src/ids.ts`); only `cvi_` and `cvf_` are minted. A migrated conversation's
  id is `cnv_` and its owner's UUID.
- A transcript's order is `conversation_items.seq`, unique per conversation and numbered in the old id order; never
  the id. Files order by `created_at`, then id.
- Plan's `text` becomes `message` (builder) or `agent_message`; `tool` becomes a finished `other` tool call;
  `notice` and `digest` keep their kinds; `propose`, `rehearse`, `edit`, `event` and `screen` become `shape_event`
  with the old kind in the body. Authors `claude` and `note` become `agent` and `system`. A task's `reply` becomes
  `agent_message`.
- Plan's builder messages are delivered at their own time: Plan's queue lived in memory.
- A session names its conversation (`sessions.conversation_id`); `shape_id` is dropped. A session has a conversation,
  a workstream, or both (a lane of a task with a thread).
- The lane's `idOfUuid('TaskMessage', …)` becomes a lookup of the conversation's items by push uuid or by the row's
  own uuid.

## Why

- Keeping ids keeps `shape_proposals.source_message_ids` and `shape_questions.source_message_ids` (JSON lists), the
  shadow answers, `pass_turns.message_id` and `pass_preview_marks.notice_id` valid with no rewrite. The reviewers
  preferred fresh ids with a `legacy_id` column; that needs every JSON list rewritten in SQL and two ids per row
  forever.
- `seq` because a new `cvi_` id sorts before every `shm_` and `tmg_` id as text, so id order would put new messages
  first.
- Delivered-at for Plan: after any restart Plan's queue was empty, and the explore engine (M4b) reads an undelivered
  builder message as one waiting to be sent.
```

  Add to `packages/db/AGENTS.md` one bullet: "Conversations, migrations 0066 (generated), 0067 (`--custom`,
  never regenerated), 0068–0071 (generated): …" naming the tables, the copy's rules and the decision file.

- [ ] **Step 7: Commit.**

```bash
git add packages/db/drizzle/0067_conversation_copy.sql packages/db/drizzle/meta/0067_snapshot.json packages/db/drizzle/meta/_journal.json packages/db/src/migrations-conversations.test.ts packages/db/src/store/transcript-kinds.ts packages/db/src/store/transcript-kinds.test.ts packages/db/src/store/index.ts packages/db/AGENTS.md docs/architecture/decisions/<today>-one-conversation-store-keeps-ids-and-orders-by-seq.md && git commit -m 'feat(db): copy Plan transcripts and task threads into conversations, keeping ids' -m 'Value: protects=every Plan and thread row reaches its own conversation with its id, delivery fields and order, the SQL and the code map each kind alike, and every reference still resolves; fails_when=the copy drops, reorders, renumbers or mixes rows across owners, or a reference dangles; why_new=no test migrated a transcript; no_claim=the services do not read the new tables yet'
```

---

### Task 4: The generic conversation repositories

**Files:**
- Create: `packages/db/src/store/conversations.ts`, `conversation-items.ts`, `conversation-files.ts`
- Modify: `packages/db/src/store/index.ts`
- Test: `packages/db/src/store/conversation-items.test.ts`

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces (synchronous, over `DbReader` / `WriteContext`; none appends an event, as the old marks didn't):

```ts
export type ConversationRow = typeof schema.conversations.$inferSelect;
export interface ConversationOwner { readonly kind: ConversationOwnerKind; readonly id: string }
export function insertConversation(ctx: WriteContext, input: { projectId: ProjectId; owner: ConversationOwner;
  profile: ConversationProfile; state: ConversationState | null; accountId?: AccountId }): ConversationRow; // account defaults to the project's
export function getConversation(db: DbReader, id: ConversationId): ConversationRow;              // NotFoundError
export function conversationOf(db: DbReader, owner: ConversationOwner): ConversationRow | null;
export function patchConversation(ctx: WriteContext, id: ConversationId,
  patch: Partial<Pick<ConversationRow, 'model' | 'providerSessionId' | 'state' | 'contextPct' | 'accountId'>>): ConversationRow;

export type ConversationItemRow = typeof schema.conversationItems.$inferSelect;
export type ConversationFileRow = typeof schema.conversationFiles.$inferSelect;
/** A message-like item (message, agent_message, notice, digest) with its text and files. */
export interface ConversationMessageRow extends Omit<ConversationItemRow, 'body'> {
  readonly body: string; readonly files: readonly ConversationFileRow[];
}
export function insertItem(ctx: WriteContext, conversationId: ConversationId, input: { author; kind; body: Json;
  partial?: boolean; deliveredAt?: string | null; turnId?: PassTurnId | null }): ConversationItemRow;
  // mints the id; seq = next_seq, then next_seq + 1, in the caller's write; body checked with parseItemBody.
  // M4b adds a caller-given id, which its engine needs.
export function listItems(db: DbReader, conversationId: ConversationId, opts?: { afterSeq?: number; limit?: number }): ConversationItemRow[];
export function lastItems(db: DbReader, conversationId: ConversationId, count: number): ConversationItemRow[]; // oldest first
export function getItem(db: DbReader, id: ConversationItemId): ConversationItemRow;
export function deleteItem(ctx: WriteContext, id: ConversationItemId): void;                  // with its files' rows
export function getMessageRow(db: DbReader, id: ConversationItemId): ConversationMessageRow;
export function listMessageRows(db: DbReader, conversationId: ConversationId): ConversationMessageRow[];
export function listUntakenMessageIds(db: DbReader, conversationId: ConversationId): ConversationItemId[]; // builder messages not delivered, by seq
export function listUndeliveredMessages(db: DbReader, conversationId: ConversationId): ConversationMessageRow[]; // pushed, not delivered
export function findItemByPushUuid(db: DbReader, conversationId: ConversationId, uuid: string): ConversationItemId | null;
export function markItemPushedUnder(ctx: WriteContext, id: ConversationItemId, uuid: string): void;
export function markItemsDelivered(ctx: WriteContext, conversationId: ConversationId, ids: readonly ConversationItemId[]): ConversationItemId[];
export function markItemsHandedBack(ctx: WriteContext, conversationId: ConversationId, ids: readonly ConversationItemId[]): ConversationItemId[]; // clears pushed_at, sets handed_back_at
export function markItemsTakenUnder(ctx: WriteContext, conversationId: ConversationId, held: readonly string[]): ConversationItemId[];

export function insertFiles(ctx: WriteContext, conversationId: ConversationId, itemId: ConversationItemId | null,
  files: readonly NewConversationFile[]): ConversationFileRow[];
export function listFiles(db: DbReader, conversationId: ConversationId): ConversationFileRow[]; // created_at, id
export function getFile(db: DbReader, id: ConversationFileId): ConversationFileRow;
export function markFilesInline(ctx: WriteContext, conversationId: ConversationId, ids: readonly ConversationFileId[], fresh: boolean): void;
export function markFilesTold(ctx: WriteContext, ids: readonly ConversationFileId[]): void;
export function markFilesUnreadableTold(ctx: WriteContext, ids: readonly ConversationFileId[]): void;
export function listUntoldFiles(db: DbReader, conversationId: ConversationId): ConversationFileRow[];
```

  Each mark keeps the semantics of its `task-thread.ts` or `shape-state.ts` original (`task-thread.ts:246-389`,
  `shape-state.ts:268-319`), keyed by conversation instead of task or shape. `findItemByPushUuid` matches an item of
  the conversation whose `push_uuids` holds `uuid` (`json_each`) or whose own UUID (the id after `_`) is `uuid`.

- [ ] **Step 1: Write the failing tests.** On `createTestStore`, a conversation owned by a seeded shape:
  - `insertItem` three times → `seq` 1, 2, 3 and `next_seq` 4; an item written by SQL with the id `shm_<uuidv7 of
    an earlier time>` at `seq` 1 (as the copy leaves it, `next_seq` 2) lists before one `insertItem` then writes at
    `seq` 2 (`listItems`).
  - `listItems(…, { afterSeq: 1, limit: 1 })` answers only `seq` 2.
  - `findItemByPushUuid` table: a `push_uuids` hit → its id; a legacy `tmg_` item with empty `push_uuids` and its own
    uuid → its id (Review Focus 4); a uuid of another conversation's item → null; `'not-a-uuid'` → null.
  - `markItemsHandedBack` clears `pushed_at`, sets `handed_back_at`, keeps `push_uuids`, and leaves a delivered item.
  - `insertItem` with `kind: 'tool_call'` and a body that is not a `ToolCallView` throws `InvalidError`.

- [ ] **Step 2: Run them and watch them fail.** `pnpm --filter @10db/db exec vitest run src/store/conversation-items.test.ts`.
  Expected: FAIL, the module does not exist.

- [ ] **Step 3: Implement** the three files with the signatures above.

- [ ] **Step 4: Run them and watch them pass.** Same command, then `make check-changed`. Expected: PASS.

- [ ] **Step 5: Commit** (`feat(db): conversation repositories: items numbered by seq, push-uuid lookup, delivery marks`),
  naming the four files and `store/index.ts`, with the value card:
  `Value: protects=items list by seq whatever their id prefix, and a uuid finds its message by push or by its own id; fails_when=listing or lookup goes by id text or skips a legacy row; why_new=task-thread.test.ts covers the task tables only; no_claim=no owner reads through these yet`.

---

### Task 5: A shape owns a conversation; sessions name their conversation

**Files:**
- Modify: `packages/db/src/schema.ts` (`shapes` `:1227-1250` drops `sdkSessionId`, `model`; `sessions` drops `shapeId`,
  its index, and `sessions_one_owner`, gains `check('sessions_has_owner', …)` **(call 9)**)
- Create: `packages/db/drizzle/0068_session_conversation.sql` (generated)
- Modify: `packages/db/src/store/shapes.ts` (`insertShape :35-62`, `getShape :64-68`, `shapeTokens :76-86`,
  `listShapes :89-96`), `shape-state.ts` (`patchShape :47-61`, `getShapeSdkSessionId :64-73`), `sessions.ts`
  (`SessionOwner :30-32`, `projectOwner :51-73`, `insertSession :75-115`), `usage.ts:41-55`
- Modify: `apps/daemon/src/shape/service.ts:1056-1065` (the session row) and its explore spec (M2b moved it to
  `open`), `apps/daemon/src/mcp/server.ts:98-104`, `apps/daemon/src/knowledge/provenance.ts:79-91`
- Modify: `apps/daemon/src/sessions/types.ts` (`AgentSessionCore` gains `conversationId`, call 16), the runner's
  lane spec (`runner/runner.ts`, M2b's `open` call: `conversationId: null` until Task 7)
- Modify: `packages/db/src/database.test.ts:539-626` (pin the Shape-sessions migration test to its migration)
- Modify: `apps/daemon/src/mcp/shape-tools.test.ts:42,82,104` (`insertSession({ shapeId })` becomes
  `{ conversationId: shapeConversation(…).id }`; the handler's `session.shapeId` becomes `sessionShapeId(db, session)`)
- Test: `packages/db/src/store/shape-data.test.ts:90-123`, `:340-426`; `migrations-conversations.test.ts`;
  `apps/daemon/src/shape/service.test.ts` (one new `it`)

**Interfaces:**
- Consumes: Task 4's `insertConversation`, `conversationOf`, `patchConversation`.
- Produces:
  - `insertShape` writes the shape and its conversation (owner `shape`, profile `explore`, state `idle_cold`, the
    project's account) in one write; `ShapeDto.model` and `getShapeSdkSessionId` read the conversation;
    `patchShape(ctx, id, { sdkSessionId, model, … })` keeps its signature and writes those two to the conversation.
  - `shapeConversation(db: DbReader, id: ShapeId): ConversationRow` (NotFoundError for a shape without one).
  - `type SessionOwner = { readonly workstreamId: WorkstreamId; readonly conversationId?: undefined } |
    { readonly conversationId: ConversationId; readonly workstreamId?: undefined }`; a lane session's
    `conversation_id` stays null in this task (Task 7 sets it). `sequence` counts the owner's sessions.
  - `sessionShapeId(db: DbReader, row: SessionRow): ShapeId | null`: the shape whose conversation the session runs,
    for `mcp/server.ts` and `provenance.ts`.
  - `accountUsage` joins `conversations` on `sessions.conversation_id` and resolves the project as
    `coalesce(workstreams.project_id, conversations.project_id)`.
  - `AgentSessionCore.conversationId: ConversationId | null` **(call 16)**. Plan passes its shape's conversation;
    the fake records it with the spec.

- [ ] **Step 1: Write the failing tests.**
  - `shape/service.test.ts`: the explore spec of a Plan conversation's first session names its conversation:
    `f.adapter.shapeSessions[0].spec.conversationId` equals `shapeConversation(db, shape.id).id`.
  - `shape-data.test.ts` "a Shape session": insert through `{ conversationId: shapeConversation(db, shape.id).id }`;
    `getSession` matches `{ conversationId, workstreamId: null, accountId: project.accountId, sequence: 1 }`.
  - The CHECK table becomes: `neither a workstream nor a conversation` → refused; `both` → accepted.
  - Usage across the three owners (Review Focus 3): a lane session (workstream only), a Shape session (conversation
    only) and a lane session whose row names both its workstream and its task's conversation (seeded by SQL), with
    100, 40 and 7 input tokens → one project row with `tokensIn: 147`.
  - A new shape has a conversation with `model: null`; `patchShape(…, { model: 'claude-opus-5-5', sdkSessionId:
    'sdk-9' })` → `getShape(…).model` and `getShapeSdkSessionId` answer them and the conversation row holds them.
  - The column table at `:90-123`: `shapes` without `sdk_session_id`; add `['conversations', [...]]`.
  - `migrations-conversations.test.ts`: `PRAGMA table_info(sessions)` has no `shape_id`; both Shape sessions keep
    `conversation_id`; `shapes` has no `sdk_session_id` or `model`.

- [ ] **Step 2: Run them and watch them fail.**
  `pnpm --filter @10db/db exec vitest run src/store/shape-data.test.ts src/migrations-conversations.test.ts`.
  Expected: FAIL on the session owner and on `shape_id` still present.

- [ ] **Step 3: Change the schema and generate.** `pnpm --filter @10db/db generate --name session_conversation`. Read
  the SQL: a `__new_sessions` rebuild that copies `conversation_id` (added in 0066) and no `shape_id`, under the new
  CHECK; `shapes` loses two columns. Then the repositories and the three daemon call sites. In
  `database.test.ts:539-626`, migrate through `0028_session_owner` instead of to the head, since that test checks
  0028's CHECK and `shape_id`; say so in the commit body.

- [ ] **Step 4: Run them and watch them pass.** Same command, then `pnpm --filter @10db/db exec vitest run`,
  `pnpm --filter @10db/daemon exec vitest run src/shape src/mcp src/knowledge` and `make check-changed`.

- [ ] **Step 5: Commit** (`feat(db): a shape owns a conversation and sessions name their conversation`), naming the
  schema, migration and snapshot files, the five store files, the daemon files and the test files above, with
  the value card: `Value: protects=a Plan session belongs to its conversation and per-project usage counts every owner once; fails_when=a session with both owners is counted twice or a Shape session is not counted; why_new=the usage test had two owners, not a lane that names its task's conversation; no_claim=Plan's transcript still lives in shape_messages`.

---

### Task 6: Plan's transcript and files on the conversation tables

**Files:**
- Modify: `packages/db/src/store/shape-state.ts` (`:77-153` transcript, `:220-323` files), `shape-shadow.ts`
- Modify: `packages/db/src/schema.ts` (`shapeShadowAnswers.messageId` → `conversationItems.id`, `:1594-1615`)
- Create: `packages/db/drizzle/0069_shadow_answer_items.sql` (generated)
- Modify: `apps/daemon/src/shape/service.ts:1015-1024` (the never-spoke start lists the builder messages before the
  turn's by position in the `seq`-ordered transcript, not `m.id < turn.messageId`)
- Modify: `packages/contracts/src/ids.ts` (drop the `ShapeMessage` and `ShapeFile` kinds; `ShapeMessageId` and
  `ShapeFileId` become aliases of `ConversationItemId` and `ConversationFileId` **(call 10)**)
- Modify: the 16 `mintId('ShapeMessage')` and `mintId('ShapeFile')` call sites outside `shape-state.ts`, each to the
  conversation kind (an id-kind rename and nothing else): `apps/desktop/src/test/shape-fixtures.ts:36,55`,
  `apps/desktop/src/views/shape/shape-drawer.test.tsx:341`,
  `apps/desktop/src/views/shape/shape-editing.test.tsx:338,393,432,872`, `apps/daemon/src/shape/service.test.ts:412`,
  `apps/daemon/src/shape/validate.test.ts:7,191`, `apps/daemon/src/api/app.test.ts:1471,1658,1891`,
  `packages/contracts/src/shape-view.test.ts:19,143`, `packages/contracts/src/shape.test.ts:16`
- Test: `packages/db/src/store/shape-files.test.ts`, `shape-data.test.ts`; `apps/daemon/src/shape/resume.test.ts`
  (one new `it`)

**Interfaces:**
- Consumes: Task 3's `shapeItemOf`, `shapeMessageOf`, `planLinePreview`; Task 4's items and files; Task 5's
  `shapeConversation`.
- Produces: unchanged signatures: `insertShapeMessage`, `listShapeMessages(db, shapeId, after?)` (after = items with
  a greater `seq` than `after`'s), `lastShapeMessages`, `insertShapeFile`, `getShapeFile`, `listShapeFiles`,
  `listUntoldShapeFiles`, `markShapeFilesTold`, `markShapeFilesUnreadableTold`, `markShapeFilesInline`,
  `countShapeFiles`, `insertShadowAnswer`. A builder `text` is written delivered at `ctx.now` **(call 3)**; a `tool`
  line through `shapeItemOf(m, randomUUID())` (call 4). `listShapeMessages` leaves out an item `shapeMessageOf`
  answers null for.

- [ ] **Step 1: Write the failing tests.**
  - `shape-data.test.ts`: a transcript with a row inserted as `shm_…` at `seq` 1 (SQL, as the copy leaves it), then
    `insertShapeMessage` twice → `listShapeMessages` answers the `shm_` row first and the two new ones after, the
    first new at `seq` 2 (Review Focus 1 and 2); `listShapeMessages(db, shape, shmId)` answers the two new rows.
  - `shape-data.test.ts`: a tool line of 150 emoji round-trips through `insertShapeMessage` and `listShapeMessages`
    (call 4).
  - `shape-files.test.ts`: a file inserted after a migrated `sfl_` file lists after it.
  - `insertShadowAnswer` on a `cvi_` message id succeeds with `foreign_keys = ON`.
  - `resume.test.ts` (Review Focus 2): a conversation whose agent never spoke holds a migrated builder message (an
    `shm_` row at `seq` 1); the builder sends a new one; the session that starts is told both, the `shm_` one first
    (read from the fake's explore spec `prompt`).

- [ ] **Step 2: Run them and watch them fail.**
  `pnpm --filter @10db/db exec vitest run src/store/shape-data.test.ts src/store/shape-files.test.ts` and
  `pnpm --filter @10db/daemon exec vitest run src/shape/resume.test.ts`.
  Expected: FAIL, the `shm_` row is not listed (the store still reads `shape_messages`), the shadow answer violates
  its foreign key, and the start's prompt leaves out the migrated message (`'shm_…' < 'cvi_…'` is false).

- [ ] **Step 3: Implement.** Retarget the shadow-answer reference, `pnpm --filter @10db/db generate --name shadow_answer_items`
  (a rebuild of `shape_shadow_answers` only); rewrite the Plan functions as adapters; fix `service.ts:1022`; alias
  the ids and rename the call sites above; run `pnpm --filter @10db/contracts generate` (the `ShapeMessageDto` id
  pattern widens) and commit `generated/`.

- [ ] **Step 4: Run them and watch them pass.** Same commands, then `pnpm --filter @10db/db exec vitest run`,
  `pnpm --filter @10db/daemon exec vitest run src/shape src/screens src/api`,
  `pnpm --filter @10db/desktop exec vitest run src/views/shape`, `pnpm --filter @10db/contracts exec vitest run` and
  `make check-changed`. `shape/confinement.test.ts` must pass unmodified.

- [ ] **Step 5: Commit** (`feat(db): Plan's transcript and files read and write the conversation tables`), naming
  every changed file, with the value card: `Value: protects=Plan's transcript lists in seq order across migrated and new ids, and a fresh session is told the migrated messages; fails_when=the list or the start orders by id text; why_new=no test held a transcript that mixes prefixes; no_claim=the engine does not run Plan yet`.

---

### Task 7: Task threads on the conversation tables

**Files:**
- Modify: `packages/db/src/store/task-thread.ts` (every function, `:25-453`), `pass-turns.ts:116-125`,
  `pass-previews.ts:166-170`, `sessions.ts` (a lane session takes its task's conversation)
- Modify: `packages/db/src/schema.ts` (`passTurns.messageId` and `passPreviewMarks.noticeId` → `conversationItems.id`)
- Create: `packages/db/drizzle/0070_pass_turn_items.sql` (generated)
- Modify: `packages/contracts/src/ids.ts` (drop `TaskMessage`, `TaskFile`; `TaskMessageId` and `TaskFileId` become
  aliases **(call 10)**)
- Modify: `apps/daemon/src/runner/lane-messages.ts:186-191` (`idOfUuid` → `findTaskMessageByUuid`), and the
  runner's lane spec: `conversationId` is the session row's (call 16)
- Modify: `apps/daemon/src/thread/session-text.ts:62-69` (`buildThreadDigest` takes the rows before
  `window.before` by position in the `seq`-ordered thread, not `m.id < window.before`)
- Create: `apps/daemon/src/runner/lane-conversation.test.ts`
- Modify, id-kind renames only (`mintId('TaskMessage' | 'TaskFile')` → the conversation kinds):
  `apps/desktop/src/test/pass-fixtures.ts:401,421`, `apps/daemon/src/runner/thread-pictures.test.ts:38,40`,
  `runner/lane-messages.test.ts:142,233`, `runner/next-action.test.ts:15,16`,
  `sessions/claude-adapter.live.test.ts:142-144,183-184,225-226`, `thread/thread.test.ts:260`,
  `packages/db/src/store/pass-turns.test.ts:213`, `task-thread.test.ts:111,164`
- Modify, the table a raw-SQL line names: `apps/daemon/src/thread/thread.test.ts:217` (the "disk full" trigger is
  `BEFORE INSERT ON conversation_items`, so it still refuses the message's write); `thread/session-text.test.ts:54-62`
  (the `reply` helper writes through `insertItem` on the task's conversation, author `agent`, kind
  `agent_message`, since `task_messages` is gone) and `:79` (the expected id prefix is `cvi_`)
- Test: `packages/db/src/store/task-thread.test.ts`, `migrations-conversations.test.ts`,
  `apps/daemon/src/thread/session-text.test.ts` (one new `it`)

**Interfaces:**
- Consumes: Task 4; Task 3's `taskItemOf` / `taskMessageOf`.
- Produces:
  - `TaskMessageRow` keeps its fields (`id, taskId, author, kind, body, createdAt, pushedAt, deliveredAt, pushUuids,
    turnId, files`) and `TaskFileRow` its (`id, taskId, messageId, name, mediaType, size, sha256, storedPath,
    inlineSent, createdAt`); every exported function of `task-thread.ts` keeps its name and signature. A task's
    conversation is made, owner `task`, profile `lane`, state null, by its first item (`taskConversation(ctx,
    taskId)`, insert-or-get).
  - `taskConversationOf(db: DbReader, taskId: TaskId): ConversationRow | null`.
  - `findTaskMessageByUuid(db: DbReader, taskId: TaskId, uuid: string): TaskMessageId | null`.
  - `insertSession({ workstreamId })` sets `conversation_id` to the task's conversation when it has one.

- [ ] **Step 1: Write the failing tests** in `task-thread.test.ts`:
  - A thread with a `tmg_` row at `seq` 1 (SQL), then `insertBuilderMessage`, `insertSystemNotice`,
    `insertAgentReply` → `listTaskThread` answers them in that order after the `tmg_` row.
  - `findTaskMessageByUuid`: the row's own uuid of a `tmg_` message with empty `push_uuids` → it; a uuid in another
    message's `push_uuids` → that one; another task's uuid → null (Review Focus 4).
  - A message taken back by `deleteUnsentBuilderMessage`, then a new one: the new one's `seq` is 3 and it lists last;
    its picture lists after the one kept before (Review Focus 5).
  - A message of `TASK_MESSAGE_MAX_CHARS` characters round-trips.
  - A lane session inserted for a task with a thread names the thread's conversation; one for a task with none
    names none.
  - `lane-conversation.test.ts` (`createTestEngine`, one case each, since only the runner builds a lane spec): a
    task given a builder message before its run starts opens its lane with `conversationId` set to the thread's
    conversation; a task with no message opens with `null`.
  - `migrations-conversations.test.ts`: `pass_turns.message_id` and `pass_preview_marks.notice_id` are declared to
    reference `conversation_items` (`PRAGMA foreign_key_list`).
  - `session-text.test.ts` (Review Focus 2): a thread holding a migrated `tmg_` builder message at `seq` 1, then a new
    message → `buildThreadDigest(…, { before: <the new one> })` names the `tmg_` message.

- [ ] **Step 2: Run them and watch them fail.**
  `pnpm --filter @10db/db exec vitest run src/store/task-thread.test.ts src/migrations-conversations.test.ts` and
  `pnpm --filter @10db/daemon exec vitest run src/runner/lane-conversation.test.ts src/thread/session-text.test.ts`.
  Expected: FAIL, the `tmg_` row is missing from the thread, the lane opens with `conversationId: null`, and the
  digest leaves the `tmg_` message out (`'tmg_…' < 'cvi_…'` is false).

- [ ] **Step 3: Implement.** Retarget the two references, `pnpm --filter @10db/db generate --name pass_turn_items`
  (rebuilds of `pass_turns` and `pass_preview_marks`; read it); rewrite `task-thread.ts` over Task 4's functions;
  `insertPassTurn` stamps the item's `turn_id` within the task's conversation; `lane-messages.ts` resolves an unknown
  uuid with `findTaskMessageByUuid(state.db, taskId, uuid)`; fix `session-text.ts:64`. Alias the ids, make the
  renames and table changes listed above, and regenerate the contracts' schemas.

- [ ] **Step 4: Run them and watch them pass.** Same commands, then `pnpm --filter @10db/db exec vitest run`,
  `pnpm --filter @10db/daemon exec vitest run src/runner src/thread src/pass test/crash-recovery.test.ts`,
  `pnpm --filter @10db/desktop exec vitest run src/views/workbench`, the id-order grep from Global Constraints (no
  output), and `make check-changed`. `pass-lane.test.ts`, `read-back.test.ts` and `crash-recovery.test.ts` pass
  unmodified; `lane-messages.test.ts`, `thread.test.ts` and `session-text.test.ts` pass with only the changes listed
  in Files.

- [ ] **Step 5: Commit** (`feat(db): task threads read and write the conversation tables`), naming every changed
  file, with the value card: `Value: protects=a thread lists in seq order across migrated and new ids, a consumed uuid finds its message without the old id kind, and a lane session names its task's conversation; fails_when=the lookup needs a tmg_ id or a taken-back message reorders the thread; why_new=task-thread.test.ts never held a migrated row; no_claim=the runner still owns delivery`.

---

### Task 8: Drop the old transcript tables

**Files:**
- Modify: `packages/db/src/schema.ts` (remove `shapeMessages`, `shapeFiles`, `taskMessages`, `taskFiles`)
- Create: `packages/db/drizzle/0071_drop_old_transcripts.sql` (generated)
- Modify: `packages/db/src/database.test.ts:930-982` (migrate through `0044_shape_files_inline_sent_backfill`, the
  migration it tests, since `shape_files` is gone at the head)
- Modify: `packages/db/AGENTS.md` (the conversation bullet: the drop; mark the Shape and Task-thread bullets'
  tables as moved)
- Test: `migrations-conversations.test.ts`

- [ ] **Step 1: Write the failing test.** `sqlite_master` holds none of the four tables, and
  `PRAGMA foreign_key_check` is empty after migrating to the head.
- [ ] **Step 2: Run it and watch it fail.** `pnpm --filter @10db/db exec vitest run src/migrations-conversations.test.ts`.
  Expected: FAIL, `shape_messages` is still there.
- [ ] **Step 3: Remove the tables and generate.** `pnpm --filter @10db/db generate --name drop_old_transcripts`;
  read it: four `DROP TABLE`s and nothing else.
- [ ] **Step 4: Run it and watch it pass.** `pnpm --filter @10db/db exec vitest run`, then
  `pnpm --filter @10db/daemon exec vitest run` and `make check-changed`.
- [ ] **Step 5: Commit** (`feat(db): drop the transcript tables the conversations replaced`), with the value card:
  `Value: protects=the head schema has one transcript store and no dangling reference; fails_when=a reference still names a dropped table; why_new=the copy test stopped short of the drop; no_claim=none`.

---

### Task 9: The `conversation/` module and the picture code it needs

A move with no behaviour change; the moved tests are the check, and no test is added.

**Files:**
- Create: `apps/daemon/src/conversation/index.ts`
- Move (with `git mv`, and their tests): `screens/picture-limits.ts`, `screens/inline-budget.ts`,
  `screens/image-check.ts`, `screens/file-check.ts` **(call 11)** → `conversation/`;
  `runner/thread-pictures.ts` → `conversation/block-pictures.ts` (`threadInlineBytes` becomes `heldInlineBytes`,
  over `ConversationFileRow`-shaped files); `thread/pictures.ts`'s `checkPicture`, `keepPicture`, `CheckedPicture`,
  `KeptPicture` → `conversation/pictures.ts` (`taskFilesDir` stays in `thread/`)
- Split: `shape/dropped-files.ts:48-139` (`FileSize`, `inlineImageIds`, `PathReason`, `pathReasonText`,
  `imageVerdicts`, `pathImageReasons`) → `conversation/picture-budget.ts`
- Modify: the importers (`screens/index.ts`, `screens/screens.ts`, `shape/*`, `runner/*`, `thread/*`,
  `daemon/start.ts`) to import from `../conversation`
- Modify: `apps/daemon/AGENTS.md:58-59` (module order) and a `conversation/` bullet

**Interfaces:**
- Produces: `conversation/index.ts` exports what the moved files exported, under the same names but
  `heldInlineBytes`. The order line becomes `… delivery, accounts → conversation → pass → pictures → mcp → screens
  → thread, shape → runner …` **(call 14)**. Nothing in `conversation/` imports `pass`, `pictures`, `mcp`,
  `screens`, `thread`, `shape` or `runner`.

- [ ] **Step 1: Move and re-point.** Then check the direction:
  `grep -rn "from '\.\./\(pass\|pictures\|mcp\|screens\|thread\|shape\|runner\)'" apps/daemon/src/conversation`.
  Expected: no output.
- [ ] **Step 2: Run the moved and dependent tests.**
  `pnpm --filter @10db/daemon exec vitest run src/conversation src/screens src/shape src/runner src/thread` and
  `make check-changed`. Expected: PASS with the same test count as before the move.
- [ ] **Step 3: Commit** (`refactor(daemon): a conversation module holds the picture limits, budget and checks`).

---

### Task 10: The delivery library

**Files:**
- Create: `apps/daemon/src/conversation/delivery-rules.ts`, `delivery-rules.test.ts`, `delivery.ts`,
  `delivery.test.ts`
- Modify: `apps/daemon/src/runner/lane-messages.ts` (keeps `untakenMessages`, `OutgoingMessage`, `LaneMessages`,
  `LaneMessagesDeps`, `createLaneMessages`; their bodies call the library), `apps/daemon/src/thread/session-text.ts`
  (`builderMessageText` takes a `DeliverableMessage`)

**Interfaces:**
- Consumes: Task 4's item and file functions; Task 9's `blockPictures`, `heldInlineBytes`, `PictureLimits`;
  `SessionHandle`, `ShapeImage` (`sessions`).
- Produces:

```ts
export interface DeliverableFile { readonly id: ConversationFileId; readonly name: string; readonly mediaType: string;
  readonly size: number; readonly storedPath: string; readonly inlineSent: boolean }
export interface DeliverableMessage { readonly id: ConversationItemId; readonly body: string;
  readonly pushedAt: string | null; readonly pushUuids: readonly string[]; readonly files: readonly DeliverableFile[] }
export type MessageText = (message: DeliverableMessage, asBlocks: ReadonlySet<ConversationFileId>) => string;
// delivery-rules.ts, pure:
export function clientUuid(message: Pick<DeliverableMessage, 'id' | 'pushedAt' | 'pushUuids'>, fresh: () => string): string; // rule 2
export function pushedAgainAfter<M extends { readonly id: ConversationItemId }>(undelivered: readonly M[],
  stillQueued: ReadonlySet<ConversationItemId> | null): M[];                                                         // rule 4
export function outgoingMessage(message: DeliverableMessage, spent: number, limits: PictureLimits,
  readsPictureFiles: boolean, text: MessageText, fresh: () => string): OutgoingMessage;
// delivery.ts:
export interface Delivery { push(message: DeliverableMessage, lead?: string | null): void; pushUntaken(lead?: string | null): void;
  consumed(uuids: readonly string[]): ConversationItemId[]; interrupt(): Promise<void>; untaken(): ConversationItemId[];
  handBack(uuids: readonly string[]): ConversationItemId[] }
export interface DeliveryDeps { readonly state: StateStore; readonly conversation: () => ConversationId | null;
  readonly handle: Pick<SessionHandle, 'send' | 'interrupt'>; readonly limits: PictureLimits;
  readonly prompt?: { readonly uuid: string; readonly messageId: ConversationItemId };
  readonly readsPictureFiles?: boolean; readonly messageText: MessageText }
export function createDelivery(deps: DeliveryDeps): Delivery;
```

  `createDelivery` is `createLaneMessages` (`lane-messages.ts:180-239`) over a conversation, resolved per call
  **(call 12)**: with none, `pushUntaken`, `untaken` and `interrupt`'s re-push do nothing. The uuid is kept before
  the handle sees it (rule 2, `:196-201`). `fresh` is `randomUUID` in production.

- [ ] **Step 1: Write the failing tests.**
  - `delivery-rules.test.ts`, one row per case of rules 2 and 4: never pushed (`pushedAt` null, no uuids) → the
    row's own uuid, for a `cvi_` and a `tmg_` id; pushed once → `fresh()`; handed back (`pushedAt` null, one uuid) →
    `fresh()`; `pushedAgainAfter` with a null receipt → every undelivered; with a receipt naming one → the others.
  - `delivery.test.ts` (real SQLite, the fake handle's `send` and `interrupt` recorded): over a **shape's**
    conversation, so the library is shown owner-free: a push records `push_uuids` before `send` is called (rule 1's
    order); `consumed([uuid])` marks it delivered (rule 3); `handBack` clears `pushed_at`; `interrupt()` with a
    receipt naming one of two pushed messages pushes the other again under a fresh uuid (rule 4); with no
    conversation yet, `pushUntaken()` sends nothing.
- [ ] **Step 2: Run them and watch them fail.**
  `pnpm --filter @10db/daemon exec vitest run src/conversation/delivery-rules.test.ts src/conversation/delivery.test.ts`.
  Expected: FAIL, the modules do not exist.
- [ ] **Step 3: Implement**, then make `createLaneMessages` build a `createDelivery` with
  `conversation: () => taskConversationOf(state.db, taskId)?.id ?? null` and `messageText: builderMessageText`.
- [ ] **Step 4: Run them and watch them pass.** Same command, then
  `pnpm --filter @10db/daemon exec vitest run src/runner src/thread test/crash-recovery.test.ts` and
  `make check-changed`. `pass-lane.test.ts` passes unmodified, and `lane-messages.test.ts` unchanged since Task 7.
- [ ] **Step 5: Commit** (`feat(daemon): delivery rules as a conversation library the lanes call`), with the value
  card: `Value: protects=a builder message is pushed under its row's uuid first, delivered on consumed, and pushed again after a lossy interrupt, for any conversation owner; fails_when=the library reads a task id or pushes before its uuid is kept; why_new=lane-messages.test.ts reaches the rules only through a task; no_claim=the explore engine does not use it yet`.

---

### Task 11: The message intake

A refactor under `thread.test.ts`'s HTTP coverage, unchanged since Task 7 (its "disk full" trigger now on
`conversation_items`, so it still proves the pictures go when the write fails); no test is added.

**Files:**
- Create: `apps/daemon/src/conversation/intake.ts`
- Modify: `apps/daemon/src/thread/service.ts:40-195` (`PastedFile` moves; `postTaskMessage` calls the intake)

**Interfaces:**
- Consumes: Task 9's `checkPicture`, `keepPicture`; `StoredPicture` (`@10db/db`).
- Produces:

```ts
export interface PastedFile { readonly name: string; readonly bytes: Uint8Array }
export interface MessageLimits { readonly maxChars: number; readonly maxPictures: number; readonly maxPicturesBytes: number }
/** Validates, keeps the pictures under `filesDir`, then runs `write`; removes what it kept if `write` throws. */
export function keepBuilderMessage<M>(input: { readonly text: string; readonly pictures: readonly PastedFile[] },
  opts: { readonly limits: MessageLimits; readonly filesDir: string;
          readonly write: (body: string, files: readonly StoredPicture[]) => M }): M;
export function removeKeptFiles(paths: readonly string[]): void;
```

  The refusals keep `thread/service.ts:123-136`'s words, with the limits passed in (the thread passes the
  `TASK_MESSAGE_*` constants) **(call 13)**.

- [ ] **Step 1: Move the code** and make `postTaskMessage` call `keepBuilderMessage`, keeping `refusedByPass` and the
  Ready-turn mark inside its `write`, and its `ConflictError` take-back calling `removeKeptFiles`.
- [ ] **Step 2: Run the coverage.** `pnpm --filter @10db/daemon exec vitest run src/thread test/workbench-api.test.ts`
  and `make check-changed`. Expected: PASS, with no test file changed in this task.
- [ ] **Step 3: Commit** (`refactor(daemon): the builder-message intake is a conversation library`).

---

### Task 12: Run it, review it, open the pull request

- [ ] **Step 1: Make a 0065 data directory on `main`, for free.** In the main checkout, on `main`, run
  `pnpm --filter @10db/desktop e2e`. Its fake agent (`TENDB_FAKE_SCRIPTS`, `apps/desktop/e2e/script-book.json`)
  leaves Plan conversations (`shape.spec.ts`) and a pass with page threads (`workbench.spec.ts`) in the folder it
  prints as `e2e data: <path>`, and the next e2e run deletes it. Copy it before anything else runs:
  `cp -R <path> /tmp/m4a-data`.
- [ ] **Step 2: Upgrade it.** In the worktree, with the same fake so no turn costs money:
  `TENDB_DATA_DIR=/tmp/m4a-data TENDB_FAKE_SCRIPTS="$PWD/apps/desktop/e2e/script-book.json" pnpm dev`. The daemon
  starts (no `MigrationIntegrityError`). In the window: each Plan conversation shows every message in order, its
  picture and its proposals' Why? links; a pass page's thread shows its messages and notices. Send one Plan message
  and one thread message: each lists last. Quit and start again: the same.
- [ ] **Step 3: Migrate a copy of the builder's own database, and count.** `migrateDatabase` commits before it runs
  `foreign_key_check` (`database.ts:118-123`), so a bad copy would already be written by the time it throws; this
  step catches what the seeded test can't, on real data. The original is never opened for writing: take an online
  copy with `sqlite3 "$HOME/Library/Application Support/10db/10db.sqlite" ".backup '/tmp/m4a-real.sqlite'"`, then,
  in the worktree, run a throwaway script (not committed) with `pnpm --filter @10db/daemon exec tsx` that opens
  `/tmp/m4a-real.sqlite` and reads, before `migrateDatabase(db)` and after it:
  - before: `count(*)` of `shape_messages`, `task_messages`, `shape_files`, `task_files`, `shapes`, the tasks with a
    message, and `sessions`;
  - after: `count(*)` of `conversation_items` (equal to the two message counts), `conversation_files` (the two file
    counts), `conversations` (shapes plus tasks with a message), `sessions` (unchanged), the sessions with
    `conversation_id` null and no workstream (zero), and `PRAGMA foreign_key_check` (empty).

  Any difference stops the PR. Delete `/tmp/m4a-real.sqlite` afterwards.
- [ ] **Step 4: e2e.** `pnpm --filter @10db/desktop e2e`. `shape.spec.ts` and `workbench.spec.ts` pass unmodified.
- [ ] **Step 5: Review.** Dispatch `code-reviewer` (opus) with this plan, Tasks 1–11 and the base commit; tell it
  this is round 1 and the Review Focus. Fix blocking findings in one commit; round 2 checks only those.
- [ ] **Step 6: Gate.** `make gate` → `GATE PASS`.
- [ ] **Step 7: Pull request.** Push `feat/sessions-m4a`; open a PR titled
  `feat: one conversation store for Plan and task threads, migrated keeping ids`, its body listing the migrations,
  the calls above, the click-through, the row counts of Step 3 and the e2e result.

---

## Review round 1: where each finding went

| Finding | Where |
| --- | --- |
| A1 (blocking) `m.id <` comparisons at `thread/session-text.ts:64` and `shape/service.ts:1022` | Global Constraints (no id-order comparison, with a grep); Review Focus 2; Task 6 (Plan's never-spoke start, a `resume.test.ts` row); Task 7 (`buildThreadDigest`, a `session-text.test.ts` row; the grep at Step 4) |
| A2 (high) tests called unmodified that break | Global Constraints (which three change, and how); Task 7 Files (the trigger on `conversation_items`, the `reply` helper through `insertItem`, `cvi_`, every rename by file:line) and Step 4; Tasks 10 and 11 wording |
| A3 (medium) seed can't catch a wrong join or partition | Task 3 seed: project `P2` on `B`, `S3` and `T3` interleaving by id with `S1` and `T1`, `T3`'s latest session on `B`; assertions per conversation |
| A4 (medium) `substr` counts code points, zod counts UTF-16 units | Call 4 (100 code points in SQL and TypeScript, `planLinePreview`); the 0067 SQL; Task 3 emoji seed row and `transcript-kinds.test.ts` row; Task 6 round-trip row |
| A5 (medium) the SQL-vs-map check ran after 0067 froze | Task 3 creates `transcript-kinds.ts` and checks every copied row against it before Step 7 commits 0067; Task 6 consumes it |
| A6 (medium) `migrateDatabase` commits before `foreign_key_check` | Task 12 Step 3: migrate an online copy of the builder's database and compare per-table counts |
| A7 (low) the cap is 32 KB and needs an owner | Call 8 (32 KB, new items only); owned by M4b Task 8 |
| A8 (low) byte-identical one-prefix regexes | Task 1 Steps 3 and 4 (`generated/` must not change) |
| A8 (low) `mcp/shape-tools.test.ts` missed | Task 5 Files |
| A8 (low) Task 6's call-site count | Task 6 Files lists all 16 by file:line |
| A8 (low) `insertItem({ id })` has no M4a caller | Task 4 drops it; M4b Task 5 adds it with the engine; call 4 gives an adapter-written Plan line a fresh call id |
