# 10db Sessions: one conversation engine, one adapter layer, and tabs to talk to agents in

**Status:** designed overnight on 2026-11-11. Nothing in it is built.

- The builder asked for it before bed, so no questions could be asked. Every call the builder has not made is
  marked **(call)** and listed in §17. Where a requirement comes from the builder, their words are quoted.
- Revised twice (v2, v3) after two rounds of plan review and engineering review. §18 says where each finding
  went.

**Research:** `docs/architecture/research/2026-11-11-sessions-research.md` holds the vendor findings and the
codebase audit, with sources.

**UI:** `docs/superpowers/specs/2026-11-11-10db-sessions-ui.md` is the companion UI design, with mockups.

**Extends:**

- `2026-11-02-10db-brainstorm-chat-design.md`: Plan's conversation moves onto the shared engine (§6).
- `2026-11-09-10db-workbench-design.md`: Hands-on in Your folder is a pass of one (§7.3). Its thread moves onto
  the shared stores (§6).
- `2026-10-13-10db-factory-loop-design.md`: §5.4 there, takeover, is built here as Open in Terminal (§7.5).

**Keeps:**

- The lane sandbox spec, and "the sandbox is the boundary" (`decisions/2026-10-29-sandbox-is-the-boundary.md`).
- The guard and the permission broker.
- The pinned-agents rule (`decisions/2026-11-08-10db-runs-pinned-copies-of-codex-and-claude-code.md`).
- **Provider parity** (`AGENTS.md`). Every part of this spec states its behaviour per provider (§3, §5.3).

**Words:**

- A **session**, in the UI, is a tab on the Sessions screen. In the code it is a **chat** **(call)**. The builder
  asked for "Sessions", but the code's `sessions` table, `SessionAdapter` and Factory's goal Sessions already use
  that word for agent processes.
- A **conversation** is a transcript plus a queue of builder messages. A chat, a Plan shape and a task with a
  thread each own one.
- An **agent session** is a `sessions` row: one run of an agent process.
- A **harness** is the agent program: Claude Code or Codex. OpenCode comes later (§5.6).
- **Explore** is a session that writes nothing to the project.
- **Hands-on** is work that a session starts and that writes. It is a pass of one in Your folder, or a task in a
  worktree (§7.3).
- **The UI's words** come from the UI spec. A session is a **Chat** (Explore) or a **Task** (Hands-on). The two
  places are **Your folder** and **Separate copy**, the Board's words: the UI never says "worktree".
- A fact marked **built** is in the code on `main` (c4da899) and cited. Everything else is designed here.

## 1. Intent

The builder: "I'm still using Claude Code (and Codex) a bit when I just want to jump into a session and
interactively chat, get some work done, explore, when I don't necessarily want to just be running tasks. Maybe the
chat gets no work done, maybe it creates tasks, maybe I say 'let's just knock this out, go ahead and do this work
for X project either in a worktree or just on the branch we're on.' This would really help me do EVERYTHING in
10db."

On how to build it: "I don't want to maintain two systems. I want to maintain one really robust system" (use
adapters and libraries where those are right), and "make sure that whatever you end up coming up with is really
best in class UI/UX." They also asked: "what happens if a project has a backend like OpenRouter and we're wanting to
use Gemini … does that mean that we need to make this much more flexible."

**Goals**

1. **A Sessions screen.** iTerm-like tabs, each one a conversation with an agent in a project. A session can
   explore, file tasks, or do the work on the branch you are on or in a worktree.
2. **One conversation store, one delivery library, one engine for interactive conversations.** Today there are
   two engines and seven duplicates (§2.2). After this spec there is one:
   - Plan and Sessions run on the engine.
   - Task threads share its stores and its delivery rules.
   - Autonomous lane steps join it in M9 (§6.9).
3. **One adapter seam with capabilities.** The UI shows what an agent can do and never branches on the provider.
   Claude and Codex are built now. The seam is shaped so that an ACP agent (OpenCode on OpenRouter, which reaches
   Gemini and any other model) is one more adapter, specified separately once the engine has soaked (§5.6).
4. **One conversation UI kit.** Sessions, Plan and the Workbench use it: streamed markdown, typed tool-call cards
   with diffs, and a composer with `@` files and `/` commands, built on Mantine 9.8 and a short list of vetted
   libraries.
5. **Open in Terminal.** The escape hatch to the agent's own TUI, with one writer at a time.

**Non-goals here:**

- ACP agents. They get their own spec (§5.6).
- Plan's researcher and reviewer subagents on Codex: a parity gap with a follow-up task (§5.5).
- An embedded terminal.
- Mobile.
- Cloud agents.
- Rewind and fork.

**Anti-goals:**

- A second permission system.
- A chat that writes the repository.
- A provider check in the UI.
- Markdown that can fetch a URL or run a script.
- A hand-typed copy of a protocol its vendor generates.
- A process outside a sandbox that acts on files an agent wrote.

## 2. What is built, and what is wrong with it

### 2.1 Built

- **Adapters.** `SessionAdapter` (`apps/daemon/src/sessions/types.ts:392-412`) has two adapters:
  - Claude, through `@anthropic-ai/claude-agent-sdk` 0.3.316.
  - Codex, through `codex app-server` 0.167.0, with a JSON-RPC client typed by hand (`codex-rpc.ts`,
    `codex-protocol.ts`).

  `routed-adapter.ts` picks one by account kind (`providerOf`, `packages/contracts/src/accounts.ts:31-39`). Both
  binaries are pinned and verified (`environment/agent-pins.ts`).
- **The handle.** `SessionHandle` (`types.ts:278-290`) has `events`, `send(text, images?, uuid?)`,
  `interrupt(): InterruptReceipt` and `stop()`. Receipts (`consumed`, `dropped`, `stillQueued`) are built on both
  agents (`decisions/2026-11-11-a-pass-runs-on-the-projects-account-claude-or-codex.md`). Read-back
  (`readClientUuids`) works on Codex only: `claude-adapter.ts:1182-1187` rejects it.
- **The guard** runs before every tool call. It is `judgePreToolUse` for lanes and `judgeShapeCall` for Plan. On
  Claude it is an in-process PreToolUse hook; on Codex it is a hook that calls a socket (`codex-guard.ts`).
- **The permission broker** (`inbox/permission-broker.ts`) cards what needs the builder. Its owner is a workstream
  or a shape (`:59-61`).
- **Plan's conversation** (`apps/daemon/src/shape/service.ts`):
  - an in-memory turn queue
  - `shape_messages` and `shape_files`
  - a session kept warm for 10 minutes (`:420`), resumed by id
  - a digest and a fresh session past 70% (`:423`)
  - a read-only sandbox
- **The Workbench thread** (`thread/`, `runner/lane-messages.ts`, `runner/pass-turn.ts`):
  - `task_messages` and `task_files`
  - delivery with receipts
  - Stop and Redo
  - a pass lane that stays open between turns
    (`decisions/2026-11-09-a-pass-task-session-stays-open-between-turns.md`)
  - a close that fast-forwards the folder's branch (`decisions/2026-11-09-a-close-fast-forwards-the-folders-branch.md`)
- **The UI:** Plan (`views/shape/`) and the Workbench (`views/workbench/`) each have their own transcript, composer
  and working line, and both render plain `pre-wrap` text.

### 2.2 What this spec fixes

From the audit (research T1):

1. **Two engines.** The lane runner and Plan's service each own:
   - turn handling
   - a transcript
   - a picture store and budget
   - a digest
   - warm, resume and event handling

   Plan's queue lives in memory, so a message queued at quit is lost. Plan also ignores the interrupt receipt.
2. **The Claude session loop exists twice.** `claude-adapter.ts` (1189 lines) and `claude-shape.ts` (532). The fake
   adapter is split the same way.
3. **Nothing streams.** `SessionEvent` has no text delta, so the agent's words arrive once, at the end of the turn.
   Tool activity is a 200-character summary, and no DTO carries a tool's input, output, diff or exit code.
4. **Codex can't host a conversation.** `startShape` ends at once (`codex-adapter.ts:114-116`). Plan refuses a
   ChatGPT account in seven places, against provider parity.
5. **Claude and Codex are hard-coded:**
   - "Claude" labels in the UI (`views/shape/transcript.tsx:26,58`, `working-line.tsx`)
   - a closed two-way `providerOf`
   - about 15 account-kind switches
6. **A live bug.** The Codex protocol is typed by hand and has gone stale. `Account` (`codex-protocol.ts:13-21`)
   has no `gcp` variant, which Codex 0.167.0 sends, so parsing throws.
