# Chat parity pack: plan mode, todos, background tasks, fork

## Brief

**What changes for you.** A Sessions chat gets four things Claude Code has:

- **Plan mode.** Shift+Tab in the composer (or the mode chip beside the model menu) moves the chat between its
  normal mode and plan mode. The composer shows the mode.
- **A todo list.** The agent's `TodoWrite` (Claude) or turn plan (Codex) shows above the composer as a live list
  with each step's status.
- **A background tasks list.** The shells and subagents a chat started and that still run, with what each is.
- **Fork.** "Fork" in the session bar menu makes a new tab that starts from this chat's history and goes its own
  way. The original is untouched.

**What it buys.** The chat stops feeling like a lesser Claude Code before M6 lets it write files. Plan mode only
narrows, so it can ship ahead of M6.

**What could go wrong, and how we'd know.**

- Plan mode is held in the daemon's memory, not stored, so a daemon restart puts a chat back in its normal mode.
  The composer chip shows the mode, so a restart is visible. Cost if wrong: one Shift+Tab.
- Codex plan mode rests on an experimental `turn/start` field (`collaborationMode`). The pin is checked by a
  protocol test and a live check; if the field is refused the capability reads "not available" and the chip says
  so, never silently.
- Fork of a chat with pictures copies the text history and not the picture files; the agent still has the
  pictures in its own forked context. A fork's picture budget starts clean.

**Calls you might disagree with.** A fork copies title ("... (fork)"), model, effort and the transcript; it does
not copy plan mode, the picture files or the picture budget. Fork is allowed only between turns. No migration:
fork lineage lives in a notice item at the head of the fork's transcript (see Fork).

**Needed from you.** Nothing.

## Provider parity

| Feature | Claude plan, Bedrock, API key | Codex |
| --- | --- | --- |
| Plan mode | `setPermissionMode('plan')` on the live query; back to the chat's normal mode (`auto` or `default`). Live, mid-turn too. | `collaborationMode: {mode: 'plan'}` on `turn/start`, from the next turn on (a running turn is not changed). Where the field is not accepted the chip is shown disabled with the reason. |
| Todo list | `TodoWrite` is a `plan_update` | `turn/plan/updated` is a `plan_update` |
| Background tasks | Claude's `background_tasks_changed` | Not reported by app-server for a session: the panel's place shows "Codex doesn't report background tasks." |
| Fork | `resume` + `forkSession: true` at the fork's first start | `thread/fork` of the parent thread at the fork's first start |

Plan mode narrows only: nothing in the sandbox, guard, allow list or judge changes. A chat has no write tool
today, so on Claude plan mode changes what the agent offers (a plan, no edits) and starts to matter when M6 lands.

## State by event

Plan mode (`P` = planMode flag on the conversation's runtime, never stored).

| State | Toggle | Fork | Stop | Steer | Turn end |
| --- | --- | --- | --- | --- | --- |
| idle (warm) | flips `P`; Claude applies to the open session at once; Codex on the next turn | allowed | no turn: nothing | starts a turn under `P` | n/a |
| idle (cold) | flips `P`; the next start opens in it | allowed (has a provider session) | nothing | the start opens under `P` | n/a |
| starting | flips `P`; the session opens with `P` as it is when it opens (read at open) | refused: "a turn is running" | cancels the start | queued | n/a |
| turn running | flips `P`; Claude applies live, so the rest of the turn runs under the new mode; Codex next turn | refused | stops the turn; `P` kept | injected into the turn, under the mode the turn began with | `P` kept for the next turn |
| stopping | flips `P`; applies as in running | refused | already stopping | queued | `P` kept |
| sealed / archived | refused (409) | refused | n/a | refused | n/a |
| daemon restart | `P` is gone: normal mode | needs a stored provider session: kept | n/a | n/a | n/a |

Fork (a fork is a new conversation whose first item is a fork notice naming the parent's provider session).

- **Pending fork** is derived: the conversation's `providerSessionId` equals the notice's parent id. The first
  start passes it as `resume` with the fork flag; the session's `started` reports the new id, which replaces it.
  A restart before the first message keeps the derivation, so a message in the fork never reaches the parent.
- Forking needs the parent between turns (idle warm or cold, ended in error, or paused) and a provider session
  (at least one finished turn). A running, stopping, taken-over, sealed or archived parent refuses with its words.

## Spec lines this amends

- Sessions design spec §15 "Rewind and fork" becomes "Rewind" only; §3's non-goal line likewise; the plan_update
  row of the events table gets its UI; a new §7.6 note says what the four features do and how.
- Sessions UI spec §15 "Rewind, fork, branch from here" becomes "Rewind, branch from here"; "Agent modes, such as
  Claude's plan mode, and an effort control" becomes "An effort control", since plan mode is the `planMode`
  capability and the effort control already exists.

## Tasks

Each is a vertical slice: contracts, daemon, UI, a test through the real daemon.

1. **Todo list.** `conversation/todo-list.tsx` over the latest `plan` item of the transcript; chat tab shows it
   above the composer, collapsed when every step is done. The stored plan item is what already exists; a plan
   update rewrites the same item in a turn. Test: rendered chat with a plan item (`renderWithDaemon`).
2. **Background tasks.** `ConversationDto.backgroundTasks` (list of `{id, description}`), kept in memory by the
   open session and sent on `conversation.state`; capability `backgroundTasks`. Panel above the composer; Codex
   says it is not reported. Test: fake adapter script emits `background_tasks`, `app.request()` view and render.
3. **Plan mode.** Capability `planMode`; `SessionHandle.setPlanMode`; `ExploreProfile.planMode` at open;
   `POST /conversations/:id/plan-mode`; Shift+Tab and the chip. Red-first steps: capability row, engine flag per
   state, Claude `setPermissionMode` mapping, Codex turn param, route, UI.
4. **Fork.** `POST /chats/:id/fork`; `ChatService.fork`; the notice item; adapters' fork-on-start; "Fork" menu
   item. Red-first steps: refusal table, copy rules, pending derivation across a restart, Claude option, Codex
   `thread/fork`.
5. **Docs.** Specs above, `AGENTS.md` beside the code, the UI notes.

## Value cards

Written in each commit that adds a tested behavior.
