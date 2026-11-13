# Agent output streams as live frames that are never stored, and an early end keeps partial text

- **Date:** 2026-11-12

## Decision

- Both adapters stream. A session emits `text_delta` and `reasoning_delta` (`itemId`, `offset`, `text`), a
  `message` for each finished text item, a `tool_call` carrying a `ToolCallView` (`@10db/contracts`) from start to
  end, `commands` and `plan_update` (`apps/daemon/src/sessions/types.ts`). `offset` is the item's text length
  before the delta, so a reader drops a frame it has already applied.
- Claude Code streams through the Agent SDK's partial messages; Codex through `item/started`, the
  `item/*/delta` notifications and `item/completed`. A Codex plan's steps come from `turn/plan/updated`.
- Every edit becomes hunks with three lines of context (`sessions/hunks.ts`), cut past 1,500 changed lines. jsdiff
  is bounded by an edit length of 10,000 and 100 ms; past either, the card shows the whole new text as added,
  marked truncated. A written file's previous text is read only when it is a regular file inside the checkout
  with one link, up to 1 MB, through one descriptor opened without following a link
  (`sessions/before-text.ts`). On Claude it is read in the PreToolUse hook, before the tool runs.
- The runner's live line and the files a turn touched come from `tool_call` alone, through
  `sessions/tool-target.ts`. The `activity` event keeps only its text kind.
- A call's `harnessTool` is the agent's own name for the tool. A Codex command that only reads a file is shown as a
  `read` card, but its `harnessTool` stays `command`. The earlier picture rule (`pictures/before-rule.ts`) counts
  any command as a tool that may change a file, and a command that looks like a read can still write.
- A denied call carries 10db's `refusal` and who denied it (`deniedBy`): `builder` only for a card the builder
  answered Deny, `judge` for auto mode's denial, `10db` for every other refusal. A judge's denial carries the
  limit its reason names and whether it is soft: only a limit in a session a person is in, whose policy renders
  the limits as soft denies, is soft. Claude Code may report a denial after the call's result; the call is then
  sent again, denied. Codex's items don't say who declined a call, so its `deniedBy` stays null.
- A Codex session lists `/compact`, `/review` and `/model`. `/compact` and `/review` are sent as
  `thread/compact/start` and `review/start`, never as text to the model, and wait for a running turn to end;
  `/model` is the composer's and reaches Codex as an ordinary message.
- Every Claude account kind (a Claude plan, Bedrock, an API key, a gateway) streams exactly as the plan does: the
  same SDK, the same options and the same events.
- These events reach the UI as `conversation.delta` frames, sent with `live: true`, never written to `events`
  and never advancing the replay seq, coalesced to one every 50 ms per item. Only finished items are stored. A turn
  that ends early (Stop, error, rate limit, restart) stores what streamed as an agent message marked partial, and
  its running tool calls as failed. The adapter events above are built with this record; the frames, the stored
  items and the partial capture are the conversation engine's
  (`docs/superpowers/specs/2026-11-11-10db-sessions-design.md` §6.3, §6.5), and until it lands the events are
  logged by id and size, never by text.

## Why

- Words that arrive only at a turn's end make a chat feel dead; streaming makes it feel alive (spec S9).
- Storing every delta would flood the events table and every replay; storing finished items keeps the store the
  size of the transcript.
- Dropping streamed text on Stop would throw away words the builder has already read, so an early end keeps them,
  marked partial.
- One `ToolCallView` for both agents gives one card and one diff path (S12). Codex patches and Claude edits both
  become hunks; a tail and a byte count keep each event small.
- The daemon runs outside every sandbox, so the previous-text read must never follow a link an agent planted or
  swapped; a file it won't read shows as wholly added, which is safe and still useful.
- Turned down: storing deltas and compacting later (the flood happens first), a second socket for live frames (one
  socket with a `live` flag keeps reconnect simple), and keeping the old `activity` tool events beside
  `tool_call` (two sources of the live line would drift).