7. **Duplicated UI.** Two composers, two transcripts and two working lines. The Workbench imports `isSendKey` from
   `views/shape`.

## 3. Decisions

| # | Decision | Why |
| --- | --- | --- |
| S1 | Sessions is a top-level screen beside Inbox and Factory. Its tabs span projects, and each tab shows its project. **(call)** | iTerm-like use crosses projects. A new tab takes the selected project. |
| S2 | A session is **Explore** until the builder says Do it. Explore writes nothing. Hands-on work is a pass of one in Your folder, or a task in a worktree. **(call)** | There is one writing path: lanes, with the sandbox, claims, guard and delivery. A chat that wrote would be a second system. |
| S3 | **Do it** offers **Here, on `<branch>`** or **In a worktree**. **File as tasks** puts the work on the Board instead. | These are the builder's three outcomes: no work, tasks, or "knock this out". |
| S4 | Conversations share one store (`conversation_items`, `conversation_files`) and one delivery library. Explore conversations (Sessions and Plan) also share one live-session engine. Task conversations keep the runner as the owner of their live session until M9 (§6.9). | "One really robust system", built in an order where each step is safe. |
| S5 | `AgentAdapter.open()` replaces `start` and `startShape`. Each adapter reports `AgentCapabilities` (§5.3). The UI reads capabilities, never a provider. | Gemini, OpenRouter or any other agent becomes one more adapter, not a UI change. |
| S6 | Claude stays on the Agent SDK directly, and Codex on `codex app-server` directly. ACP is the path for other agents. | The guard needs in-process hooks on Claude, and Codex receipts need app-server. ACP v1 can carry neither (research T2, T3). |
| S7 | Codex protocol types are generated from the pinned binary, checked in, and checked by a version-and-hash stamp. The runtime keeps a small, loose zod subset, plus a test that it matches the generated types. | It ends the stale hand types (the `gcp` bug). Runtime parsing still tolerates fields Codex adds. |
| S8 | Explore and Hands-on work on every supported account kind. Plan works on Codex, without its Claude-only subagents, and says so. | Provider parity. |
| S9 | Agent text and tool calls stream to the UI as live deltas with offsets. Only finished items are stored. A turn that stops part-way stores what streamed, marked partial. | Streaming makes a chat feel alive. Storing every delta would flood the events table, and dropping streamed text on Stop would lose words the builder read. |
| S10 | Agent output renders as markdown through streamdown, behind one `Markdown` component: raw HTML skipped, no remote or data images, links `https:` only, opened after a confirm. | Agent output is untrusted. This amends the "never markup" rule by decision. |
| S11 | The composer is Mantine 9.8 `Mentions`: `@` for files, `/` for the agent's commands. Pictures paste and drop as they do today. | Native to Mantine. No editor framework to pin. |
| S12 | The daemon turns every edit into hunks, and a card renders Mantine `Diff` for each hunk. | One diff path for Claude edits and Codex patches. It stays fast because each hunk is small. |
| S13 | A tab's "needs you" mirrors the Inbox. A permission or question card shows inline in its session and in the Inbox, and is the same object. | One queue of what needs the builder. |
| S14 | A chat gets its own scoped builder MCP server, on a per-session token. `create_task`, `set_title` and edits to the tasks this chat created run without a card. Every other builder tool asks or is absent. | An Explore agent reads untrusted text. It must not start paid runs or remove work unasked. |
| S15 | Hands-on **Here** is a pass of one, whose page is the whole checkout. It holds the folder, works on its own branch, and lands as a pass lands: one PR, and a close that fast-forwards the branch you were on. **(call)** | It reuses the pass's kept work, sign-off, Abandon and landing, and it never commits to a protected base. "On the branch we're on" is what the fast-forward gives. |
| S16 | Hands-on **In a worktree** is an ordinary task, placed in a worktree, that starts from the chat. The builder can message it while it runs, and it lands by the project's delivery. **(call)** | It needs no new machinery. A worktree task that stays warm between turns needs the pass rules made general, which M9 does. |
| S17 | Open in Terminal: the daemon runs the agent's own TUI in the builder's terminal, with the session's isolation (setting sources, strict MCP, untrusted trust) and the account's environment. The tab shows "In your terminal" until Hand Back. **(call)** | It covers every TUI-only feature, keeps one writer, and never runs project files the agent wrote outside a sandbox. |
| S18 | One forward migration moves Plan's and the threads' rows into the new tables, keeping their ids and ordering by a per-conversation `seq`. **(call)** | v0.1.0 is tagged, so migrations go forward only. Keeping ids keeps every reference valid without rewriting JSON lists. |

## 4. Architecture

```
┌ desktop ───────────────────────────────────────────────────────────────────────┐
│ views/sessions   views/shape (Plan)   views/workbench                          │
│        └──────────────┬──────────────┘                                         │
│                 conversation/  (Markdown, ConversationList, ToolCallCard,      │
│                                 Composer, WorkingLine, PermissionRequest)      │
└────── HTTP + /events/stream (stored events, plus live frames never stored) ────┘
┌ daemon ────────────────────────────────────────────────────────────────────────┐
│ chat/ (Sessions)    shape/ (Plan)     thread/, pass/, runner/ (tasks)          │
│        └── engine ──────┘                    │ (runner keeps its live session) │
│                conversation/  items, files, delivery rules, live buffers,      │
│                               explore engine (queue, warm, resume, fresh)      │
│                       │ AgentAdapter.open(spec) → SessionHandle                │
│                sessions/  claude-session, codex-*, capabilities, tool calls    │
│                guard/  inbox/ (broker)  sandbox/  environment/ (pins, launch)  │
└────────────────────────────────────────────────────────────────────────────────┘
```

**Module order** (`apps/daemon/AGENTS.md`, edited in M4).

The new line is: `… delivery, accounts → conversation → pass → pictures → mcp → screens → chat, thread, shape →
runner …`.

- `conversation` depends on `sessions`, `inbox`, `accounts` and `events`.
- `screens/picture-limits.ts`, `screens/inline-budget.ts`, `screens/image-check.ts`, `screens/file-check.ts`, the
  image-budget part of `shape/dropped-files.ts` and `runner/thread-pictures.ts` move into `conversation/`, since conversation needs them and must sit below `screens`.
- `chat` sits beside `shape`. Nothing below `conversation` imports it.

## 5. The adapter layer

### 5.1 The seam

`start` and `startShape` become one `open`:

```ts
interface AgentAdapter {
  capabilities(account: AccountExpectation): AgentCapabilities;
  open(spec: AgentSessionSpec): SessionHandle;          // the existing handle
  complete(spec: CompletionSpec): Promise<string>;
  probeAccount(probe: AccountProbeSpec): Promise<SeenAccount>;
  startLogin(login: AccountProbeSpec): Promise<AccountLogin>;
  readClientUuids(spec: ConversationReadSpec): Promise<readonly string[]>;
  takeoverCommand(spec: TakeoverSpec): TakeoverCommand;  // §7.5
}
```

`AgentSessionSpec` is a common core plus a `profile`, as a discriminated union. The fields come from the audit's
seam (research T1 §4):

- **Core:** `sessionId`, `conversationId` (added in M4a, when the id exists), `cwd`, `prompt`, `images`, `promptUuid`, `model`, `effort`,
  `resumeProviderSessionId`, `env`, `account`, `mcp`, `sandbox`, `projectMcpServers`, `preToolUse`, `canUseTool`,
  `postToolUse?`, `toolFailed?`.
- **`{ kind: 'lane', workstreamId, sequence, allowedTools, lanePermissionMode }`:** today's `SessionSpec`.
- **`{ kind: 'explore', systemPrompt, tools, allowedTools, disallowedTools, agents }`:** read-only. Sessions'
  Explore and Plan both use it, and Plan adds its agents and its Shape MCP tools.

`SessionEvent` keeps every variant it has today, except `activity` with kind `tool`: tool activity comes only from
`tool_call`. It gains these:

| Event | Fields | Claude | Codex |
| --- | --- | --- | --- |
| `text_delta` | `itemId`, `offset`, `text` | `includePartialMessages` stream events | `item/agentMessage/delta` |
| `reasoning_delta` | `itemId`, `offset`, `text` | thinking deltas | `item/reasoning/summaryTextDelta` |
| `message` | `itemId`, `text` | each finished assistant text block | `item/completed` (agentMessage) |
| `tool_call` | `call: ToolCallView` | tool_use and its result, under one id | `item/started` and `item/completed`, plus `outputDelta` |
| `commands` | `{ name, description, argumentHint? }[]` | `supportedCommands()` after init | the fixed list in §5.5 |
| `plan_update` | `{ text, status }[]` | TodoWrite input | `turn/plan/updated` |

