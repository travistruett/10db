# Sessions research (2026-11-11)

> **Correction (coordinator):** T1 §5 row C says the migration baseline is regenerated before v0.1.0. v0.1.0 is tagged and migrations are forward-only (`packages/db/AGENTS.md`); the spec's §9.2 is a forward migration.

Research behind `docs/superpowers/specs/2026-11-11-10db-sessions-design.md`. Section 0 is the first pass; T1 to T5 are the overnight tracks, each by a research agent (model named in each), saved as they reported. Facts are marked VERIFIED or INFERRED by the agent that found them.

## 0. First pass

### 1. What 10db already has (read from the code)

| Piece                                              | Where                                                                                                                              | What it gives Sessions                                                                                                                                                                                                                                                      |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A structured chat in 10db's own UI                 | Plan (`apps/daemon/src/shape/`, `apps/desktop/src/views/shape/`), decision `2026-11-02-shape-is-an-sdk-session-in-10dbs-own-ui.md` | Agent SDK session, typed messages rendered by 10db, a transcript stored by 10db (`shape_messages`), queue one turn at a time, Stop (interrupt), images, model picker, 10-minute warm session then resume by id, fresh session from a deterministic digest past 70% context. |
| Read-only confinement with real commands           | `2026-11-05-plan-runs-commands-and-project-tools-through-the-lane-broker.md`                                                       | Read-only lane sandbox, guard on Bash, project MCP servers, permission broker cards owned by a conversation (not a workstream).                                                                                                                                             |
| Questions as cards                                 | `apps/daemon/src/inbox/permission-broker.ts:615`                                                                                   | `AskUserQuestion` already becomes a card.                                                                                                                                                                                                                                   |
| Two native adapters                                | `sessions/claude-*.ts` (Agent SDK), `sessions/codex-*.ts` (`codex app-server`)                                                     | One `SessionAdapter` interface (`sessions/types.ts`), with `start` (lane) and `startShape` (chat). Pinned, unmodified binaries (`2026-11-08-...pinned-copies...`), a per-account `CLAUDE_CONFIG_DIR` / `CODEX_HOME`.                                                        |
| Task threads (branch `feat/workbench`, not merged) | `apps/daemon/src/thread/`, `task_messages`, decision `2026-11-11-a-pass-runs-on-the-projects-account-claude-or-codex.md`           | A builder message to a running lane, a lane session that stays open after its step, pictures, Stop and Redo, Codex `turn/steer` with `clientUserMessageId` receipts, exactly-once delivery where the thread can be read. Works on Claude and Codex.                         |
| Filing tasks from a chat                           | builder MCP (`apps/daemon/src/builder/`), `create_task` and siblings                                                               | A chat can create, edit and start tasks with tools that already exist.                                                                                                                                                                                                      |
| Placement and claims                               | worktree mode, "Your folder", claims, the watcher                                                                                  | Where writing work runs, and how it avoids colliding with lanes.                                                                                                                                                                                                            |
| Takeover                                           | factory-loop decision 3 and §5.4                                                                                                   | **Designed, not built:** pause the managed session, release the lease, `claude --resume <id>` in a terminal, "hand back" afterwards.                                                                                                                                        |

Two gaps:

- Plan refuses a ChatGPT account (`shape/chatgpt-refusal.test.ts`, `BRAINSTORM_REFUSED_ON_CHATGPT`). Sessions must
  run on Codex, because ampsio bills to ChatGPT on purpose.
- "Session" is already a code term: the `sessions` table, `SessionAdapter`, and the Sessions part of Factory's goal
  detail. The Workbench spec (W2) avoided the word for that reason.

### 2. How the agents expose an interactive session (external, fetched 2026-11-11)

### Claude Code: Agent SDK

All verified on code.claude.com (agent-sdk/typescript, /sessions, /user-input):

- **Streaming input mode** (async-iterable prompt, `streamInput`). It is required for `interrupt()`,
  `setPermissionMode()`, `setModel()` and `applyFlagSettings()`.
- **Query methods:**
  - `supportedCommands()`, `supportedModels()`, `getContextUsage()`
  - `rewindFiles()`, which needs `enableFileCheckpointing`
  - `backgroundTasks()` and `stopTask()`
  - MCP toggles
  - `reloadSkills()`
- **Session APIs:** `listSessions`, `getSessionMessages`, `getSessionInfo`, `renameSession`, `tagSession`, and
  `forkSession(id, {upToMessageId})`. Use these rather than parsing the JSONL, whose format is internal and
  changes between versions.
- **Slash commands:** sending `/compact`, `/clear` or `/context` as a prompt works. `system/init` lists the
  available commands and skills. An unknown `/x` goes to the model as text.
- **Questions:** `AskUserQuestion` arrives through `canUseTool` and may wait indefinitely. It is not available
  inside subagents.
- **Handoff to the CLI:**
  - `claude --resume <id>` opens an SDK session from any directory, and SDK `resume` takes a CLI id. The two share
    the transcript store under `CLAUDE_CONFIG_DIR`.
  - SDK and `-p` sessions are hidden from the `/resume` picker and from `--continue`, so a handoff must open them
    by id.
  - `--mcp-config`, `--settings`, `--plugin-dir` and `--system-prompt` must be passed again on resume.
  - Two writers on one session interleave its transcript, so keep one at a time.
  - Transcripts are kept for 30 days by default.
- **The TUI has, and the SDK has no direct equivalent for:**
  - the resume picker (build it from `listSessions`)
  - `@` file autocomplete
  - image paste (10db already does this)
  - the `!` bash prefix
  - the Esc-Esc conversation rewind (only `rewindFiles` exists)
  - terminal-only commands (`/theme` and the like)

### Codex: `codex app-server`

Verified on learn.chatgpt.com/docs/app-server and the app-server README:

- **Threads:** `thread/start`, `thread/resume`, `thread/fork` (`lastTurnId`, `ephemeral`), `thread/list` (paged,
  filtered by `cwd` and `searchTerm`), `thread/read`, `thread/archive`, `thread/compact/start`.
- **Turns:**
  - `turn/start` takes per-turn overrides (model, effort, `cwd`, sandbox policy, `approvalPolicy`), which become
    the thread's defaults. Switching models mid-thread means passing a new model on the next turn.
  - `turn/steer` needs `expectedTurnId`.
  - `turn/interrupt` ends the turn.
  - `review/start` runs a review.
- **Approvals** are requests from the server to 10db:
  - `item/commandExecution/requestApproval` (accept, acceptForSession, decline, cancel, or an execpolicy amendment)
  - `item/fileChange/requestApproval`
  - `item/permissions/requestApproval`
- **Streaming events:** `item/agentMessage/delta`, `item/reasoning/*`, `item/commandExecution/outputDelta`,
  `item/started` / `item/completed`, `turn/completed`.
- **Not documented:** a slash-command protocol. A client builds its own palette over the RPCs.
- **Unconfirmed:** whether `codex resume <id>` in the TUI opens an app-server thread. It is likely, since both use
  the same core and the same rollout files. Needs a live test on the pinned release.
- "An unused thread is not guaranteed to survive restart."

### Others

- **Pi (pi-mono coding-agent):**
  - Hosts it through JSONL RPC over stdio or an in-process TS SDK (`createAgentSession`).
  - Commands include `prompt`, `steer`, `follow_up`, `abort`, `fork`, `clone`, `set_model` and `compact`.
  - Sessions are a tree under `~/.pi/agent/sessions/`.
  - It has many providers.
  - No permission-prompt model was found, so the host's sandbox must be the only boundary.
- **Factory droid:**
  - `droid exec --input-format stream-jsonrpc --output-format stream-jsonrpc`
  - `droid.initialize_session` / `load_session` / `add_user_message`
  - The client receives `droid.request_permission` and `droid.ask_user`.
  - TS and Python SDKs (`@factory/droid-sdk`).
  - Autonomy levels: read-only by default, then `--auto low|medium|high`.
- **ACP (Zed's Agent Client Protocol):**
  - JSON-RPC over stdio, v1 stable, v2 a draft.
  - It covers sessions, list and resume, prompt turns, tool calls, permission requests, plans, modes, config
    options and slash commands. Fork, archive and subagents are still RFDs.
  - The registry lists 51 agents:
    - Claude through Zed's adapter over the Agent SDK. Its own README says v2 is experimental and steering works on
      v1 only.
    - Codex through `codex-acp`, now rebuilt on app-server.
    - Pi through `pi-acp`, with no MCP pass-through and no fs or terminal delegation.
    - Gemini CLI, Droid, Copilot CLI, Goose, OpenCode and others.

### How the products present many sessions

- **VS Code:**
  - The session list is the index. The Agents window opens each chat as a tab, grouped by workspace.
  - Each session is Local (a folder), Worktree, or Cloud, chosen when it is created.
  - Archiving a worktree session commits to the session branch and removes the folder.
  - Hand-off: Open in Editor / Resume in Terminal.
  - Claude and Codex run there as third-party harnesses.
- **Cursor 2.x/3:**
  - Up to 8 parallel agents in a sidebar, each in a worktree or on a remote machine.
  - The Agents window shows local and cloud agents together, grouped by repository.
- **GitHub Copilot:** an Agents panel lists tasks, and a cloud session ends in a PR.
- **Conductor:** a workspace, branch and terminal per task, over Claude Code, Codex, Cursor and OpenCode.
- **Unknown:** how Conductor, Superset and opcode embed the agent (PTY, stream-json, SDK or ACP). Their source was
  not read.
- **Sunset or deprecated:** Vibe Kanban is sunsetting. Crystal was deprecated in Feb 2026.
- **The common pattern:** a list or sidebar is the index, tabs are the open chats, and place (local / worktree /
  cloud) is picked when a session is created. A worktree session ends in a PR or is archived.

### Terms and billing (Claude)

- **Allowed:** an end user signing in to the unmodified Claude Code binary with their own subscription, "including
  where a platform hosts Claude Code" (code.claude.com/docs/en/legal-and-compliance). 10db runs the pinned,
  unmodified binary under the builder's own login, so this holds as long as 10db never reads or stores the OAuth
  token, which it doesn't today.
- **Not allowed:** SDK products may not use "Claude Code" branding.
- **Billing:**
  - The June 15, 2026 plan to move Agent SDK and `claude -p` use to a separate credit was paused.
  - Anthropic's support article 15036540 says that when you sign in with the plan, the SDK and `-p` "still draw
    from your subscription limits".
  - The Oct 7, 2026 update adds monthly API credits on Max, Ultra and Team, which apply only with an API key from a
    linked Console organization.
  - So an SDK chat costs the same plan limits as typing into `claude`. There is no billing reason to prefer a PTY.

### 3. The three ways to build it

|                                                       | PTY + xterm.js wrapping the TUI                                       | ACP over every agent                                                     | 10db's own adapters (SDK + app-server)         |
| ----------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------- |
| TUI parity                                            | full                                                                  | partial, per adapter                                                     | partial; fill gaps by hand                     |
| Permission cards, sandbox, guard, broker              | none beyond the terminal                                              | through ACP's permission request; the guard and hooks are lost on Claude | yes, the mechanisms lanes and Plan already use |
| File tasks, pictures, Inbox, usage, fallback accounts | no (screen-scraping)                                                  | partly                                                                   | yes                                            |
| Codex steer with receipts, review mode                | via TUI                                                               | lost or unconfirmed                                                      | yes (Workbench)                                |
| New code                                              | a Rust PTY in Tauri plus a terminal view; little shared with the rest | a third protocol layer beside two working ones                           | a chat service over existing adapters          |
| Already decided                                       | turned down for Plan (decision above)                                 | not considered                                                           | the runtime for lanes and Plan                 |

**Recommendation:** build on 10db's own adapters. A PTY buys TUI parity and gives up everything that makes the
work 10db's: cards, sandbox, tasks, usage, accounts. Keep ACP as the way to add a third agent family later (Pi,
Droid, Gemini) as one more `SessionAdapter`, not as the base. Pi's lack of a permission model means it would run
only inside the lane sandbox.

