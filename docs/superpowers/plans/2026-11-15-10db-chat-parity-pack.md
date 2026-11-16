# Chat parity pack: the todo list and the background tasks panel

## Brief

**What changes for you.** A Sessions chat shows two things Claude Code shows:

- **A todo list** above the composer: the agent's `TodoWrite` (Claude) or turn plan (Codex) as a live list with
  each step's status. It is open while work remains and folds to its heading once every step is done.
- **A background tasks list** above the composer: the shells, monitors and subagents the chat's session started
  and that still run, each with its kind, a subagent's type and what it is doing.

**What it buys.** You see what the agent is working through and what it left running, without reading the
transcript. Both only read what the daemon already receives.

**What could go wrong, and how we'd know.**

- Codex reports no background tasks, so its chat shows one dim line saying so rather than an empty panel.
- The list of background tasks is kept in the daemon's memory and goes with the session, so a stopped or restarted
  chat shows none. If a task outlives its session, the panel is wrong until the next report; the report replaces
  the whole set each time, so it heals itself.

**Calls you might disagree with.** Plan mode and fork were cut from this pack by the builder. Rewind stays out
(design spec §15 keeps "Rewind and fork" out of scope, and the UI spec's agent-modes line stays).

**Needed from you.** Nothing.

## Provider parity

| Feature | Claude plan, Bedrock, API key | Codex |
| --- | --- | --- |
| Todo list | `TodoWrite` is a `plan_update` | `turn/plan/updated` is a `plan_update` |
| Background tasks | `background_tasks_changed`: task type, subagent type, description | app-server reports none for a thread: the chat says "Codex doesn't report background tasks." (`capabilities.backgroundTasks`) |

## How it works

- The todo list is the chat transcript's latest `plan` item (the item recorder keeps one per turn and rewrites it
  on each update); `conversation/todo-list.tsx` draws it.
- `background_tasks` events are kept by the open session (`explore-session.ts`), never stored. The engine's view
  serves them as `ConversationDto.backgroundTasks` (`id`, `description`, `kind`, `agent`), and each report emits a
  `conversation.state` event so the screen reads the view again. `kind` is `shell`, `monitor`, `agent` or `other`,
  read from Claude Code's task type; ambient watchers are left out by the Claude mapping.
- The todo list sits just above the working line and the background panel above the composer, both in the chat
  tab's footer, each capped in height and scrolling inside; the todo list is hidden without `capabilities.plan`.

## Tasks

1. Todo list: component, chat tab, a test over the chat tab.
2. Background tasks: capability, contract, session and view, panel, tests through the engine and the chat tab.
3. Notes beside the code.

## Value cards

Written in each commit that adds a tested behavior.