`offset` is the length of the item's text before the delta, and the UI drops a frame it has already applied. One
shared mapper (`sessions/tool-target.ts`) derives `activity` and `ToolTarget` from `tool_call`, so the runner's live
line and claims keep their inputs.

### 5.2 `ToolCallView`

`ToolCallView` is a zod discriminated union in `packages/contracts`, keyed on `kind`. Every variant has:

- `id`
- `status`: `running`, `done`, `failed` or `denied`
- `title`
- `startedAt`
- `durationMs`
- `parentId`: a subagent's calls nest under it
- `harnessTool`: the agent's own name for the tool (`Edit`, `commandExecution`), for the live line and its tests
- `refusal` and `deniedBy` (`builder` or `10db`): set when a call was denied, so a card can say "You denied this"
  or "10db stopped this: <reason>"

| Kind | Fields |
| --- | --- |
| `command` | `command`, `cwd`, `outputTail` (last 4 KB), `outputBytes`, `exitCode` |
| `edit` | `path`, `change` (`add`, `delete`, `update`, or `move` with `movePath`), `hunks: { oldStart, oldLines, newStart, newLines, before, after }[]`, `addedLines`, `removedLines`, `truncated` |
| `read` | `path`, `range?` |
| `search` | `pattern`, `paths?`, `matchCount?` |
| `mcp` | `server`, `tool`, `argumentsPreview`, `resultTail` or `error` |
| `subagent` | `agent`, `promptPreview`, `model?` |
| `web` | `query` or `url` |
| `other` | `name`, `inputPreview` |

**Hunks (S12).** For each edit, the daemon makes hunks with three lines of context, using the `diff` package's
`structuredPatch`.

- **Claude `Edit` and `MultiEdit`** are diffed from `old_string` and `new_string`.
- **Claude `Write`** compares against the file's previous content. That content is read only after an `lstat` and a
  `realpath` check that it is a regular file inside the conversation's checkout, and only up to 1 MB. Otherwise the
  card shows the whole file as added.
- **A Codex `fileChange`** carries a unified diff that is parsed into hunks.

`truncated` is set past 1,500 changed lines. The full patch stays on disk.

A running command's `tool_call` update carries `appended`, the output added since the last update, so a live frame
sends only that.

**Full output on disk** is written by the conversation library (M4b) when a `tool_call` finishes. Full output, results
and patches go under
`<dataDir>/conversations/<conversationId>/items/<itemId>/`, with paths made only from ids, and fetched when a card
expands. The folder goes when its conversation is archived.

### 5.3 `AgentCapabilities`, per provider

```ts
interface AgentCapabilities {
  harness: 'claude' | 'codex';            // widened by the ACP spec
  label: string;                          // "Claude Code", "Codex"
  steer: 'inject' | 'queue';              // inject requires receipts (invariant, tested)
  receipts: boolean;
  readBack: boolean;                      // readClientUuids
  images: readonly ('png' | 'jpeg' | 'webp')[];
  slashCommands: boolean;
  plan: boolean;
  reasoning: boolean;
  subagents: boolean;                     // Plan's researchers and reviewers
  modelSwitch: 'next_turn' | 'none';
  takeover: boolean;
  costUsd: boolean;
}
```

| Capability | Claude (plan, Bedrock, API key, gateway) | Codex (ChatGPT plan) |
| --- | --- | --- |
| steer | inject (streaming input) | inject (`turn/steer`) |
| receipts | yes | yes |
| readBack | no, so delivery is at-least-once with the id in the text (§6.2) | yes, so delivery is exactly once |
| images | png, jpeg, webp | png, jpeg, webp (`localImage`) |
| slashCommands | yes | yes (mapped) |
| plan | yes | yes |
| reasoning | yes | yes (summaries) |
| subagents | yes | **no**: Plan runs without researchers or reviewers and says so |
| modelSwitch | next_turn (`setModel`) | next_turn (turn override) |
| takeover | yes | yes |
| costUsd | metered kinds only | no |

The capabilities DTO is in `packages/contracts`. `providerOf` becomes an open lookup that returns an adapter id,
and the UI never reads it.

### 5.4 Claude: one session core

`claude-adapter.ts` and `claude-shape.ts` become `claude-session.ts`, with a profile switch.

- **One options builder** (`claudeQueryOptions(profile, sandbox)`), tested as a pure table over profile × sandbox:
  - The lane profile keeps the plugin dir, sandbox and auto mode, and `settingSources: sandbox ? [] : ['project']`.
  - The explore profile keeps `settingSources: []`, `strictMcpConfig`, `default` mode, `agents`, and the
    Read-counting hooks.
  - The explore profile never gets project settings, auto mode or the plugin dir. That is a row in the test.
- **Preflight.**
  - Lanes keep their three starts (30, 60 and 120 s) with a sign-in check (`START_ATTEMPTS = START_WAITS_MS.length`).
    `decisions/2026-10-30-a-slow-start-is-not-a-signed-out-account.md` still says two. M2a corrects that statement of
    fact in its PR, as the decisions README allows.
  - Explore keeps its single 30-second preflight, so it never pauses an account (research T1, trap 9).
  - The two are one function with an `attempts` parameter.
- **When each part lands.** M2a moves code and changes no behaviour. The behaviour changes ship later:
  - streaming (`includePartialMessages: true`) and `supportedCommands()` in M2c
  - the single-open assertion in M2b
  - `setModel` at the next turn in M4b
- **Streaming.** `includePartialMessages: true`.
- **Commands** come from `supportedCommands()`.
- **Model switching.** A model pick is applied at the next turn through `setModel` on the live query.
- **The fake.** `fake-shape.ts` folds into one scripted fake that takes either profile, emits the new events, and
  asserts at most one open handle per conversation.

### 5.5 Codex: generated types, Explore, and Plan

**Generation.**

- `pnpm --filter @10db/daemon generate:codex` unpacks the pinned tarball, verifying its checksum with the pin's own
  code, and runs `codex app-server generate-ts`.
- It writes `apps/daemon/src/sessions/codex-generated/`: the three root unions, plus the response types 10db
  reads. The roots don't reach the response types, so those are added as extra roots. That is about 430 of 761
  files, roughly 240 KB **(call)**.
- It also writes `STAMP` (the pinned version, plus a hash of the output).
- The folder is checked in. `AGENTS.md`'s generated-files list names it. Prettier, ESLint and knip ignore it.

**The check.** `make gate` checks only that `STAMP`'s version equals `CODEX_VERIFIED_ON` and that the hash matches
the folder. Running the darwin binary in CI's Linux shards or a lane's gate is impossible. A pin bump fails until
`generate:codex` is run on a Mac, and Renovate's Codex PR note names that command beside the live test.

**Runtime.** The loose zod in `codex-protocol.ts` stays as the boundary validator. Two tests check it:

- **A type test:** each generated type (with ts-rs `bigint` mapped to `number` by `Wire<T>`) is assignable to its
  runtime schema's input. That direction catches a variant the schema lacks, such as `gcp`.
- **A fixture test:** sampled payloads must pass both the runtime schema and `z.fromJSONSchema` on the generated
  JSON schema. A sample carries the required fields only, with one instance per union branch and per enum value.
  The samples are generated alongside the types and covered by the stamp, since a live recording can't hold a
  variant the builder's own account lacks.

`Account` gains `gcp` (M1).

**Explore on Codex.**

