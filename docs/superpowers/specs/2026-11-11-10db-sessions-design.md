# 10db Sessions: one conversation engine, one adapter layer, and tabs to talk to agents in

**Status:** designed overnight on 2026-11-11. Nothing in it is built.

- The builder asked for it before bed, so no questions could be asked. Every call the builder has not made is
  marked **(call)** and listed in §17. Where a requirement comes from the builder, their words are quoted.
- Revised twice (v2, v3) after two rounds of plan review and engineering review. §18 says where each finding
  went.
- Revised again (v4) on top of the trust line (`docs/superpowers/specs/2026-11-12-10db-trust-line-design.md` §13):
  a chat writes in Your folder, every builder tool is present and judged, and the builder's setup and the web come
  along. §19 says where each change went.

**Research:** `docs/architecture/research/2026-11-11-sessions-research.md` holds the vendor findings and the
codebase audit, with sources.

**UI:** `docs/superpowers/specs/2026-11-11-10db-sessions-ui.md` is the companion UI design, with mockups.

**Extends:**

- `2026-11-02-10db-brainstorm-chat-design.md`: Plan's conversation moves onto the shared engine (§6).
- `2026-11-09-10db-workbench-design.md`: a chat that writes in Your folder holds it as a pass does, and Do it in
  Your folder is an optional pass of one (§7.3). Its thread moves onto the shared stores (§6).
- `2026-10-13-10db-factory-loop-design.md`: §5.4 there, takeover, is built here as Open in Terminal (§7.5).

**Keeps:**

- The lane sandbox spec, and "the sandbox is the boundary" (`decisions/2026-10-29-sandbox-is-the-boundary.md`).
- The trust line (`2026-11-12-10db-trust-line-design.md`): one policy with four limits, a judge per agent, and
  the builder's setup on every surface. Every session here runs under it.
- The permission broker, and the guard as the trust line leaves it: the coordination rules and the `rules` floor
  (trust line §4).
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
- **Explore** is the engine's profile (`explore` in code): the live session of a conversation the engine owns, a
  chat or Plan. Both are attended (trust line §5). The name comes from Plan, which writes no code; a chat on it
  also writes in Your folder (§7.3) **(call)**.
- **Hands-on** is work a chat hands to a task with Do it: a task in a worktree, or, optionally, a pass of one in
  Your folder (§7.3).
- **Attended**, **unattended**, **limit**, **policy** and **judge** are the trust line's words (trust line, Words).
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

- A second permission system. Every session runs under the trust line's one policy.
- A card for a call that touches no limit (trust line §1).
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
| S2 | A session starts as a **Chat**. It reads, runs commands and searches the web, and it writes in Your folder, holding the folder while a turn runs (§7.3). It can commit, branch, push and open a pull request through the daemon's git tools; `.git` stays closed to the sandbox. **(call)** | The builder: "we're gonna fix this button super quick, or bump this package really quick, and I just want it done." The trust line lets a chat do the work (trust line §8, §13). The folder hold keeps one writer in Your folder. |
| S3 | **Do it** hands bigger work to a task: **In a separate copy**, or, optionally, **In Your folder, as a pass**. **File as tasks** puts the work on the Board instead. | The builder's three outcomes: no work, tasks, or "knock this out". A chat does small work itself; a task takes work that wants its own copy, a brief and the project's delivery. |
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
| S14 | A chat gets its own builder MCP server, on a per-session token. Every builder tool is present, and its calls are judged like any other call. Tools that make or edit work show with Undo. Removing or retiring work the chat didn't make is limit 1 (trust line §2), and the tool asks for it. **(call)** | The trust line: builder tools are all present; destructive ones get Undo or are judged (trust line §8). A card for a call that touches no limit is an anti-goal. |
| S15 | Optional: **Do it in Your folder, as a pass** is a pass of one, whose page is the whole checkout. It holds the folder, works on its own branch, and lands as a pass lands: one PR, and a close that fast-forwards the branch you were on. It opens in its own tab, and the chat stays open. **(call)** | A chat already writes in Your folder (S2). The pass of one is for work that wants the pass's kept turns, sign-off, Abandon and landing, and it never commits to a protected base. |
| S16 | **Do it in a separate copy** is an ordinary task, placed in a worktree, that starts from the chat's brief. The chat is sealed (§6.7), and the task takes its tab. The builder can message the task while it runs, and it lands by the project's delivery. **(call)** | It needs no new machinery, and sealing keeps one writer per agent session. A worktree task that stays warm between turns needs the pass rules made general, which M9 does. |
| S17 | Open in Terminal: the daemon runs the agent's own TUI in the builder's terminal, with the session's setup (instructions, plugins, MCP servers) and isolation (no settings file, strict MCP, untrusted trust), and the account's environment. The tab shows "In your terminal" until Hand Back. **(call)** | It covers every TUI-only feature, keeps one writer, and never runs project files the agent wrote outside a sandbox. |
| S18 | One forward migration moves Plan's and the threads' rows into the new tables, keeping their ids and ordering by a per-conversation `seq`. **(call)** | v0.1.0 is tagged, so migrations go forward only. Keeping ids keeps every reference valid without rewriting JSON lists. |
| S19 | Every session runs under the trust line: its calls are judged by `capabilities.judge` against the policy, and the builder's setup comes along (trust line §3, §4, §6). A chat, Plan and a pass are attended: at a limit they ask. Lanes are unattended: at a limit they skip. | One policy and the best judge each agent has. The guard keeps only the coordination rules and the `rules` floor. |

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
│                trust/  judge/  guard/  inbox/ (broker)  sandbox/  environment/ │
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
  capabilities(account: AccountExpectation, model: string | null): AgentCapabilities;  // model: for `judge`
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
- **`{ kind: 'explore', systemPrompt, tools, allowedTools, disallowedTools, agents }`:** the engine's attended
  profile. A chat and Plan both use it. A chat's tools include edits, and it writes in Your folder (§7.3). Plan's
  leave edits out, since Plan writes no code (trust line §8), and Plan adds its agents and its Shape MCP tools.