The terminal stays one click away, as **Open in Terminal**: the designed takeover, `claude --resume <id>` or
`codex resume <id>`, in iTerm. It runs with the account's `CLAUDE_CONFIG_DIR` / `CODEX_HOME` and the pinned binary.
The chat shows "in your terminal" until the builder hands it back, so the session has one writer. In the terminal
the session runs outside 10db's sandbox and guard, and the button says so.

### 4. The simple, right shape

**One rule:** a chat never writes the project. Writing is a task, run by the machinery every lane uses. This keeps
the factory's one-writer guarantees (claims, sandbox, guard, gate, delivery) intact, and it is what the Workbench
already proves: a task with a live thread is an interactive, writing session.

1. **A tab holds one of two things.**
   - **Chat** (the default):
     - A Plan-style session, read-only on the project's checkout, under Plan's confinement and broker.
     - It can run read-only commands, ask for others by card, call the project's approved MCP tools, and see
       pictures.
     - It can file, edit and start tasks through the builder MCP tools.
     - Cheap and safe to leave open.
   - **Hands-on task:**
     - A task with a Workbench thread, minus the page.
     - It writes in a worktree or in Your folder (the project's checkout, on the current branch), with the
       sandbox, claims and per-turn check that any lane has.
     - The builder talks to it turn by turn: messages reach the running turn, and Stop and Redo works.
     - It lands the way the project delivers, or the way a pass does (one PR, one review).
2. **"Do it" moves from talk to work.**
   - From a chat, **Do it here** (Your folder) or **Do it in a worktree** creates a hands-on task.
   - The task's brief is the chat's digest. Plan already builds a deterministic one.
   - It opens in the same tab or a new one, and the chat stays linked.
   - "File as tasks" goes to the Board instead, through the existing tools.
3. **Tabs:**
   - Shortcuts: ⌘T new, ⌘W closes the tab (the chat is kept), ⌘1-9 switch.
   - Each tab shows the project tile, a state dot (working, needs you, idle) and a title the agent names.
   - A Recent list reopens any chat.
   - A closed tab's session idles out after 10 minutes and resumes on the next message, as Plan's does.
4. **Agent and model:**
   - The project's account picks Claude or Codex, with the fallback and move-back rules lanes follow. The tab
     shows which.
   - A model picker offers any model the account has, as Plan's does.
   - Sessions needs the Codex chat path Plan refuses today: app-server with a read-only sandbox policy and
     approvals routed to the broker.
5. **Parity to build in 10db:**
   - a slash-command palette: Claude from `supportedCommands()`; Codex mapped to RPCs (`/compact`, `/review`,
     `/model`)
   - `@` file mentions
   - plan mode (`setPermissionMode('plan')`)
   - `/context` from `getContextUsage()`
   - Already there: image paste and `AskUserQuestion`.
   - Later: rewind, using `rewindFiles` with checkpointing on.

### 4a. Other models (Gemini through OpenRouter, and the like)

10db keeps three things separate, so Sessions does not hard-code Claude or Codex:

- **The harness:** the agent program that runs the tools. Claude Code or Codex today, behind `SessionAdapter`.
- **The account and backend:** subscription, API key, Bedrock, or a `gateway` (`packages/contracts/src/accounts.ts`).
- **The model:** chosen per role, mapped per account.

A `gateway` account already runs Claude Code against another endpoint (`ANTHROPIC_BASE_URL` plus a token from the
Keychain, with a model map: accounts spec §149).

There are three ways to reach Gemini:

1. **Claude Code on a gateway account pointed at OpenRouter, with the model map naming a Gemini model.** The kind
   exists and nothing new is built. Unverified: how well a non-Anthropic model drives Claude Code's tools through
   OpenRouter's Anthropic-format endpoint. Needs a live test.
2. **Codex with a custom model provider** (OpenRouter is OpenAI-compatible). Not built: `openai_api_key` is not a
   supported kind.
3. **Gemini's own harness (Gemini CLI)** as a third adapter, most cheaply over ACP, which it speaks natively.

   - This is where ACP earns its place.
   - The real cost is confinement. 10db's guard rides on each harness's hooks: PreToolUse on Claude, Codex's
     sandbox and hooks. A new harness needs equivalent hooks, or it runs under the lane sandbox alone.
   - The UI is not the cost.

**Requirement for the spec:** the Sessions UI never branches on the provider. Each adapter reports what it can do,
and the UI shows what is there:

- steer mid-turn
- images
- slash commands
- fork
- permission requests
- plan mode

### 4b. Libraries: adopt, keep, skip, watch (checked on npm and GitHub, 2026-11-11)

**The agent layer**

| Choice       | What                                                                                          | Why                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------ | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Adopt**    | `@agentclientprotocol/sdk` 2.6.0 (Apache-2.0) as a client, behind one new `AcpSessionAdapter` | One adapter brings every agent in the ACP registry (45). Agents launch as stdio subprocesses that 10db spawns, so the pinned binary, the account env and srt all hold. Examples: Gemini CLI (`--acp`), OpenCode (`opencode acp`), Factory droid, Pi, Amp, Cursor, Copilot CLI. Others ship on it: emdash's agents (`packages/plugins/src/agents/helpers/acp-stdio.ts`), Paradev/Superset's chat, and Happy's non-Claude backends. |
| **Adopt**    | **OpenCode** as the any-model harness (MIT, 226k stars), through ACP                          | It reaches every provider, OpenRouter and Gemini included, and has allow/ask/deny permissions. This answers "Gemini through OpenRouter" better than pointing Claude Code at another model.                                                                                                                                                                                                                                        |
| **Adopt**    | `codex app-server generate-ts` / `generate-json-schema`                                       | The official Codex protocol types, from the pinned binary (761 files on 0.167.0). They replace the hand-typed message shapes in `codex-rpc.ts`. The code style still wants zod at the boundary, so either generate zod from the JSON schema or check the hand zod against the generated types in a test.                                                                                                                          |
| **Evaluate** | `@agentclientprotocol/codex-acp` 2.6.0 in place of `codex-session.ts`                         | It runs on app-server and takes `CODEX_PATH`, images, usage and approvals. Before adopting: its GitHub license shows NOASSERTION; steering is a non-standard `_session/steering` extension; and 10db's clientUserMessageId receipts may not survive. Unproven that its approvals carry the command and path the guard needs.                                                                                                      |
| **Keep**     | The Claude adapter on `@anthropic-ai/claude-agent-sdk` directly                               | The ACP adapter owns `canUseTool`, `permissionMode` and `cwd`. 10db's guard is an in-process PreToolUse hook that runs before allow rules and uses `updatedInput` and the subagent's `agentId`. A separate adapter process can't carry that. Happy keeps Claude on the SDK directly for the same reason. No V2 session API is in 0.3.322 (10db pins 0.3.316).                                                                     |
| **Skip**     | Coder agentapi                                                                                | Archived and deprecated; it scrapes the terminal.                                                                                                                                                                                                                                                                                                                                                                                 |
| **Skip**     | `@openai/codex-sdk`                                                                           | `codex exec` per call, with no approval callback and no steering.                                                                                                                                                                                                                                                                                                                                                                 |
| **Skip**     | AI SDK agent providers, and `@ai-sdk/harness-acp`                                             | They sit behind a generate/stream-text shape. Harness-acp approves by tool kind and wants a Vercel sandbox.                                                                                                                                                                                                                                                                                                                       |
| **Skip**     | Rivet sandbox-agent (`rivet-dev/agents`)                                                      | It adds a layer over the same ACP adapters, aimed at remote sandboxes.                                                                                                                                                                                                                                                                                                                                                            |
| **Watch**    | ACP v2 (`/experimental/v2`)                                                                   | Standard steering and resume.                                                                                                                                                                                                                                                                                                                                                                                                     |

**The UI layer** (Plan's transcript is plain `pre-wrap` text today, `views/shape/transcript.tsx:220`)

| Choice    | What                                                                                                    | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Adopt** | `streamdown` 2.7.1 (Apache-2.0 on npm)                                                                  | Streaming markdown that copes with unfinished syntax. Check its LICENSE file and whether it needs Tailwind. Fallback: `react-markdown` plus a highlighter.                                                                                                                                                                                                                                                                                                         |
| **Adopt** | Mantine 9.8 `Diff` (`@mantine/code-highlight`), with `@pierre/diffs` 1.6.4 (Apache-2.0) as the fallback | Mantine's `Diff` takes two strings (`previousValue`, `currentValue`), splits or unifies the view, works at word level and collapses context. That fits Claude's `Edit` (`old_string`/`new_string`) and `Write`. A Codex `fileChange` arrives as a patch, so it needs before and after rebuilt, or `@pierre/diffs`, which reads patches and highlights syntax.                                                                                                      |
| **Adopt** | `@mantine/spotlight` and Mantine 9.8 `Mentions` (`@mantine/core`)                                       | Spotlight is the palette (⌘K, tabs, commands). `Mentions` is a textarea with one `Mentions.Mention` per trigger: `@` for files from the daemon (async `data(query, {signal})`, `debounceMs`) and `/` for the adapter's slash commands. Its markup serializer (`markup`, `createMarkupSerializer`, `getMentions`) gives the daemon a parseable value, and it replaces Tiptap. Image paste stays with Plan's attachment code. Mantine 9.7.4 to 9.8.0 bumps together. |
| **Maybe** | `@assistant-ui/react` 0.15 (MIT)                                                                        | Headless thread and composer state with an external-store runtime. It is 0.x, ships weekly and has no Mantine skin. Plan's transcript already virtualizes.                                                                                                                                                                                                                                                                                                         |
| **Keep**  | Daemon-to-UI events on 10db's zod contracts and WebSocket                                               | Not AG-UI or ACP to the browser. Permission cards, questions, plans and tabs are 10db's own.                                                                                                                                                                                                                                                                                                                                                                       |
| **Skip**  | CopilotKit                                                                                              | Too heavy.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Skip**  | AI Elements                                                                                             | Tailwind and shadcn.                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Skip**  | AI SDK `useChat`                                                                                        | It forces its own message model.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Skip**  | opcode and claudecodeui                                                                                 | AGPL-3.0: ideas only, no code.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Skip**  | tauri-plugin-pty                                                                                        | 22 stars, no license. A terminal pane, if ever wanted, is xterm.js fed by a PTY the daemon owns.                                                                                                                                                                                                                                                                                                                                                                   |

### 5. Open questions for the spec

1. **The name.** The UI wants "Sessions". The code's `sessions` table, `SessionAdapter` and Factory's goal
   Sessions already use the word. Options:
   - UI "Sessions" with code name `chat`
   - UI "Chat" throughout
   - "Threads", as Codex says
2. **Where it sits.** Options:
   - A top-level item beside Inbox and Factory, with tabs from every project and each tab badged
   - A project item beside Board and Plan, with tabs for one project
   - iTerm-like use suggests top-level, where a new tab takes the selected project.
3. **Skills and settings.** Plan and sandboxed lanes load no settings (`settingSources: []`). The builder's own
   skills (gstack, superpowers) and `~/.claude` hooks and MCP servers would bypass the sandbox. Options:
   - The project's committed skills only
   - None, as in Plan
   - A per-project opt-in
4. **Plan's future.** Plan is a chat with propose tools and a sidebar. Options:
   - Build Sessions' chat service as the general one and later make Plan a chat with extra tools
   - Leave Plan alone
   - Recommended: share the turn engine (queue, resume, digest, warm close) from the start.
5. **Hands-on landing.** Options:
   - Same as a pass: one PR, one review, the gate once
   - The project's ordinary delivery
   - Your folder: commit on the current branch with no PR
6. **Lane accounting.** Options:
   - A hands-on task counts against `maxLanes`, as an ordinary task does
   - It has its own small budget, as a pass does (W11)
   - Warm chats hold no lane.
7. **Your folder while the factory runs.** Options:
   - Refuse "Do it here" while a shared batch or pass holds the folder, as opening a pass is refused today
   - Queue it
   - Claims decide per file, as lanes do

### 6. Live checks before the spec is final

- `codex resume <id>` opens a thread started through app-server on the pinned release, under the account's
  `CODEX_HOME`.
- `claude --resume <id>` opens a 10db chat session under the account's `CLAUDE_CONFIG_DIR`, and what the terminal
  loses without 10db's MCP config and sandbox.
- A Codex chat under a read-only sandbox policy, with approvals answered by the broker.
- Whether `forkSession` / `thread/fork` with a new `cwd` can carry a chat into a worktree. That would let "Do it"
  keep the agent's memory instead of a digest.

### Sources

- https://code.claude.com/docs/en/agent-sdk/typescript
- https://code.claude.com/docs/en/sessions
- https://code.claude.com/docs/en/agent-sdk/user-input
- https://code.claude.com/docs/en/legal-and-compliance
- https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan
- https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-ultra-and-team-plans
- https://learn.chatgpt.com/docs/app-server
- https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server/README.md
- https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/README.md
- https://docs.factory.com/droid-exec/overview.md
- https://agentclientprotocol.com/overview/agents
- https://github.com/agentclientprotocol/claude-agent-acp
- https://github.com/svkozak/pi-acp
- https://code.visualstudio.com/docs/agents/run/sessions/manage-sessions
- https://cursor.com/changelog/2-0
- https://github.blog/news-insights/product-news/agents-panel-launch-copilot-coding-agent-tasks-anywhere-on-github/
- https://www.conductor.build/docs/

## T1: audit of 10db's agent-session code

- **Model:** claude-sonnet-5-5. The coordinator wrote this file from the agent's message.
- **Checkout:** sessions-plan (origin/main c4da899, which includes the Workbench, #573).
- **Paths:** `d/` means `apps/daemon/src/`.

### 0. Two engines, not three

There are two conversation engines today:

- **The lane runner:** `d/runner/runner.ts` `runSession`, lines 1814-2983 (about 1170 lines). It calls
  `adapter.start(SessionSpec)` at line 2337.
- **Plan:** `d/shape/service.ts` (1860 lines). It calls `adapter.startShape` at line 1267.

The **Workbench thread has no engine.** `d/thread/service.ts` stores a message and calls `PageMessages.deliver`,
which is `runner.deliverMessage` (`runner.ts:3866`). The message rides a lane session that is kept warm.

**Nothing streams.** `SessionEvent` has no text delta, so agent text arrives once, in `turn_complete.text`.
Activity summaries are cut to 200 characters (`claude-mapping.ts:25`, `codex-mapping.ts:62`). `includePartialMessages`
appears nowhere in the code.

**Codex can't host a chat.** `codex-adapter.ts:114-116`: `startShape` ends at once with "Brainstorm chat is not
available on a ChatGPT account". `complete()` is refused too (`:111`).

**Events reach the UI the same way for both.** `StateStore.write` puts them on the bus, `/events/stream` replays
them by seq (`d/api/app.ts:164,1416`), and the desktop's `EVENT_INVALIDATIONS` refetches what changed. Plan emits
only `shape.changed`. The thread emits `task.message_added` and `session.activity`. No partial text is pushed, and
no markdown renderer exists.

### 1. Every mechanism, by owner

| Mechanism                      | Lane runner                                                                                                                                                                        | Plan                                                                                                                                                                      | Workbench thread                                                                                                                                |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Turn queue                     | A message goes straight into the adapter channel (Claude `input.push` `claude-adapter.ts:885-898`; Codex queue held by 10db). Turns are rows in `pass_turns` (`pass-turn.ts:102`). | `rt.queue` in memory (`service.ts:499`), `pump` 1446, `runTurn` 1333. A queued message is lost on quit (`neverRan`).                                                      | Delegates to the lane.                                                                                                                          |
| Transcript                     | None; lanes keep handoffs and evidence.                                                                                                                                            | `shape_messages` (`schema.ts:1253`): authors builder, claude and note; 10 kinds. Agent text comes from `turn_complete.text` (731-744); tool lines from hooks (1150-1262). | `task_messages` (`schema.ts:1351`) and `task_files` (1381). The reply is written at turn end. Live activity is only a `session.activity` event. |
| Delivery and receipts          | Pushed under a uuid (`pushed_at`, `push_uuids`); `consumed` sets `delivered_at`; `dropped` hands the message back (`lane-messages.ts`). Codex read-back: `read-back.ts:69`.        | None. The prompt carries `[m:<id>]` (1623).                                                                                                                               | The lane's.                                                                                                                                     |
| Interrupt, steer, Redo         | `interrupt()` returns an `InterruptReceipt`, and what it doesn't name is re-pushed. Redo: `runner.ts:3930`. Codex `turn/steer`: `codex-session.ts:646`.                            | `interrupt` ignores the receipt (1498-1501). No steer.                                                                                                                    | Stop, and Stop and Redo, call the lane's.                                                                                                       |
| Warm, idle, resume             | Pass lanes only: `armIdleClose` (825), 10 minutes, `closeWarm`.                                                                                                                    | `IDLE_MS` 10 minutes (420), `closeLive` 1298. Resumes from `shapes.sdk_session_id`.                                                                                       | The lane's.                                                                                                                                     |
| Digest and fresh session       | Handoff at `handoffPct` (2633-2672) with nudges; compaction reinjection (2685); `buildThreadDigest` (`thread/session-text.ts:57`).                                                 | Past 70%: closes as `continued`; `buildDigest` (`shape/digest.ts:46`, 40 messages) is stored as a row.                                                                    | The lane's.                                                                                                                                     |
| Pictures and files             | `outgoingMessage` (`lane-messages.ts:77`), `blockPictures` (`thread-pictures.ts:27`), `readsPictureFiles` for Codex.                                                               | `shape_files` (1317), `dropped-files.ts` (173), a budget in `service.ts:785-950`, hooks that count Reads.                                                                 | `thread/pictures.ts` (87), `task_files`. Both use `PictureLimits` (`screens/picture-limits.ts:96`).                                             |
| Permissions                    | `judgePreToolUse` (2362), then `createPermissionBroker` owned by the workstream; auto mode is possible. Codex reaches the same through a hook socket (`codex-guard.ts:140-158`).   | `judgeShapeCall` (`confinement.ts:396`), then the same broker, owned by the conversation. Always `default` mode.                                                          | The lane's. Cards appear in the Inbox and in `page-ask.tsx`; Plan uses `waiting-permissions.tsx`.                                               |
| Sandbox                        | `laneSandbox.forSession` (2033).                                                                                                                                                   | `forSession({readOnly:true})` (`shape-session-tools.ts:160-169`). No sandbox means no Bash.                                                                               | The lane's.                                                                                                                                     |
| Account preflight and fallback | Claude preflight `claude-adapter.ts:605-702`, `startWithRetry` with 3 starts. Pauses and moves through `accounts.*` (2714, 2726, 2877). `startGate` (2026).                        | A second preflight with one try (`claude-shape.ts:335`, 30 s). No pause: rate limits and ends become notices (723-762).                                                   | The lane's.                                                                                                                                     |
| Usage and context              | `updateSessionUsage` (2740), `session.context`.                                                                                                                                    | The same `updateSessionUsage` (714). `contextPct` (705).                                                                                                                  | The lane's.                                                                                                                                     |
| Model                          | `resolvedStep` from routing and marks.                                                                                                                                             | `shapes.model` alias, `planModel` (`daemon/start.ts:1228`), `chooseModel` (1717), `agent-models.ts`.                                                                      | Inherits the step's model.                                                                                                                      |
| UI transcript                  | none                                                                                                                                                                               | `shape/transcript.tsx` (253; "Claude" is hard-coded at lines 26 and 58).                                                                                                  | `workbench/thread.tsx` (110), `thread-message.tsx` (135).                                                                                       |
| Composer                       | none                                                                                                                                                                               | `shape/composer.tsx` (260).                                                                                                                                               | `workbench/composer.tsx` (263), `composer-buttons.ts`, `drafts.ts`.                                                                             |
| Working line                   | n/a                                                                                                                                                                                | `shape/working-line.tsx` (25): "Claude is working…", fed by `ShapeTurnDto`.                                                                                               | `workbench/working-line.tsx` (42) and `live-line.ts`, fed by `session.activity`.                                                                |

### 2. What exists twice

1. **The Claude session loop.**
   - `claude-adapter.ts` (1189 lines) and `claude-shape.ts` (532 lines) each have their own preflight, pump, send,
     interrupt, stop and options builder. They share `claude-mapping.ts`.
   - The lane copy retries a slow start, loads the plugin and runs in sandbox or auto mode.
   - The Plan copy passes `agents` and has hooks that count Reads.
2. **The turn engine.**
   - Plan keeps an in-memory queue, one turn per message.
   - Lanes keep durable rows, push messages mid-turn, and record receipts.
3. **The transcript.**
   - Plan's `shape_messages` has authors builder, claude and note, and 10 kinds.
   - The thread's `task_messages` has authors builder, agent and system, and the kinds message, reply and notice.
   - `sessions` rows carry either `workstream_id` or `shape_id`, never both (`schema.ts:~644`).
4. **Pictures.**
   - `shape_files` and `task_files` both have `inline_sent`.
   - Two budget implementations.
5. **Three fresh-session mechanisms:** Plan's digest, the lane handoff and context pack, and the thread digest.
6. **Two event handlers:**
   - `service.ts:697` and `runner.ts:2535` repeat the usage and model-mark handling.
   - Plan ignores `consumed`, `compacted`, `background_tasks` and `activity`.
7. **The fake adapter:** `fake-adapter.ts` (752 lines) and `fake-shape.ts` (306 lines).
8. **The UI:** two composers, two working lines and two transcripts.
9. **Already shared:**
   - the permission broker (`BrokerOwner` is a workstream or a shape)
   - `Channel`, `contextEvent` and the `userMessage` mapping
   - `settleWithin` and the account check

### 3. Hard-coded Claude and Codex branches

**Daemon:**

- `contracts/accounts.ts:31-39`: `providerOf` is a closed two-way switch. `routed-adapter.ts:13` chooses Codex or
  Claude.
- Plan refuses Codex in many places:
  - `daemon/start.ts:1224-1227`
  - `shape/service.ts:638-641`, with calls at 1510, 1515, 1617, 1638, 1663 and 1719
  - `codex-adapter.ts:114`
  - `accounts.ts:44` (`BRAINSTORM_REFUSED_ON_CHATGPT`)
- The runner branches on the provider:
  - `read-back.ts:69`
  - `runner.ts:1950`, 1958, 2025, 2043 and 2155
  - `claude-adapter.ts:621`
- Switches on the account kind:
  - `account-check.ts:54-107` and 132-156
  - `fake-adapter.ts:58-91` and 284
  - `picture-limits.ts:98-106`
  - `shape/agent-models.ts:12-17`
  - `catalogue/account-offer.ts:26-30`
  - `environment/launch.ts:141-235`
  - `sandbox/lane-sandbox.ts:223-225`
  - `briefing/prompts.ts:346-360` and 606
  - `accounts/cards.ts:52`, 56 and 372
  - `accounts/service.ts:227` and 286
  - `team/routing-inputs.ts:32`
  - `catalogue/{model-rows,profiles,join}.ts`
  - `daemon/area-namer.ts:34`
- Codex-only modules come to about 3,100 lines.

**Desktop:**

- `shape/composer.tsx:139-141` holds the ChatGPT refusal text.
- "Claude" is hard-coded in `shape/transcript.tsx:26` and 58, `working-line.tsx:4-21`, `composer.tsx:141`, and
  `convert-modal.tsx:32` and 155.
- The accounts settings branch on the account kind.
- The Workbench views don't branch on the provider.

### 4. The narrowest seam

**`SessionAdapter` today has these methods:**

- `complete`
- `start` and `startShape`
- `probeAccount`
- `readClientUuids`
- `startLogin`

**A conversation engine needs:**

- **A handle.** The existing `SessionHandle` is enough: `events`, `send(text, images, clientUuid)`,
  `interrupt() -> receipt`, `stop()`.
- **Events both owners read:**
  - `started`
  - `context`
  - `turn_complete{result, text, usage, dropped?}`
  - `rate_limit`
  - `ended`

  `activity`, `consumed`, `compacted` and `background_tasks` are read only by lanes today. A chat needs `activity`
  and `consumed` too.

- **A spec core:**
  - `sessionId`, `cwd`, `prompt`, `images`
  - `model`, `effort`, `resumeProviderSessionId`
  - `env`, `account`
  - `mcp`, `sandbox`, `projectMcpServers`
  - `allowedTools`
  - `preToolUse`, `canUseTool`

  `workstreamId`, `sequence`, `promptUuid` and `lanePermissionMode` are lane-only. `shapeId`, `systemPrompt`,
  `tools`, `disallowedTools`, `agents`, `postToolUse` and `toolFailed` are chat-only.

- **`ToolRequest`** already serves both owners.
- **Per account, outside the conversation seam:** `probeAccount`, `startLogin`, `complete` and
  `readClientUuids`.

**Gaps for Sessions:**

- text and reasoning deltas
- a tool-result event
- a typed approval event for an adapter's own asks
- listing commands, models and history
- fork and rewind

Codex permissions are hook-only today, with `approvalPolicy:'never'` (`codex-session.ts:465`).

### 5. What could be merged

| #   | Candidate                                                                                             | Replaces                                                                                                                | Size                              | Risk                                                                                                            | Tests that protect it                                                                                                                                                                                                                                                                         |
| --- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A   | One Claude session core with a lane or chat profile                                                   | `claude-shape.ts` and the duplicated loop                                                                               | about -450 lines                  | med-high (billing and account checks)                                                                           | `claude-adapter.test.ts` (102 tests), `claude-shape.test.ts` (22), `claude-mapping.test.ts`, the live tests                                                                                                                                                                                   |
| B   | One conversation engine: queue, warm and idle, resume, digest, usage, context, marks, ended, receipts | `shape/service.ts` 697-790 and 1298-1505; `lane-messages.ts`; part of `pass-turn.ts`; `runner.ts` 825-840 and 3866-3990 | +900 / -1000 lines                | high                                                                                                            | `shape/service.test.ts`, `resume.test.ts`, `held-turns.test.ts`, `runner/pass-lane.test.ts` (42 tests), `lane-messages.test.ts`, `read-back.test.ts`, `test/{pass-api,workbench-api,crash-recovery}.test.ts`, e2e `shape` and `workbench`. Recovery and restart rows stay on their real rung. |
| C   | One transcript table and DTO                                                                          | `shape_messages` and `task_messages`; `ShapeMessageDto` and `TaskMessageDto`                                            | -150 lines, touching every reader | medium. FKs at `schema.ts:1604`, 1721 and 1958. Cheapest now, because the baseline is regenerated before v0.1.0 | db store tests, `shape/view.test.ts`, `thread.test.ts`                                                                                                                                                                                                                                        |
| D   | One picture store and budget                                                                          | `dropped-files.ts`, `service.ts:785-950`, `thread/pictures.ts`, `thread-pictures.ts`                                    | -250 lines                        | medium                                                                                                          | `shape/files.test.ts` (50 tests), `thread-pictures.test.ts`                                                                                                                                                                                                                                   |
| E   | One fake adapter                                                                                      | `fake-shape.ts`                                                                                                         | -200 lines                        | low                                                                                                             | `fake-adapter.test.ts`                                                                                                                                                                                                                                                                        |
| F   | One UI conversation kit                                                                               | the transcript, composer and working line of Plan (538 lines) and the Workbench (614 lines)                             | -400 lines                        | medium                                                                                                          | the shape and workbench component tests                                                                                                                                                                                                                                                       |
| G   | A provider slot for a third agent                                                                     | `routed-adapter` and `providerOf`; the account-kind switches                                                            | +150 lines                        | medium                                                                                                          | `routed-adapter.test.ts`, account-check tests                                                                                                                                                                                                                                                 |

**Keep separate:**

- The two judges, `judgeShapeCall` and `judgePreToolUse`. Each profile selects its own. The broker is already
  shared.
- `shape/confinement.test.ts`, `policy.test.ts`, `inbox/shape-permissions.test.ts`, `codex-guard.test.ts` and
  `codex-session.test.ts` stay on their real rung.

**Module order** (`apps/daemon/AGENTS.md`): sessions and inbox, then delivery and accounts, then pass, then
pictures, then mcp, then screens, then thread and shape, then runner. A shared engine sits after `screens` and
before `thread` and `shape`, or inside `sessions`.

### 6. Traps: decisions that merging must respect

1. **`decisions/2026-11-02-shape-session-and-convert.md`.** Plan carries no lane fields. A profile must keep no
   settings or plugins, no Bash without a sandbox, and Plan's tool lists.
2. **`2026-11-02-shape-is-an-sdk-session-in-10dbs-own-ui.md` and `2026-11-05-plan-runs-commands-...`.** Plan is
   read-only:
   - its sandbox has the checkout in `denyWrite`
   - its cards are owned by the conversation, with no workstream rule
   - it has no web tools
3. **`2026-10-31-lanes-run-in-auto-mode-inside-the-sandbox.md`.** Auto mode runs only in a sandboxed lane. Plan runs
   in `default`.
4. **`2026-11-05-codex-lanes-use-codex-sandbox-and-hooks.md`.** Every Codex hook failure exits with 2. The trust pin
   is `untrusted` before `thread/start`, and `approvalPolicy` is `never`. A Codex chat needs the same. ACP agents
   have neither, so they need an equal guard or must stay read-only.
5. **`2026-11-11-a-pass-runs-on-the-projects-account-claude-or-codex.md`.** The Codex queue is 10db's own, with
   `stillQueued`, `dropped` and exactly-once delivery where the thread can be read. Keep `InterruptReceipt` and
   `dropped`.
6. **`2026-11-09-a-pass-task-session-stays-open-between-turns.md`.** These lifecycle rules belong to a pass: it never
   fails, it holds a message, and an idle close yields the lane. Don't apply them to a chat.
7. **`2026-11-08-10db-runs-pinned-copies-of-codex-and-claude-code.md`.** A third agent needs a pin and verification,
   or a decision saying why not.
8. **`2026-11-05-chatgpt-plan-through-the-codex-app-server.md`.** It puts chat on a ChatGPT account out of scope.
   Lifting that needs an amending decision, the refusal sites changed, and `chatgpt-refusal.test.ts` updated.
9. **The slow-start retry and the sign-in check are lane-only** (`2026-10-30-a-slow-start-is-not-a-signed-out-account.md`,
   `2026-11-03-a-start-with-no-account-is-checked-before-the-account-is-paused.md`).
10. **`2026-11-05-shape-picture-budget-follows-the-accounts-request-limit.md`.** Pictures are re-sent when a session
    resumes, and `inline_sent` is tracked per live session.
11. **`2026-10-29-sandbox-is-the-boundary.md`.** Writing chats need the lane sandbox, and a change to it gets an
    adversarial review.
12. **Repo rules.** `decisions.md` is closed. Drizzle migrations are regenerated, never edited by hand. No enums and
    no constructor parameter properties.
13. **Takeover is designed, not built.** `sessions.mode` already has `terminal` (`contracts/states.ts:188`). Keep one
    writer at a time.

## T2: Codex protocol layer

Ran on claude-sonnet-5-5. The coordinator wrote this file from the agent's message.

### Verdict

**Keep `codex app-server` direct, with generated types. Do not drive Codex through codex-acp.**

### Generating the protocol

- **The pinned tarball checks out.** It is 0.167.0 (`agent-pins.ts:10-12`). `npm pack @openai/codex@0.167.0-darwin-arm64`
  matches the pinned SHA-512.
- **Both generators run without a login and without a model call.** They are
  `codex app-server generate-ts --out ts` (marked experimental) and `generate-json-schema --out schema`.
- **The TS output** has 761 files and is 3.1 MB, from ts-rs, with 665 files in `v2/`. `ClientRequest`,
  `ServerNotification` and `ServerRequest` are unions discriminated by `method`. It is `import type` only.
- **The JSON schema output** has 322 files and is 4.5 MB.
  - It has union roots: `ClientRequest.json` holds 106 requests, `ServerNotification.json` 86 and
    `ServerRequest.json` 10.
  - It has two bundles: `codex_app_server_protocol.schemas.json` (753 KB) and the v2 bundle (649 KB, 678
    definitions).
- **The protocol churns.** 0.167.0 differs from 0.166.x, so the output must be regenerated at every bump.

### Comparison with 10db's hand-written code

| File                | Lines |
| ------------------- | ----- |
| `codex-protocol.ts` | 190   |
| `codex-rpc.ts`      | 223   |
| `codex-mapping.ts`  | 259   |
| `codex-session.ts`  | 923   |

The Codex layer is about 2,700 non-test lines in all.

**What 10db uses:**

- **Requests:**
  - `initialize`
  - `account/read`
  - `account/login/{start,cancel}`
  - `account/rateLimits/read`
  - `model/list`
  - `config/read`
  - `hooks/list`
  - `thread/start`, `thread/resume`, `thread/turns/list`
  - `turn/start`, `turn/steer`, `turn/interrupt`
- **Notifications:**
  - `turn/started`, `turn/completed`
  - `item/completed`
  - `thread/tokenUsage/updated`
  - `account/rateLimits/updated`
  - `account/login/completed`

**A latent bug.** `Account` (`codex-protocol.ts:13-21`) is a discriminated union over chatgpt, apiKey and
amazonBedrock. The generated `v2/Account.ts` also has `{type:"gcp"}`, so the parse throws on a GCP account.

**Everything else compared matches:**

- `TurnStatus`
- `ThreadTokenUsage`
- `RateLimitWindow`
- `userMessage.clientId`
- the `clientUserMessageId` on `turn/start` and `turn/steer`
- the 14 `MODEL_ITEMS`

Some fields 10db reads loosely are required in Codex's output, which is harmless.

**The saving.** Generation replaces `codex-protocol.ts` and about 60 lines of `codex-rpc.ts`, roughly 250 lines,
and removes the staleness risk. The mapping and session behavior stay.

### From generated output to zod

- **(a) `z.fromJSONSchema` exists in zod 4.6.7** (`zod/v4/classic/from-json-schema.d.ts:11`).
  - It builds the three union roots and parses real payloads.
  - It throws on `not`, `if/then/else`, `unevaluated*`, `dependent*` and external `$ref`.
  - Its result is `ZodType` with no static output type.
  - It turns `oneOf` into `ZodXor`.
  - It is strict on objects by default. That conflicts with 10db's choice to tolerate added fields.
  - Its cost on every event was not measured.
- **(b) json-schema-to-zod** (2.8.1, ISC). Worse: a generator to maintain, with huge output.
- **(c) Recommended:**
  - Keep the loose hand-written zod subset at runtime.
  - Commit the generated TS types.
  - Add type-level tests (`expectTypeOf`) that the hand zod and the generated types agree.
  - Add a test that validates recorded fixtures with `z.fromJSONSchema` on the generated per-type schemas.
  - This approach would have caught the gcp bug.

**How it fits the repo.**

- Generated files are committed and drift-checked (`packages/contracts/AGENTS.md`).
- Add a `generate:codex` script. It reuses the pinned fetch and checksum code to unpack the tarball, then writes
  `apps/daemon/src/sessions/codex-generated/`.
- Commit only what is needed: the types the code uses plus the union roots, or the v2 bundle. Not all 4.5 MB.
- Prettier, ESLint and knip must ignore the generated folder.

**Renovate.** Renovate can't regenerate the output. The drift check fails the bump PR, and the PR note names
`pnpm generate:codex`, alongside the live test the note already names.

### codex-acp as an alternative

`@agentclientprotocol/codex-acp` 2.6.0, at commit 9b2a785:

- **License:** Apache-2.0, © JetBrains.
- **Size:** about 43k lines of TS. It bundles `@openai/codex ^0.166.0`, but `CODEX_PATH` lets it run a pinned
  binary.
- **Its own code generation:** it uses `generate-ts` and checks the output in. That is the same pattern as above.
- **Approvals:** these map to `session/request_permission`. The command and cwd survive
  (`CommandReporter.ts:114-115`), and file locations survive (`FileChangeReporter.ts:65`), but only as ACP
  content. The decisions available are limited to the options it offers.
- **Steering:** `_session/steering` (`CodexAcpServer.ts:3095-3120`), a non-standard extension.
- **Images:** sent as data URLs, never as `localImage`.
- **Usage:** sent as `usage_update`. Rate limits are probably not forwarded.
- **Resume:** through `thread/resume`, with fork.
- **Receipts are lost.** It mints its own `clientUserMessageId` (`CodexAcpServer.ts:3108`), and `session/prompt`
  carries none from the caller. 10db's exactly-once receipts
  (`decisions/2026-11-11-a-pass-runs-on-the-projects-account-claude-or-codex.md`) would not survive.
- **Config and permissions:** `CODEX_HOME` is inherited, and config comes from `CODEX_CONFIG` JSON. Sandbox and
  permissions run only through its ACP mode model (`permission-profile:<id>`). Untested.

**The call.** Keep app-server direct. codex-acp loses the receipts, adds a second protocol hop, a 43k-line
dependency and a second Codex pin, and makes 10db maintain the adapter's mode semantics. Read it as a reference
implementation, not as a runtime dependency.

**Next:**

- generated types and a compatibility test
- fix the gcp Account variant
- extend the Renovate PR note with the regenerate command

Scratch output is in `t2-codex/{ts,schema,repo}`.

## T3: ACP for 10db

**Model:** claude-sonnet-5-5. The coordinator wrote this file from the agent's message.

Plain-file clones are in `R/` here. Sources read:

- the ACP docs and schema (`R/agent-client-protocol`)
- claude-agent-acp 0.106.0
- OpenCode at dev HEAD 1017760 (about 2.2.7)
- Gemini CLI 0.70 nightly
- pi-acp 0.0.34
- amp-acp 0.12
- the ACP registry
- Droid: closed source, so its docs only

### The call

**Claude stays on the Agent SDK directly, Codex stays on `codex app-server` directly, and ACP carries every other
agent.**

- Running every agent over ACP would lose the guard on Claude (§4).
- For ACP agents, the kernel sandbox is the boundary. Their permission requests are a best-effort second layer.

### 1. How ACP v1 maps onto 10db

| ACP                                                                                | 10db                                                                                                                                     | Gap                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `initialize` capabilities                                                          | A new adapter capability descriptor. 10db sends `clientCapabilities: {}`.                                                                | `types.ts` has nowhere to put capabilities.                                                                                                                                                               |
| `session/new`                                                                      | `cwd` and `mcpServers` (the project's servers plus 10db's). `sessionId` becomes `providerSessionId`.                                     | None.                                                                                                                                                                                                     |
| `session/load`                                                                     | Replays history. 10db swallows the replay.                                                                                               | Gemini and Pi have load only.                                                                                                                                                                             |
| `session/resume`                                                                   | Resumes with no replay.                                                                                                                  | OpenCode, Amp and Claude have it. Gemini and Pi don't.                                                                                                                                                    |
| `session/list`                                                                     | Nothing yet.                                                                                                                             | Optional.                                                                                                                                                                                                 |
| `session/prompt` and its stop reason                                               | `end_turn` maps to success; `max_turn_requests` to `max_turns`; `max_tokens` and `refusal` to error.                                     | The stable `PromptResponse` carries only `stopReason`. Tokens come from `usage_update` or the unstable `PromptResponse.usage`. Cost only arrives if `usage_update.cost` is sent.                          |
| Images                                                                             | `{type:'image', data, mimeType}`, when `promptCapabilities.image` is set.                                                                |                                                                                                                                                                                                           |
| `agent_message_chunk`, `agent_thought_chunk`                                       | Text and reasoning deltas.                                                                                                               |                                                                                                                                                                                                           |
| `tool_call` / `tool_call_update`                                                   | ToolCallView: `kind`, `locations`, `rawInput` and `title`. `written` comes from the kinds edit, delete and move.                         | `name` and `rawInput` are optional. Needs an ACP variant of `claudeToolTarget`.                                                                                                                           |
| `plan`, `available_commands_update`, `current_mode_update`, `config_option_update` | No 10db event yet.                                                                                                                       | Add events.                                                                                                                                                                                               |
| `usage_update {used, size, cost?}`                                                 | The `context` event.                                                                                                                     | No ACP source for `rate_limit`, `compacted`, `background_tasks`, `consumed` or `dropped`.                                                                                                                 |
| `session/request_permission`                                                       | A `ToolRequest` built from `toolCall` and `options`. The decision is `selected(optionId)`: allow is `allow_once`, deny is `reject_once`. | The outcome carries only an optionId. So no `deny.message`, `interrupt` or `updatedInput`, and no `escalated` or hook `cwd`. "Always" grants are stored by the agent, so **10db never selects "always"**. |
| `session/cancel`                                                                   | `interrupt()`. Pending permission requests must be answered `cancelled`.                                                                 | No equivalent of `stillQueued`.                                                                                                                                                                           |
| Modes and config options                                                           | Model, effort and mode selectors, by category. Modes are being replaced by config options.                                               | Gemini uses the older `models` field.                                                                                                                                                                     |
| Client `fs/*` and `terminal/*`                                                     | **Never offer them.** If they are omitted, the agent must not call them.                                                                 | Gemini routes reads and writes through the client when they are offered.                                                                                                                                  |
| MCP servers                                                                        | `mcpServers` on new, load and resume.                                                                                                    | Pi ignores them. OpenCode refuses sse.                                                                                                                                                                    |
| Steering and fork                                                                  | None in stable v1. v2 accepts a prompt in any state.                                                                                     | Each agent has its own extension: OpenCode `_session/steering`, Claude's adapter, Amp `_amp/session/steer`.                                                                                               |
| Exactly-once receipts                                                              | Not possible on v1: only agents mint message ids. v2 returns the inserted `messageId`.                                                   | Receipts need v2 or `_meta`.                                                                                                                                                                              |

### 2. Agents

|                                  | OpenCode 2.2.7                                                                                                                                                                                                                                                                                  | Gemini CLI 0.68                                                                                                                                               | Droid 1.9                                                                                 | Pi (pi-acp)                       | Amp (amp-acp)                                         |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------- | ----------------------------------------------------- |
| Launch                           | `opencode acp`, which spawns its own server on loopback over HTTP (`cli/.../acp.ts:21`, `standalone.ts:19-26`)                                                                                                                                                                                  | `gemini --acp`                                                                                                                                                | `droid exec --output-format acp-daemon` (the registry) or `acp` (the docs): they conflict | `pi-acp` runs `pi --mode rpc`     | `amp-acp` runs `amp --execute --stream-json` per turn |
| Every tool asks, with raw input? | **Yes by default** (`permission.ts:96-104` defaults to ask). `rawInput` carries the command or path. **Holes:** the `explore` subagent allows shell, read, grep and webfetch without asking (`plugin/agent.ts:80-93`), and a repo's `opencode.json` or `.opencode/` plugins can allow anything. | **Partly.** Writes, shell and MCP ask. Reads are allowed without asking. **No rawInput or name**: only a title, kind and locations. `yolo` mode asks nothing. | Unknown. `--auto` sets a risk tier.                                                       | **No.** Tools run without asking. | **No.** Tools run without asking.                     |
| Deny honoured                    | yes                                                                                                                                                                                                                                                                                             | yes                                                                                                                                                           | ?                                                                                         | n/a                               | n/a                                                   |
| Images                           | yes                                                                                                                                                                                                                                                                                             | yes                                                                                                                                                           | ?                                                                                         | yes                               | yes                                                   |
| Resume                           | load, resume, fork, list                                                                                                                                                                                                                                                                        | load only                                                                                                                                                     | ?                                                                                         | load, list                        | load, resume, list                                    |
| Usage                            | `usage_update` and `PromptResponse.usage`                                                                                                                                                                                                                                                       | `usage_update`                                                                                                                                                | ?                                                                                         | `usage_update`                    | both                                                  |
| Steer                            | `_session/steering`                                                                                                                                                                                                                                                                             | none                                                                                                                                                          | ?                                                                                         | client queue                      | steer, applied as the next turn                       |
| Auth per process                 | **`OPENROUTER_API_KEY`** (models.dev); `GOOGLE_API_KEY`; inline config in `OPENCODE_CONFIG_CONTENT`                                                                                                                                                                                             | `GEMINI_API_KEY`, `GOOGLE_GEMINI_BASE_URL`. Google only, **no OpenRouter**.                                                                                   | `FACTORY_API_KEY`                                                                         | provider env vars                 | `AMP_API_KEY`                                         |
| Isolation                        | `OPENCODE_CONFIG_DIR`, `XDG_*`, `HOME`. Credentials and "always" grants live in the data dir. `OPENCODE_DISABLE_PROJECT_CONFIG` and `OPENCODE_DISABLE_CLAUDE_CODE`.                                                                                                                             | `GEMINI_CLI_HOME`. `authenticate` writes the user's settings, and the user's MCP servers merge in.                                                            | `~/.factory`, so use `HOME`                                                               | `PI_CODING_AGENT_DIR`             | `AMP_ACP_STATE_DIR`                                   |
| Pin                              | GitHub release zip with a sha256 in the registry (npm `opencode-ai` is the 1.x line, the wrong one). It churns fast.                                                                                                                                                                            | npm with sha512 integrity, pure JS                                                                                                                            | npm, proprietary, postinstall                                                             | npm, plus a separate pi           | the CLI can't be pinned                               |
| Under srt                        | Likely, but its loopback server needs the per-project `allowLocalBinding` (lane spec D15). Whether its Bun HTTP client honours the proxy needs a test.                                                                                                                                          | Likely; don't nest its own sandbox                                                                                                                            | ?                                                                                         | likely                            | needs Amp's cloud host                                |
| Own sandbox                      | none                                                                                                                                                                                                                                                                                            | Docker, Podman, Seatbelt                                                                                                                                      | tiers                                                                                     | none                              | none                                                  |

**Consequence.** Every ACP agent runs on a key held in its env, so the whole process can be wrapped in srt. Lane
spec D10 allows that for keyed accounts (`2026-10-25-10db-lane-sandbox-design.md:83`). The kernel then confines the
agent's own file tools. `sandbox/mcp-sandbox.ts` already launches a stdio process under srt with `env -i` and the
proxy variables.

An ACP session is therefore:

- launched under srt, with its own home and XDG dirs
- offered no fs and no terminal
- treated as having permission requests only as a second layer

**Guard tiers:**

- **pre-exec-all:** OpenCode, with config overrides.
- **pre-exec-mutating:** Gemini.
- **observe-only:** Pi and Amp. Droid is unknown. For these the guard can only cancel after a tool has started.

**"Gemini through OpenRouter" means OpenCode with `OPENROUTER_API_KEY`**, not Gemini CLI.

### 3. What a handshake would show (inferred from source)

**OpenCode `initialize`:**

- `loadSession`
- `mcpCapabilities {http: true, sse: false}`
- `promptCapabilities {image, embeddedContext}`
- `sessionCapabilities {additionalDirectories, close, delete, fork, list, resume}`
- `_meta.steering.supported`
- `authMethods [opencode-login]`

**OpenCode `session/new`** returns `configOptions`:

- `model`, with `provider/model` values
- `effort`, as a thought level
- `mode` (Build, Plan)

Commands arrive by `available_commands_update`: `compact` plus the project's own commands.

**Gemini `initialize`:**

- `loadSession`
- image, audio and embeddedContext
- http and sse MCP
- no `sessionCapabilities`
- auth: `oauth-personal`, `gemini-api-key`, `vertex-ai` and `gateway`

`session/new` needs auth first. It returns `modes` (default, autoEdit, yolo, plan) and an old-style `models`
field.

### A no-cost handshake for the morning

1. Make a fresh `T/{home, xdg/{config,data,cache,state}, work}`.
2. Download the OpenCode v2.2.7 darwin-arm64 zip from GitHub and check it with
   `shasum -a 256 = 811c42be9cad489ea8c411ead49e06f691deee4957ba9a0a56a159a7d6c1abdc`.
3. Run it under
   `sandbox-exec -p '(version 1)(allow default)(deny network*)(allow network* (local ip "localhost:*"))(allow network* (remote ip "localhost:*"))'`
   with:
   - `env -i PATH=/usr/bin:/bin HOME=$T/home XDG_*=$T/xdg/...`
   - `OPENCODE_CONFIG_DIR=$T/xdg/config/opencode OPENCODE_CONFIG_CONTENT='{}'`
   - `OPENCODE_DISABLE_MODELS_FETCH=1 OPENCODE_DISABLE_AUTOUPDATE=true OPENCODE_DISABLE_PROJECT_CONFIG=1`
   - `OPENCODE_DISABLE_CLAUDE_CODE=1 OPENCODE_DISABLE_FREE_MODELS=1`
   - `OPENROUTER_API_KEY=placeholder-not-a-key`
   - cwd `$T/work`, and the argument `acp`

   Run it once with the key and once without.

4. Send `initialize {protocolVersion: 1, clientCapabilities: {}, clientInfo}`, then `session/new {cwd, mcpServers: []}`,
   then `session/list`, using `@agentclientprotocol/sdk` 2.6.0 or a FIFO. Record everything it sends back.
5. It passes when:
   - the server starts inside the profile (also try without the loopback allow)
   - `configOptions` lists `model` and `mode`
   - `_meta.steering` is present
6. Gemini:
   - `npm pack @google/gemini-cli@0.68.0`, with integrity
     `sha512-eq7AWY+YCijNGKVwyiRjN+GuOdXU/djuOZhX18p+HDmNyUqFdqH7C5V6vDJLl1uffhRPhGijePV+YvY8lymrbQ==`.
   - Write settings at `$T/home/.gemini/settings.json` that turn off auto-update and usage statistics.
   - Run `node bundle/gemini.js --acp` with `GEMINI_CLI_HOME`.
   - Send `initialize` only.

### 4. Claude through ACP: no

**It can't run in-process.** It exports only `serveAcp` over stdio (`lib.ts:1-11`). Options cross only as JSON
(`_meta.claudeCode.options`).

**It owns the permission path.** `canUseTool` and `permissionMode` are set after the user's options
(`acp-agent.ts:9973, 9989-9990`). Hooks can't cross (`session-fingerprint.ts`).

**Its defaults and binary are its own.**

- `settingSources` defaults to `["user", "project", "local"]`, so one missed override loads `~/.claude`.
- `pathToClaudeCodeExecutable` is reset; only `CLAUDE_CODE_EXECUTABLE` overrides it.
- It bundles its own SDK, 0.3.322 against 10db's 0.3.316.
- 10db's `spawnClaudeCodeProcess` (`claude-adapter.ts:380`) can't be passed in.

**The guard can't stay first.** 10db's guard is an in-process PreToolUse hook with `settled`, `cwd`, `agentId` and
`updatedInput` (`claude-adapter.ts:349-378`). There is a workaround: settings hooks that call a socket, as
`codex-guard.ts` does. It would still lose the deny message (fixed to "User refused permission to run tool",
`effects.ts:46-58`), `updatedInput` and the receipts.

**Verdict:** Claude and Codex direct, ACP for the rest. Revisit when ACP v2 is stable and the adapter offers a
library API.

### 5. Capability descriptor

```ts
interface AdapterCapabilities {
  harness: string;
  turn: {
    steer: 'none' | 'queue' | 'inject';
    interruptReceipt: boolean;
    clientMessageReceipts: boolean;
  };
  input: { images: readonly ('png' | 'jpeg' | 'webp' | 'gif')[]; embeddedContext: boolean };
  slashCommands: 'none' | 'static' | 'dynamic';
  session: {
    resume: 'native' | 'load-replay' | 'none';
    list: boolean;
    fork: 'native' | 'none';
    compact: boolean;
    rewindFiles: boolean;
  };
  permissions: {
    guard: 'pre-exec-all' | 'pre-exec-mutating' | 'observe-only';
    inputFidelity: 'raw' | 'title-only';
    denyMessage: boolean;
    updatedInput: boolean;
    questions: boolean;
    grants: 'agent-owned' | 'none';
  };
  modes: { readOnly: boolean; plan: boolean; options: readonly { id: string; label: string }[] };
  model: { switch: 'mid-session' | 'next-turn' | 'none'; effort: boolean; anyProvider: boolean };
  usage: { context: boolean; turnTokens: boolean; costUsd: boolean; rateLimits: boolean };
  work: { subagents: boolean; backgroundTasks: boolean; planUpdates: boolean; thoughts: boolean };
  mcp: { stdio: boolean; http: boolean };
  process: {
    wrapWholeInSrt: boolean;
    needsLoopback: boolean;
    ownSandbox: boolean;
    isolation: readonly string[];
  };
  pin: { source: 'npm' | 'github-release'; integrity: 'sha512' | 'sha256' };
}
```

| Agent    | steer  | guard             | Other                     |
| -------- | ------ | ----------------- | ------------------------- |
| OpenCode | inject | pre-exec-all      | raw input, any provider   |
| Gemini   | none   | pre-exec-mutating | title-only input, no list |
| Pi       | queue  | observe-only      | no MCP                    |
| Amp      | queue  | observe-only      |                           |

### What is unverified

- Whether every OpenCode tool asks, under a real permission config: MCP and `external_directory` included.
- Whether OpenCode's HTTP client honours srt's proxy.
- Droid's ACP behaviour.
- How Amp isolates its config.

## T4: chat UI building blocks

Ran on claude-sonnet-5-5. The coordinator wrote this file from the agent's message. Package tarballs are in this
folder: `sd` (streamdown), `mc` (@mantine/core), `ch` (@mantine/code-highlight), `mh` (@mantine/hooks), `sp`
(@mantine/spotlight), `pd` (@pierre/diffs), plus `codex-ts`. No browser was run, so the claims about WKWebView,
virtualization and IME are INFERRED. Each needs a spike.

### 1. Markdown: streamdown 2.7.1

**License.** VERIFIED Apache-2.0, "Copyright 2023 Vercel, Inc." Redistribution must keep the license and NOTICE.

**Dependencies.**

- Core: marked, remend (closes unterminated markdown while streaming), remark-gfm, rehype-raw, rehype-sanitize,
  rehype-harden, clsx and tailwind-merge. Peers react and react-dom ^18 or ^19. About 125 KB.
- Opt-in plugins, all Apache-2.0: `@streamdown/code` 2.0.0 (Shiki ^4, lazy chunk), `@streamdown/math` and
  `@streamdown/mermaid`. Use only `@streamdown/code`.

**Tailwind.** VERIFIED: the built-in code block, controls and tables emit Tailwind and shadcn classes. 10db has no
Tailwind, so:

- Override `components` (p, a, ul, ol, li, h1-h6, blockquote, table, th, td, code, pre, img) with Mantine `Text`,
  `Anchor`, `List`, `Table`, `Blockquote`, `Code` and `Title`.
- Set `controls` off.
- Style through `--mantine-*` variables in a CSS module.
- `shikiTheme` takes `[light, dark]`.
- `allowedTags` plus `fallbackComponent` render custom tags such as `<file-ref>`.

**Security.** VERIFIED. The default pipeline is rehype-raw, then rehype-sanitize with GitHub's schema, then
rehype-harden. The harden defaults are PERMISSIVE: every image, link and protocol prefix is allowed, and
`allowDataImages` is true. So a remote `<img>` in agent output becomes an exfiltration beacon. `linkSafety` (a
confirm modal) is on by default. Required settings:

- `skipHtml`
- harden with `allowedImagePrefixes: []` (or a daemon proxy), `allowedLinkPrefixes: ['https://']` and
  `allowDataImages: false`
- links open through Tauri's opener
- one hostile-markdown test: an img beacon, a `javascript:` link, `<script>` and a `data:` image

The repo today never renders markup: "Text is never rendered as markup" (`views/shape/transcript.tsx`,
`views/workbench/thread-message.tsx`). Rendering it needs a decision file.

**Performance.** INFERRED. It memoizes per block, so while streaming only the last block re-renders. Row height
changes reach `measureElement`'s ResizeObserver. A spike should check a streaming last row with scroll-to-end.

**Code blocks.** `@mantine/code-highlight` 9.8.0 provides `CodeHighlight` and `InlineCodeHighlight`, with
`CodeHighlightAdapterProvider` and a Shiki adapter. It is native Mantine.

**Call.** Streamdown behind one `Markdown` wrapper, with fences rendered by Mantine `CodeHighlight` and the Shiki
adapter. Fallback: react-markdown 10.1.0 plus rehype-sanitize 6.0.0 plus remend, with our own memoized block
splitter of about 100 lines.

### 2. Mantine 9.8.0 (released Nov 10, 2026)

**Breaking changes.** None listed, and there is no migration page. `apps/desktop/src` imports only `@mantine/core`
(237 times) and `@mantine/hooks` (16 times).

**What to bump.**

- `apps/desktop/package.json:23-24`: `@mantine/core` and `@mantine/hooks` from 9.7.4 to 9.8.0.
- Add `@mantine/code-highlight` 9.8.0 (it depends on `diff` ^9) and `@mantine/spotlight` 9.8.0 (it depends on
  `@mantine/store`).
- `.mcp.json:5` and `.codex/config.toml:17`: `@mantine/mcp-server` from 9.7.2 to 9.8.0. That pin already lags
  core. A changed args line asks for MCP approval again.
- Regenerate the lockfile.
- Leave historical docs as they are.

**`Mentions`.**

- One `Mentions.Mention` per trigger, as a string or a RegExp.
- Each mention takes `data(query, {signal})`, which may be async and is aborted when stale.
- Each mention also takes `markup` or a serializer, `displayTransform`, `renderSuggestion({item, query,
highlighted, index})`, `renderEmpty`, `renderError`, `onAdd`, `appendSpaceOnAdd`, `debounceMs` and
  `maxSuggestions`.
- `onChange` gives `{value, plainTextValue, idValue, mentions[], reason{type}}`.
- `suggestionsDisplay` is overlay or inline. It has `minRows` and `maxRows`.
- **Keyboard:**
  - Up and Down move through suggestions.
  - Enter or Tab picks one while the list is open.
  - Escape closes the list.
  - The send key must not fire while the dropdown is open. TEST this.
- **IME:** guarded by `isComposing` or keyCode 229.
- **Copy:** writes `application/x-mantine-mentions`.
- **Image paste:** not handled, so the composer wraps `onPaste` for pictures.
- Undo and redo are built in.

**`Diff`** (in code-highlight).

- It takes `previousValue` and `currentValue` as two strings: no patch, no syntax highlighting, no windowing.
- Props:
  - `mode`: unified or split
  - `diffMethod`: chars, words or lines
  - `contextLines`: defaults to Infinity, so always set it to about 3
  - `withLineNumbers`
- Colors come from `--diff-*` variables.

**`Spotlight`.**

- Store-driven: `spotlight.open`.
- Actions can be grouped.
- It takes a `filter` and a `limit`.
- It is a palette for sessions and commands, not the in-composer `/`.

**`use-active-element`.** `useActiveElement()` gates global shortcuts while typing. The key hooks in
`shape/use-shape-keys.ts`, `workbench/workbench-keys.ts` and `inbox/use-inbox-keys.ts` could use it.

### 3. The chat UIs 10db has today

**Plan (`views/shape/`)**

- `transcript.tsx` (253 lines):
  - virtualized (estimate 72, overscan 6)
  - text, tool, screen and note blocks
  - follows the tail unless the builder has scrolled up by more than 120 px
  - plain `pre-wrap` text
- `composer.tsx` (260 lines):
  - an autosize Textarea
  - the draft lifted out of the component
  - `isSendKey`
  - paste and drop of files
  - a `late` outcome
  - Propose and Stop
- `working-line.tsx`
- `waiting-permissions.tsx` (136 lines): Inbox cards answered in place, outside the windowed list.
- `attachments/` (`safe-render.ts`, 294 lines)
- `screenshot.tsx`, `dropped-files.ts`, `round-announcer.tsx` (aria-live), `conversation-pane.tsx` (309 lines) and
  `model-picker.tsx`

**Workbench (`views/workbench/`)**

- `thread.tsx` (110 lines): a plain `ol`, not virtualized.
- `thread-message.tsx` (135 lines): plain `pre-wrap`, with `CodeSpans`.
- `turn-pictures.tsx`, `turn-files.tsx` and `retry-turn.tsx`.
- `composer.tsx` (263 lines), with `composer-buttons.ts` (a phase table) and `drafts.ts`.
- `working-line.tsx`, `live-line.ts` and `turn-log-drawer.tsx`.
- `announcer.tsx` and `pictures.ts`.
- `page-ask.tsx` and `shared-choices.tsx`.

**What the two duplicate.**

- The composer. Workbench imports `isSendKey` from `../shape/use-shape-keys`, a cross-view import.
- The transcript list.
- The working line.
- The announcer.
- The picture and attachment handling.
- The way a permission is asked.

**Proposed shared folder: `apps/desktop/src/conversation/`**

| Component               | Job                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------ |
| `ConversationList`      | Virtualized and tail-following.                                                            |
| `Markdown`              | The only place streamdown is configured.                                                   |
| `MessageBubble`         | One message.                                                                               |
| `ToolCallCard`          | Dispatches to `command-card`, `diff-card`, `mcp-card`, `subagent-card` and `generic-card`. |
| `ComposerInput`         | Mentions, the send key, IME-safe Enter, image paste and drop.                              |
| `SendBar`               | The phase table.                                                                           |
| `WorkingLine`           | The working indicator.                                                                     |
| `PermissionRequest`     | A permission card for this conversation.                                                   |
| `ConversationAnnouncer` | aria-live.                                                                                 |
| `attachments/`          | Picture and file handling.                                                                 |

What stays with each screen:

- **Plan:** proposals, review notes, undo, screen blocks, preview, the split layout and `late`.
- **Workbench:** the pass, the queue, sign-off, page pictures, retry-turn and page status.
- **Sessions:** the tab strip, the mode, the project and branch, the agent and model, and Spotlight commands.

**Migration order.** Sessions first, then Plan, then Workbench. Each screen's behavior tests move with it.

### 4. Tool calls

**Today only one activity line reaches the desktop:** `SessionActivityData {workstreamId, kind, summary,
tool:{name,target}|null, turn}` (`packages/contracts/src/pass-activity.ts`).

- Claude's summary is built from `name` plus a truncated `toolBrief(input)` (`claude-mapping.ts:113-118`).
- Codex keeps only the command, `changes[0].path`, or the server and tool (`codex-mapping.ts:93-101`).
- Plan's tool rows are strings (`ShapeMessageKind.Tool`, `shape.ts:44-57`).
- No DTO carries a tool's input, output, diff or exit code.

**A new contract is needed: `ToolCallView`.** It is a zod discriminated union on `kind`, and every variant has `id`,
`status` (running, done, failed or denied), `startedAt`, `durationMs`, `title` and `parentToolId`.

| Kind              | Fields                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------- |
| `command`         | `command`, `cwd`, `output` (truncated, with a flag), `exitCode`                                         |
| `edit`            | `path`; `changeType` (add, delete, update, or move with `movePath`); `before` and `after`, or a `patch` |
| `read` / `search` | the path or pattern, and a summary                                                                      |
| `mcp`             | `server`, `tool`, `arguments`, `result` or `error`                                                      |
| `subagent`        | the subagent's call                                                                                     |
| `web`             | the web call                                                                                            |
| `other`           | anything else                                                                                           |

Large output is fetched when the card expands.

**What Codex sends for a file change** (codex-cli 0.167.0, from `generate-ts`):

- `fileChange {id, changes: FileUpdateChange[], status}`
- `FileUpdateChange {path, kind: add|delete|update{move_path}, diff: string}`
- live `FileChangePatchUpdatedNotification`
- `TurnDiffUpdatedNotification`, a unified diff of the whole turn

**Diff call.**

- Phase 1 is a `DiffCard` built on Mantine `Diff` with `contextLines` 3: unified in the chat, split when expanded.
- Claude's `Edit` maps directly.
- A Codex hunk becomes before and after text: drop the `+` lines for before and the `-` lines for after. That loses
  line numbers and syntax color, which is fine for a card. Full review belongs to the review views.
- `@pierre/diffs` 1.6.4 is the upgrade if wanted:
  - Apache-2.0
  - a `PatchDiff` component, Shiki highlighting, a shadow DOM and `--diffs-*` variables
  - about 11 MB, so it must be lazy-loaded
  - a spike first, on bundle size in Tauri and on theming against Selenized

model: claude-sonnet-5-5

# T5: UX patterns for many interactive agent sessions

Coverage is partial. The docs pages I could fetch were thin for most products; anything not seen is UNKNOWN. Claims are VERIFIED (seen on the cited page) or UNKNOWN. Only the first two Claude desktop items and Zed are rich.

### Claude desktop Code tab (https://code.claude.com/docs/en/desktop) - VERIFIED

- Create: row under the prompt: environment (Local/SSH/Cloud, saved), project folder, permission mode, model. Worktree toggle is off by default; worktrees in `<project>/.claude/worktrees/`, branch prefix setting, `.worktreeinclude` copies gitignored files.
- List: sidebar, group/sort, Archived tab. Details panel: Changes, Context, Environment, Background tasks. Per-session status icons: UNKNOWN.
- Notify: OS notification when a session finishes and you are not viewing it; phone push for dispatched sessions that finish or need approval.
- Changes: "Changes" card with +/- counts opens diff pane (Cmd+Shift+D); inline line comments, submit all with Cmd+Enter.
- PR: card shows PR with CI; Auto-fix, Merge when ready (needs gh).
- Archive: menu; if uncommitted changes, asks "Archive anyway" (discards) or cancel and commit; otherwise worktree kept ~30 days. Auto-archive after PR merge/close is a setting. Unarchive from the Archived tab.
- Shortcuts: Cmd+N new, Cmd+W close, Ctrl+Tab / Cmd+Shift+[ ] switch, Esc stop, Ctrl+` terminal; Option-click opens split view, Cmd-click opens a window.
- Handoff: terminal pane in the session cwd; right-click path, Open in VS Code/Cursor/Zed; Open in Cloud continues with a summary.
- Limits: UNKNOWN. Restart resume: UNKNOWN (page truncated).

### Zed agent panel (https://zed.dev/docs/ai/agent-panel) - VERIFIED

- New thread cmd-n; menu offers Zed Agent, external agents, "New From Summary", Terminal.
- Titles auto-generated, click to edit, "Regenerate Thread Title". Sidebar groups threads by project (cmd-alt-j); ctrl-tab recent switcher; archive with shift-backspace; History restores.
- Messages sent while generating are queued; "Send Now" (double enter) interrupts; Steer is Zed-agent only.
- Notifications: `agent.notify_when_agent_waiting`, `agent.play_sound_when_agent_done`, `agent.prevent_idle_sleep`.
- Changes: accordion of edited files above the editor; Review Changes multi-buffer with per-hunk accept/reject.
- Worktree: title-bar picker selects or creates a worktree per thread.

### Cursor Agents window (https://cursor.com/docs/agent/agents-window, https://cursor.com/docs/agent/overview) - VERIFIED where stated

- Opened by Cmd+Shift+P "Open Agents Window"; GA with Cursor 3 on 2026-04-02. Agents run local, worktree, cloud or SSH; `/in-cloud` hands local to cloud; multi-workspace in one window; diffs view to review, commit and manage PRs.
- Enter twice = Send now, Tab = queue; Cmd+K searches past transcripts.
- Status icons, notifications, concurrency limit, titles: UNKNOWN.

### VS Code (https://code.visualstudio.com/docs/copilot/agents/overview) - VERIFIED where stated

- Agents window manages sessions across projects; local, worktree, cloud (experimental). Sessions continue between Chat view and Agents window; GitHub environments continue from other clients. Local sessions need the host running. Status, notifications, archive, shortcuts: UNKNOWN (sub-pages 404/not fetched).

### Superset/Paradev (https://github.com/superset-sh/superset) - VERIFIED

- Per task: worktree, branch, terminals; setup/teardown/run scripts in `.paradev/config.json`.
- Sidebar shows working / done / waiting on you; completion chimes; dock badge when attention needed.
- Diff Viewer with comments and editing; Changes pane commits, pushes, opens PRs; PR pane shows checks and review threads; diff lines can be sent as feedback to a running or new agent.
- All shortcuts remappable (Cmd+/); Cmd+I rich prompt editor with @-file mentions. Limits: none stated.

### emdash (https://github.com/generalaction/emdash) - VERIFIED

- Detects installed CLIs (Claude Code, Codex, Cursor, OpenCode, Amp, Copilot); one worktree and branch per agent. Lifecycle hooks written into the agent's user config track status, notifications and resumable sessions. Review diffs, create PR, inspect CI, merge. Shortcuts, limits: UNKNOWN.

### Conductor (https://www.conductor.build/docs/) - VERIFIED overview only

- Runs Claude Code, Codex, Cursor, OpenCode in parallel; each task has workspace, branch, files, terminal, diff, review path; flow is review diff, open PR, merge, archive. Reference pages exist (Isolated workspaces, Diff viewer, Checks, Agent modes) but were not read: everything else UNKNOWN.

### Codex app (https://learn.chatgpt.com/docs/app) and Warp

- Codex app overview page had no session detail: UNKNOWN. Warp docs URLs 404'd: UNKNOWN.

### Common rules (seen in at least 3 products)

1. A session is a first-class, persistent row in a project-grouped sidebar/tab list; archive instead of delete, with an Archived view and unarchive (Claude, Zed, Conductor).
2. Isolation by worktree, chosen before the first message, off or explicit by default (Claude, Zed, Cursor, emdash, Superset, Conductor).
3. Three-way status: working / waiting on you / done, with OS notification only when the session is not in view (Superset, Claude, Zed).
4. A changes card with +/- counts opens a diff pane; the diff is the review surface and can send comments back to the agent (Claude, Superset, Zed, Cursor).
5. Promotion is diff, then PR with CI status, then merge, then archive.
6. Messages sent mid-turn queue; an explicit "send now" interrupts (Zed, Cursor).
7. Open in editor/terminal at the session's cwd from any path.

### Distinctive

- Archive refuses or warns on a dirty worktree and keeps a clean one 30 days (Claude).
- Hook-driven resume and status from the agent itself (emdash).
- Diff lines routed to a new agent session (Superset).
- Per-hunk accept/reject (Zed). New thread "from summary" (Zed). Local to cloud handoff (Cursor, Claude).

### Recommended rules for 10db Sessions

1. Tab strip of sessions per project; title auto-generated from the first message, editable, regenerable. Colored dot per tab: working, needs you, idle, done.
2. "Needs you" (approval, question) is also written to the existing Inbox; the tab dot is a view of Inbox state, never a second queue. OS notification only when the tab is not focused; dock badge counts Inbox items.
3. New session picker: project, mode (explore read-only / file task / work), branch or worktree, agent and model. Mode and worktree are fixed at creation; changing later means a new session "from summary".
4. Chat never writes the project (per research): write mode creates a task with a thread on the Board; the session's Changes card links to that task's diff using the Mantine Diff.
5. Changes card with file list and +/- counts above the composer; diff pane shortcut; line comments go back to the agent.
6. Archive is the only end state; archive warns on uncommitted changes in a worktree and offers commit or discard; a clean worktree is kept for a grace period. Promotion to PR happens from the task, not the chat.
7. Resume after restart: rehydrate tabs from the database, not from the agent process; reattach where the adapter supports resume, otherwise show the transcript read-only with "continue". Use agent lifecycle events as the status source.
8. Queue mid-turn messages; double-Enter sends now; Esc stops.
9. Shortcuts: Cmd+N new, Cmd+W close, Ctrl+Tab and Cmd+Shift+[ ] switch, Cmd+Shift+D diff, Ctrl+` terminal, Open in editor/terminal from any path.
10. Concurrency: no product states a cap (UNKNOWN); set a soft cap in settings and show the running count.