- The thread runs in a read-only sandbox (`sandboxPolicy` read-only by the generated type's name) with
  `approvalPolicy: 'never'`.
- The project is pinned `untrusted`.
- The guard hook socket judges every call with the explore rules
  (`decisions/2026-11-05-codex-lanes-use-codex-sandbox-and-hooks.md`), and an `ask` reaches the broker.
- The refusal in `startShape` is removed.

**Plan on Codex (S8).**

- Plan runs on the explore profile with its Shape MCP tools.
- Its Claude-only `agents` (code-researcher, web researcher, reviewers) are absent, because
  `capabilities.subagents` is false.
- Plan's header says "Research and review agents need a Claude account. This conversation runs without them."
- A follow-up task closes the gap, by running those roles as separate Codex threads.
- This amends `decisions/2026-11-05-chatgpt-plan-through-the-codex-app-server.md`, and the seven refusal sites go
  away.

**Streaming on Codex.** These map to §5.1's events:

- `item/agentMessage/delta`
- `item/reasoning/summaryTextDelta`
- `turn/plan/updated`
- `item/commandExecution/outputDelta`
- `item/started` and `item/completed`

**Commands.** A fixed list maps onto Codex calls:

| Command | Maps to |
| --- | --- |
| `/compact` | `thread/compact/start` |
| `/review` | `review/start` |
| `/model` | the model picker |

### 5.6 Other agents through ACP: direction, specified separately

The builder asked about Gemini through OpenRouter. The research answers it (T3):

- **OpenCode** (`opencode acp`) on an `OPENROUTER_API_KEY` reaches every OpenRouter model, Gemini included.
- It is the only ACP agent that asks before every tool and sends raw input.
- Gemini CLI speaks to Google only and sends no raw input.
- Pi and Amp never ask before a tool.

Adding OpenCode is one more `AgentAdapter` over `@agentclientprotocol/sdk`. The UI needs nothing new, because of S5.
It gets its own spec, written after M5 has run for a while, because it opens questions this spec can't settle
safely:

- a whole-process srt launch, which needs loopback for OpenCode's own server; that amends decision 133's "never
  loopback" for stdio launches
- relaying 10db's MCP server and the project's MCP servers from outside the agent's sandbox, since srt doesn't nest
- its host list (`openrouter.ai`, `models.dev`)
- turning off its `explore` subagent and `webfetch`
- a third pin, from a GitHub release with a sha256
- `steer: 'queue'`, since ACP v1 has no receipts
- an account kind that runs Sessions only, never a project's lanes

That spec also has to decide whether such an account can be a project's billing line, and if so, what its lanes
do, so that provider parity holds. The research holds the handshake to run first (T3 §3).

## 6. Conversations

### 6.1 Owners

| Owner | Profile | Live session owned by | Adds |
| --- | --- | --- | --- |
| `chat` (Sessions, Explore) | explore | the engine | the chat's scoped builder server (S14) |
| `shape` (Plan) | explore | the engine | agents (where `subagents`), Shape MCP tools, proposals, Convert |
| `task` (pass page, Hands-on, or any task the builder messages) | lane | the runner, until M9 | lane spec, claims, kept work, sign-off |

`conversation/` has two parts:

1. **The library** (every owner):
   - the stores for items and files
   - the delivery rules (§6.2)
   - live buffers and deltas (§6.5)
   - the picture budget
   - the partial capture
   - the delivery half of `runner/lane-messages.ts` and `thread/service.ts` moves here, and the runner calls it
2. **The explore engine** (chat and shape): the live-session controller, which follows §6.4 and the state table in
   §6.7. An explore owner plugs in through these hooks:

```ts
interface ExploreOwnerHooks {
  spec(conv: Conversation): Promise<AgentSessionSpec>;  // profile 'explore'
  digest(conv: Conversation): string;
  onTurnEnded(conv: Conversation, end: TurnEnd): Promise<void>;
  freshAtContextPct: number;   // 70 for both today
  outgoing(conv: Conversation): Promise<OutgoingParts>;  // the owner's per-turn notes and files (Plan's intake)
}
```

### 6.2 Items and delivery

The transcript is `conversation_items`, in `seq` order. `seq` is an integer, unique within a conversation.

**Columns:**

- `author`: `builder`, `agent` or `system`
- `kind`: see the list below
- `body`: JSON, parsed per kind, with a 32 KB cap on new items; anything larger goes to disk
- `turn_id`
- `partial`: a boolean
- the builder-message delivery fields: `pushed_at`, `push_uuids`, `delivered_at`, `handed_back_at`

**Kinds:**

- `message`
- `agent_message`
- `reasoning`
- `tool_call`
- `notice`
- `digest`
- `card`: a link to an Inbox card
- `plan`
- `shape_event`: Plan's own kinds, kept as they are, with the old kind in the body
- `turn_marker`

**The delivery rules.** One function, in the library:

1. **A message is stored before anything else.** A quit never loses it.
2. **It is pushed under its row's own uuid first** (as `lane-messages.ts:81-85` does today). Later pushes use fresh
   uuids, kept in `push_uuids` before the handle sees them.
3. **It counts as delivered** once a `consumed` event names one of its uuids, or once the turn it started
   completes. An adapter with `steer: 'inject'` must report receipts. That is an invariant, tested in a pure table
   over every adapter's capabilities.
4. **It is pushed again** when it comes back `dropped`, or when an interrupt receipt names it `stillQueued`.
5. **After a restart,** a message that was pushed and never seen taken is handled by `capabilities.readBack`:
   - With read-back (Codex), it is checked with `readClientUuids`.
   - Without it (Claude), it waits as queued (§6.4).

   Its id travels in its text, and the brief says a repeated id is one message. Delivery is exactly once on Codex
   and at least once on Claude, as it is today.

### 6.3 Turns, steering, Stop, and Stop and Redo

- **One turn runs at a time.**
- **A message sent during a turn** is injected (`steer: 'inject'`) and reaches the turn at its next step, or waits
  for the next turn (`queue`). The composer says which before Send.
- **What can start a turn.** A builder message, or an owner's turn starter: Plan's Propose and Rehearse are
  `shape_event` items with a `prompt`. Both wait in the same durable queue.
- **When a turn completes** and messages are waiting, the next turn starts at once. Nothing waits for a new
  builder message.
- **Stop** interrupts the turn. If the session doesn't report that the turn ended within 10 seconds (a new
  `STOP_GRACE_MS` in `conversation/`; the adapters' own stop waits 5 s), the handle is stopped and the conversation goes cold. Messages named `stillQueued` start the
  next turn.
- **Stop and Redo** interrupts, then pushes the builder's edited last message as a new turn.
- **A turn that ends early** (Stop, error or rate limit) stores what it streamed. A crash loses the live buffer, which
  is memory only, so a restart stores no partial text: the turn is marked interrupted. A turn that ends early stores as an `agent_message` with
  `partial: true`. Its running tool calls are stored with `status: failed`.

### 6.4 The live session (explore engine)

| Rule | Value |
| --- | --- |
| Warm after a turn | 10 minutes, then close. The next message resumes the session by `provider_session_id`. |
| Live sessions | At most 4 *idle* warm explore sessions app-wide. A fifth closes the one idle longest, with no notice: it resumes on its next message. A running session is never closed for this, so five running sessions may exist at once **(call)**. |
| Resume fails | A fresh session, seeded with `digest()` and stored as a `digest` item. |
| Context past 70% | At the end of the turn, a fresh session from the digest, with the notice "Continued in a fresh session. Nothing is lost." |
| Model pick | Applied at the next turn through a new `SessionHandle.setModel(model)`: Claude's `setModel`, or the Codex turn override (M4b). |
| Account or harness change | The builder can't change either after the first message, since a resume can't cross config dirs, so they start a new session instead **(call)**. A move to the fallback account (§7.1) changes the config dir: the next start fails to resume and starts fresh from the digest. That is the expected path. |
| Account rate-limited or capped | Turns wait, and a notice names the reset time. No card is raised. When the account resumes, the queue runs, unless the daemon restarted while the account was paused; in that case the messages wait under "Send now". |
| Daemon restart | A running turn is stored as interrupted. Every untaken turn starter waits under a "Send now" line in the transcript, whatever state the conversation falls to. A new builder message also sends what waits. Nothing spends tokens unattended after a crash. **(call)** |

### 6.5 Live buffers and streaming

- The engine keeps, in memory, each running item's text and its running tool calls.
- **Live frames.** A `conversation.delta` frame is `{ conversationId, itemId, kind, offset, text? | callPatch? }`.
  - It goes out on the event socket with `live: true`.
  - It is never written to `events`, and it never advances the replay seq.
  - Frames for one item are coalesced to at most one every 50 ms.
  - A tool's output frames carry only appended output, never the whole call.
- **Reconnect.** After a reconnect the UI calls `GET /conversations/:id/live`, which returns the in-flight items and
  their offsets.
- **Background tabs** keep their buffers but don't render.
- **Reasoning items** are closed by the engine at the turn's end or when the next item starts, since no adapter event
  marks one finished.

### 6.6 Permissions

- **The broker's owner** gains `{ conversationId }`. A task conversation keeps its `workstreamId`, so a lane's
  stored rules still apply.
- **The judge is the profile's:** explore uses `judgeShapeCall`'s rules, a lane uses `judgePreToolUse`.
- **Cards.** A card has a `card` item in its conversation and renders inline. Answering it in the session or in the
  Inbox answers the same card (S13).
- **The builder tools in a chat (S14)** come from a scoped server, mounted per session with its own token. The
  UI's token never reaches a session.

| Tool | In a chat |
| --- | --- |
| `create_task`, `set_title`, `write_brief`, `edit_task` (only tasks this chat made) | no card. Each shows as a tool card with Undo; Undo removes an unstarted task (the existing route) |
| `start_task` | a card: "Start <task> now?" |
| `remove_task`, `move_task`, `run_next`, `save_decision`, `retire_knowledge`, `withdraw_knowledge`, `start_shape` | absent |
| knowledge search and reads, `list_tasks`, `list_flows` | no card |
| `list_projects`, `list_inbox`, `list_proposals`, `save_principle`, `supersede_knowledge` and any tool added later | absent until a decision adds it |

### 6.7 State × event table: an explore conversation

**States:**

- `idle_cold`
- `idle_warm`
- `starting`
- `running`
- `waiting_card`
- `stopping`
- `taken_over`
- `paused_account`
- `ended_error`
- `sealed`

`ended_error` means the last session ended in an error. Nothing is live, and the next message starts afresh.

`sealed` means the conversation has handed its work to a Hands-on task (§7.3). It is read-only for good: a
message, Open in Terminal and Stop are refused, and only archive applies. It has no live session and is never
resumed. Do it moves any state to `sealed`, after closing the live session (a running turn is stopped first, and
its partial text is stored). Do it is refused from `taken_over` ("Hand back first").

| Event \ State | idle_cold | idle_warm | starting | running | waiting_card | stopping | taken_over | paused_account | ended_error |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| builder message | store; start → starting | store; push → running | store (queued) | store; inject or queue (§6.3) | store; inject or queue | store (queued) | store; held | store (queued) | store; start → starting |
| `started` | | | push the first queued message → running | | | | | | |
| card raised | | | | → waiting_card | | | | | |
| card answered or withdrawn | | | | | → running | | | | |
| Stop | if queued: drop the queue's pending start, keeping the messages | n/a | cancel the start → idle_cold | interrupt → stopping | withdraw the card; interrupt → stopping | n/a | n/a | n/a | n/a |
| receipt or `turn_complete` after Stop | | | | | | re-push `stillQueued`; queue non-empty → running, else idle_warm | | | |
| stop grace (10 s) passes | | | | | | `stop()` → idle_cold; partial stored | | | |
| `turn_complete` | | | | queue non-empty → next turn; else → idle_warm; `onTurnEnded` | | (as above) | | | |
| idle 10 min, or LRU close | | close → idle_cold | | | | | | | |
| context past 70% at turn end | | close → idle_cold; next start is fresh from the digest | | | | | | | |
| `ended`: error | | → ended_error | → ended_error | partial stored; → ended_error | withdraw the card; → ended_error | → ended_error | | | |
| `ended`: rate_limited or capped | | → paused_account | → paused_account | partial stored; → paused_account | withdraw; → paused_account | → paused_account | | | |
| `ended`: completed or stopped, unasked | | → idle_cold | → ended_error | partial stored; → idle_cold | withdraw; → idle_cold | → idle_cold | | | |
| account resumes | | | | | | | | → idle_cold; run the queue (after a restart: "Send now") | |
| Open in Terminal | no provider id: refused ("Send a message first"); else → taken_over | close → taken_over | refused | refused ("Stop first") | refused | refused | n/a | → taken_over | id: → taken_over; none: refused |
| Hand Back | | | | | | | → idle_cold; notice (§7.5); run held messages | | |
| daemon restart | | → idle_cold | → idle_cold; queued messages wait under "Send now" | partial stored; → idle_cold; "Send now" | withdraw; partial; → idle_cold | → idle_cold | stays | stays | stays |
| archive | archive | close; archive | cancel; archive | Stop, then archive | withdraw; Stop; archive | after the stop | confirm "End takeover and archive?"; archive | archive | archive |

A task conversation's state stays the runner's: the pass lane, its turns ending `ready`, `stopped` or `failed`, and
recovery. The runner uses the library's delivery rules, partial capture and stores. The fake adapter's
one-open-handle assertion guards against the engine and the runner both opening a session.

### 6.8 Recovery

- **The order of writes.** A builder message, its `pushed_at` and uuid, and a turn's start are stored before their
  effect.
- **On daemon start,** each explore conversation with a live session row is closed by the restart row of the table.
  The process sweep handles its pid.
- **Task conversations** recover by the runner's existing rules, unchanged. `runner/pass-lane.test.ts` and
  `test/crash-recovery.test.ts` stay as they are.

### 6.9 M9: lane steps as conversations

M9 makes every task conversation's live session the engine's, with the runner as the task's driver:

- Nudges become messages.
- A handoff becomes a fresh session from a digest.
- The pass rules for turns, sign-off and warm lanes become `interactive/`, for any task, which lets a worktree task
  stay warm between turns.
- Every lane gains a transcript.

**The trigger:** M6 has run for two weeks with no recovery bug in the library. M9 gets its own short spec, because
it changes recovery for every lane. Until then the runner's loop is the one remaining second owner of a live
session, and the shared library is what keeps it from being a second system.

## 7. Sessions

### 7.1 A chat

**The `chats` table:**

- `id`, `project_id`, `conversation_id`
- `title` and `title_source` (`agent` or `builder`)
- `mode` (`explore` or `hands_on`)
- `task_id` and `pass_id` (Hands-on)
- `tab_position`: null when the tab is closed
- `created_at`, `last_activity_at`, `archived_at`

**New session.**

- **Its project** is the selected one.
- **Its account** is the project's account, with its fallback and move-back rules **(call: a chat is project work,
  billed to the project's line)**.
- **Its model:**
  - The default is the model the `plan` role resolves to.
  - The builder can pick any model the account offers, before the first message or between turns.
  - A different agent means a different project account. That is not offered (§6.4).

**Title.** After the first turn the agent names the session through `set_title`. The builder can rename it, and
the builder's title wins.

**Close and archive.**

- **Close tab** sets `tab_position` to null. The session stays as it is, warm until its idle close.
- **Archive** hides it from Recent and removes its folder on disk. Archive is refused while its Hands-on work is
  unfinished.

**What the agent gets:**

- the checkout, read-only
- Plan's read-only sandbox and command rules
- the project's approved MCP servers
- the scoped builder server
- no web tools **(call: matches Plan's line, where the web belongs to a researcher)**
- no user or project settings (`settingSources: []`), so neither `~/.claude` hooks nor MCP servers reach it
  **(call)**

### 7.2 File as tasks

The agent calls `create_task` and its siblings. Each call shows as a card with the task's title, a Board link and
Undo. **File as tasks** in the header is a prompt shortcut that asks the agent to turn the conversation into tasks.

### 7.3 Do it

The Do It sheet (UI spec §8.1) offers two choices.

**Here, on `<branch>`** (S15): a pass of one, whose single page is the whole checkout.

- It opens as a pass opens (Workbench spec §5.1):
  - the pass's own branch, from `HEAD`
  - `return_branch` and `start_sha` recorded
  - the folder held, so other Your-folder work goes to a copy or waits (W9)
- Do it is refused, with a reason and a link, in these cases:
  - while another pass holds the folder
  - while a merge, rebase or bisect is in progress
  - when the folder's state refuses a pass today
- Do it first seals the Explore conversation (§6.7). The task starts a new agent session from a brief, on Claude
  and on Codex alike. The chat's agent writes the brief when the Do It sheet opens: a short explore turn that calls
  `write_brief` on the chat's scoped server. The builder can edit it before Start. If the agent is unavailable or
  doesn't answer within 60 seconds, the brief is the chat's digest plus the builder's last message **(call: the
  designer's)**. It never resumes the Explore agent
  session, so one agent session never has two writers, and the picture budget starts clean **(call: the digest
  carries the context; resuming would need a fork and a copied picture budget for little gain)**.
- The page is synthetic: a page named "Whole project" over `WHOLE_REPOSITORY_GLOBS` (`@10db/contracts`), made for
  this pass and never saved as a project area. The pass's page code takes it in place of an area-backed page, and
  `no_page_area` does not apply.
- Hazards still apply. The judge's rule that counts a hazard only outside the pass's pages does not apply to a
  whole-project page, so lockfiles and migrations keep their rules. A judge table row covers it.
- The Task takes the Chat's place in the tab strip. The sealed Chat closes, and stays reachable from the Task's
  "From chat" link, ⌘⇧T and ⌘K. Its read-only line offers **New Chat From This**, which starts a fresh chat seeded
  from its digest, with no resume **(call: the design review's; the strip doesn't fill twice as fast, and the
  builder can keep talking)**.
- **Sign Off and Abandon** are the pass's, word for word. Sending a message reopens the page, as in a pass.
- **Landing** is the pass's close:
  - one PR, on every project (Workbench W8)
  - then a fast-forward of the branch the builder was on, when the PR merges, or at once on a `local` project
    (`decisions/2026-11-09-a-close-fast-forwards-the-folders-branch.md`)

  The folder ends on the branch it started on, holding the work.
- **The Workbench.** It lists a pass of one with the other passes. Its page reads "Whole project" **(call)**.
- **The Inbox.** A pass of one's Ready and question cards open its Sessions tab, not the Workbench.
- **The Changes panel** (UI spec §9) reads `GET /workstreams/:id/changes`, the route the builder's check card
  already uses. Before M4c, a Task's tool rows show only once the runner stores `tool_call` items (M4c).

**In a worktree** (S16): an ordinary task in a worktree.

- Its brief is the one written for the Do It sheet, as above. It starts at once.
- It takes the Chat's place in the strip, as above. The tab shows the task's thread, where messages reach the
  running lane, and the task's live line.
- It lands by the project's delivery. Its card on the Board is the usual one.
- It does not stay warm between turns, which waits for M9. When it finishes, the tab says so and offers the Board
  and the PR.

**Per provider.** Both choices run on Claude and on Codex: passes and worktree tasks already do (research T1).

### 7.4 What Do it never does

- Hide what happens to the builder's uncommitted work. A whole-project page covers every file, so by the pass's
  own rule (Start Pass), uncommitted changes in the folder become part of the task's work. The Do It sheet lists
  them and says so before Start **(call: the pass's existing rule wins; refusing a dirty folder would make
  "knock this out" fail on the common case)**.
- Run on a folder in the middle of a merge, rebase or bisect.
- Force a branch move. The fast-forward is compare-and-swap, as a pass's is.

### 7.5 Open in Terminal, and Hand Back

**Open in Terminal** (S17) works on a session that has a provider session id and no running turn.

1. The engine closes the live session, and the conversation goes to `taken_over`.
2. The adapter's `takeoverCommand` builds the command:
   - **Claude:** the pinned `claude` with `--resume <id>`, `--setting-sources` matching the profile (none for
     explore), `--strict-mcp-config` and an `--mcp-config` file naming only the servers the session had (the
     project's approved ones), with `CLAUDE_CONFIG_DIR` set to the account's directory.
   - **Codex:** the pinned `codex resume <id>` under the account's `CODEX_HOME`, with the project still pinned
     `untrusted`.
   - **Hands-on sessions** in a worktree or a pass folder also leave out any project setting file the agent changed
     during the session. Their banner lists such files.
3. The daemon writes the command to `<dataDir>/conversations/<id>/takeover.command` with mode 700, holding no
   secret.
   - A keyed account's key is read inside the script with
     `security find-generic-password -s 10db -a account:<id> -w`. That is the Keychain item `keychain.ts` reads.
   - The daemon then runs `open -a <Terminal|iTerm> <file>` itself. The webview gets no new capability.
   - The script's first line deletes itself (`rm -- "$0"`). The daemon cannot observe when the terminal has read
     it.
   - The terminal app is a setting, Terminal by default **(call)**.
4. A banner: "In your terminal. This runs outside 10db's sandbox. 10db won't touch this session until you hand it
   back."

**Hand Back.**

- The conversation goes to `idle_cold`, and messages held meanwhile run.
- A notice reads "Turns from your terminal are in the agent's memory; they aren't shown here." 10db imports no
  history **(call: the agent's own resume carries the context; showing the terminal's turns is a later nicety)**.
- 10db doesn't watch the terminal process, so Hand Back trusts the builder.

**Hands-on.** A pass of one keeps its folder hold through a takeover. A worktree task keeps its claims. The banner
names both.

## 8. The UI, in brief

The design is the companion UI spec. This spec holds it to these rules:

- **The kit.** `apps/desktop/src/conversation/` holds Markdown, ConversationList, ToolCallCard, Composer,
  WorkingLine, PermissionRequest and Announcer. Sessions builds it, and Plan and the Workbench thread move onto it
  in M4, so there is only one UI after M4.
- **Markdown** (S10). Code fences use Mantine `CodeHighlight` with the Shiki adapter.
- **Tool cards:**
  - Consecutive reads and searches fold into one line: "Read 6 files".
  - Commands show their output tail, collapsed.
  - Edits show `Diff` per hunk, with `withLineNumbers={false}` and 10db's own line gutter fed from `oldStart` and
  `newStart`, since `Diff` numbers every hunk from 1.
  - A subagent's calls nest under it.
- **The composer** (S11). ⌘↩ sends and Enter starts a new line, in Sessions, Plan and the Workbench alike. Before
  Send, it states what ⌘↩ will do while a turn is running, from `steer`.
- **The tabs** sit in the title bar (UI spec §5.1), which needs the Tauri title-bar check in §16.
- **No label names a provider** except one that shows `capabilities.label`.
- **Every state has its words and its look:**
  - working, waiting for you, ready, error
  - in your terminal
  - waking up, paused until a time
  - continued in a fresh session
  - downloading the agent, reconnecting
  - "Send now" after a restart
- **Notifications.** A tab's "needs you" dot is the Inbox's count for that conversation. A notification fires only
  when the session isn't in view.
- **Links** in agent markdown open through a new Rust command, `open_web_link`. It parses the address, accepts only
  `https:`, and asks in a native confirm. The opener's allow list does not widen, since a confirm in JavaScript is no
  boundary. A decision amends `decisions/2026-11-08-the-desktop-opener-opens-artificial-analysis.md`.
- **A model change** stores a `notice` item with `{ kind: 'model_change', label, model }`, which the kit draws as
  the "Now on …" divider, in Plan and in Sessions.
- **Chat notifications** are a global setting, in a new Settings › Sessions section. Settings › General is per
  project.

## 9. Data

### 9.1 Tables

**`conversations`:**

- `id`, `project_id`
- `owner_kind` and `owner_id`, unique together
- `profile`
- `account_id`: the project's account; a task conversation's is rewritten when its lane moves account, at the next
  session start
- `model`: the builder's pick; null follows the owner's default
- `provider_session_id`
- `state` (§6.7; tasks keep `null`, since the runner owns their state)
- `context_pct`
- `next_seq`
- `created_at`, `updated_at`

**`conversation_items`** (§6.2) has a unique index on (`conversation_id`, `seq`). The body cap is 32 KB, above
`TASK_MESSAGE_MAX_CHARS`, and the cap applies to new items only. Migrated bodies are copied as they are.
`ToolCallView` gains `refusal`: 10db's reason when the guard or broker denied the call.

**`conversation_files`:**

- `id`, `conversation_id`, `item_id`
- `name`, `media_type`, `size`
- `sha256`, which is null for files migrated from Plan, since SQL can't hash
- `stored_path`, `inline_sent`, `told_at`, `unreadable_told_at`
- `created_at`

**`chats`** is described in §7.1.

**`sessions`** changes:

- It gains `conversation_id`, added by `ALTER TABLE` in an earlier migration than the rebuild (`packages/db/AGENTS.md`
  explains why, under migrations 0027/0028).
- It keeps `workstream_id`.
- It drops `shape_id`.
- Check: `conversation_id IS NOT NULL OR workstream_id IS NOT NULL`.

Per-project usage resolves through `conversations.project_id` or the workstream. A test proves it counts every
owner.

### 9.2 Migration (forward-only)

The steps run in order. Generated migrations do the schema changes; one `--custom` migration does the data copy:

1. **Generated:** create the new tables, and `ALTER TABLE sessions ADD conversation_id`.
2. **`--custom`, written by hand once:**
   - **Shapes.** For each shape:
     - insert a `conversations` row (owner `shape`, profile `explore`, `account_id` from its latest session,
       or the project's account when it has none,
       `model` from `shapes.model`, `provider_session_id` from `shapes.sdk_session_id`)
     - copy its `shape_messages` in id order with `seq` 1, 2, 3…, using the kind table below, author `claude` as
       `agent` and `note` as `system`
     - copy its `shape_files` (`unreadable_told_at` kept)
   - **Tasks.** For each task with `task_messages`:
     - insert a conversation (owner `task`, profile `lane`, `account_id` from its latest session, or the
       project's account)
     - copy its messages, with their delivery fields, and its files (`sha256` kept)
   - **Sessions.** Set `sessions.conversation_id` from `shape_id`, and from the workstream's task where that task has
     a conversation.
   - **Delivery.** Migrated builder messages of a shape are marked delivered, since Plan's in-memory queue held none
     across the migration.
   - **Conversation ids** of migrated rows are `cnv_` plus the owner's UUID, since SQL can't mint a UUIDv7.
   - **Ids.** They are kept as they are. `ConversationItemId` accepts the prefixes `cvi_`, `shm_` and `tmg_`, and
     `ConversationFileId` accepts `cvf_`, `sfl_` and `tfl_`, when read (`packages/contracts/src/ids.ts`). A table
     test checks every legacy prefix against `ids.ts`. The ID module mints only `cvi_` and `cvf_`. Order
     never depends on the id, because it is `seq`. `lane-messages.ts`'s `idOfUuid('TaskMessage', …)` becomes a
     lookup by `push_uuids` **(call: the reviewers preferred fresh ids with a `legacy_id`. Keeping ids avoids
     rewriting `shape_proposals.source_message_ids` and `shape_questions.source_message_ids`, both JSON lists.)**
3. **Generated rebuilds**, so the referencing columns point at the new tables:
   - `shape_shadow_answers.message_id`
   - `pass_turns.message_id`
   - `pass_preview_marks.notice_id`
   - `sessions` (dropping `shape_id`)
   - `shapes` (dropping `sdk_session_id` and `model`)
4. **Generated:** drop `shape_messages`, `shape_files`, `task_messages` and `task_files`.
5. **The test.** A database at migration 0064, seeded with every referencing table filled, is migrated through
   `migrateDatabase` and must pass:
   - `foreign_key_check`
   - transcript order
   - proposals' and questions' source ids that still resolve
   - the recovery and restart tests afterwards

| shape kind | becomes |
| --- | --- |
| `text` (builder) | `message` |
| `text` (claude) | `agent_message` |
| `tool` | `tool_call` (kind `other`, `inputPreview` = the old summary) |
| `notice` | `notice` |
| `digest` | `digest` |
| `propose`, `rehearse`, `edit`, `event`, `screen` | `shape_event` (body `{ kind, text }`) |

This covers every `ShapeMessageKind` (`packages/contracts/src/shape.ts:44-56`). Authors map separately: `builder`
stays `builder`, `claude` becomes `agent`, and `note` becomes `system`.

### 9.3 Daemon modules

| Module | Holds |
| --- | --- |
| `conversation/` (new) | item, file and chat-independent stores; the delivery rules; live buffers; partial capture; picture limits and budget (moved from `screens/`); the explore engine |
| `chat/` (new) | Sessions: chats, titles, the scoped builder server, Do it, archive |
| `shape/` | proposals, rounds and Convert; its turn code is replaced by the explore engine |
| `thread/` | removed; its routes move to `conversation/` |
| `runner/` | `lane-messages.ts` calls the library |
| `sessions/` | `claude-session.ts`, `codex-*` with `codex-generated/`, `capabilities.ts`, `tool-call-view.ts`, `hunks.ts` |

## 10. Contracts and API

**DTOs:**

- `ConversationDto`: `id`, `owner`, `state`, `capabilities`, `model`, `contextPct`, the queued count, and
  `commands` (the last list the agent reported, stored on the conversation so a cold tab still offers it).
- `ConversationItemDto`: a union by kind, with tails and previews only.
- `ChatDto`: `id`, `projectId`, `title`, `titleSource`, `mode`, `tabPosition`, `conversation` (a
  `ConversationDto`), `taskId`, `passId`, `lastActivityAt`, `archivedAt`.
- `AgentCapabilitiesDto`.

**Routes:**

| Route | What it does |
| --- | --- |
| `GET /chats?open=1` | The open tabs. |
| `GET /chats/recent` | Recent sessions. |
| `POST /chats` | Create a session. |
| `PATCH /chats/:id` | Title, tab position, model. |
| `POST /chats/:id/archive` | Archive. |
| `POST /chats/:id/do-it` | `{ place: 'here' \| 'worktree' }` |
| `GET /conversations/:id/items?afterSeq=` | Pages of 200. |
| `GET /conversations/:id/live` | In-flight items, with offsets. |
| `POST /conversations/:id/messages` | Text, mentions and pictures. |
| `POST /conversations/:id/send-now` | Sends the messages that waited through a restart. |
| `POST /conversations/:id/stop` | Stop. |
| `POST /conversations/:id/redo` | Stop and Redo. |
| `POST /conversations/:id/takeover` | Open in Terminal. |
| `POST /conversations/:id/hand-back` | Hand Back. |
| `GET /conversations/:id/items/:itemId/full` | A tool's full output or patch, from disk. |
| `GET /conversations/:id/files?q=` | For `@` mentions. `git ls-files` of the conversation's own checkout (the project folder, or a task's worktree), which the daemon resolves from the conversation. The client never sends a path. Fuzzy, at most 50 results. |

Plan's and the thread's routes move onto these, and the old ones go in the same PR as their callers.

**Events.**

- Stored: `conversation.item_added {id, seq, kind}`, `conversation.item_updated {id}`, `conversation.state` and
  `chat.changed`. Each carries ids, never bodies. The client patches its cache from one `GET` of the item.
- Live: `conversation.delta` (§6.5).
- A test over a real WebSocket checks two things: a live frame never advances the replay seq, and a reconnect
  replays no live frame.

## 11. Security

- **Markdown (S10).**
  - streamdown is configured with `skipHtml`, and rehype-harden with no image prefixes, `https:` links only, and no
    data images.
  - One hostile-markdown test covers an image beacon, a `javascript:` link, `<script>`, a `data:` image and an
    `<iframe>`.
  - It amends the "never markup" rule in `decisions/2026-11-02-the-shape-view.md` and `apps/desktop/AGENTS.md` (the
    Plan bullet), by a decision.
- **The opener.** `open_web_link` (Rust) accepts only `https:` and confirms natively. The allow list is unchanged.
- **Builder tools (S14).** A chat's server has its own per-session token. The tool table in §6.6 is a pure table
  test, and it includes the rows that must be absent.
- **Takeover (S17).**
  - Isolation flags go on every launch.
  - No secret is in the file, and the file is mode 700 and removed after launch.
  - The daemon runs `open` itself, so the webview never can.
  - Project setting files the agent changed are named in the banner and never loaded.
  - The launch command is a pure table test per harness and profile.
- **File mentions.** `git ls-files` only. A mention reaches the agent as a path, and the explore judge decides each
  read.
- **Write cards.** Their before-text is read only after `lstat` and `realpath` confirm a regular file inside the
  checkout, up to 1 MB.

## 12. Milestones

Each milestone is a pull request the builder can run.

| # | Milestone | The builder sees | Risk |
| --- | --- | --- | --- |
| M1 | **Foundations.** Mantine 9.8, with the MCP pin. Codex generated types with stamp and tests. The `gcp` fix. Decision S7. | Nothing changes, except that a Codex account on GCP no longer breaks. | low |
| M2a | **One Claude core and one fake.** No behaviour change. | Nothing. | medium-high: billing and preflight |
| M2b | **`AgentAdapter.open`**, capabilities, and an open `providerOf`. | Nothing. | medium |
| M2c | **Streaming and typed tool calls.** Events, `ToolCallView`, hunks, on Claude and Codex. | Nothing yet; the events are logged. | medium |
| M3 | **The static kit.** Markdown, ToolCallCard, Diff and ConversationList, rendering stored items. | Plan renders markdown. | medium |
| M4a | **The migration and stores.** The old services read and write the new tables. | No change; it survives a restart. | high: small red-first steps |
| M4b | **The explore engine.** Plan on it, with live deltas, partial capture and "Send now". | Plan streams, shows tool cards, and keeps its queue. | high |
| M4c | **Task threads** through the library. The Workbench thread UI moves onto the kit. | The Workbench streams and renders markdown. | high: runner |
| M5a | **Sessions, Explore, on Claude.** The screen, tabs, new session, File as tasks, the scoped builder server, `/` and `@`, notifications. | The feature. | medium |
| M5b | **Codex conversations.** Explore on Codex, and Plan on Codex without subagents. | Sessions and Plan on ChatGPT. | medium: guard |
| M6 | **Do it.** A pass of one, worktree tasks, the tab transitions. | "Knock this out." | medium |
| M7 | **Open in Terminal and Hand Back.** | The escape hatch. | medium: security table |
| M8 | **Spotlight.** ⌘K over sessions, projects and commands. | Polish. | low |
| — | **The ACP spec, then OpenCode** (§5.6). | Gemini, or any model through OpenRouter. | its own spec |
| M9 | **Lane steps as conversations** (§6.9), with its own spec. | Every task has a transcript; worktree tasks stay warm. | high |

**Order.**

- M1 ships alone.
- M2a, then M2b, then M2c.
- M3 needs M2c.
- M4a needs M2c. M4b needs M4a and M3. M4c needs M4b.
- M5a needs M4b. M5b needs M5a.
- M6 needs M4c and M5a. M7 needs M5a.
- M8 is anywhere after M5a.

Two UIs exist only from M3 to M4c, and two transcript stores never exist.

## 13. Testing

The rules in `.claude/rules/testing.md` apply. These are the rows for this spec, by rung.

**Pure:**

- `ToolCallView` mapping tables, per adapter
- hunks: Claude edit, `Write`, a Codex patch, and the 1,500-line cap
- the capability tables, plus the invariant that `inject` requires receipts
- the Claude options builder over profile × sandbox
- the §6.7 table, as a reducer with one row per cell
- delivery rules 1 to 5
- the delta offset reducer: interleaved, duplicate and gap frames
- the `/` command map
- the scoped builder tool table
- the judge row for a whole-project page, where hazards still apply
- the takeover command table
- the hostile-markdown test
- the Codex fixtures through `z.fromJSONSchema`
- the type-compatibility test

**Real SQLite:**

- the migration from a seeded 0064 database (§9.2 step 5)
- the stores
- per-project usage across all three owners

**Rendered or HTTP:**

- the kit components
- the Sessions screen (`renderWithDaemon`)
- the routes (`app.request()`)
- live frames over a real WebSocket

**Real git:**

- Do it Here on a feature branch
- Do it Here on base, on a pull-request project and on a `local` project
- Do it refused mid-merge
- after the close: HEAD, the working tree and the landed commit, for each case

**Pipeline:**

- restart rows for every §6.7 state, on the explore engine's own fixture and through Plan's service fixture
  (`createTestEngine` builds no explore engine)
- a task conversation in every lane state, with the fake's single-open assertion keyed by provider session id
- Do it while the Explore session is warm: afterwards a message or takeover on it is refused
- a runner claim test with the fake emitting only `tool_call`, so a `tool-target.ts` regression that stops
  claims goes red
- e2e: Plan and the Workbench kept green through M3 to M4c
- a new e2e: Sessions Explore, then Do it, then sign-off

**Live (opt-in):**

- streaming checks added to the Claude and Codex live tests
- a Codex read-only explore test

**Unchanged and on their rung:**

- `runner/pass-lane.test.ts`
- `test/crash-recovery.test.ts`
- `shape/confinement.test.ts`
- `codex-guard.test.ts`
- `codex-session.test.ts`

## 14. Decision records to write

Each record is its own file, written in the milestone that builds it.

| Milestone | Decision |
| --- | --- |
| M1 | Codex protocol types are generated and stamped (S7). |
| M2b | One adapter seam with capabilities, and the UI never reads a provider (S5, S6). |
| M2c | Agent output streams as live frames that are never stored, and an early end keeps partial text (S9). |
| M3 | Agent output renders as hardened markdown (S10). Amends `2026-11-02-the-shape-view.md`. |
| M3 | The opener opens confirmed `https:` links. Amends `2026-11-08-the-desktop-opener-opens-artificial-analysis.md`. |
| M4a | One conversation store, keeping ids, ordered by `seq` (S18). |
| M4b | One explore engine for Sessions and Plan (S4). Amends `2026-11-02-shape-session-and-convert.md`. |
| M5a | Sessions is a top-level screen. A chat's builder tools are scoped (S1, S2, S13, S14). |
| M5b | Plan and Sessions run on Codex without Claude-only subagents (S8). Amends `2026-11-05-chatgpt-plan-through-the-codex-app-server.md`. |
| M6 | Do it Here is a pass of one, and Do it in a worktree is a task (S15, S16). |
| M7 | Takeover is Open in Terminal with isolation and Hand Back (S17). |

## 15. Out of scope, and later

- ACP and OpenCode, which get their own spec.
- M9 and `interactive/`.
- Plan's subagents on Codex, as a follow-up task.
- Rewind and fork.
- Search across conversations.
- Project skills in chats.
- Cloud sessions.
- An embedded terminal.
- `@pierre/diffs`.
- Showing the terminal's turns after Hand Back.

## 16. Morning live checks

Each check is free, or costs one turn.

1. **`claude --resume <id>`** opens a Plan session's id with `CLAUDE_CONFIG_DIR` set to the account's, and with
   `--setting-sources ''` and `--strict-mcp-config`.
2. **`codex resume <id>`** opens an app-server thread under the account's `CODEX_HOME`.
3. **A read-only Codex thread** refuses a write and asks through the hook.
4. **Title-bar tabs in Tauri:** a tab in the title bar doesn't start a window drag, and ⌘W reaches the webview
   before the menu's Close (UI spec §20).
5. **The streamdown spike** in Plan's transcript: a 20k-token streaming message, at 50 ms frames, inside the
   virtualizer, in the Tauri webview.
6. **The OpenCode handshake** (research T3 §3), for the ACP spec.

## 17. Calls to review

Each call is marked **(call)** where it is made. Grouped by what the builder is likeliest to change:

1. **Name and place.** The UI says "Sessions" and the code says `chat`. Sessions is a top-level screen with tabs
   across projects (S1).
2. **Explore can't write.** Do it Here is a pass of one, landing by PR and a fast-forward of your branch (S15). Do
   it in a worktree is an ordinary task, not warm between turns until M9 (S16).
3. **The Workbench lists a pass of one** as "Whole project" (§7.3).
4. **What a chat loads:** no settings, no personal skills and no web tools (§7.1). The project's account, and the
   `plan` role's model by default (§7.1).
5. **No account or harness change after the first message** (§6.4). At most 4 warm Explore sessions (§6.4).
6. **After a crash,** queued messages wait under "Send now" (§6.4).
7. **Do it starts the task from a brief and seals the Explore conversation**, on both providers (§7.3).
8. **Generated Codex types are a subset** (§5.5).
9. **The migration keeps ids** and orders by `seq` (§9.2).
10. **Takeover** uses Terminal by default, with no history import on Hand Back (§7.5).
11. **ACP gets its own spec** (§5.6).
12. **The designer's calls** in the UI spec's own list (§19 there) are adopted unless they contradict this spec. Among them: tabs in the title bar; Do It opens a new tab; the agent writes the brief; ⌘↩ sends everywhere.

## 18. Where the round-1 findings went

| Finding | Where |
| --- | --- |
| Who owns a task conversation (eng 1) | S4, §6.1, §6.7 last paragraph, §6.9 (M9) |
| Module order (eng 2, plan 11) | §4 |
| A Hands-on task without a pass; landing on base (eng 3, plan 5) | S15, S16, §7.3, §7.4 |
| `inject` without receipts (eng 4) | §5.3, §6.2 rule 3. OpenCode would be `queue` (§5.6). |
| Streamed text lost on Stop (eng 5) | S9, §6.3 |
| Migration foreign keys, `sha256`, `unreadable_told_at`, kinds (eng 6, plan 2) | §9.2 |
| Takeover runs agent-written config (eng 7) | S17, §7.5, §11 |
| Builder tools without a card (eng 8, plan 6) | S14, §6.6 |
| Provider parity (plan 1) | S8, §5.3, §5.5, §5.6, §7.3 |
| Id order (plan 3) | §6.2, §9.2 (`seq`) |
| State table holes (plan 4, eng 16) | §6.3, §6.4, §6.7 |
| ACP sandbox (plan 7), over-built (eng 9) | §5.6 moved to its own spec |
| Takeover mechanism and citation (plan 8) | §7.5 |
| Opener and "never markup" (plan 9) | §8, §11, §14 |
| Companion UI spec missing (plan 10) | written alongside this spec |
| Claude has no read-back (plan 12) | §5.3, §6.2 rule 5 |
| Milestones (eng 15, plan 13) | §12 |
| Do it loses context (plan 14) | §7.3 |
| Codex drift check (plan 15) | §5.5 (stamp) |
| Account per chat, usage (plan 16) | §7.1, §9.1 |
| Write card reads (plan 17) | §5.2, §11 |
| Diff for patches (plan 18, eng 12) | S12, §5.2 |
| Delta races and bloat (eng 10, 11, 13) | §6.5, §5.2, §10 |
| Claude starts: 2, not 3 (eng 14) | §5.4 |
| Hand Back history (eng 9) | §7.5 |
| No provider id (plan 20) | §6.7 |
| Round 2: Do it resuming the Explore session gives two writers (both) | §6.7 `sealed`, §7.3 (brief only) |
| Round 2: file id prefixes (plan A) | §9.2 |
| Round 2: `image-check` move (eng 2) | §4 |
| Round 2: whole-checkout page and hazards (eng 3) | §7.3 |
| Round 2: Diff gutter, LRU when running, claims from `tool_call`, script self-delete, account fallback, kind table, paused after restart, M4a needs M2c | §8, §6.4, §13, §7.5, §9.2, §12 |