- **Every profile** carries the trust line's policy for its surface (`TrustPolicy`, trust line §3) and the builder's
  setup (trust line §6).

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
- `refusal` and `deniedBy`: set when a call was denied, so a card can say "You denied this", "10db stopped this:
  <reason>" or which limit stopped it
  - `builder`: the builder denied a card
  - `10db`: the guard refused it, by a coordination rule or the `rules` floor
  - `judge`: the session's judge denied it. `limit` names the limit when the denial is one of the policy's limits
    (trust line §2), and `soft` says whether the builder's go-ahead may clear it. In an attended session every
    classifier denial is `soft: true`, with or without a `limit`: Claude Code's denial doesn't say whether a soft
    deny or one of its own `$defaults` hard denies fired, so the row offers **Allow This** (§6.6), as Claude Code
    lets the user approve what auto mode blocked; against a hard deny the go-ahead is denied again, and the notice
    says so. A lane's denial and one of Claude Code's own safety checks are `soft: false`. M2c adds this value, `limit` and `soft`, from
    the limits the trust line's T3 names (each soft-deny line names its limit, trust line §3), since T3 lands
    first.

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
  judge: 'native' | 'tendb' | 'rules';    // who judges a call against the policy (trust line §4)
}
```

`judge` is per live session, not per account: it depends on the account kind and the model. A model change that
drops auto mode moves the session to `tendb` at its next turn (trust line §4). M2b adds the field and the `model`
argument, and its tables read the account kind only. T3 makes `judge` read the model, and T5 adds `tendb` for the
gateway and for Codex.

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
| judge | `native` (auto mode) on a plan, an API key or Bedrock, on a model auto mode supports; `tendb` on a gateway account, an unsupported model or with auto mode turned off by an admin | `tendb`: 10db's judge through the hook, after T5 (Auto-review reviews only escalations, which stay closed; live checks L1, L5) |

Without an OpenRouter key, or with 10db's judge turned off, `tendb` falls to `rules`, and the session says so
(trust line §4, §10). Until T5 builds 10db's judge, `tendb` is `rules`.

The capabilities DTO is in `packages/contracts`. `providerOf` becomes an open lookup that returns an adapter id,
and the UI never reads it.

### 5.4 Claude: one session core

`claude-adapter.ts` and `claude-shape.ts` become `claude-session.ts`, with a profile switch.

- **One options builder** (`claudeQueryOptions(profile, sandbox)`), tested as a pure table over profile × sandbox:
  - Both profiles get the builder's setup as the trust line's T2 builds it: the instructions appended to
    `systemPrompt`, and the skills and plugin dirs in `plugins` (trust line §6). T2 lands before M2a, so M2a's table
    takes T2's values as they are on `main`.
  - The lane profile keeps 10db's harness plugin dir, the sandbox and auto mode, and
    `settingSources: sandbox ? [] : ['project']`.
  - The explore profile keeps `settingSources: []`, `strictMcpConfig`, `agents`, and the Read-counting hooks. It
    runs in auto mode, with the policy's `autoMode` settings, where `capabilities.judge` is `native`, and in
    `default` mode with the hook judge elsewhere. Plan gets auto mode in M4b (trust line §12).
  - The explore profile never gets project settings or the lane's harness plugin dir. That is a row in the test.
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

**Explore on Codex** is the trust line's attended profile (trust line §4, §5):

- **The sandbox.** A chat's thread may write the checkout (`sandboxPolicy` workspace-write, by the generated type's
  name), since a chat writes in Your folder (§7.3). Plan's stays read-only, as its role.
- **The judge.** 10db's judge: `approvalPolicy: 'never'`, with the hook sending each call to it. Auto-review reviews
  only escalations, which stay closed, so it is not used (live checks L1, L5). The trust line's T5 builds it.
- The project is pinned `untrusted`.
- **The guard hook socket** stays, with the coordination rules and the `rules` floor
  (`decisions/2026-11-05-codex-lanes-use-codex-sandbox-and-hooks.md`). A call 10db's judge asks about reaches the
  broker as a card.
- **The setup:** `tools.web_search` on, the builder's skills through `skills/extraRoots/set`, and the instructions in
  `developerInstructions` (trust line §6, live check L4).
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
| `chat` (Sessions) | explore | the engine | the chat's builder server (S14); writes in Your folder under the folder hold (§7.3) |
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
- **The judge is the session's** `capabilities.judge` (§5.3), given the trust line's policy for the surface (trust
  line §3, §4). A chat, Plan and a pass are attended. The guard hook stays on every session, with the coordination
  rules (trust line §7) and the `rules` floor.
- **At a limit, attended** (trust line §5):
  - On auto mode, the limits are soft denies. The denial shows as a dim row with **Allow This**, which sends the
    builder's go-ahead as a message.
  - A call the judge escalates, or one 10db's judge asks about, is a card.
  - **Allow This** belongs to the kit's tool row (M3's `ToolCallCard`), so Plan (M4b), a chat (M5a) and a pass
    (M4c) all have it.
  - Anything else runs without a card.
- **Cards.** A card has a `card` item in its conversation and renders inline. Answering it in the session or in the
  Inbox answers the same card (S13). An answer is Allow once, Always in this project, or Deny (trust line §5). T5
builds the project's grants store and the card's third option, and gives the grants to every judge as allow lines:
auto mode's `allow` and 10db's judge's prompt. Until T5, a card offers Allow once and Deny.
- **The builder tools in a chat (S14)** come from the chat's own server, mounted per session with its own token. The
  UI's token never reaches a session. Every tool is present. A `runs` tool is in the session's allowed tools; a
  `judged` one reaches the judge like any call; an `asks` one raises its own card, attended.
- **A tool call waits** up to the lane's own limit, the project's human wait plus 5 minutes (`runner/runner.ts`),
  since an `asks` card waits on the builder. Plan keeps 60 s. On Codex, M5b sets `tool_timeout_sec` to the same.
  Stop or archive while an `asks` card waits withdraws the card, and the call returns denied ("The builder stopped
  the turn."). A card that outlives the wait is withdrawn the same way.

| Tool | In a chat |
| --- | --- |
| `create_task`, `set_title`, `write_brief`, `edit_task` | runs. Each shows as a tool row with Undo. Undo removes an unstarted task (the existing route), puts back an edit's old values, or restores the title |
| `start_task`, `run_next`, `move_task`, `start_shape`, `save_decision`, `save_principle` | runs. The row links what it started or changed |
| knowledge search and reads, `list_tasks`, `list_flows`, `list_projects`, `list_inbox`, `list_proposals` | runs |
| `remove_task` | runs on a task this chat made (`chat_tasks`). On any other task the tool itself asks with a card: removing work the chat didn't make is limit 1. The handler decides, since a judge can't know which tasks the chat made |
| `retire_knowledge`, `withdraw_knowledge`, `supersede_knowledge` | the tool asks with a card, every time: limit 1 |
| `make_branch`, `switch_branch`, `pull`, `commit_changes` (§7.3) | runs, and refuses unless the chat's turn holds the folder. The project's git hooks don't run. The row names the branch or commit |
| `open_pull_request` | runs. The row links the pull request |
| `push_branch` | judged. No force option |
| `merge_pull_request` | judged: limit 4 |
| any tool added later | present, and judged like any call |

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

`sealed` means the conversation has handed its work to a task in a separate copy (§7.3). It is read-only for good:
a message, Open in Terminal and Stop are refused, and only archive applies. It has no live session and is never
resumed. Do it in a separate copy moves any state to `sealed`, after closing the live session (a running turn is
stopped first, and its partial text is stored). Do it in Your folder, as a pass, seals nothing: it stops a running
turn first and leaves the chat in the state the stop reaches. Both are refused from `taken_over` ("Hand back
first").

The folder hold a chat's turn takes follows these states. Its table is in §7.3.

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
- `mode`: `explore` while the tab is the chat's own, `hands_on` once Do it in a separate copy hands the tab to a
  task
- `task_id` and `pass_id` (Do it)
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

**What the agent gets** (trust line §2, §6):

- the checkout: it reads all of it, and writes in it while a turn holds the folder (§7.3)
- the sandbox's rules: writes only in the checkout and the session's temp dir, credential stores unreadable, the
  network through the proxy
- the attended policy, judged by `capabilities.judge` (§6.6)
- the builder's setup and the project's, each behind its switch in Settings › Trust: the project's instructions,
  the builder's own `CLAUDE.md`, their skills and plugins, their MCP servers, and the project's skills, commands and
  agents
- the web: `WebSearch` and `WebFetch` on Claude, `web_search` on Codex
- Claude Code's own subagents, and the agents the builder's plugins bring
- the project's approved MCP servers
- the chat's builder server (S14)
- no settings file: `settingSources: []`, as on every engine session, so the builder's `~/.claude/settings.json`
  never loads (trust line §6)
- the attended `.env` rule (trust line §2): the checkout's `.env*` files are readable to the kernel, and reading one
  is a limit the judge asks about. The project switch "Agents may read `.env` files" makes it free, from the next
  session. T4 builds the attended and unattended split and the switch. M4b lands before T4, so Plan keeps today's
  `.env` behaviour there, and T4 extends its rule to Plan's sandbox. A chat gets it with that sandbox in M5a and
  keeps it in M6's

### 7.2 File as tasks

The agent calls `create_task` and its siblings. Each call shows as a tool row with the task's title, a Board link
and Undo. **File as tasks** in the header is a prompt shortcut that asks the agent to turn the conversation into tasks.

### 7.3 Writing in Your folder, and Do it

**A chat writes in Your folder** (S2), as Claude Code does in a terminal.

- **It writes while its turn holds the folder** (the folder hold, below). A turn that couldn't take the hold still
  runs, but writes nothing. The guard's coordination rule refuses its edits, and any command the read-only line
  doesn't pass (`guard/read-only.ts`), with "Your folder is in use by {holder}." The session bar says so. The
  sandbox profile is fixed when a session starts, so the hold is the guard's, not the kernel's.
- **Background jobs** a chat's turn starts stop when the turn ends, so nothing it started writes after it gives the
  hold back **(call)**. They run under the lanes' process tracking.
- **Git goes through the daemon** **(call)**. The sandbox keeps `.git` closed, as it does for lanes
  (`sandbox/project-access.ts`), and git trust is unchanged (`git/git.ts`, `git/trust-card.ts`). The chat's builder
  server has the git tools, which run the daemon's own git and `gh` in Your folder, the way a lane lands:
  - `make_branch` (from `HEAD`), `switch_branch`, `pull` (a fast-forward of the current branch), `commit_changes`
    (a message and the paths, or every change), `push_branch` and `open_pull_request`. `merge_pull_request` merges
    a pull request.
  - **The tools that change the folder** (`make_branch`, `switch_branch`, `pull`, `commit_changes`) refuse unless
    the chat's turn holds the folder, naming the holder when another has it.
  - **Hooks are off.** The daemon's git runs with the project's hooks off (`git/daemon-config.ts`), so the
    project's own pre-commit and pre-push hooks don't run on a chat's commit or push. The tools' descriptions say
    so. A follow-up task runs the project's commit checks for chat commits **(call)**.
  - `push_branch` has no force option. A force push of history others have stays limit 1 and has no tool.
  - Credentials stay with the daemon. The sandbox never reads the Keychain, a credential file or `gh`'s token.
  - A push is judged. Merging a pull request is limit 4 (trust line §2). Both reach the judge (§6.6).
  - **Any git write in the chat's shell** (commit, push, branch, switch, checkout, merge, rebase, reset, pull, tag,
    stash, and `gh pr create` or `merge`) is refused by the guard with one message listing the tools. Reading git
    (`git status`, `git diff`, `git log`) runs.
  - **On Codex** the same tools reach the thread through 10db's `/mcp`, and the guard socket refuses the same
    commands.
- **No lane rules.** No claims or hazards, since nothing else writes the folder while the turn holds it. 10db makes
  no commit of its own and runs no gate for a chat. Installs run in place. (Trust line §7.)
- **Uncommitted work** is the folder's, as in a terminal. 10db neither commits nor discards it.
- **Agent-written config** (`.claude/settings*.json`, `.claude/hooks`, `.mcp.json`, a mise config) may be written,
  and runs only after the builder approves its hash (trust line §2).
- **A gap: the builder's own MCP servers** run outside the sandbox (trust line §6, T6), so a write through one of
  them is not stopped by the hold. Their calls are judged, not held. A follow-up task after T6 decides whether a
  writing call waits for the hold.

**The folder hold** (Workbench W9, made a primitive here, M6) **(call)**.

- **One daemon module** (`apps/daemon/src/folder-hold/`) holds, per project, who has Your folder, by kind and id:
  - `pass`: a pass, a pass of one included, for its life. One at a time.
  - `chat_turn`: a chat's running turn. One at a time.
  - `takeover`: a chat in the builder's terminal (§7.5). One at a time.
  - `lane`: a Board task that runs in Your folder (`WorkspaceMode.Shared`, or any task on a `local` project,
    `placement/propose.ts`). **Counted:** the scheduler runs several of them in Your folder at once today, up to
    the project's `maxLanes`, coordinated by claims and hazards (`scheduler/scheduler.ts`). A lane holds from its
    task's first start in the folder until the task lands or ends, between its steps too.
  - The kinds exclude each other: while any lane holds, no chat turn, takeover or pass takes the folder, and while
    one of those holds, no Your-folder lane starts.
- **Its readers** are the scheduler's W9 wait (`scheduler/scheduler.ts`), `proposePlacement`, pass open, the Do it
  refusals, a chat turn's start and Open in Terminal. Each refusal and wait reason names the holder: "Your folder is
  in use by the pass ‘Settings pass’", "… by the chat ‘Retry login’ in your terminal", "… by the task ‘Bump
  vite’".
- **It lives in memory** and is rebuilt at daemon start from live state: open passes, running Your-folder lanes and
  chats in `taken_over`. A chat turn doesn't survive a restart (§6.7), so its hold doesn't either.
- **A chat's hold, by state** (the §6.7 states):

| Event | The hold |
| --- | --- |
| a turn starts (`starting` → `running`) and the folder is free | taken, as `chat_turn` |
| a turn starts and another holds the folder | not taken; the turn runs and writes nothing |
| the holder leaves while the turn runs | not taken mid-turn; the next turn takes it |
| a turn starts between two steps of a Your-folder task | not taken: the task's lane still holds, so the turn writes nothing |
| `turn_complete` with messages queued (a chained turn) | kept for the next turn |
| `turn_complete` with nothing queued | released |
| any other exit from `running`, `waiting_card` or `stopping`: `ended` error, rate-limited or unasked, the stop grace's `stop()`, archive, Do it (`sealed`) | released, after the session's background jobs stop |
| Do it in Your folder | the running turn is stopped, and the pass opens only once the stop has settled and released the hold |
| Open in Terminal, the folder free or held by this chat | taken, as `takeover` |
| Open in Terminal, another holder | refused, naming it |
| Hand Back, or archive from `taken_over` | released |
| daemon restart | a `chat_turn` hold is gone; a `takeover` is taken again from the `taken_over` row |

**Do it.** The Do It sheet (UI spec §8.1) hands bigger work to a task. It offers two places.

**In a separate copy** (S16): an ordinary task in a worktree.

- Do it first seals the chat (§6.7). The task starts a new agent session from a brief, on Claude and on Codex
  alike. The chat's agent writes the brief when the Do It sheet opens: a short turn that calls `write_brief` on the
  chat's builder server. The builder can edit it before Start. If the agent is unavailable or doesn't answer within
  60 seconds, the brief is the chat's digest plus the builder's last message **(call: the designer's)**. It never
  resumes the chat's agent session, so one agent session never has two writers, and the picture budget starts clean
  **(call: the digest carries the context; resuming would need a fork and a copied picture budget for little
  gain)**.
- The task starts as any worktree task starts. Changes the chat left uncommitted in Your folder stay there (§7.4).
- The Task takes the Chat's place in the tab strip. The sealed Chat closes, and stays reachable from the Task's
  "From chat" link, ⌘⇧T and ⌘K. Its read-only line offers **New Chat From This**, which starts a fresh chat seeded
  from its digest, with no resume **(call: the design review's; the strip doesn't fill twice as fast, and the
  builder can keep talking)**.
- The tab shows the task's thread, where messages reach the running lane, and the task's live line.
- It lands by the project's delivery. Its card on the Board is the usual one.
- It does not stay warm between turns, which waits for M9. When it finishes, the tab says so and offers the Board
  and the PR.

**In Your folder, as a pass** (S15, optional): a pass of one, whose single page is the whole checkout.

- It is for work that wants the pass's ceremony: kept turns, Sign Off, Abandon, one PR and a fast-forward. A chat
  that just writes needs none of it.
- It opens as a pass opens (Workbench spec §5.1):
  - the pass's own branch, from `HEAD`
  - `return_branch` and `start_sha` recorded
  - the folder held for the pass's life, so other Your-folder work goes to a copy or waits (W9)
- Do it is refused, with a reason and a link, in these cases:
  - while another holder has the folder (a pass, a Your-folder lane, a takeover), named in the refusal
  - while a merge, rebase or bisect is in progress
  - when the folder's state refuses a pass today

  A running chat turn is stopped first, so its hold is given back.
- The brief is written as for a separate copy. The task starts a new agent session from it, and never resumes the
  chat's.
- **The chat is not sealed** (trust line §13). The pass opens in its own tab beside the chat. The chat stays open,
  and its turns write nothing while the pass holds the folder.
- The page is synthetic: a page named "Whole project" over `WHOLE_REPOSITORY_GLOBS` (`@10db/contracts`), made for
  this pass and never saved as a project area. The pass's page code takes it in place of an area-backed page, and
  `no_page_area` does not apply.
- Hazards still apply. The judge's rule that counts a hazard only outside the pass's pages does not apply to a
  whole-project page, so lockfiles and migrations keep their rules. A judge table row covers it.
- **Sign Off and Abandon** are the pass's, word for word. Sending a message reopens the page, as in a pass.
- **Landing** is the pass's close:
  - one PR, on every project (Workbench W8)
  - then a fast-forward of the branch the builder was on, when the PR merges, or at once on a `local` project
    (`decisions/2026-11-09-a-close-fast-forwards-the-folders-branch.md`)

  The folder ends on the branch it started on, holding the work.
- **The Workbench.** It lists a pass of one with the other passes. Its page reads "Whole project" **(call)**.
- **The Inbox.** A pass of one's Ready and question cards open its Sessions tab, not the Workbench.

**The Changes panel** (UI spec §9) reads `GET /workstreams/:id/changes`, the route the builder's check card already
uses. Before M4c, a Task's tool rows show only once the runner stores `tool_call` items (M4c).

**Per provider.** A chat's writes, and both Do it places, run on Claude and on Codex. Passes and worktree tasks
already do (research T1), and the attended profile writes the checkout on both (§5.5).

### 7.4 What Do it never does

- Hide what happens to uncommitted work in Your folder. The Do It sheet lists the changed files and says which
  rule applies **(call: the pass's existing rule wins; refusing a dirty folder would make "knock this out" fail on
  the common case)**:
  - **A pass:** a whole-project page covers every file, so by the pass's own rule (Start Pass), uncommitted changes
    become part of the task's work.
  - **A separate copy:** they stay in Your folder, and the task starts without them.
- Run a pass on a folder in the middle of a merge, rebase or bisect.
- Force a branch move. The fast-forward is compare-and-swap, as a pass's is.

### 7.5 Open in Terminal, and Hand Back

**Open in Terminal** (S17) works on a session that has a provider session id and no running turn.

1. The engine closes the live session, and the conversation goes to `taken_over`.
2. The adapter's `takeoverCommand` builds the command:
   - **Claude:** the pinned `claude` with `--resume <id>`, `--setting-sources` matching the session's (none for
     explore), `--strict-mcp-config` and an `--mcp-config` file naming only the servers the session had (the
     project's approved ones and the builder's own, trust line §6), a `--plugin-dir` for each plugin dir the session
     had, and the instructions it had appended, with `CLAUDE_CONFIG_DIR` set to the account's directory.
   - **Codex:** the pinned `codex resume <id>` under the account's `CODEX_HOME`, with the project still pinned
     `untrusted`, and the session's skill roots and instructions.
   - **Sessions that wrote** (a chat, a pass, a worktree task) load a project hook only when the builder approved
     its hash (trust line §6). A file the agent changed has a new hash, so it doesn't load. The banner lists such
     files.
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

**Holds.** A chat takes Your folder's hold for the whole takeover (`takeover`, §7.3), since its turns in the
terminal can write; Hand Back gives it back. When another writer holds the folder, Open in Terminal is refused
("Your folder is in use by {holder}"). A pass of one keeps its folder hold through a takeover. A worktree task keeps
its claims. The banner names each, and a forgotten Hand Back shows by name in every wait and refusal it causes
**(call)**.

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
  - A call the judge denied is a dim row naming the limit. In an attended session it offers **Allow This** (§6.6).
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
`ToolCallView` gains `refusal`: the reason, when the guard, the broker or the judge denied the call (§5.2).

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
| `chat/` (new) | Sessions: chats, titles, the chat's builder server, the folder hold for a chat's turn, Do it, archive |
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
| `POST /chats/:id/do-it` | `{ place: 'worktree' \| 'here' }`: a separate copy, or a pass of one in Your folder. |
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
  test over every builder tool, and it checks that none is missing.
- **A chat's git** goes through the daemon's tools (§7.3). `.git` stays closed to the sandbox, git trust is
  unchanged, and credentials stay with the daemon. M6's git tools and the guard's git refusals get adversarial
  review.
- **A chat's writes** are bounded by the sandbox: the checkout and the session's temp dir (trust line §2). The
  folder hold is coordination, not a boundary. A judge's mistake can let through a call inside that line, never a
  write outside it (trust line §11).
- **Takeover (S17).**
  - Isolation flags go on every launch, beside the session's setup.
  - No secret is in the file, and the file is mode 700 and removed after launch.
  - The daemon runs `open` itself, so the webview never can.
  - Project setting files the agent changed are named in the banner and never loaded.
  - The launch command is a pure table test per harness and profile.
- **File mentions.** `git ls-files` only. A mention reaches the agent as a path, and the session's judge decides each
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
| M5a | **Sessions on Claude.** The screen, tabs, new session, File as tasks, the chat's builder server, `/` and `@`, notifications. Attended and judged, with the builder's setup and the web. A chat reads and runs commands; its writes come in M6. | The feature. | medium |
| M5b | **Codex conversations.** Chats on Codex on the attended profile, and Plan on Codex without subagents. | Sessions and Plan on ChatGPT. | medium: the judge |
| M6 | **Writing in Your folder, and Do it.** The folder hold as a module. A chat writes under it, and commits, branches, pushes and opens a PR through the daemon's git tools. Do it in a separate copy; a pass of one as the option; the tab transitions. | "Knock this out." | high: the hold, git tools, adversarial review |
| M7 | **Open in Terminal and Hand Back.** | The escape hatch. | medium: security table |
| M8 | **Spotlight.** ⌘K over sessions, projects and commands. | Polish. | low |
| — | **The ACP spec, then OpenCode** (§5.6). | Gemini, or any model through OpenRouter. | its own spec |
| M9 | **Lane steps as conversations** (§6.9), with its own spec. | Every task has a transcript; worktree tasks stay warm. | high |

**Order.**

- M1 ships alone.
- The trust line's milestones interleave (trust line §12; the roadmap holds the full order): T2 after M1 and before
  M2a, T3 after M2b, T4 and then T5 after M4b, T6 after M5b.
- M2a, then M2b, then M2c.
- M3 needs M2c.
- M4a needs M2c. M4b needs M4a and M3. M4c needs M4b.
- M5a needs M4c (and so T5). M5b needs M5a. M5a and M5b ship in the same release, since Sessions has no flag to
  hide it behind and a chat must run on every account kind.
- M6 needs T6, after M5b (the roadmap's order). M7 needs M6, whose folder hold a takeover takes.
- M8 is anywhere after M5b.

Two UIs exist only from M3 to M4c, and two transcript stores never exist.

## 13. Testing

The rules in `.claude/rules/testing.md` apply. These are the rows for this spec, by rung.

**Pure:**

- `ToolCallView` mapping tables, per adapter
- hunks: Claude edit, `Write`, a Codex patch, and the 1,500-line cap
- the capability tables, `judge` included, plus the invariant that `inject` requires receipts
- the Claude options builder over profile × sandbox
- the §6.7 table, as a reducer with one row per cell
- delivery rules 1 to 5
- the delta offset reducer: interleaved, duplicate and gap frames
- the `/` command map
- the chat's builder tool table, over every builder tool
- the judge row for a whole-project page, where hazards still apply
- the takeover command table
- the hostile-markdown test
- the Codex fixtures through `z.fromJSONSchema`
- the type-compatibility test

**Real SQLite:**

- the migration from a seeded 0064 database (§9.2 step 5)
- Stop and archive while an `asks` card waits: the card is withdrawn, and the call returns denied
- the folder hold's table (§7.3), a row each, on the explore engine with a real store: release on an error end, a
  rate limit, an unasked end, the stop grace, archive and Do it; a restart drops a `chat_turn` and keeps a
  `takeover`
- the stores
- per-project usage across all three owners

**Rendered or HTTP:**

- the kit components
- the Sessions screen (`renderWithDaemon`)
- the routes (`app.request()`)
- live frames over a real WebSocket

**Real git:**

- a chat's turn in Your folder: an edit, then `make_branch` and `commit_changes` through the daemon, and the hold
  given back when the turn ends
- a git write in a chat's shell is refused, with the message that lists the tools
- `commit_changes`, `make_branch`, `switch_branch` and `pull` refuse while the turn doesn't hold the folder
- a chat's turn between two steps of a Your-folder task writes nothing
- a chat's turn while a pass holds the folder: no edit lands, and the refusal names the pass
- a chat's turn while a Your-folder lane runs: no edit lands, and the lane's kept work holds none of the chat's
- a task scheduled during a chat's turn waits, naming the chat; a pass opened during it is refused, naming it
- Do it Here on a feature branch
- Do it Here on base, on a pull-request project and on a `local` project
- Do it refused mid-merge
- after the close: HEAD, the working tree and the landed commit, for each case

**Pipeline:**

- restart rows for every §6.7 state, on the explore engine's own fixture and through Plan's service fixture
  (`createTestEngine` builds no explore engine)
- a task conversation in every lane state, with the fake's single-open assertion keyed by provider session id
- Do it in a separate copy while the chat's session is warm: afterwards a message or takeover on it is refused
- Do it in Your folder while the chat's session is warm: the chat stays open, and its next turn writes nothing
  while the pass holds the folder
- a runner claim test with the fake emitting only `tool_call`, so a `tool-target.ts` regression that stops
  claims goes red
- e2e: Plan and the Workbench kept green through M3 to M4c
- a new e2e: a chat edits a file in Your folder, then Do it in Your folder, then sign-off

**Live (opt-in):**

- streaming checks added to the Claude and Codex live tests
- a Codex chat on the attended profile, whose judge stops a call at a limit (live check L1)

**Unchanged and on their rung:**

- `runner/pass-lane.test.ts`
- `test/crash-recovery.test.ts`
- `shape/confinement.test.ts`, until M4b gives Plan auto mode and retires the rows the trust line removes (web,
  command cards, the researcher's limits). M4b names each.
- `codex-guard.test.ts` and `codex-session.test.ts`, unchanged by Sessions. The trust line's T3 and T5 change the
  guard and the Codex judge, and their own tests with them.

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
| M5a | Sessions is a top-level screen. A chat is attended, and its builder tools are all present; removing or retiring the builder's work asks (S1, S13, S14, S19). |
| M5b | Plan and Sessions run on Codex without Claude-only subagents (S8). Amends `2026-11-05-chatgpt-plan-through-the-codex-app-server.md`. |
| M6 | The folder hold is one module. A chat writes in Your folder under it, with git through the daemon's tools. Do it in a separate copy is a task that seals the chat, and Do it in Your folder is an optional pass of one (S2, S15, S16). |
| M7 | Takeover is Open in Terminal with isolation and Hand Back (S17). |

## 15. Out of scope, and later

- ACP and OpenCode, which get their own spec.
- M9 and `interactive/`.
- Plan's subagents on Codex, as a follow-up task.
- Rewind and fork.
- Search across conversations.
- Cloud sessions.
- An embedded terminal.
- `@pierre/diffs`.
- Showing the terminal's turns after Hand Back.

## 16. Live checks

Each check is free, or costs one turn. The trust line's L1 to L4 (trust line §14) gate T2, T5, M5b and the Codex
rows of §5.3 and §5.5. Results of both lists go in the research notes.

1. **`claude --resume <id>`** opens a Plan session's id with `CLAUDE_CONFIG_DIR` set to the account's, and with
   `--setting-sources ''` and `--strict-mcp-config`.
2. **`codex resume <id>`** opens an app-server thread under the account's `CODEX_HOME`.
3. **A read-only Codex thread** (Plan's) refuses a write, and the hook still runs.
4. **Title-bar tabs in Tauri:** a tab in the title bar doesn't start a window drag, and ⌘W reaches the webview
   before the menu's Close (UI spec §20).
5. **The streamdown spike** in Plan's transcript: a 20k-token streaming message, at 50 ms frames, inside the
   virtualizer, in the Tauri webview.
6. **The OpenCode handshake** (research T3 §3), for the ACP spec.
7. **A go-ahead clears a soft deny** (with the trust line's L2): after auto mode denies a call at a limit, the
   builder's "Go ahead" message lets the retry through, and a `$defaults` hard deny stays denied.

## 17. Calls to review

Each call is marked **(call)** where it is made. Grouped by what the builder is likeliest to change:

1. **Name and place.** The UI says "Sessions" and the code says `chat`. Sessions is a top-level screen with tabs
   across projects (S1).
2. **A chat writes in Your folder,** holding the folder for each turn, and commits, branches and opens a pull
   request (S2, §7.3). Do it in a separate copy is an ordinary task, not warm between turns until M9 (S16). Do it in
   Your folder, as a pass of one, is optional, and seals nothing (S15).
3. **The Workbench lists a pass of one** as "Whole project" (§7.3).
4. **What a chat loads** is the trust line's (§6, §9 there): the builder's setup and the web, behind switches, and
   no settings file (§7.1). The project's account, and the `plan` role's model by default (§7.1).
5. **No account or harness change after the first message** (§6.4). At most 4 warm Explore sessions (§6.4).
6. **After a crash,** queued messages wait under "Send now" (§6.4).
7. **Do it starts the task from a brief.** In a separate copy it seals the chat; in Your folder it doesn't. On both
   providers (§7.3).
8. **Generated Codex types are a subset** (§5.5).
9. **The migration keeps ids** and orders by `seq` (§9.2).
10. **Takeover** uses Terminal by default, with no history import on Hand Back (§7.5).
11. **ACP gets its own spec** (§5.6).
12. **The designer's calls** in the UI spec's own list (§19 there) are adopted unless they contradict this spec. Among them: tabs in the title bar; Do It opens a new tab; the agent writes the brief; ⌘↩ sends everywhere.
13. **The engine's profile keeps the code name `explore`,** though a chat on it writes (Words). Renaming it touches
    every plan from M2a on, for no behaviour.
14. **A chat's hold lasts one turn, and its background jobs stop with it** (§7.3). Between turns a pass can take the folder, and the chat's next turn then
    writes nothing until the pass ends. A chat takes the hold for a whole takeover (§7.5).
15. **`start_task` runs without a card** (§6.6): starting a task touches no limit. Removing or retiring work the chat
    didn't make is limit 1, and the tool asks.
16. **A chat gets subagents:** Claude Code's own, and the agents of the builder's plugins. Plan's researchers and
    reviewers stay Plan's (§7.1).
17. **A chat's git goes through the daemon's tools** (§7.3), with `.git` closed to the sandbox, and plain `git
    commit` or `git push` in its shell is refused, naming the tool.
18. **The folder hold is one daemon module** with four holder kinds, in memory and rebuilt at start (§7.3).

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

## 19. Where the trust line's changes went

| Trust line §13 | Where |
| --- | --- |
| S2, §7.1: a chat is no longer read-only; "a chat that writes the repository" leaves the anti-goals | S2, Anti-goals, §7.1, §7.3 |
| S15, §7.3: Do it Here becomes optional; a chat writes in Your folder, holding the folder | S3, S15, §6.7 (`sealed`), §7.3, §7.4 |
| Do it in a separate copy stays; the sealed handoff stays only there | S16, §6.7, §7.3 |
| S14, §6.6: builder tools all present and judged; the "absent" rows go | S14, §6.6, §11, §13 |
| §7.1: setup per the trust line's §6; web on; no `settingSources` call | §5.4, §5.5, §7.1, §17 call 4 |
| §17.4: the calls on skills, web and settings | §17 call 4, §15 (project skills leave "later") |
| `AgentCapabilities` gains `judge` | §5.3 |
| M5a, M5b: the chat and Codex explore profiles become the attended profile | §5.1, §5.5, §6.6, §12 |
| Also: the guard's role, carded web and MCP, Plan's auto mode, judged denials | Keeps, S19, §5.2 (`deniedBy`), §5.4, §6.6, §8 |
| Review round 1 (plan review of v4) | §5.1, §5.2 (`soft`), §5.3, §6.6, §6.7, §7.1 (`.env`), §7.3 (git tools, the folder hold), §7.5, §9.1, §11, §12, §13, §16 check 7, §17 calls 14–18 |
