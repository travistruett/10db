# Sessions M5a: Sessions on Claude: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sessions is a global screen with tabs in the title bar. Each tab is a Chat with an agent in one project.
It is attended (trust line §5): it reads the project, runs commands and searches the web with the builder's setup,
uses every builder tool through its own server, asks only at a limit, and mirrors the Inbox when it needs the
builder. Its writes in Your folder come in M6, with the folder hold.

**Architecture:**

- **Daemon.** A `chat/` module owns `chats` and `chat_tasks`. It plugs into M4b's explore engine through
  `ExploreOwnerHooks`, with the explore profile as the attended profile: the attended `TrustPolicy` (T3), the
  builder's setup and the web (T2), and the judge `capabilities.judge` names (T3, T5).
- **The chat's tools.** A chat session's token on 10db's own `/mcp` server lists every builder tool plus
  `set_title`. A policy table says which go in the session's `allowedTools` and which reach the judge.
- **Routes.** Chats get their routes. `GET /conversations/:id/files?q=` serves `@` mentions from `git ls-files` of
  the checkout the daemon resolves from the conversation; the client never sends a path.
- **Desktop.** `views/sessions/` holds the screen, built on the kit (M3, M4b):
  - the tab strip in the shell's header slot
  - the session bar
  - the fresh tab
  - the conversation
  - the composer on Mantine `Mentions`
  - task rows
  - needs-you, notifications and the keyboard
- **Inbox.** "Needs you" is read from the Inbox: a tab's ring is an open Inbox card whose detail names its
  conversation.

**Tech Stack:**

- TypeScript, Hono, Drizzle and SQLite, zod 4
- React 19, Mantine 9.8.0 (`Mentions`, `Menu`, `Combobox`), `@dnd-kit/sortable` 10.0.0, `@tanstack/react-virtual`,
  TanStack Router and Query
- Tauri 2 (the notification plugin)
- Vitest, Testing Library and MSW, Playwright (WebKit) with axe

**Spec:** `docs/superpowers/specs/2026-11-11-10db-sessions-design.md` (v4):

- S1, S2, S11, S13, S14, S19
- §5.3 (`judge`), §6.6 (the chat's builder server, judged denials), §6.7 (the archive row), §7.1, §7.2
- §8, §10 (the chat routes, `GET /conversations/:id/files`), §11 (builder tools, file mentions)
- §12 (M5a), §13, §14 (the M5a record)

The trust line, `docs/superpowers/specs/2026-11-12-10db-trust-line-design.md`: §5 (attended), §6 (what comes
along), §8 (Chat), §13.

And `docs/superpowers/specs/2026-11-11-10db-sessions-ui.md` throughout, except:

- Do It (§8)
- a chat's writes in Your folder, and the folder hold (design spec §7.3)
- Changes (§9)
- Open in Terminal (§10)
- Spotlight (§5.8's ⌘K)

Those are M6, M7 and M8.

## Starting point: M4b, T4, T5 and M4c have merged

The roadmap's order is M4b → T4 → T5 → M4c → M5a. Task 0 confirms each name below. Where M4b or a trust line
milestone chose another name, use that one and say so in the PR. Where a piece is missing, the task that first needs
it adds it, as that task says.

- **From the trust line** (`docs/superpowers/specs/2026-11-12-10db-trust-line-design.md` §12). Their plans are
  `docs/superpowers/plans/2026-11-12-10db-trust-t2-setup-comes-along.md`, `…-t3-policy-and-auto-mode.md` and
  `…-t5-tendb-judge-and-codex.md`; find the names there, and Task 0 confirms them:
  - **T2:** the setup builder that appends the project's instructions and the builder's `CLAUDE.md` to
    `systemPrompt`, and passes the skills and plugin dirs in `plugins`, behind the Settings › Trust switches; web
    on where a native judge exists.
  - **T3:** `TrustPolicy` (`packages/contracts`) and the daemon's `trust/` module, which builds the policy for an
    attended surface and renders its `autoMode` settings; the guard slimmed to the coordination rules and the
    `rules` floor; `capabilities.judge` with the model, which Plan already uses on the engine (M4b).
  - **T5:** 10db's judge (`crossesLimit` in `judge/`) and the hook that sends each call to it, for a session whose
    judge is `tendb`; the `rules` floor when no judge is available.
  - **T4** changes only unattended work. A chat is attended, so it reads nothing from T4.

- **From M4a** (`docs/superpowers/plans/2026-11-12-10db-sessions-m4a-stores.md`):
  - `ConversationId` (`cnv`), `ConversationItemId`, `ConversationFileId` and **`ChatId` (`cht`)** in
    `packages/contracts/src/ids.ts`
  - **the `chats` table, with no repository** (M4a call 1): `id`, `project_id`, `conversation_id`, `title`,
    `title_source`, `mode`, `task_id`, `pass_id`, `tab_position`, `created_at`, `updated_at`, `last_activity_at`,
    `archived_at`
  - `insertItem(ctx, conversationId, { author, kind, body, … })`; a `notice` body is `{ text }`
  - the tables `conversations`, `conversation_items` and `conversation_files` in `packages/db/src/schema.ts`,
    with `sessions.conversation_id`
  - `ConversationDto` and `ConversationItemDto`
  - `ConversationOwnerKind = { Chat: 'chat', Shape: 'shape', Task: 'task' }`
  - `ConversationState`, the §6.7 states
- **From M4b** (`docs/superpowers/plans/2026-11-12-10db-sessions-m4b-engine.md`):
  - `createExploreEngine(deps): ExploreEngine` in `apps/daemon/src/conversation/explore-engine.ts` (M4b Task 9),
    with `register(kind: 'shape' | 'chat', hooks)`, `queued(id)`, `stop`, `redo`, `sendNow`,
    `modelChanged(id, model)`, `view(id): ConversationDto`, `live(id)`, `settled(id)`, `recover()` and an
    engine-wide `close()`. There is no per-conversation close; Task 4 adds one.
  - `ExploreOwnerHooks`: `spec(conv, start): Promise<ExploreLaunch>`, `digest(conv)`,
    `outgoing(conv, item, session): Outgoing` (M4b call 5), `onTurnEnded(conv, end)` and `freshAtContextPct`.
  - The routes (M4b Task 17): `GET /conversations/:id`, `/items?afterSeq=`, `/live`, `/items/:itemId/full`, and
    `POST /conversations/:id/messages` (`PostConversationMessage = { text }`, pictures as multipart),
    `/send-now`, `/stop` and `/redo`. The message route is dispatched by owner in
    `apps/daemon/src/daemon/conversation-services.ts`; only `shape` is wired there.
  - `ConversationDto` (`packages/contracts/src/conversation-dto.ts`): `id`, `owner`, `state`, `capabilities`,
    `model`, `contextPct`, `queued`, `sendNow`, `pausedUntil`. `ConversationItemDto`, by kind, with `deliveredAt`.
  - The events `conversation.item_added`, `conversation.item_updated` and `conversation.state`, and the live
    `conversation.delta` frame.
  - The broker's owner `{ workstreamId: null; conversationId; shapeId? }`, whose Inbox cards carry
    `detail.conversationId` (M4b Task 13).
  - Plan on the engine.
- **From M4b, in the desktop** (M4b Task 18):
  - `daemon/conversation-queries.ts`: `useConversation`, `useConversationItems`, `useConversationLive`,
    `useSendConversationMessage`, `useStopConversation`, `useRedoConversation`, `useSendNow` and `useToolCallFull`
  - `conversation/live-items.ts` (`LiveItems`, `applyFrame`)
  - the kit's `WorkingLine({ conversation, streaming, tool })` and `ConversationList`'s `busy` prop
  - `planItemEntries(items, live, sendNow)` in `views/shape/plan-entries.ts`
  - **Not from M4b:** the kit's `Composer`, `PermissionRequest` and `Announcer` are M5a's (M4b call 15). Plan keeps
    its own composer and `waiting-permissions.tsx`. Task 9 builds them.
- **From M1 to M3:** Plan's `ModelPicker` (`views/shape/model-picker.tsx:37`, props `{ view: ShapeViewDto }`).
- **From M2c and T3:** `ToolCallView.deniedBy` with `builder`, `10db` and `judge`, and `limit` on a judged denial
  (design spec §5.2).
- **From M2a and M2c:** one scripted `FakeAdapter` serving both profiles. Its explore sessions emit `commands`,
  `message` and `tool_call`. The book is keyed by `Task: <title>` (`sessions/fake-adapter.ts:358-359`).
- **Built today:**
  - `/mcp` picks a session's tools from its row (`mcp/server.ts:94-104`), with per-session tokens
    (`mcp/tokens.ts:8`).
  - The builder tool names and inputs are in `packages/contracts/src/builder-mcp-tools.ts:28-47` and `:111`.
  - `POST /tasks/:taskId/remove` (`api/app.ts:1272`) removes an unstarted task.
  - `gitTrackedFiles` (`shape/ceremony.ts:103-119`).
  - The plan role's models come from `models(projectId)` (`daemon/start.ts:1285-1294`).
  - App settings are `app_settings` key and value (`packages/db/src/schema.ts:167`), served as
    `/settings/<name>` (`api/app.ts:1402`).
- **Morning check 4** (spec §16): a tab in the title bar doesn't start a window drag, and ⌘W reaches the webview
  before the menu's Close. Task 14 holds the fallback if ⌘W fails.

## Global Constraints

- **Rules:**
  - Root `AGENTS.md`
  - `apps/daemon/AGENTS.md`, `apps/desktop/AGENTS.md`, `packages/db/AGENTS.md` and
    `packages/contracts/AGENTS.md`
  - `.claude/rules/code-style.md` and `.claude/rules/testing.md`
  - `DESIGN.md`
- **Where to work:** `../10db-worktrees/sessions-m5a` on branch `feat/sessions-m5a`, from `origin/main` after M4c
  merged (roadmap order).
- **Commits:**
  - Name every path, with a single-quoted `-m`.
  - Conventional Commits, ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
  - One value card per newly tested behaviour.
- **Migrations are forward-only** (`v0.1.0` is tagged, `packages/db/AGENTS.md:15-17`). Make them with
  `pnpm --filter @10db/db generate`, and never edit a generated one.
- **Size each task to its risk:**
  - Permissions and the chat's builder server (Task 5) and archive through the engine (Task 4) take small red-first
    steps, one commit per behaviour.
  - Each UI task is one vertical slice. It is run against the real daemon (`pnpm dev`, click-through) before it is
    reviewed.
- **Provider words:**
  - No label names a provider except `capabilities.label`.
  - `views/sessions/` never compares a harness id. Task 10 extends M3's ESLint rule there.
- **Words are UI spec §2 and §14's, word for word.**
  - The UI says Sessions, Chat and Task, and never "worktree".
  - Buttons and menu items are Title Case.
  - A label never carries its count.
- **Colors:**
  - Status colors are DESIGN.md's: blue working, yellow needs you, orange paused, red error.
  - Nothing pulses.
  - Every color is a Selenized token.
- **A chat is attended** (trust line §5, design spec §7.1). Its session is the explore profile as the attended
  profile:
  - Plan's sandbox, so the checkout stays read-only in M5a. A chat's writes in Your folder come in M6, with the
    folder hold (design spec §7.3).
  - the attended `.env` rule with that sandbox (design spec §7.1): `.env*` files readable to the kernel, a read is a
    limit the judge asks about, and the project switch makes it free. T4 builds the rule and the switch, and extends
    it to Plan's sandbox, which the chat reuses.
  - commands judged, not carded: auto mode with the attended policy's `autoMode` where `capabilities.judge` is
    `native`; the hook judge (T5) where it is `tendb`; the `rules` floor where neither is available, said in the
    session bar
  - `settingSources: []`, with T2's setup: the instructions appended, the skills and plugin dirs
  - the web: `WebSearch` and `WebFetch`
  - subagents: Claude Code's own (`Task`, `Agent`) and the agents of the builder's plugins, but none of Plan's
    `agents`
  - 10db's `/mcp` with every builder tool, plus the project's approved MCP servers. The builder's own MCP servers
    come with T6, after M5a.
- **Out of scope:**
  - A chat's writes in Your folder, and the folder hold (M6)
  - Do It and its sheet (M6)
  - Changes (M6)
  - Open in Terminal and Hand Back (M7)
  - ⌘K Spotlight (M8)
  - Codex chats (M5b)

  None of them gets a placeholder. The UI spec draws them only where they work.
- **Done:** an agent in a 10db lane runs only the checks for what it changed. The last task runs `make gate`
  once.

## Calls made in this plan

Each is marked **(call)** where it is made.

1. **The chat's builder tools ride on 10db's own `/mcp` server.** A chat session's token lists the chat tools
   (`mcp/server.ts`, a third branch beside the lane and shape tools). The UI's `/builder/mcp` stays unreachable
   from a session. That is the "builder server, per-session token" of spec §6.6, built on the token mechanism that
   exists.
2. **The chat tool table** (spec §6.6). Every builder tool is listed on a chat's token, plus `set_title`.
   `ChatToolPolicy = { Runs: 'runs', Asks: 'asks' } as const`. Every name goes in the session's `allowedTools`;
   the tool's own handler decides what asks, since a judge can't know which tasks the chat made (spec §6.6):
   - **`runs`:** every builder tool but the four below, and `set_title`. `start_task` starts the task with no card:
     starting a task touches no limit. `edit_task` works on any task, with Undo (call 25).
   - **`asks`:** `remove_task` runs on a task this chat made (`chatMadeTask`), and on any other task raises a
     permission card owned by `{ conversationId }`: removing work the chat didn't make is limit 1. The answers are
     Allow once, Always in this project (T5's grants) and Deny (trust line §5). `retire_knowledge`,
     `withdraw_knowledge` and `supersede_knowledge` raise the same card every time.

   `write_brief` and the git tools arrive with M6, which adds `Judged` for `push_branch` and `merge_pull_request`.
3. **`chat_tasks (chat_id, task_id, created_at)` records the tasks a chat made.** It is what `edit_task`'s scope,
   Recent's "2 tasks filed" and Undo read. It is a table, not a column on `tasks`.
4. **A fresh tab lives in the client until its first `@` or its first send, whichever comes first** (the
   coordinator's option 1). It is kept in `localStorage` (`tendb.sessions.fresh`), a per-window convenience. At
   that moment the client does `POST /chats`; the files route needs a conversation, since the client never sends a
   path. From then on the Project control is fixed. The fresh tab is replaced by the chat's tab at once, its draft
   moves to the chat's draft, and the send (if any) goes from the chat's tab, so a failed post never makes a second
   chat. An empty chat never reaches Recent (call 6). The M5a decision records this.
5. **The daemon titles a chat from its first message**, in the message route's chat branch: the first line cut to
   40 characters, or "New session" for a message that is only a picture, as the agent's title
   (`title_source = 'agent'`). So `set_title` replaces it, and a builder's rename (`builder`) always wins. A chat is
   created as "New session".
6. **`chats.last_activity_at` (M4a's column) is written in two places:** the chat branch of the message route, and
   the chat's `onTurnEnded` hook. It stays null until the first message, so Recent, which orders by it, never lists
   an empty chat.
7. **The latest `commands` list is stored on `conversations.commands`.** A cold tab still offers `/`.
   `ConversationDto` gains `commands`.
8. **A message's `@` mentions travel as `mentions: string[]`** beside its text (`@path` stays in the text). The
   builder's panel draws each as a mono chip.
9. **`GET /conversations/:id/files?q=` resolves the checkout from the conversation** (spec §10, §11): a chat's is
   its project's `repoPath`. A task conversation is refused with 409 until M6 gives it a checkout to name. The query
   takes `q` only: a stray `root` (or any other key) is a 400.
10. **"Start from" is a route, `GET /projects/:id/session-starts`,** built from three rules on daemon facts: a task
    that failed in the last 7 days, commits on the base branch in the last 24 h, and the area of the latest
    commit's files.
11. **Notify when a chat replies** is an app setting (`/settings/sessions`), shown in a new global Settings section,
    **Sessions**, because Settings › General is a project section (`views/settings/sections.ts:32-38`). M7's
    terminal setting joins it.
12. **"New reply" and the last five closed tabs are per-window state** in `localStorage`
    (`tendb.sessions.seen`, `tendb.sessions.closed`).
13. **Chat models come from `GET /projects/:projectId/chat-models`**, which is `models(projectId)`
    (`daemon/start.ts:1285`) as `{ default, offered, unavailable }` (call 23).
14. **Shared pieces move out of the views that hold them,** since Sessions can't import from another view:
    `escapeIsTaken` and `escapeHasOwner` (`views/shape/use-shape-keys.ts:15-31`) and `dropped-files.ts` into the
    kit (Task 9), and `edge-fade.tsx` from `views/board/` to `shell/` (Task 13).
15. **The tab states M5a can reach are needs you, stopped by an error, paused, working, new reply and idle.**
    Ready, in your terminal, in review, signed off and done come with M6 and M7, each as a new row in Task 13's
    table. So does **Close Finished Tabs**, which closes only Done and In review tabs: in M5a it would close nothing,
    so its menu item comes with M6.
16. **A chat gets subagents:** Claude Code's own (`Task`, `Agent`) and the agents of the builder's plugins (T2).
    It gets none of Plan's `agents`, which are Plan's role (spec §17 call 16).
17. **The fake runs book scripts for explore sessions too.** A book key `Chat: <first line>` matches a chat
    session whose first prompt line is exactly that text.
18. **`set_title` is cut at a word to 28 characters by the daemon** (`cutTitle`), whatever the agent sends; the
    tool's description asks for at most 28, in sentence case, with no trailing period (UI spec §5.4).
19. **A model change is a `notice` item with the body `{ kind: 'model_change', label, model }`** (UI spec §7.1,
    "Now on {label} · {model}"). Task 1 widens M4a's notice body to carry it. The engine stores it in its own
    model-change path (`modelChanged`), so Plan gets the divider too, and the kit's `itemEntries` maps it, not
    `chatEntries`. It is stored only once the conversation has a message, at the change, which is where the next
    turn starts.
20. **A tab with no composer in M5a is a removed project's.** Switching to it focuses its transcript. Open Task, Open
    on Board and Hand Back (UI spec §13.1) come with M6 and M7.
21. **Closed tabs remember where they were.** The closed stack holds `{ chatId, position }`, so ⌘⇧T and the Inbox's
    Open Session reopen a tab at its place (UI spec §5.7).
22. **A double-click on the strip's empty space zooms the window** through `data-tauri-drag-region`'s own handling
    in Tauri 2. If the live check finds it doesn't, Task 13 calls `getCurrentWindow().toggleMaximize()` on
    `dblclick` of the empty space, with the `core:window:allow-toggle-maximize` permission and a repo-test row.
23. **Chats need a Claude account until M5b, which follows directly, and the two ship in the same release.**
    Sessions has no flag to hide it behind, so no release is cut between M5a's merge and M5b's (roadmap); a builder
    on a ChatGPT plan never meets the line below in a release. On a project whose account is a ChatGPT
    plan, `models()` is empty and `launch` throws `BRAINSTORM_REFUSED_ON_CHATGPT`
    (`packages/contracts/src/accounts.ts:44`, `daemon/start.ts:1226`), which would loop resends and leave a red ring
    worded with a retired product name. So `ChatModelsDto.unavailable` carries the daemon's words, decided from the
    account kind: "Chats on a ChatGPT account come with the next update. Plan, the Board and tasks work as before."
    The fresh tab shows Recent, Start from and that line, with the composer disabled; `POST /chats` answers 409 with
    the same words. On a Claude plan, Bedrock, an API key or a gateway the screen is the same everywhere; the only
    difference is the cost in the context meter's tooltip, shown on metered kinds (`capabilities.costUsd`).
24. **Copy with no field is dropped.** The cost reads `ConversationDto.costUsd` (Task 1: the sum of the
    conversation's `sessions.cost_usd`, `packages/db/src/schema.ts:636`, null unless `capabilities.costUsd`). No DTO
    says why a session ended or that the account signed out, so "The session stopped." has no `{reason}` and the
    Signed out alert is not built; both are follow-ups for a field the engine would record.
25. **An `edit_task` row is not a create row.** Its result is `{ kind: 'task_edit', taskId, title, previous }`; the
    row says "Changed {fields}" (call) and its Undo patches `previous` back, so it can never remove a task.
26. **An archived chat stays reopenable until M8's ⌘K:** archive pushes it onto the closed stack, marked archived,
    and All Tabs' Reopen unarchives it (`POST /chats/:id/unarchive`). The M5a decision says so.

## Review Focus

1. **A chat's agent removes work it didn't make.** `remove_task`'s handler sees the task isn't in `chat_tasks` and
   asks with a card, on every judge; on the chat's own task it runs. `edit_task` on a task the builder made
   applies, with Undo. Tests in Task 5.
2. **A path with spaces, Unicode, or regex characters in `@`** (`docs/a b.md`, `src/[id].tsx`, `é.ts`). It lists,
   matches and inserts as typed, because `git ls-files -z` and the ranker treat the query as text. Tests in Task 6.
3. **⌘W with a draft in the composer, then ⌘⇧T.** The draft comes back with the tab. Test in Task 15.
4. **A tab whose project was removed.** Its transcript stays readable with "This project was removed from 10db."
   and no composer. It is never a crash or an empty tab. Test in Task 11.
5. **Two tabs reordered, closed and reopened quickly.** Positions stay unique and gap-free after every write.
   Tests in Task 2.

---

### Task 0: Confirm the starting point

No commit.

- [ ] **Step 1: Find each M4b and trust line name.**

Run:

```bash
git grep -n "ExploreOwnerHooks\|conversation.delta\|ConversationOwnerKind\|conversationId" -- apps/daemon/src/conversation packages/contracts/src | head -40
git grep -n "createExploreEngine\|modelChanged\|planItemEntries\|useConversationLive" -- apps packages | head -20
git grep -ln "export function WorkingLine\|export function Composer\|export function PermissionRequest\|export function Announcer" apps/desktop/src/conversation
git grep -n "escapeIsTaken" apps/desktop/src | head
git grep -n "TrustPolicy\|crossesLimit\|judge:" -- apps/daemon/src/trust apps/daemon/src/judge apps/daemon/src/sessions packages/contracts/src | head -30
git grep -n "deniedBy" -- packages/contracts/src | head
```

Expected: every name in "Starting point" is found; `WorkingLine` is in the kit and the other three are not.

- [ ] **Step 2: Write down any name that differs** in a scratch note. Each later task uses the name you found,
  and the PR's body lists the mapping.

---

### Task 1: Contracts for chats, files and the chat tools

**Files:**

- Modify:
  - `packages/contracts/src/events.ts`: `ChatChanged: 'chat.changed'`
  - `packages/contracts/src/index.ts`
  - `packages/contracts/src/json-schema.ts`
  - the file holding `ConversationDto` and the message input: `commands` (call 7) and `mentions` (call 8)
- Create:
  - `packages/contracts/src/chat.ts` and `packages/contracts/src/chat.test.ts`
  - `packages/contracts/src/chat-tools.ts`
- Generated: `packages/contracts/generated/*.schema.json`

**Interfaces:**

- **Produces, in `@10db/contracts`** (`ChatId` is M4a's; if M4a already exports `ChatTitleSource` or `ChatMode`
  for the `chats` columns, use those):
  - `ChatTitleSource = { Agent: 'agent', Builder: 'builder' } as const`.
  - `ChatMode = { Explore: 'explore', HandsOn: 'hands_on' } as const`.
  - `ChatDto`:
    - `id`, `projectId`, `conversationId`
    - `conversation: ConversationDto`, nested as spec §10 has it (M5a-11); a tab's state reads
      `conversation.state`
    - `title: string` and `titleSource`
    - `mode`
    - `taskId: TaskId | null` and `passId: PassId | null` (null until M6)
    - `tabPosition: int ≥ 0 | null`
    - `createdAt`, `lastActivityAt` (call 6), `archivedAt: string | null`
    - `lastReplyAt: string | null`
    - `tasksFiled: int ≥ 0`
  - `ChatCreateInput`: `{ projectId; model: string | null; tabPosition: int ≥ 0 }`. No title: the daemon titles it
    (call 5).
  - `ChatPatchInput`: `{ title?: 1..120 chars; tabPosition?: int ≥ 0 | null; model?: string | null }`. At least one
    key is set.
  - `ChatModelsDto = { default: string | null; offered: ShapeModelOption[]; unavailable: string | null }` (calls 13
    and 23).
  - `ConversationDto.costUsd: number | null` (call 24).
  - The notice item body widens (call 19): `{ text: string } | { kind: 'model_change'; label: string; model: string }`.
  - `ProjectFileMatchDto = { path: string; matches: [start, end][] }`. `matches` holds index ranges into `path`,
    which the suggestion underlines. `PROJECT_FILES_MAX = 50`.
  - `SessionStartDto = { kind: 'failed_task' | 'base_commits' | 'recent_area'; text: string }`.
  - `SessionsSettingsDto = { notifyReplies: boolean }`.
  - `AgentCommandDto = { name: string; description: string; argumentHint: string | null }`, unless M2c or M4b
    already exports one.
  - **The chat tools:**
    - `ChatToolName`: every `BuilderToolName` (`builder-mcp-tools.ts:28-47`) plus `set_title` (call 2).
    - `ChatToolInputs`: the builder tools' inputs with the project removed, plus `set_title: { title: 1..80 chars }`
      (the daemon cuts it to 28, call 18).
    - `CHAT_TITLE_MAX = 28` and `cutTitle(title: string, max = CHAT_TITLE_MAX): string`: cut at the last word
      boundary within `max`, no trailing period or space; a single word longer than `max` is cut at `max`.
    - `ChatToolResult`, for the rows the UI draws:
      - `{ kind: 'task', taskId, title, column: string }` (`create_task`)
      - `{ kind: 'task_edit', taskId, title, previous: Partial<TaskPatch> }` (`edit_task`, call 25): `previous`
        holds the old value of each field the edit changed
      - `{ kind: 'title', title, previousTitle: string }` (`set_title`)
      - `{ kind: 'start', taskId, started: true }` (`start_task`, which runs with no card)
- **Every message carries:** `ConversationDto.commands: AgentCommandDto[] | null`, and the message input's
  `mentions: string[]`, defaulting to `[]`, each a relative path of at most 1,024 characters.

- [ ] **Step 1: Write the failing `chat.test.ts` table.**
  - Valid rows parse and round-trip (including a `task_edit` result and a `model_change` notice body):
    - a `ChatDto`
    - each `ChatToolResult` kind
    - a `ChatPatchInput` with only `tabPosition: null`
  - These rows are rejected:
    - a `ChatCreateInput` with a `title` key: an unknown key, rejected (the daemon titles a chat, call 5)
    - an empty `ChatPatchInput`
    - a mention of `../x` or `/etc/passwd`
    - `set_title` with an empty title
    - a notice body `{ kind: 'model_change' }` with no `model`
  - `cutTitle` rows: "Retry login on a 401" stays; "Retry login once on a 401 after the token refresh" becomes
    "Retry login once on a 401"; "Fix it." becomes "Fix it"; a 40-letter word becomes its first 28 letters.

- [ ] **Step 2: Run it and watch it fail.**

Run: `pnpm --filter @10db/contracts exec vitest run src/chat.test.ts`

Expected: FAIL, because `./chat` does not exist.

- [ ] **Step 3: Implement.** Register each DTO in `CONTRACT_SCHEMAS`, then run
  `pnpm --filter @10db/contracts generate`.

- [ ] **Step 4: Run the tests.**

Run: `pnpm --filter @10db/contracts exec vitest run`

Expected: PASS.

- [ ] **Step 5: Commit.** The message is
  `feat(contracts): chats, their tool results, file matches and session starts`. Value card:
  - protects: the wire shapes Sessions reads and the chat tools return
  - fails_when: a title cap, the mention path rule or a `ChatId` prefix drifts
  - why_new: no chat contract existed
  - no_claim: that the daemon fills them right

---

### Task 2: The chats store, and the `chat_tasks` table

**Files:**

- Modify:
  - `packages/db/src/schema.ts`
  - `packages/db/src/index.ts`
- Create:
  - `packages/db/src/store/chats.ts`
  - `packages/db/src/store/chats.test.ts`
  - the generated migration under `packages/db/drizzle/`
- `schema.ts` gains `chat_tasks` and `conversations.commands` (call 7); `chats` is M4a's

**Interfaces:**

- **Tables:**
  - `chats` exists (M4a). If M4a left `conversation_id` without a unique index, this migration adds one.
  - `chat_tasks`: `chat_id`, `task_id` (primary key together), `created_at`
  - `conversations.commands`: nullable JSON
- **Produces, in `packages/db/src/store/chats.ts`, every write inside `state.write` and emitting `chat.changed`
  with `entityType: 'chat'`:**
  - `insertChat(ctx, input: { projectId; conversationId; title; tabPosition }): ChatRow`. It shifts the tabs at or
    after `tabPosition` right by one.
  - `moveChatTab(ctx, chatId, position: number | null): void`.
    - `null` closes the tab.
    - A number opens it there or moves it there.
    - The other open tabs are renumbered so the positions are exactly `0..n-1`.
  - `setChatTitle(ctx, chatId, title, source): boolean`. An `agent` title never replaces a `builder` one; that case
    returns `false` and writes nothing.
  - `archiveChat(ctx, chatId, at): void`. It sets `archived_at` and closes the tab.
  - `recordChatTask(ctx, chatId, taskId): void`.
  - `chatMadeTask(db, chatId, taskId): boolean`.
  - `openChats(db): ChatRow[]`, ordered by position across every project.
  - `touchChat(ctx, chatId, at): void`: sets `last_activity_at` (call 6).
  - `recentChats(db, projectId, limit): ChatRow[]`: not archived, `last_activity_at` not null, newest first.
  - `unarchiveChat(ctx, chatId): void`: clears `archived_at` (call 26).
  - `chatView(db, chatId): ChatRowView`, everything of `ChatDto` but `conversation`, which `ChatService` adds from
    the engine's `view(conversationId)` (the DTO carries capabilities, which only the engine knows). It reads
    `lastActivityAt` from the row, the
    latest
    `agent_message` for `lastReplyAt`, and the `chat_tasks` whose task is not cancelled for `tasksFiled`.

- [ ] **Step 1: Write the failing tests** in `chats.test.ts`, on a real SQLite file in a temp directory (the
  store tests' own setup). One test per behaviour, run red one at a time:
  - **Insert at a position.** Inserting at 1 among three open tabs leaves positions `0..3`, with the new tab at 1.
  - **Move and close** (Review Focus 5). Move 3 to 0, then close 1, then reopen it at 2. After each write the
    positions are unique and gap-free, and a closed tab's is null.
  - **Titles.** An `agent` title after a `builder` title is refused. A `builder` title after an `agent` one wins.
  - **Archive.** It closes the tab, and the chat leaves `recentChats`.
  - **Recent.**
    - A chat whose `last_activity_at` is null is not listed.
    - The order follows `last_activity_at`, which `touchChat` sets.
    - The limit holds.
  - **`chatView`.**
    - `tasksFiled` counts two recorded tasks, then one after one is cancelled.
    - `lastReplyAt` is the latest agent message.
  - **Events.** Every write emits one `chat.changed` event in the same transaction. Read it back from `events`.

- [ ] **Step 2: Run them and watch each fail.**

Run: `pnpm --filter @10db/db exec vitest run src/store/chats.test.ts`

Expected: FAIL, because `./chats` does not exist.

- [ ] **Step 3: Add the tables, then generate the migration.** Run `pnpm --filter @10db/db generate`. Then
  implement the store until each test passes, one commit per behaviour group (positions, titles, archive and
  recent, view).

- [ ] **Step 4: Run the db package's tests.** `migrateDatabase` must still pass from a seeded database.

Run: `pnpm --filter @10db/db exec vitest run`

Expected: PASS.

- [ ] **Step 5: Commit** each group with its value card. For example, positions:
  - protects: open tabs keep unique, gap-free positions through insert, move, close and reopen
  - fails_when: two tabs share a position or a gap appears
  - why_new: chats are new
  - no_claim: the drag in the UI

---

### Task 3: The chat service, its explore hooks, and the chat routes

**Files:**

- Create:
  - `apps/daemon/src/chat/index.ts`, `service.ts`, `hooks.ts`, `prompt.ts`
  - `apps/daemon/src/chat/hooks.test.ts`
  - `apps/daemon/src/chat/service.test.ts`
- Modify:
  - `apps/daemon/src/api/services.ts`: the chat methods on `ApiServices`
  - `apps/daemon/src/api/app.ts`: the routes
  - `apps/daemon/src/api/app.test.ts`: route rows
  - `apps/daemon/src/daemon/services.ts` and `apps/daemon/src/daemon/start.ts`: wiring, and
    `engine.register(ConversationOwnerKind.Chat, chatHooks(deps))` beside Plan's
  - `apps/daemon/src/daemon/conversation-services.ts`: the message route's chat branch
  - `apps/daemon/src/conversation/explore-engine.ts`: `modelChanged` stores call 19's notice, and `view` fills
    `costUsd` (call 24)
  - `apps/daemon/AGENTS.md`: the module order gains `chat` beside `thread, shape`, per spec §4

**Interfaces:**

- **Consumes:**
  - Task 2's store
  - M4b's engine registration, `ExploreOwnerHooks`
  - `models(projectId)` and `launch(projectId, chosen)` (`daemon/start.ts:1285-1310`)
  - `sessions/project-mcp.ts`
- **Produces:**
  - `chatHooks(deps): ExploreOwnerHooks`, M4b's interface:
    - `spec(conv, start)` returns an `ExploreLaunch` whose spec is the explore profile:
      - `systemPrompt: CHAT_SYSTEM_PROMPT`, with T2's instructions appended
      - Plan's sandbox, read tools and commands; no `Edit` or `Write` until M6
      - `WebSearch`, `WebFetch`, `Task` and `Agent` in `tools`, none of them in `disallowedTools` (call 16)
      - `agents: {}`: none of Plan's (call 16)
      - T2's `plugins`, and `settingSources: []`
      - the policy: T3's attended `TrustPolicy` for the chat. Where `capabilities.judge` is `native`,
        `permissionMode: 'auto'` with its `autoMode` settings; where it is `tendb` or `rules`, `default` mode with
        the hook judge (T5)
      - `allowedTools`: the `runs` names of call 2, as `mcp__10db__<name>`
      - `mcp`: 10db's `/mcp` with the session's token and `toolTimeoutMs` the lane's, `(project.humanWaitMinutes +
        5) * 60_000` (`runner/runner.ts`), so an `asks` card can wait on the builder (spec §6.6); plus the project's
        approved servers
      - the chat's account and model
    - `digest`: Plan's digest rule
    - `outgoing(conv, item, session)`: the message's text (mentions already in it as `@path`) and its pictures
      within `session.limits`, marked told once sent. A chat has none of Plan's notes, so nothing goes ahead of it.
    - `onTurnEnded`: `touchChat` (call 6)
    - `freshAtContextPct: 70`
  - `CHAT_SYSTEM_PROMPT`. It says:
    - the agent reads the project, runs commands and searches the web
    - it doesn't edit files yet (M6 changes this line, when a chat writes in Your folder); when the builder wants a
      change made, it offers to file a task
    - it calls `set_title` once after its first reply, with a title of at most 8 words
    - it files tasks with `create_task` only when the builder asks
    - repeated message ids are one message (spec §6.2)
  - `ChatService`:
    - `create(input: ChatCreateInput): ChatDto`. It creates a conversation with owner `chat`, profile `explore`,
      the project's account (spec §7.1 call), and `model`. Then it inserts the chat.
    - `open(): ChatDto[]`
    - `recent(projectId, limit = 6): ChatDto[]`
    - `patch(id, input: ChatPatchInput): ChatDto`. A model change while the state is `starting`, `running`,
      `waiting_card` or `stopping` throws `ConflictError` "Change the model between turns." A model the account
      doesn't offer throws `InvalidError` "Not available on this account". An accepted change calls M4b's
      `engine.modelChanged(conversationId, model)`, which stores call 19's notice.
    - `models(projectId): ChatModelsDto`, with `unavailable` set for a ChatGPT-plan account (call 23); `create`
      refuses such a project with `ConflictError` and the same words.
    - `unarchive(id)` (call 26)
    - `archive(id)`, built in Task 4
  - **Routes:**
    - `GET /chats?open=1`
    - `GET /chats/recent?projectId=&limit=`
    - `POST /chats`
    - `PATCH /chats/:id`
    - `POST /chats/:id/archive` and `POST /chats/:id/unarchive`
    - `GET /projects/:projectId/chat-models`

    Each route parses its input with its zod schema through `validator`, as `api/app.ts:516-528` does. Errors map
    by `STATUS` (`:162`).
  - **The message route's chat branch.** `POST /conversations/:id/messages` for a chat's conversation stores the
    builder `message` item queued, with its `mentions` (call 8) and pictures, and `touchChat`s it in the same write,
    then calls `engine.queued(id)`, as the shape branch does. A chat's archived conversation refuses it with 409 "This session is archived."

- [ ] **Step 1: Write the failing `hooks.test.ts` table** (pure). For a chat on a project with one approved MCP
  server:
  - `profile.kind` is `explore`.
  - `WebSearch` and `WebFetch` are in `tools`, and not in `disallowedTools`.
  - `Task` and `Agent` are in `tools`, and not in `disallowedTools` (call 16).
  - `Edit` and `Write` are not in `tools` (writes come in M6).
  - `agents` is empty.
  - The MCP servers are exactly 10db's own plus the approved one.
  - `settingSources` is `[]`, and `plugins` holds T2's setup dirs.
  - `allowedTools` holds every chat tool name (call 2).
  - One row per judge value: `native` → `permissionMode: 'auto'` and the attended policy's `autoMode`; `tendb` →
    `default` and the hook judge; `rules` → `default` and the `rules` floor.
  - The model is the chat's pick, or the plan role's when null.

- [ ] **Step 2: Write the failing `service.test.ts`** on a real SQLite file:
  - `create` makes a conversation whose owner is the chat, with the project's account.
  - `patch` refuses a model change while the state is `running` (set the conversation's state directly through
    M4a's store).
  - `models` on a ChatGPT-plan project has `unavailable` set to call 23's words, and `create` there throws
    `ConflictError` with them.
  - The model-change notice is tested on the engine harness: Step 2b.
  - Archive is covered in Task 4.

- [ ] **Step 2b: Write the failing engine row** in M4b's `explore-engine.test.ts`: `modelChanged` on a
  conversation with a message stores one `notice` with `{ kind: 'model_change', label: 'Claude Code', model:
  'opus' }`; on one with no message it stores none. A Plan conversation gets it too.

- [ ] **Step 3: Write the failing route rows** in `app.test.ts`, with `stubServices` (`:40`), plus one row in M4b's
  `api/conversation-routes.test.ts` (real store and engine on the fake): a message to a chat's conversation is
  stored queued with its `mentions` and starts a turn.
  - `POST /chats` with an unknown key is a 400; `POST /chats` on a ChatGPT-plan project is 409 with call 23's words.
  - The chat branch of the message route titles a new chat from its first line, or "New session" for a
    picture-only message (`conversation-routes.test.ts`).
  - `PATCH /chats/:id` with `{}` is a 400.
  - `GET /chats?open=1` returns the service's list.
  - The 409 from `patch` reaches the client as 409, with its words.

- [ ] **Step 4: Run them and watch them fail.**

Run: `pnpm --filter @10db/daemon exec vitest run src/chat src/api/app.test.ts`

Expected: FAIL.

- [ ] **Step 5: Implement, wire, and run the tests again.** Expected: PASS. Then run
  `pnpm --filter @10db/daemon exec tsc --noEmit` and the daemon's ESLint.

- [ ] **Step 6: Commit** in two commits, each with its value card:
  - `feat(daemon): a chat is an attended conversation with the builder's setup and the web`
  - `feat(daemon): routes to create, list, rename, move and pick a model for a chat`

---

### Task 4: Archive through the engine

Small red-first steps. One commit per row group.

**Files:**

- Modify:
  - `apps/daemon/src/chat/service.ts`: `archive`
  - `apps/daemon/src/conversation/explore-engine.ts`: `retire`
- Test: the engine's test file (M4b's explore engine harness), plus `apps/daemon/src/chat/service.test.ts`

**Interfaces:**

- **Produces:**
  - `ChatService.archive(id: ChatId): Promise<ChatDto>`. It follows spec §6.7's archive row for every state M5a
    can reach. Then it removes `<dataDir>/conversations/<conversationId>/`, a path made only from ids (spec §5.2).
  - M4b's engine has only an engine-wide `close()`, so it gains
    `ExploreEngine.retire(conversationId: ConversationId): Promise<void>`. It:
    - cancels a start
    - stops a running turn and waits for it to settle, within `STOP_GRACE`
    - withdraws a waiting card
    - closes a warm handle and ends its session row, so the session's MCP token no longer resolves on `/mcp`
      (`getLiveSessionByTokenHash`, `mcp/server.ts:94-95`)
    - from then on, refuses messages for that conversation until `unarchive` clears it
- **The rows:**
  - `idle_cold` → archived.
  - `idle_warm`: the handle is closed, then archived.
  - `starting`: the start is cancelled, then archived.
  - `running`: Stop, then archived. The partial text is stored, as an early end stores it (spec §6.3).
  - `waiting_card`: the card is withdrawn, then Stop, then archived.
  - `stopping`: archived after the stop.
  - `paused_account` and `ended_error` → archived.
  - `taken_over` can't occur until M7. M7 adds its confirm row.

- [ ] **Step 1: Write one failing pipeline row per state** on M4b's explore harness (the fake adapter, a real
  SQLite file). Each asserts:
  - the fake has no open handle
  - no Inbox card stays open
  - the folder is gone
  - `archivedAt` is set
  - a message afterwards is refused with 409 "This session is archived."
  - the `running` row's partial `agent_message` is stored with `partial: true`

- [ ] **Step 2: Watch each fail, then make it pass.** Commit per group: idle and paused; starting and running;
  waiting_card and stopping. Each commit carries its value card:
  - protects: archiving a chat in any state leaves no live session, no open card and no folder
  - fails_when: a handle stays open, a card stays in the Inbox, or a later message spends tokens
  - why_new: archive is new
  - no_claim: `taken_over` (M7)

Run: `pnpm --filter @10db/daemon exec vitest run src/conversation src/chat`

Expected: PASS.

---

### Task 5: The chat's builder tools on `/mcp`

Permissions: exhaustive, red-first, on the real rung.

**Files:**

- Create:
  - `apps/daemon/src/chat/tool-policy.ts` and `apps/daemon/src/chat/tool-policy.test.ts`
  - `apps/daemon/src/chat/tools.ts` and `apps/daemon/src/chat/tools.test.ts`
  - `apps/daemon/src/mcp/chat-tools.ts`: `ChatToolsFor`, mirroring `mcp/shape-tools.ts:16`
- Modify:
  - `apps/daemon/src/mcp/server.ts:94-104`: the third branch
  - `apps/daemon/src/daemon/start.ts`: wire `chatTools` beside `shapeTools` (`:1935`)
  - `apps/daemon/src/mcp/server.test.ts`, or its nearest test

**Interfaces:**

- **Produces:**
  - `ChatToolPolicy = { Runs: 'runs', Asks: 'asks' } as const`.
  - `CHAT_TOOL_POLICY: Readonly<Record<BuilderToolName | 'set_title', ChatToolPolicy>>`, by call 2.
  - `chatToolsFor({ sessionId, conversationId, chatId, projectId }): Record<ChatToolName, (args: unknown) => Promise<unknown>>`.
    Each tool parses its args with `ChatToolInputs[name]` and returns a `ChatToolResult` as JSON text:
    - **`create_task`:** creates the task in the chat's project, then calls `recordChatTask`. The result is
      `{ kind: 'task', …, column: 'Ready' }`, or the column the task lands in.
    - **`edit_task`:** on any task of the chat's project. It reads the task, applies the edit through the builder
      tool's handler, and returns `{ kind: 'task_edit', taskId, title, previous }`, where `previous` holds the old
      value of each field the edit changed, in `TaskPatch`'s shape (call 25).
    - **`start_task`:** starts the task through the service the builder's `start_task` uses, with no card, and
      returns `{ kind: 'start', taskId, started: true }`.
    - **`set_title`:** calls `setChatTitle(cutTitle(title), 'agent')` (call 18). The result carries
      `previousTitle`. When a builder title stands, it is a no-op that says so. Its description: "Name this session
      in at most 28 characters, in sentence case, with no trailing period. Call it once, after your first reply."
    - **`remove_task`:** runs when `chatMadeTask` is true. Otherwise it raises the permission card of call 2 and
      waits; Allow removes the task, Deny returns "The builder kept this task." Always in this project stores T5's
      grant.
    - **`retire_knowledge`, `withdraw_knowledge`, `supersede_knowledge`:** the same card, every time.
    - **Every other builder tool:** the builder tool's handler (`builder/tools.ts:79`), held to the chat's
      project.
  - In `mcp/server.ts`: a session whose conversation's owner kind is `chat` gets `chatTools(...)`, and no lane or
    shape tool.

- [ ] **Step 1: Write the failing pure table** `tool-policy.test.ts`. One row per name in `BuilderToolName`
  (`builder-mcp-tools.ts:28-47`) plus `set_title`, with the policy of call 2. Two rows check that the table and
  `ChatToolName` agree:
  - every name in `BuilderToolName` plus `set_title` is in `ChatToolName`, and nothing else is
  - the `asks` names are exactly `remove_task`, `retire_knowledge`, `withdraw_knowledge` and
    `supersede_knowledge`, and every name is in the session's `allowedTools`

- [ ] **Step 2: Write the failing behaviour tests** in `tools.test.ts`. They run through the real `/mcp` handler,
  with a chat session row and its minted token, on a real SQLite file. One test per row, run red one at a time:
  - `tools/list` returns every builder tool plus `set_title`.
  - `create_task` writes the task in the chat's project, even when the args name another project, and records it
    in `chat_tasks`. Read the task back through `list_tasks`.
  - `edit_task` on a task the builder made applies, and returns `previous` for Undo (Review Focus 1).
  - `start_task` starts the task, creates no Inbox item, and its result says `started: true`.
  - `remove_task` on a task the builder made raises one permission card owned by `{ conversationId }`, and the
    task stays until the card is answered Allow once; Deny keeps it (Review Focus 1). `remove_task` on the chat's
    own task removes it with no card. `retire_knowledge` raises the card.
  - `set_title` renames an `agent`-titled chat and leaves a `builder`-titled one; a 50-character title is stored cut
    at a word within 28.
  - `edit_task` on the chat's own task returns `task_edit` with `previous` holding exactly the changed fields'
    old values, and never a `task` result.
  - A lane session's token doesn't list the chat tools. A chat token doesn't list the lane or shape tools. The UI
    token is refused on `/mcp`.
  - A chat session's token is refused on `/builder/mcp` (`api/app.ts:293`, behind the UI token). This row passes
    on its first run, since the check exists; show it red by briefly letting a session token through the builder
    route's token check (accept a token `getLiveSessionByTokenHash` resolves), watch the row fail, then put the
    check back.
  - Stop while a `remove_task` card waits withdraws the card, and the call returns denied ("The builder stopped
    the turn."). Archive does the same.
  - After the chat is archived (Task 4), its session's token is refused on `/mcp`. This row also passes on its first
    run once Task 4's `retire` ends the session row; show it red by briefly skipping that end in `retire` (the warm
    handle closes but the row stays live), watch the row fail, then restore it.

- [ ] **Step 3: Watch each fail, implement, and run.**

Run: `pnpm --filter @10db/daemon exec vitest run src/chat src/mcp`

Expected: PASS.

- [ ] **Step 4: Commit** in three commits:
  - the policy table
  - the server branch, listing every tool
  - each tool's behaviour

  Each carries its value card. For the server branch:
  - protects: a chat's agent reaches every builder tool by its own token, and removing or retiring work it didn't
    make asks the builder
  - fails_when: a tool is missing, a removal of the builder's work runs without a card, or a token reaches another
    owner's tools
  - why_new: chats are new; the builder server is UI-token only
  - no_claim: the tool rows in the UI

---

### Task 6: `GET /conversations/:id/files` for `@` mentions

**Files:**

- Create:
  - `apps/daemon/src/chat/file-rank.ts` and `apps/daemon/src/chat/file-rank.test.ts`
  - `apps/daemon/src/chat/conversation-files.ts` and `apps/daemon/src/chat/conversation-files.test.ts`
- Modify: `apps/daemon/src/api/services.ts`, `apps/daemon/src/api/app.ts`, `apps/daemon/src/daemon/services.ts`
- Test: route rows in `apps/daemon/src/api/app.test.ts`

**Interfaces:**

- **Produces:**
  - `rankFiles(paths: readonly string[], query: string, limit = PROJECT_FILES_MAX): ProjectFileMatchDto[]`.
    - The query is text, not a pattern.
    - Its characters must appear in order, case-insensitively.
    - Ranked by:
      1. a match in the file name before a match in the folder
      2. contiguous runs first
      3. the shorter path first
      4. alphabetical
    - An empty query returns the first `limit` paths, alphabetically.
  - `conversationFiles(conversationId: ConversationId, query: string): ProjectFileMatchDto[]` (call 9).
    - It resolves the checkout from the conversation: a chat's is its project's `repoPath`
      (`packages/db/src/schema.ts:209`). A task conversation throws `ConflictError` "Files for a task come with Do
      It." until M6. An unknown conversation throws `NotFoundError`.
    - It reads `gitTrackedFiles(repoPath)` (`shape/ceremony.ts:103`), cached 30 s as Plan caches it
      (`shape/service.ts:422`).
    - Then it ranks.
  - Route: `GET /conversations/:conversationId/files?q=`. The query is a strict object with `q` alone, at most 200
    characters, so a `root` or any other key is a 400. The client never sends a path.

- [ ] **Step 1: Write the failing `file-rank.test.ts` table**, with named rows:

| query | expected |
| --- | --- |
| `log` | `src/login.ts` before `docs/catalog.md` before `src/blog/x.ts` |
| `LOG` | the same |
| `a b` | `docs/a b.md` matches |
| `[id]` | `src/[id].tsx` matches, and the query isn't a pattern |
| `é` | `src/é.ts` matches |
| `` (empty) | the first 50, alphabetically |
| 60 matches | 50 returned |
| `zzz` | `[]` |

  Each row also checks the `matches` ranges.

- [ ] **Step 2: Write the failing real-git test** `conversation-files.test.ts`, through a chat's conversation on a
  real SQLite file. Build a temp repository with
  `maintenance.auto=false`, `gc.auto=0` and `receive.autogc=false`, and the isolated git env. It holds:
  - committed `src/login.ts` and `docs/a b.md`
  - an untracked file
  - an ignored file

  Expected:
  - `q=login` lists the committed file.
  - The untracked and ignored files are never listed.
  - A task's conversation is refused.

  And the route rows: an unknown conversation is 404; `?q=a&root=/elsewhere` is 400.

- [ ] **Step 3: Watch them fail, implement, and run.**

Run: `pnpm --filter @10db/daemon exec vitest run src/chat/file-rank.test.ts src/chat/conversation-files.test.ts src/api/app.test.ts`

Expected: PASS.

- [ ] **Step 4: Commit.** Value card:
  - protects: `@` lists only tracked files of the chat's checkout, matched as text
  - fails_when: an untracked or ignored file appears, a query is read as a pattern, or a path from the client is
    read
  - why_new: no file search existed
  - no_claim: that the explore judge allows each read (spec §11, judge tests)

---

### Task 7: "Start from" suggestions

**Files:**

- Create:
  - `apps/daemon/src/chat/session-starts.ts` and `apps/daemon/src/chat/session-starts.test.ts`
  - `apps/daemon/src/chat/start-facts.ts` and `apps/daemon/src/chat/start-facts.test.ts`
- Modify: `apps/daemon/src/api/services.ts`, `apps/daemon/src/api/app.ts`, `apps/daemon/src/daemon/services.ts`

**Interfaces:**

- **Produces:**
  - `StartFacts = { failedTask: { title } | null; baseCommits: { base: string; count: number } | null; recentArea: string | null }`.
  - `sessionStarts(facts: StartFacts): SessionStartDto[]`. It returns at most three, in this order. The text is
    UI spec §6.2's:
    1. "Why did “{title}” fail?"
    2. "What changed on {base} since yesterday?"
    3. "How does {area} work?"
  - `startFacts(project, now): Promise<StartFacts>`. Its sources:
    - the latest task that failed in the last 7 days
    - `git rev-list --count --since=<now − 24 h> <base>` on the project's base branch, through `runGit`
    - the area whose globs cover the most files of `HEAD`'s commit. An area over `WHOLE_REPOSITORY_GLOBS` gives
      none.
  - Route: `GET /projects/:projectId/session-starts`. It answers `[]` rather than fail when git fails.

- [ ] **Step 1: Write the failing pure table** for `sessionStarts`:
  - every fact present gives three suggestions, in order
  - none gives `[]`
  - a count of 0 drops the second
  - a long title is cut at 60 characters with "…"

- [ ] **Step 2: Write the failing real-git test** for `startFacts`:
  - a repository with a commit dated now and one dated 3 days ago (`GIT_COMMITTER_DATE` in the isolated env)
    gives a count of 1
  - the latest commit touching `src/billing/**` names the billing area

  Inject the clock.

- [ ] **Step 3: Watch them fail, implement, run, and commit.**

Run: `pnpm --filter @10db/daemon exec vitest run src/chat/session-starts.test.ts src/chat/start-facts.test.ts`

Expected: PASS. Value card:
- protects: Start from offers at most three rule-built prompts from the project's state
- fails_when: a rule fires with no fact, or the order changes
- why_new: new
- no_claim: that a suggestion is useful

---

### Task 8: The desktop data layer for chats

**Files:**

- Create:
  - `apps/desktop/src/daemon/chat-queries.ts`
  - `apps/desktop/src/test/chat-fixtures.ts`
- Modify: `apps/desktop/src/daemon/events.ts:34-84`: `chat: [chatKeys.all]`, and `conversation` also
  invalidates `chatKeys.all`, so a tab's state follows

**Interfaces:**

- **Produces:**
  - `chatKeys = { all: ['chats'], open: […], recent: (projectId) => […], models: (projectId) => […], files: (conversationId, q) => […], starts: (projectId) => […] }`.
  - **Queries:**
    - `useOpenChats()`
    - `useRecentChats(projectId)`
    - `useChatModels(projectId)`
    - `useSessionStarts(projectId)`
    - `fetchConversationFiles(client, conversationId, q, signal)`, a plain async function for `Mentions`' `data`
    - `useUnarchiveChat()`
  - **Mutations:**
    - `useCreateChat()`
    - `usePatchChat()`
    - `useArchiveChat()`

    Each mutation invalidates `chatKeys.all` when it settles.
  - Every read is parsed with its contract through `readJson`, as `daemon/shape-queries.ts:34` and `:124` do.
  - **Fixtures:** `chatDto(overrides)`, plus handler builders for the routes above, as `test/pass-fixtures.ts:41`
    does.

  This task has no test of its own. Its hooks are exercised by Tasks 9 to 17, which carry the value cards. It is
  folded into Task 10's commit.

---

### Task 9: The kit's `Composer`, `PermissionRequest` and `Announcer`, and items as entries

The kit pieces M4b leaves to M5a (M4b call 15). Plan and the Workbench keep their own until M4c moves the Workbench.

**Files:**

- Create:
  - `apps/desktop/src/conversation/composer.tsx`, `composer-phase.ts` and `composer-phase.test.ts`,
    `composer.test.tsx`
  - `apps/desktop/src/conversation/permission-request.tsx` and `permission-request.test.tsx`
  - `apps/desktop/src/conversation/announcer.tsx`
  - `apps/desktop/src/conversation/model-picker.tsx` (and `views/shape/model-picker.tsx` becomes its wrapper)
  - `apps/desktop/src/conversation/item-entries.ts` and `item-entries.test.ts`
  - `apps/desktop/src/conversation/drafts.ts`
- Move into the kit, updating every importer (Sessions can't import from a view, call 14):
  - `apps/desktop/src/views/shape/dropped-files.ts` (and its test) to `apps/desktop/src/conversation/dropped-files.ts`
  - `escapeIsTaken` and `escapeHasOwner` (`views/shape/use-shape-keys.ts:15-31`) to
    `apps/desktop/src/conversation/escape.ts`, with their test rows; `escapeIsTaken` also returns true when focus is
    inside an element marked `data-waiting-card` (UI spec §7.7)
- Modify:
  - `apps/desktop/src/views/shape/plan-entries.ts`: `planItemEntries` delegates the common kinds to `itemEntries`
  - `apps/desktop/src/views/inbox/permission-labels.ts:18`: a conversation's card reads "Allow for this session"
  - the kit's `WorkingLine` (M4b): `waiting_card` reads "Waiting for your answer" (UI spec §7.5, review round
    finding 5)

**Interfaces:**

- **Produces:**
  - `ComposerPhase = { stop: 'stop' | 'stop_and_redo' | null; send: 'filled' | 'default' | 'hidden'; placeholder: string; hint: string | null }`.
  - `composerPhase(input: { state: ConversationState; hasText: boolean; steer: 'inject' | 'queue'; project: string; fresh: boolean; narrow: boolean }): ComposerPhase`,
    the Workbench's phase table (`views/workbench/composer-buttons.ts:50-53`) without Sign Off:
    - Not working: Send filled once there is text, else `default`; no Stop.
    - Working (`starting`, `running`, `waiting_card`): Stop with no text, Stop and Redo with text; Send filled
      with text.
    - Placeholders: "Ask about {project}…" (fresh), "Reply…", "Add to this turn…" (working, `inject`), "Queue for
      the next turn…" (working, `queue`). In `paused_account` the hint reads "Sends when the limit resets".
    - Hint: "⌘↩ sends · Esc stops · / commands · @ files" ("/ commands" only with `capabilities.slashCommands` and
      a conversation; a fresh tab's reads "⌘↩ sends · @ files"), or "⌘↩ adds to this turn" while working with
      `inject`; null when `narrow` (under 640 px).
  - `Draft = { text: string; mentions: readonly string[]; pictures: readonly File[] }` and `EMPTY_DRAFT` in
    `drafts.ts`, the Workbench's shape (`views/workbench/drafts.ts:2-10`) plus mentions.
  - `Composer(props: { draft: Draft; onDraft(d: Draft): void; capabilities: AgentCapabilitiesDto; phase: ComposerPhase; disabledReason: string | null; onSend(d: Draft): void; onStop(): void; onRedo(d: Draft): void; inputRef?: Ref<HTMLTextAreaElement> })`:
    - one `bg_1` frame, radius `md`, the input on top and a bar inside the frame: Attach at its left (only with
      `capabilities.images`), Stop or Stop and Redo, then Send, at its right; the hint under the frame
    - the input autosizes from 2 to 10 rows; ⌘↩ sends and Enter is a new line; never while composing (IME,
      `isComposing` or keyCode 229)
    - pictures paste, drop and Attach, checked by `dropped-files.ts`; a type outside `capabilities.images` is
      refused under the input, in words; they wait as 56 px thumbnails with Remove
    - with `disabledReason` (reconnecting, a removed project), Send is disabled with that reason
    - queue chips are not built: no adapter reports `steer: 'queue'` yet **(call)**; `queue` gets only its
      placeholder
  - `PermissionRequest({ items, onAnswered }: { items: readonly InboxItemDto[]; onAnswered?(): void })`:
    - each item drawn by `InboxCard` without the Inbox's key hints, as `views/workbench/page-ask.tsx` draws it,
      keyed by the item, answered through `POST /inbox/:id/answer` with the Inbox's body
      (`views/inbox/card-answer.ts`)
    - pinned above the composer, at most half the pane's height, scrolling inside
    - "Also in your Inbox." in a dimmed `xs` line at each card's foot
    - its root carries `data-waiting-card`; inside it 1–5 pick an option and ⌘↩ sends
  - `ModelPicker({ offered, default, picked, busy, onPick }: { offered: readonly ShapeModelOption[]; default: string | null; picked: string | null; busy: boolean; onPick(model: string | null): void })`
    in `conversation/model-picker.tsx`: Plan's picker made generic (grouped by tier, Default first, "(not offered)"
    for a picked model the account dropped, disabled while `busy`). `views/shape/model-picker.tsx` becomes a
    wrapper that reads its `ShapeViewDto` and renders it, so Plan's `model-picker.test.tsx` stays green.
  - `Announcer({ message }: { message: string | null })`: one polite live region (`aria-live="polite"`), mounted
    once per screen; a new message replaces the last. Copy the Workbench's `announcer.tsx` behaviour.
  - `itemEntries(items: readonly ConversationItemDto[], live: LiveItems, opts: { sendNow: () => void; label: string; receipts: boolean; working: boolean; cards: readonly InboxItemDto[] }): readonly ConversationEntry[]`:
    - `message` → `builder`, its `extra` the mention chips and pictures, plus "Waiting for {label} to read it" while
      `working`, `receipts` is true and `deliveredAt` is null (UI spec §7.8)
    - `agent_message` → `reply` with its `partial`; `reasoning` → `reasoning`; `tool_call` → `tool` (with
      who denied it and why are the call's own `deniedBy` and `refusal` (M2c); nothing is inferred from cards)
    - `notice` → `notice`; a `{ kind: 'model_change', label, model }` notice → a `divider` "Now on {label} ·
      {model}" (call 19)
    - `card` → nothing while open (`PermissionRequest` draws it); once answered, a dimmed `notice` "You allowed this
      once", "You allowed this for the session", "You denied this" or "You answered: {choice}"
    - `plan` → "Made a plan · {n} steps", once; `digest` → nothing; an open `turn_marker` → a `divider` "These
      waited through a restart. Nothing was sent." with **Send Now**
    - then the live items, in first-seen order, as M4b's `planItemEntries` orders them

- [ ] **Step 1: Write the failing pure tables:**
  - `composer-phase.test.ts`: one row per state × text × steer, with its buttons, placeholder and hint; `narrow`
    hides the hint.
  - `item-entries.test.ts`: one row per item kind above (a `model_change` notice → "Now on Claude Code · opus"; a
    denied call keeps its `deniedBy` and `refusal`), plus a builder message waiting for its receipt (and the
    same with `receipts` false: no line), an answered card's history line per answer, and a live reply after the
    stored items.

- [ ] **Step 2: Write the failing rendered tests:**
  - `composer.test.tsx`: ⌘↩ sends and Enter adds a line; a composition never sends; a pasted `image/gif` is refused
    in words when `images` holds png, jpeg and webp; Attach is hidden with no `images`; Stop posts nothing but
    `onStop`; Stop and Redo hands over the draft.
  - `permission-request.test.tsx`: a conversation's permission card shows "Allow for this session" and "Also in
    your Inbox."; pressing 2 then ⌘↩ answers through `/inbox/:id/answer`; Esc in its note is taken
    (`escapeIsTaken` is true with focus inside `data-waiting-card`).
  - Plan's tests (`src/views/shape`) stay green after `planItemEntries` delegates.

- [ ] **Step 3: Watch them fail, implement, and run.**

Run: `pnpm --filter @10db/desktop exec vitest run src/conversation src/views/shape src/views/inbox src/views/workbench`

Expected: PASS.

- [ ] **Step 4: Commit.** Value card:
  - protects: one composer, one in-place card and one announcer for every conversation, and one map from items to
    rows
  - fails_when: ⌘↩ fires mid-composition, a refused picture is sent, a card's Esc stops the turn, or an item kind
    maps to the wrong row
  - why_new: the kit had none of these; Plan's and the Workbench's are their own until M4c
  - no_claim: `@` and `/` (Task 12)

---

### Task 10: The Sessions screen and a fresh tab

This task is a vertical slice.

**Files:**

- Create:
  - `apps/desktop/src/views/sessions/sessions-view.tsx`
  - `apps/desktop/src/views/sessions/sessions-search.ts`, with `?chat=<ChatId>` or `?fresh=<id>`
  - `apps/desktop/src/views/sessions/fresh-tabs.ts`
  - `apps/desktop/src/views/sessions/fresh-tab.tsx`
  - `apps/desktop/src/views/sessions/start-from.tsx`
  - `apps/desktop/src/views/sessions/recent-sessions.tsx`
  - `apps/desktop/src/views/sessions/sessions-view.test.tsx`
  - `apps/desktop/src/views/sessions/fresh-tabs.test.ts`
- Modify:
  - `apps/desktop/src/router.tsx`: the `/sessions` route, as `:137-142`
  - `apps/desktop/src/shell/app-layout.tsx`:
    - `GLOBAL_NAV` (`:46-49`) gains Sessions, third, with the Tabler `messages` icon
    - a header slot (`HeaderSlot`, a context the view fills) between the left box (`:146-157`) and the status
      group (`:158`)
  - `eslint.config.js`: M3's harness-id rule also covers `apps/desktop/src/views/sessions/**`
  - Task 8's files

**Interfaces:**

- **Produces:**
  - `FreshTab = { id: string; projectId: ProjectId; model: string | null; position: number }`.
  - `freshTabs`: a pure reducer, with `open(projects, selectedProjectId, afterPosition)`, `setProject`,
    `setModel` and `remove`. Its state is persisted in `localStorage` key `tendb.sessions.fresh` (call 4), with
    every read and write in try/catch.
  - `useHeaderSlot(node: ReactNode)`: the one way a view puts something in the header. The shell keeps
    `data-tauri-drag-region` on its own boxes, never on the slot's children.
  - `SessionsView`:
    - With no open chat and no fresh tab, it opens a fresh tab (UI spec §12, "No tabs").
    - It renders the selected tab: a fresh one with `FreshTab`, or a chat with Task 11's view.
  - **`FreshTab`.** The empty state of UI spec §6.2, in the upper third:
    - **The intro line:** "A chat reads {project}, runs commands and searches the web. When you're ready, Do It
      starts the work." **(call)** In M5a the line ends after "searches the web.", because Do It comes in M6. M6
      restores the second sentence.
    - **The Project control:** a `Select` with search "Find a project". Changing it calls
      `useSelectedProject().select` (`shell/selected-project.ts:25`). It is fixed once the chat exists (call 4).
    - **The model control:** "{capabilities.label} · {model} ⌄", the kit's `ModelPicker` over `useChatModels`.
    - **On a ChatGPT-plan project** (`ChatModelsDto.unavailable`, call 23): a dimmed `xs` line with the `info` icon
      reading `unavailable`, no model control, and the composer disabled with `unavailable` as its reason. Recent
      and Start from still show.
    - **The account line:** "Uses {project}'s account. Reads the code, runs commands and searches the web. Asks
      before anything that crosses a limit."
    - **The kit's `Composer`**, with the placeholder "Ask about {project}…" and the hint "⌘↩ sends · @ files" (a
      fresh tab has no commands yet).
    - **Start from** (`useSessionStarts`): `subtle xs` buttons, each with its source's Tabler icon by `kind`:
      `alert-circle` (a failed task), `git-commit` (base commits), `folder` (an area). They are not nudges: no
      `sparkles` and no × (UI spec §6.2). A click puts the text in the composer and sends nothing.
    - **Recent** (`useRecentChats`, 6). Each row shows its state mark when it has one, the title, "Chat · {when}",
      and "{n} tasks filed" when `tasksFiled > 0`. A click opens the chat in this tab: it gives the chat this
      fresh tab's position and removes the fresh tab.
  - **The chat is created at the first `@` or the first send** (call 4):
    1. `useCreateChat` with `{ projectId, model, tabPosition }`. A 409 (call 23) shows its words beside Send and
       creates nothing.
    2. The fresh tab is removed and the chat's tab selected (`?chat=`) at once; the draft moves to the chat's
       draft key. An `@` then queries `fetchConversationFiles` for the new conversation.
    3. A send goes from the chat's tab through the kit's send mutation, with the text, pictures and mentions. If it
       fails, the draft stays in the chat's tab and a retry posts to the same conversation: never a second chat.
  - **The sidebar badge.** Sessions shows a `CountBadge` with the phrase "{n} sessions need you" (the local
    `CountBadge` at `app-layout.tsx:75-84`). It is 0 until Task 16.
  - **The header** shows, through the slot, a minimal strip in this task: a tile and a title per tab, `+`. Task 13
    builds the full strip. On Sessions the slot starts just after the traffic lights, at 88 px (the review's measure;
    UI spec §5.1 says 84, Task 19 corrects it), not at the sidebar's edge; on every other view the header is
    unchanged.

- [ ] **Step 1: Write the failing pure test** `fresh-tabs.test.ts`:
  - opening after position 2 places the tab at 3
  - removing it shifts nothing else
  - a corrupt `localStorage` value reads as no fresh tabs

- [ ] **Step 2: Write the failing rendered tests** in `sessions-view.test.tsx`, with `renderApp('/sessions')` and
  `server.use(...chat handlers, ...baseHandlers())`:
  - With no open chats, the screen shows the intro line, the account line and the composer, never a blank page.
  - The sidebar lists Sessions third, after Inbox and Factory.
  - Start from lists the daemon's suggestions, each with its source icon and no dismiss button. A click fills the
    composer and posts nothing.
  - Recent lists the project's sessions. Clicking one selects `?chat=`.
  - Changing Project re-reads Recent and Start from for the new project, and makes it the selected project.
  - Typing and ⌘↩ posts `POST /chats` once, the URL becomes `?chat=<id>`, and the message goes to the new
    conversation. A failed message post (500), then ⌘↩ again, posts the message again to the same conversation and
    `POST /chats` is not called a second time (M5a-8).
  - Typing `@` in a fresh tab creates the chat first, then lists the files from `/conversations/:id/files`; the
    Project control is then disabled.
  - On a ChatGPT-plan project (`unavailable` set): the info line shows its words, Recent and Start from show, the
    composer is disabled, and nothing posts.
  - With no tab needing you, the sidebar's Sessions item shows no badge at all (not a 0).
  - Without the slot (any other route) the header is unchanged: its drag region and the status icons.

- [ ] **Step 3: Watch them fail, implement, and run.**

Run: `pnpm --filter @10db/desktop exec vitest run src/views/sessions`

Expected: PASS.

- [ ] **Step 4: Run it against the real daemon.**
  - In `pnpm dev`, with an account signed in or the fake adapter (`TENDB_FAKE_SCRIPTS`): open Sessions, change
    the project, send a message, and see the chat open.
  - On a project whose account is a ChatGPT plan: the line shows, the composer is disabled, and nothing loops or
    rings. On a Claude plan, a Bedrock and an API-key project the screen is the same, and only a metered one shows
    the cost in the meter's tooltip.
  - In `dev:shell`, run morning check 4: a click on the header's empty part drags the window, and a click on a tab
    doesn't.

- [ ] **Step 5: Commit.** The message is `feat(desktop): Sessions in the sidebar, and a fresh tab that starts a
  chat`, with Task 8's files. Value card:
  - protects: Sessions opens on a fresh tab whose first `@` or send creates exactly one chat in the chosen project,
    and a ChatGPT-plan project says it waits for the next update
  - fails_when: the screen is blank, the first line doesn't title it, or Start from sends
  - why_new: new
  - no_claim: the strip's states (Task 13)

---

### Task 11: The conversation in a tab

This task is a vertical slice.

**Files:**

- Create:
  - `apps/desktop/src/views/sessions/chat-tab.tsx`
  - `apps/desktop/src/views/sessions/session-bar.tsx`
  - `apps/desktop/src/views/sessions/kind-line.ts`
  - `apps/desktop/src/views/sessions/task-row.tsx`
  - `apps/desktop/src/views/sessions/chat-entries.ts`
  - `apps/desktop/src/views/sessions/chat-tab.test.tsx`
  - `apps/desktop/src/views/sessions/chat-entries.test.ts`
- Modify: the kit's `ConversationList` or its entry view, only if it has no way to draw a screen's row in place of
  a tool row. If so, add `renderTool?: (entry: ToolEntry) => ReactNode | null`, returning null to fall back.

**Interfaces:**

- **Consumes:** M4b's conversation queries, `LiveItems` and `WorkingLine`; Task 9's `itemEntries`, `Composer`,
  `PermissionRequest` and `Announcer`; Tasks 8 and 10.
- **Produces:**
  - `chatEntries(entries: readonly ConversationEntry[]): readonly ConversationEntry[]`, over Task 9's
    `itemEntries`. It turns an `mcp` tool call on 10db's server whose tool is a chat tool, and whose `resultTail`
    parses as `ChatToolResult` (the validated boundary), into a `custom` entry that renders `TaskRow`.
  - **A judged denial.** A `tool` entry with `deniedBy: 'judge'` is a dim row, "Held back: this would {limit}"
    (UI spec §7.3, §14), with **Allow This** when `soft` (the kit's, M3 call 8). M5a passes the kit's `onAllow`, which posts "Go ahead: {the call's title}" as the builder's message through
    `POST /conversations/:id/messages` (trust line §5).
  - **`TaskRow`.** A task, task-edit, start or title row (UI spec §7.3, task rows). It is not expandable.
    - A start: the title, "Started", and **Open on Board**. No Undo.
    - A task: a gray dot, the title, "Added to {column}", **Open on Board** (to `/board?task=<id>`) and **Undo**.
      Undo calls `POST /tasks/:id/remove`, then shows the row as removed. The daemon's refusal is said in place,
      for example a started task.
    - A title: "Renamed this session to ‘{title}’" and **Undo**, which patches the title back as the builder's.
    - A task edit (call 25): the title, "Changed {fields}" (the changed fields' names in words, such as "Changed
      the title and the criteria"), **Open on Board**, and **Undo**, which sends `previous` through
      `PATCH /tasks/:taskId` (`api/app.ts:1146`, `TaskPatch`). Undo is offered only while the task is unstarted and
      `previous` is non-empty; it never removes the task.
  - **`SessionBar`**, a 44 px row:
    - **At the left:** the title (weight 600; a double-click or Rename edits it in place; Enter saves through
      `usePatchChat`), and under it the dimmed `xs` kind line from `kindLine(chat, project)`: "Chat · reads
      {project}". A chat writes nothing until M6, which brings the UI spec's "Chat · Your folder · on `{branch}`"
      and "Your folder is in use" lines. Under the bar, the kit's `JudgeLine` (M4b call 36) shows the UI spec's dimmed line when `capabilities.judge` is `rules` (UI spec §11, §14; trust line §10).
    - **At the right:**
      - the model control: "{label} · {model} ⌄", disabled with "Change the model between turns" while a turn
        runs; plain text when `modelSwitch` is `none`
      - the context meter: `ContextGauge` (`views/factory/context-gauge.tsx:3`), 40 px, with UI spec §7.10's
        tooltip, and "${cost} so far" from `conversation.costUsd` when it is not null (call 24)
      - **File as Tasks**, a `default` button
      - the `⋯` menu, with Rename and Archive (Task 15)
  - **File as Tasks** sends the fixed message "File the work we agreed on as tasks on the Board." as the
    builder's turn (spec §7.2).
  - **`ChatTab`.** The 720 px column (UI spec §4), holding:
    - `ConversationList` (`chatEntries` over the live hook's entries)
    - the kit's plan row and `WorkingLine`
    - `PermissionRequest` for the conversation's open cards, pinned above the composer, with "Also in your Inbox."
    - the `Composer`, with the placeholders "Reply…" and "Add to this turn…" by state and `steer`
    - `agentLabel` from `capabilities.label`, so each article's hidden heading names the agent (UI spec §7.1)
    - the model-change divider (call 19), which the kit's `itemEntries` maps

    Each state of UI spec §12 that M5a reaches has its words:
    - **Loading:** the `Loader` in the session bar, then three static dim lines after 300 ms.
    - **Waking up** and **Paused**: the working line's words.
    - **Ended with an error:** "The session stopped. Send a message to start it again." No DTO carries the reason,
      so there is no `{reason}` and no Show Details (call 24).
    - **Model refused:** the red `Alert`, "Not available on this account", with Choose Another Model, from the
      409 of `PATCH /chats/:id` or of the message route. The draft stays.
    - The Signed out alert is not built: no DTO says the account signed out (call 24).
    - **Project removed** (Review Focus 4): the transcript, "This project was removed from 10db.", and no
      composer.
    - **Reconnecting:** Send is disabled with "Reconnecting… your message stays here."

- [ ] **Step 1: Write the failing pure table** `chat-entries.test.ts`:
  - a `create_task` call with a valid result becomes a task row
  - one with an unparseable result stays a tool row
  - a non-chat `mcp` call stays a tool row
  - `set_title` becomes a title row
  - an `edit_task` call with a `task_edit` result becomes a task-edit row, never a create row
  - a `start_task` call with a `start` result becomes a start row

- [ ] **Step 2: Write the failing rendered tests** in `chat-tab.test.tsx`. Fixtures serve a chat, its
  conversation and items, through MSW:
  - The session bar shows the title, the kind line, "Claude Code · opus" (from `capabilities.label`) and the
    meter.
  - A double-click renames; Enter sends `PATCH { title }`.
  - **File as Tasks** posts the fixed message.
  - A task row's Undo posts `/tasks/:id/remove`. A 409 shows the daemon's words in the row.
  - A task-edit row reads "Changed the title", and its Undo sends `PATCH /tasks/:id` with the old title, never
    `/remove`.
  - With `costUsd: 0.42` the meter's tooltip reads "$0.42 so far"; with null it has no cost.
  - A waiting card (an Inbox item with `detail.conversationId`) shows above the composer with "Also in your
    Inbox." Sending its answer posts `/inbox/:id/answer`.
  - A call with `deniedBy: 'judge'` and `limit` shows the limit and **Allow This**; pressing it posts "Go ahead:
    {title}" to the message route.
  - With the project missing from `/projects`, the removed line shows and there is no composer.
  - **Capabilities:** with an empty capability set (`modelSwitch: 'none'`, no `images`, no `slashCommands`,
    no `costUsd`), the model is plain text, Attach is hidden, and the tooltip has no cost.

- [ ] **Step 3: Watch them fail, implement, and run.**

Run: `pnpm --filter @10db/desktop exec vitest run src/views/sessions`

Expected: PASS.

- [ ] **Step 4: Click through against the real daemon** in `pnpm dev`, light and dark:
  - a reply streams, with reads folding and a command row
  - File as Tasks makes task rows
  - Undo removes one
  - a renamed title holds after the agent's `set_title`

- [ ] **Step 5: Commit.** Value card:
  - protects: a chat's tab draws its conversation, its builder-tool rows with Undo, and every state M5a reaches
  - fails_when: a task row loses Undo, a judged denial loses Allow This, a removed project crashes the tab, or a
    provider name is hard-coded
  - why_new: new screen
  - no_claim: live streaming correctness (M4b's reducer tests)

---

### Task 12: The composer on `Mentions`: `@` files and `/` commands

**Files:**

- Modify:
  - the kit's `Composer` (Task 9): its input becomes Mantine `Mentions`
  - its tests
  - the explore engine: store the latest `commands` (call 7)
  - its test
- Create:
  - `apps/desktop/src/conversation/composer-mentions.tsx`
  - `apps/desktop/src/conversation/mention-text.ts` and `apps/desktop/src/conversation/mention-text.test.ts`

**Interfaces:**

- **Produces:**
  - `ComposerMentions = { files?: (q: string, signal: AbortSignal) => Promise<ProjectFileMatchDto[]>; commands: readonly AgentCommandDto[] | null }`,
    a new optional `Composer` prop. Without it, the input still takes ⌘↩, IME and pictures as Task 9 built it.
  - **The `@` mention:** `Mentions.Mention trigger="@"`, `debounceMs={80}`, `maxSuggestions={8}`, data from
    `files`.
    - Each suggestion shows the `file` icon, the name in `fg_1` with the `matches` ranges underlined, and the
      folder in dimmed mono.
    - The markup is `@[path](path)`.
  - **The `/` mention:** `Mentions.Mention trigger={/^(\/(\S*))$/}`, so it fires only at the start of the input.
    Data comes from `commands`. Each row shows `/name` in mono, the description dimmed, and the `argumentHint`.
    It is shown only with `capabilities.slashCommands`.
  - `mentionText(value: string): { text: string; mentions: string[] }`. It turns the markup into `@path` and
    `/name` text and lists the paths.
  - **The send key** (⌘↩) does nothing while a suggestion list is open. Enter and Tab pick.
  - **The engine** writes `conversations.commands` on each `commands` event, emitting `conversation.state`, and
    `ConversationDto.commands` reads it.

- [ ] **Step 1: Write the failing pure table** `mention-text.test.ts`:
  - `@[src/a b.ts](src/a b.ts) why` → `@src/a b.ts why`, `['src/a b.ts']`
  - two mentions
  - a command `/[compact](compact)` → `/compact`
  - plain text, unchanged

- [ ] **Step 2: Write the failing rendered tests:**
  - Typing `@log` lists the files the stub returns, at most 8.
  - Enter picks one and inserts a chip, and the send doesn't fire. ⌘↩ while the list is open sends nothing.
  - ⌘↩ after it sends `{ text: '@src/login.ts why', mentions: ['src/login.ts'] }`.
  - `/` at the start lists `/compact` with its description. `/` mid-sentence lists nothing.
  - With `slashCommands` false, `/` types a slash.
  - Composition (an IME `compositionstart` with keyCode 229) never sends.
  - Task 9's composer tests stay green unchanged.

- [ ] **Step 3: Write the failing engine test.** A fake explore session that emits `commands` leaves the
  conversation's `commands` stored, and readable while it is cold.

- [ ] **Step 4: Watch them fail, implement, and run.**

Run: `pnpm --filter @10db/desktop exec vitest run src/conversation src/views/sessions && pnpm --filter @10db/daemon exec vitest run src/conversation`

Expected: PASS.

- [ ] **Step 5: Click through against the real daemon:** `@` lists the project's files, and `/` lists Claude's
  commands after the first turn.

- [ ] **Step 6: Commit.** Value card:
  - protects: `@` inserts tracked paths and `/` lists the agent's commands, without the send key firing mid-pick
  - fails_when: ⌘↩ sends while a list is open, `/` fires mid-text, or mentions lose their paths
  - why_new: the composer was a plain textarea
  - no_claim: that the agent reads the file (the explore judge decides)

---

### Task 13: The tab strip: anatomy, states and many tabs

This task is a vertical slice.

**Files:**

- Create:
  - `apps/desktop/src/views/sessions/tab-strip.tsx`
  - `apps/desktop/src/views/sessions/session-tab.tsx`
  - `apps/desktop/src/views/sessions/tab-state.ts` and `apps/desktop/src/views/sessions/tab-state.test.ts`
  - `apps/desktop/src/views/sessions/all-tabs-menu.tsx`
  - `apps/desktop/src/views/sessions/seen.ts`
  - `apps/desktop/src/views/sessions/tab-strip.test.tsx`
- Move: `apps/desktop/src/views/board/edge-fade.tsx` to `apps/desktop/src/shell/edge-fade.tsx`, and update the
  Board's imports (call 14).

**Interfaces:**

- **Produces:**
  - `TabState = { NeedsYou, Error, Paused, Working, NewReply, Idle }` (call 15). Its values are `'needs_you'`,
    `'error'`, `'paused'`, `'working'`, `'new_reply'` and `'idle'`.
  - `tabState(input: { state: ConversationState; openCards: number; lastReplyAt: string | null; seenAt: string | null }): TabState`.
    The first that holds wins, in UI spec §5.3's order.
  - `tabWords(state: TabState, detail): { spoken: string; mark: 'dot_blue' | 'dot_yellow' | 'alert_red' | 'pause_orange' | null; ring: 'yellow' | 'red' | null; bold: boolean }`.
    No state is told by color alone (UI spec §5.3, WCAG 1.4.1). The spoken words are §5.3's: "needs you: {card
    title}", "needs you: stopped by an error", "paused: usage limit, resumes {time}", "working", "new reply".
  - `needsYou(state: TabState): boolean`: true for Needs you and Error (the Sessions badge and ⌘J; UI spec §20
    item 11).
  - `seen.ts`: `markSeen(chatId, at)` and `seenAt(chatId)`, over `localStorage` `tendb.sessions.seen` (call 12).
    A tab is seen while it is selected and the window has focus.
  - **`SessionTab`.** A pill 30 px tall, radius `md`, its title's natural width up to 220 px (UI spec §5.2). Left
    to right:
    - `ProjectTile` at size 16 (`shell/project-tile.tsx:4`)
    - the title, truncated
    - the state mark: an 8 px blue dot (Working), a yellow dot (Needs you), Tabler `alert-triangle` 12 px red
      (Error), `player-pause` 12 px orange (Paused), or nothing
    - × (14 px) on hover and on the selected tab, **in the state mark's place**, so it adds no width; hidden from
      assistive tech

    Hovered and selected tabs take the `bg_1` fill, and the selected title is `fg_1` at weight 600. Needs you adds
    a 1 px yellow ring and Error a 1 px red ring; the ring stays while × shows. A tooltip after 500 ms gives title,
    then "{project} · Chat · {label} {model}", then the spoken state.
  - `tabWidths(natural: readonly number[], selected: number, available: number): readonly number[]`, pure: each tab
    its natural width up to 220; when they don't fit, the other tabs shrink first, evenly, down to 96, and the
    selected tab last; when even that doesn't fit, every other tab is at 96, the selected one keeps its natural
    width, and the strip scrolls.
  - **`TabStrip`.** A `role="tablist"`. Each tab is a `role="tab"` with `aria-selected`, `aria-controls`, and the
    name "{title}, {project}, {state words}". The selected tab's content (Task 11's `ChatTab`, Task 10's fresh tab)
    sits in one `role="tabpanel"` whose `id` is `session-panel-<chat id or fresh id>`, which `aria-controls` names,
    and which is labelled by the tab.
    - ← and → move focus. Enter selects (manual activation). Delete closes.
    - Drag to reorder uses `@dnd-kit/sortable`'s horizontal strategy, posting `PATCH { tabPosition }`.
    - Widths come from `tabWidths`. Past 96 px the strip scrolls sideways and fades at a hidden edge, with
      `useHiddenEdges` (`shell/use-hidden-edges.ts:31`) and `EdgeFade`.
    - The strip's empty space keeps `data-tauri-drag-region`, and a double-click there zooms the window (call 22);
      a double-click on a tab renames it.
    - `+` carries the tooltip "New Session ⌘T".
    - **All Tabs** (`chevron-down`) lists every tab (tile, title, state) and the last five closed (Task 15). It has
      a `CountBadge` of the hidden tabs that need you.
  - **Selecting a tab** sets `?chat=`, makes its project the selected project (UI spec §3, its call) and marks it
    seen. Focus goes to its composer.
  - **Titles:** a new chat shows its first line at once. `set_title` and renames replace it with no animation.

- [ ] **Step 1: Write the failing pure tables:**
  - `tabState`:
    - `waiting_card` with one open card → needs you
    - `ended_error` with no card → error (red ring), and `needsYou` is true
    - `running` with a card → needs you (a card wins)
    - `ended_error` → error
    - `paused_account` → paused
    - `starting`, `running` and `stopping` → working
    - `idle_warm` with a reply after `seenAt` → new reply
    - the same, seen → idle
    - `idle_cold` with no reply → idle
  - `tabWords`: one row per state, with the mark, the ring, bold and the words. No state but Working and Idle is
    told by a bare dot alone.
  - `tabWidths`: five 180 px tabs in 1,000 px all fit; eight in 1,000 px shrink the others first and keep the
    selected at 180; twelve overflow at 96, and the selected keeps its width.

- [ ] **Step 2: Write the failing rendered tests** in `tab-strip.test.tsx`:
  - Three open chats render as a tablist of three, named "{title}, {project}, {state}", and the selected tab's
    `aria-controls` names the `tabpanel` that is rendered.
  - At the compact width (stub `useMediaQuery` to 800 px), an unselected tab renders only its tile and state mark,
    and the selected one keeps its title.
  - → then Enter selects the second, and the URL and the selected project follow.
  - Delete on a focused tab closes it (`PATCH { tabPosition: null }`).
  - A needs-you tab has `data-ring`.
  - Twelve tabs at a strip width that hides some: All Tabs shows the `CountBadge` of the hidden needs-you tabs
    (stub the edge measure through `useHiddenEdges`' scroll handler).

- [ ] **Step 3: Watch them fail, implement, and run.**

Run: `pnpm --filter @10db/desktop exec vitest run src/views/sessions src/views/board`

Expected: PASS.

- [ ] **Step 4: Click through against the real daemon** with six chats:
  - drag a tab to reorder, and reload: the order holds
  - the needs-you ring shows on a tab whose agent's call the judge asks about (a `remove_task` on a task the
    builder made)
  - a working tab's dot is static blue
  - in `dev:shell`, a tab click doesn't drag the window, and a double-click on the empty strip zooms it (call 22)
  - at 1080 px with five tabs, each title stays readable

- [ ] **Step 5: Commit.** Value card:
  - protects: each tab says its project, its title and one state, by DESIGN.md's colors, in a keyboard tablist
  - fails_when: the state order changes, a needs-you tab hides past the edge with no badge, or a tab drags the
    window
  - why_new: new
  - no_claim: M6 and M7's states

---

### Task 14: The keyboard

**Files:**

- Create:
  - `apps/desktop/src/views/sessions/session-keys.ts` and `apps/desktop/src/views/sessions/session-keys.test.ts`
  - `apps/desktop/src/views/sessions/use-session-keys.ts`
  - `apps/desktop/src/shell/use-new-session-key.ts`
- Maybe modify: `apps/desktop/src-tauri/src/lib.rs` (Step 5's fallback)

**Interfaces:**

- **Produces:**
  - `SessionKey` is a union of `new`, `close`, `reopen`, `go(index: 0..7)`, `last`, `prev`, `next`, `next_needing`
    and `stop`.
  - `sessionKey(press: { key; meta; shift; ctrl; alt }, place: { onSessions: boolean; escapeTaken: boolean }): SessionKey | null`:
    - ⌘T → `new`, anywhere
    - ⌘W → `close`
    - ⌘⇧T → `reopen`
    - ⌘1 to ⌘8 → `go`
    - ⌘9 → `last`
    - ⌘⇧[ or ⌃⇧Tab → `prev`
    - ⌘⇧] or ⌃Tab → `next`
    - ⌘J → `next_needing`: the next tab after the selected one, in strip order and cycling, for which `needsYou`
      holds; nothing when none does
    - Esc → `stop`, unless `escapeTaken`

    Every key but ⌘T acts only on Sessions. ⌘N is never taken.
  - `useNewSessionKey()`, mounted in the shell. ⌘T opens `/sessions` with a fresh tab in the selected project.
  - A click on the sidebar's Sessions badge does `next_needing` from any view (UI spec §5.5).
  - Esc reads `escapeIsTaken` from `conversation/escape.ts` (Task 9), which counts focus inside a waiting card as
    taken.
  - `useSessionKeys(handlers)`, mounted on Sessions. It calls `preventDefault` on each key it takes.

- [ ] **Step 1: Write the failing pure table**, one row per key and place:
  - ⌘J → `next_needing`
  - Esc with `escapeTaken` true (focus in a waiting card's note, Task 9) → null
  - ⌘T off Sessions → `new`
  - ⌘W off Sessions → null
  - ⌘N → null
  - Esc with a menu open → null
  - ⌃Tab → `next`

- [ ] **Step 2: Write the failing rendered test.** On `/board`, ⌘T lands on `/sessions` with a fresh tab. On
  Sessions with three tabs:
  - ⌘2 selects the second
  - ⌘9 selects the last
  - ⌘⇧[ goes back
  - ⌘W closes the selected tab, and focus moves right (or left from the last)
  - with the second and fourth tabs needing you and the first selected, ⌘J selects the second, then the fourth,
    then the second again; the sidebar badge's click does the same from `/board`

- [ ] **Step 3: Watch them fail, implement, and run.**

Run: `pnpm --filter @10db/desktop exec vitest run src/views/sessions src/views/shape src/shell`

Expected: PASS.

- [ ] **Step 4: Live check in `dev:shell`.** ⌘W closes the tab and not the window; ⌘T opens a tab.

- [ ] **Step 5: Fallback, only if ⌘W closes the window.**
  - Give the app its own macOS menu in `lib.rs`: Tauri's default items, but Close Window without the ⌘W
    accelerator.
  - Its handler still hides the window as `:96-97` does. Off Sessions, ⌘W reaches the webview, which hides the
    window itself through `getCurrentWindow().hide()`; the capability gains `core:window:allow-hide`.
  - Re-run Step 4.
  - Add repo-test rows (`tests/repo/src/desktop-opener.test.ts`'s window block): the menu's Close Window has no ⌘W
    accelerator, and the capability holds `core:window:allow-hide`.

- [ ] **Step 6: Commit.** Value card:
  - protects: ⌘T works anywhere, and ⌘W, ⌘⇧T, ⌘1-9 and tab cycling act only on Sessions
  - fails_when: a key leaks to other views, ⌘N is taken, or Esc stops a turn while a menu owns it
  - why_new: no such keys existed
  - no_claim: the native menu, beyond the live check

---

### Task 15: Close, Archive and Reopen

This task is a vertical slice.

**Files:**

- Create:
  - `apps/desktop/src/views/sessions/closed-tabs.ts` and `apps/desktop/src/views/sessions/closed-tabs.test.ts`
  - `apps/desktop/src/views/sessions/tab-menu.tsx`
- Modify:
  - `tab-strip.tsx`, `all-tabs-menu.tsx`, `session-bar.tsx`
  - Sessions' drafts (Task 9's `Draft`): keyed by chat and kept in `localStorage` (`tendb.sessions.drafts`), text
    and mentions only, so a closed tab's draft survives its reopening and a restart. Pictures are dropped on
    restart, as the Workbench's are.

**Interfaces:**

- **Produces:**
  - `closedTabs`: a pure stack of at most five `{ chatId, position }`, newest first (call 21). It provides `push`,
    `pop` and `take(chatId)`. An entry may be marked `archived`. It is persisted in `localStorage` (call 12).
  - **Close** (× , ⌘W, Delete, or Close Tab in the menu): `PATCH { tabPosition: null }`, then push. Nothing stops
    on the daemon; a warm chat stays warm until its idle close. No confirm.
  - **Reopen** (⌘⇧T, or a closed row in All Tabs): pop, then `PATCH { tabPosition: <its remembered position> }`,
    clamped to the strip's length. A chat not in the stack opens right of the current tab.
  - **The tab menu** (right-click and the `⋯` menu): Rename · Archive · Close Tab · Close Other Tabs. Open in
    Terminal (M7) and Close Finished Tabs (M6, call 15) are not listed.
  - **Archive:** `useArchiveChat`. It closes the tab and pushes it onto the closed stack marked `archived`, with no
    confirm (UI spec §5.6). A refusal shows its words in a notification line under the strip.
  - **Reopening an archived chat** (All Tabs' closed rows show it with the dimmed word "Archived"): Reopen posts
    `POST /chats/:id/unarchive`, then the position (call 26). Its transcript is back; the full output on disk is
    not, so its rows' Show All Output is absent.

- [ ] **Step 1: Write the failing pure table** `closed-tabs.test.ts`:
  - push 6 and five remain, each with its position
  - `take` of a chat in the middle removes it and returns its position
  - pop returns the newest
  - an archived push keeps the `archived` mark, and `take` returns it
  - a corrupt store reads as empty

- [ ] **Step 2: Write the failing rendered tests:**
  - Close then ⌘⇧T restores the tab at its place, with its draft text (Review Focus 3).
  - Close Other Tabs leaves one.
  - Archive removes the tab, and Recent no longer lists it; All Tabs lists it as Archived, and Reopen posts
    `/unarchive` and brings the tab back.
  - All Tabs lists the last closed with Reopen.

- [ ] **Step 3: Watch them fail, implement, and run.**

Run: `pnpm --filter @10db/desktop exec vitest run src/views/sessions`

Expected: PASS.

- [ ] **Step 4: Click through against the real daemon:**
  - close a working tab, and its reply still arrives (reopen it to see)
  - archive a chat, and its folder under the data dir is gone

- [ ] **Step 5: Commit.** Value card:
  - protects: closing loses nothing and ⌘⇧T restores the tab and its draft; archive takes the session out of
    Recent
  - fails_when: a close stops a turn, a draft is lost, or an archived chat comes back
  - why_new: new
  - no_claim: archiving from `taken_over` (M7)

---

### Task 16: "Needs you" mirrors the Inbox, and notifications

This task is a vertical slice.

**Files:**

- Create:
  - `apps/desktop/src/views/sessions/needs-you.ts` and `apps/desktop/src/views/sessions/needs-you.test.ts`
  - `apps/desktop/src/desktop/notify-chat.ts` and `apps/desktop/src/desktop/notify-chat.test.tsx`
  - `apps/desktop/src/views/settings/sessions-section.tsx`
  - `apps/desktop/src/daemon/sessions-settings-queries.ts`
  - `apps/daemon/src/chat/settings.ts`, with its route rows in `app.test.ts`
- Modify:
  - `apps/desktop/src/shell/app-layout.tsx`: the Sessions badge's count
  - `apps/desktop/src/views/inbox/inbox-card.tsx`: Open Session
  - `apps/desktop/src/desktop/sync.ts`: the listener and the notifications, beside `:64-70` and `:83-100`
  - `apps/desktop/src/desktop/tauri.ts:156` (`notifyNewCard`): a card whose detail names a chat's conversation is
    worded "{title} needs you" and its click opens the tab
  - `apps/desktop/src/views/settings/sections.ts`: `SettingsSectionKey.Sessions`, a global section, with its row
    in `sections.test.ts`
  - `apps/desktop/src/views/settings/section-body.tsx`: the `Sessions` arm
  - `apps/daemon/src/api/app.ts`: `GET` and `PUT /settings/sessions`, as `:1402-1407`

**Interfaces:**

- **Produces:**
  - `openCardsByConversation(items: readonly InboxItemDto[]): ReadonlyMap<ConversationId, InboxItemDto[]>`. It
    reads `detail.conversationId`, parsed with `ConversationId.safeParse` (the boundary). The tab, the badge and
    the announcer read only this; nothing is stored (UI spec §5.7).
  - `useSessionsNeedingYou(): number`: the open tabs for which `needsYou` holds (an open card, or stopped by an
    error), as UI spec §20 item 11 counts them. The sidebar badge's phrase is "{n} sessions need you".
  - **The Inbox card**, for an item whose detail names a chat's conversation:
    - The card names the session: the project label, a "Chat" badge, and the title.
    - **Open Session** selects the tab, with the cursor in its composer. When the tab is closed, it reopens it at its
      remembered place (`closedTabs.take`, call 21), else right of the current tab.
    - Answering in either place uses the same `POST /inbox/:id/answer`.
  - **Notifications:**
    - `notifyChatReplied(chat, firstLine)` sends "{title} replied" with the first line.
    - A chat's card raises **one** notification: the existing `notifyNewCard`, worded "{title} needs you" for a
      chat's card. There is no second notifier for cards (M5a-13).
    - `listenForChatClicks(onClick)` is registered once, as `listenForPassClicks` is (`notify-pass.ts:81`). A click
      selects the tab and brings the window forward.
  - **When a notification fires:**
    - Only while `document.hasFocus()` is false, so never for the tab in view.
    - A reply notifies only when `notifyReplies` is on.
    - A reply is a chat conversation going from `running` or `stopping` to `idle_warm` or `idle_cold`, as read from
      the `conversation.state` refetch. `sync.ts` remembers the last state per conversation.
  - **The Settings section "Sessions"** holds one `SettingRow`: "Notify when a chat replies", a `Switch`, on by
    default, read through `GET /settings/sessions` (`app_settings` key `sessions`) (call 11).

- [ ] **Step 1: Write the failing pure test** `needs-you.test.ts`:
  - two items for one conversation and one for another
  - a malformed `conversationId` is ignored
  - a resolved item is not counted

- [ ] **Step 2: Write the failing rendered and notification tests:**
  - An open card for a chat makes its tab ring and the sidebar badge read 1. Answering it in the tab clears both
    after the Inbox refetch.
  - The Inbox card shows Open Session. A click lands on `/sessions?chat=<id>` with the composer focused. For a
    closed tab, the click first posts `PATCH { tabPosition }` with its remembered position.
  - A chat stopped by an error counts in the badge with no Inbox card.
  - A chat's new card sends exactly one notification, "{title} needs you" (spy on `sendNotification` through
    `mockIPC`).
  - `notifyChatReplied` sends nothing while the document has focus, or when the setting is off. Otherwise it sends
    once (mock `@tauri-apps/plugin-notification` through `mockIPC`, as `notify-pass.test.tsx` does).
  - The daemon route rows: `PUT /settings/sessions { notifyReplies: false }` round-trips, and a missing key reads
    `true`.
  - Settings lists Sessions among the global sections (`sections.test.ts`), and its body shows the switch.
  - The sidebar badge renders nothing at 0, and "1" with "1 session needs you" read aloud at 1.

- [ ] **Step 3: Watch them fail, implement, and run.**

Run: `pnpm --filter @10db/desktop exec vitest run src/views/sessions src/views/inbox src/desktop src/views/settings && pnpm --filter @10db/daemon exec vitest run src/chat src/api/app.test.ts`

Expected: PASS.

- [ ] **Step 4: Click through against the real daemon and in `dev:shell`:**
  - a card the judge raised (a `remove_task` on a task the builder made) rings the tab and shows in the Inbox
  - answering in the Inbox clears the ring
  - with the window behind another app, a reply raises "{title} replied", and a click opens the tab

- [ ] **Step 5: Commit.** Value card:
  - protects: a tab needs you exactly when the Inbox holds a card for its conversation, and a notification fires
    only out of view
  - fails_when: a second queue appears, a ring outlives its card, or a notification fires for the tab in view
  - why_new: new
  - no_claim: Ready cards (M6)

---

### Task 17: Narrow windows and accessibility

**Files:**

- Create:
  - `apps/desktop/src/views/sessions/strip-layout.ts` and `apps/desktop/src/views/sessions/strip-layout.test.ts`
  - `apps/desktop/src/views/sessions/tab-switcher.tsx`
  - `apps/desktop/src/views/sessions/session-announcements.ts` and
    `apps/desktop/src/views/sessions/session-announcements.test.ts`
- Modify:
  - `apps/desktop/src/shell/app-layout.tsx:116`: `folded` also when `narrow` on `/sessions`
  - `tab-strip.tsx`, `session-bar.tsx`, `chat-tab.tsx`

**Interfaces:**

- **Produces:**
  - `stripLayout(width: number): 'full' | 'compact' | 'switcher'`: `full` at 900 px or wider, `compact` from 640
    to 899, `switcher` under 640 (UI spec §13.2).
  - **Compact:** unselected tabs show only their tile and state; the session bar's model and meter move into `⋯`.
  - **The switcher:** one control in the header with the tile, the title and its state, a `CountBadge` of the
    other tabs that need you, and a chevron that opens All Tabs. `+` stays. Tool rows drop their durations, and
    the hint line hides.
  - `sessionAnnouncement(event): string | null`. The words are UI spec §13.1's:
    - "{label} replied: {first sentence}"
    - "{label} asks to run a command. Answer it above the message box."
    - "The session stopped"
    - "Paused: usage limit, resumes {time}"
    - "{title} in {project} needs you", for another tab

    These go through the kit's one polite `Announcer`. The transcript is never `role="log"`, and it is
    `aria-busy` while a reply streams.
  - **Focus order:** sidebar, strip, session bar, transcript (`role="group"`, "Messages", one `article` per message
    with its hidden speaker heading), plan row and cards, composer. ⇧Tab from the composer reaches a waiting card.
    Switching tabs puts the cursor in the composer; a tab with no composer focuses its transcript (call 20).
  - **Reduced motion:** with `prefers-reduced-motion`, the strip's fades and the scroll to the tail jump.

- [ ] **Step 1: Write the failing pure tables:**
  - `stripLayout`: rows at 420, 639, 640, 899, 900 and 1280
  - `sessionAnnouncement`: one row per event, plus a streaming delta, which gives null

- [ ] **Step 2: Write the failing rendered test.** At 600 px (stub `useMediaQuery` through the `matchMedia` stub in
  `test/setup.ts:26`):
  - the switcher shows the selected title and a `CountBadge` of 1 when another tab needs you
  - the sidebar is folded behind the burger

- [ ] **Step 3: Watch them fail, implement, and run.**

Run: `pnpm --filter @10db/desktop exec vitest run src/views/sessions src/shell`

Expected: PASS.

- [ ] **Step 3b: Run it against the real daemon.** In `pnpm dev` at 480, 800 and 1280 px: the switcher, the
  compact tabs and the full strip each work with the keyboard alone, the sidebar folds under 900 px, and VoiceOver
  reads a tab as "{title}, {project}, {state}" and a reply's heading as the agent's label.

- [ ] **Step 4: Commit.** Value card:
  - protects: Sessions stays usable from 420 px, and announces only what the builder acts on
  - fails_when: the switcher hides a needs-you tab, the sidebar covers the window, or tokens are read aloud
  - why_new: new
  - no_claim: the real window's width (the e2e at 480)

---

### Task 18: The e2e against the real daemon

**Files:**

- Create: `apps/desktop/e2e/sessions.spec.ts`
- Modify:
  - `apps/desktop/e2e/script-book.json`: the chat scripts
  - `apps/daemon/src/sessions/fake-adapter.ts:358-359`: the `Chat: ` key for explore sessions (call 17)
  - its test, a new row in the matcher's table
  - `apps/desktop/AGENTS.md`: the e2e bullet

**Interfaces:**

- **The fake's matcher:** `Chat: <text>` keys match an explore session of a chat conversation whose first prompt
  line is exactly `<text>`. Sessions follow `spec.sequence`, as for tasks. If M2c's fake has no `commands` step, add
  `{ "do": "commands", "commands": AgentCommandDto[] }`.
- **The book entry** `"Chat: Why does login fail after sleep?"`. Session 1 runs these steps:
  1. `commands` with `/compact`
  2. a `tool` Read of `src/login.ts`
  3. a `tool` Bash `rg -n retry src`
  4. a `turn_complete` whose text is markdown: a heading, a list, a `ts` fence, and the link
     `https://example.com/retry`
  5. `mcp set_title { title: "Login fails after sleep" }`
  6. `await_message` "File the work we agreed on"
  7. `mcp create_task { title: "Retry login once on a 401" }`
  8. `mcp start_task` on it, which starts it with no card
  9. `mcp remove_task` on a task the builder made, so the tool asks and waits on a card
  10. `turn_complete`
- **The spec,** in name order. It runs after `see-screen.spec.ts` and before `shape.spec.ts`, with one worker:
  1. `createProject(request, 'sessions', [{ name: 'repo', globs: ['**'] }], { 'src/login.ts': …, 'docs/a b.md': … })`
     (`e2e/shape-project.ts:52`), then `claudeIsInstalled(page)`. Seed `tendb.project`, and the scheme dark, as
     `workbench.spec.ts:152-157` does.
  2. At 1280, open `/board` and press ⌘T. The fresh tab shows its lines. Scan: fresh tab at 1280 and 480, dark and
     light.
  3. Type the first line, then `@log`, pick `src/login.ts`, and press ⌘↩. The tab's title shows the first line,
     then "Login fails after sleep".
  4. The reply shows its heading and code block, inside an article headed "Claude Code". A read row and a command
     row show.
  5. The link opens the browser confirm "Open example.com in your browser?". Cancel it.
  6. Press File as Tasks. The task row "Retry login once on a 401 · Added to Ready" shows, then its start row.
     The judge's card for removing the builder's task sits above the composer:
     - the tab has its ring, and ⌘J from the second tab selects it
     - the sidebar reads 1
     - the Inbox lists it with Open Session

     Scan: a waiting card at 1280 and 480, dark and light.
  7. Answer Deny in the tab. The ring and the badge clear, the builder's task stays, and the turn ends.
  8. Open the started task on the Board from its row.
  9. Type `/`. The menu lists `/compact`. Press Esc.
  10. Open All Tabs and scan the open menu (1280, dark and light); close it. Press ⌘T for a second tab, then ⌘1. Press ⌘W on the second, then ⌘⇧T: it is back. Close it again.
  11. Reload. The tab is restored from `GET /chats?open=1`.
  12. At 480 the switcher shows. Scan: conversation, 480, dark and light.
  13. Archive the chat from the `⋯` menu. The strip has a fresh tab, and Recent doesn't list it.
- A `MutationObserver` records the announcer's messages, as `workbench.spec.ts` does. It asserts "Claude Code
  replied: …" and "… asks …".

- [ ] **Step 1: Add the matcher row** to the fake's test: a chat prompt matches its `Chat:` key, and a task prompt
  doesn't. Watch it fail, then implement the matcher.

Run: `pnpm --filter @10db/daemon exec vitest run src/sessions/fake-adapter.test.ts`

Expected: PASS.

- [ ] **Step 2: Write the spec and the book entry, and run it until it is green.**

Run: `pnpm --filter @10db/desktop e2e sessions.spec.ts`

Expected: PASS, with every axe scan clean (`expectAccessible`, `e2e/expect-accessible.ts:9`).

- [ ] **Step 3: Run the specs around it.**

Run: `pnpm --filter @10db/desktop e2e shape.spec.ts workbench.spec.ts`

Expected: PASS.

- [ ] **Step 4: Commit.** Value card:
  - protects: a chat end to end on the real daemon: mention, reply, task and start rows, a judge's card in tab and
    Inbox, keys, reload, archive, at two widths and both schemes
  - fails_when: any of those steps breaks, or axe finds a violation
  - why_new: Sessions had no e2e
  - no_claim: the Tauri window (checked by hand)

---

### Task 19: The decision, the docs, and the PR

**Files:**

- Create: `docs/architecture/decisions/./2026-11-12-sessions-is-a-top-level-screen-and-a-chat-is-attended.md`
  (use the commit's own date)
- Modify:
  - `apps/desktop/AGENTS.md`: a Sessions bullet
  - `apps/daemon/AGENTS.md`: a `chat/` section
  - `DESIGN.md`: the eleven updates UI spec §20 lists for M5a

- [ ] **Step 1: Write the decision record.** It records:
  - S1: Sessions is a global screen, third in the sidebar, with tabs in the title bar across projects.
  - S2 and S19: a chat is attended (trust line §5). It reads, runs commands and searches the web with the
    builder's setup, and asks only at a limit. Its writes in Your folder come in M6, with the folder hold.
  - S13: "needs you" is the Inbox, read through `detail.conversationId`, never a second queue.
  - S14: every builder tool is on a chat's token; removing or retiring the builder's work asks with a card, decided
    by the tool. Calls 1 and 2 give the table and the server.
  - A fresh tab becomes a chat at its first `@` or first send, and its project is fixed from then (call 4).
  - Until M5b, a ChatGPT-plan project's Sessions says chats come with the next update (call 23).
  - An archived chat comes back through All Tabs' closed rows until M8's ⌘K (call 26).
  - Why: the specs' reasons, and the alternatives turned down:
    - mounting `/builder/mcp` in a session, which would hand it the UI token's reach
    - a column on `tasks`
    - a fresh tab stored on the daemon

- [ ] **Step 2: Update the docs.**
  - **The UI spec** (`docs/superpowers/specs/2026-11-11-10db-sessions-ui.md`), as facts the build settled: §5.7's
    "Settings › General gets 'Notify when a chat replies'" becomes Settings › Sessions (call 11); §7.9's `@` list
    reads `GET /conversations/:id/files`; §5.1's 84 px becomes 88 px.
  - **`DESIGN.md`,** UI spec §20's eleven items, each into the bullet it names:
    1. Scope follows the question: the global group reads Inbox, Factory, Sessions.
    2. Navigation: on Sessions only, the header holds the tab strip from 88 px, keeps its empty space as a drag
       region, and zooms the window on a double-click there.
    3. Status: never told by color alone; a bare dot means running, a dot with a ring waits on the builder (yellow,
       or red for a failure); failed, paused and done are icons in their colors. This extends Card state to tabs.
    4. Green on a tab means landed; a signed-off pass that isn't closed is a dimmed check (M6 draws it; the rule is
       written now).
    5. Fills: `bg_1` is the builder's own message; code, command output, banners and read-only lines sit on `bg_0`
       with a 1 px `bg_2` border.
    6. Diffs: colored text on `bg_1`, changed words on `bg_2`, no tinted rows, 10db's own gutter per hunk.
    7. Nudges: a suggestion built by rules is not a nudge; it shows its source's icon, with no sparkles and no ×.
    8. Agent output renders as markdown through one component, by
       `docs/architecture/decisions/./2026-11-12-agent-output-renders-as-hardened-markdown.md`, with a Selenized Shiki theme.
    9. Tool calls are rows, not cards; cards stay for what the builder answers.
    10. Keys: ⌘↩ sends in every composer; ⌘T, ⌘W, ⌘1–9, ⌘⇧[ ], ⌘J and ⌘K on Sessions.
    11. Counts: the Sessions badge counts the tabs that need the builder: Needs you, Ready and Stopped by an error.
  - **`apps/desktop/AGENTS.md`**, the Sessions bullet. It covers:
    - the route and the search
    - the header slot
    - fresh tabs in `localStorage`
    - tab states from `tab-state.ts`
    - needs-you from the Inbox
    - the keys, with ⌘T global
    - the e2e
    - the harness-id lint
  - **`apps/daemon/AGENTS.md`**, the `chat/` section. It covers:
    - the hooks
    - `chat_tasks`
    - the tool policy table
    - the files and session-starts routes
    - archive through the engine

- [ ] **Step 3: Run the gate.**

Run: `make gate`

Expected: `GATE PASS`.

- [ ] **Step 4: Commit, push and open the PR.**

```bash
git add docs/architecture/decisions/./2026-11-12-sessions-is-a-top-level-screen-and-a-chat-is-attended.md apps/desktop/AGENTS.md apps/daemon/AGENTS.md DESIGN.md && git commit -m 'docs: Sessions is a top-level screen, and a chat is attended with every builder tool judged

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
git push -u origin feat/sessions-m5a
gh pr create --title 'feat: Sessions, chats with an agent in tabs, on Claude' --body '<summary; the Task 0 name mapping; the click-throughs and live checks run; the calls list>

🤖 Generated with [Claude Code](https://claude.com/claude-code)'
```

Before review, the PR must have run:

- `sessions.spec.ts`, `shape.spec.ts` and `workbench.spec.ts` in WebKit
- the click-throughs of Tasks 10 to 16 in `pnpm dev`
- the `dev:shell` checks of Tasks 10, 13, 14 and 16

## Review round 1: where each finding went

| # | Finding | Where it went |
| --- | --- | --- |
| M5a-1 | `@` files by conversation; the client never sends a path | Architecture; calls 4 and 9; Task 6 is now `GET /conversations/:id/files` with `conversationFiles`, its 404 and `root` 400 rows, the real-git test kept; Task 8's key and fetcher; Task 10 creates the chat at the first `@` or send, fixes the Project control, and drops "/ commands" from the fresh tab's hint; Task 19's decision |
| M5a-2 | A ChatGPT-plan project loops and rings | Call 23; Task 1's `ChatModelsDto.unavailable`; Task 3's service and route rows (409); Task 10's line, disabled composer, render row and click-through on ChatGPT, Claude plan, Bedrock and API-key projects |
| M5a-3 | The model change is a `model_change` notice | Call 19; Task 1 widens the notice body; Task 3 stores it in the engine's `modelChanged` (Step 2b, engine harness, Plan too); Task 9's `itemEntries` maps it, with a row; `chatEntries` no longer does |
| M5a-4 | `edit_task`'s row and Undo | Call 25; Task 1's `task_edit` result; Task 5's handler and row; Task 11's row and Undo through `PATCH /tasks/:taskId`, with rows in `chat-entries.test.ts` and `chat-tab.test.tsx` |
| M5a-5 | Token rows | Task 5: a chat token refused on `/builder/mcp`; an archived chat's token refused on `/mcp` |
| M5a-6 | `itemEntries` reads `deniedBy` and `refusal` | Task 9 |
| M5a-7 | Spec §6.6 now places `list_tasks` and `list_flows` | Call 2 |
| M5a-8 | One chat per fresh tab, and the picture-only title | Calls 4 and 5; Task 3's route row; Task 10's creation steps and its failed-post row |
| M5a-9 | A generic model picker | Task 9's `ModelPicker` in the kit; Plan's becomes its wrapper; Task 10 and Task 11 use it |
| M5a-10 | Copy needs a field | Call 24: `ConversationDto.costUsd` (Tasks 1 and 3); "The session stopped." without `{reason}`; no Signed out alert; Task 11 |
| M5a-11 | `ChatDto` nests `conversation` | Task 1 |
| M5a-12 | Settings › Sessions wiring and spec corrections | Task 16's `SettingsSectionKey`, `section-body.tsx` arm and `sections.test.ts` row; Task 19 corrects UI spec §5.7 and §7.9 |
| M5a-13 | One notification per card | Task 16: `notifyNewCard` words a chat's card; `notifyChatNeedsYou` is gone |
| M5a-14 | An archived chat stays reopenable | Call 26; Task 3's `/unarchive`; Task 15's closed stack and its rows; Task 19's decision |
| M5a-15 | Accessibility and layout | Task 13's `tabpanel` and compact row; Task 17 Step 3b; Task 18's axe on the fresh tab at 480 and light and on the open All Tabs menu; Task 16's badge at 0; the slot at 88 px (Task 10, Task 19) |
| M5a-16 | The ⌘W fallback's hide | Task 14 Step 5: `core:window:allow-hide` and repo-test rows |
| M5a-17 | No `Task` or `Agent` in a chat | Task 3's hooks table. Reversed by the trust line: a chat gets subagents (call 16) |

**Round 2 (final).**

| # | Finding | Where it went |
| --- | --- | --- |
| N2 | The stale `ChatCreateInput` title row | Task 1 Step 1: "a `title` key is an unknown key, rejected" |
| N3 | The two token rows pass first time; `app.ts:288` | Task 5 Step 2: each row names how it is shown red (the builder route briefly accepting a session token; `retire` briefly leaving the session row live); the reference is `api/app.ts:293` |
