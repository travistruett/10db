# One explore engine runs Sessions and Plan

- **Date:** 2026-11-13
- **Amends:** `decisions/2026-11-02-shape-session-and-convert.md` (the session's lifecycle)

## Decision

- An explore conversation's live session belongs to the engine in `apps/daemon/src/conversation/`, which follows
  sessions spec §6.7's state table as a pure reducer (`explore-state.ts`) and applies its effects one at a time per
  conversation. Plan plugs in through `ExploreOwnerHooks` (`spec`, `digest`, `outgoing`, `onTurnEnded`,
  `describeModel`, `freshAtContextPct`, and the optional `limits`, `keepsResume`, `readBackSpec`, `words` and
  `onParked`); Sessions does too, from M5a.
- The queue is durable: a turn starter (a builder message, or a Plan `shape_event` with a `prompt`) is stored before
  anything is sent, and stays queued until a turn takes it. After a restart, or a turn that ended in an error, waiting
  messages wait under one "Send now" line; nothing runs unattended. This replaces Plan's "10db quit before Claude
  read…" notices.
- Stop interrupts; if the turn is not reported ended within 10 s (`STOP_GRACE_MS`), the session is stopped. What a
  turn streamed before an early end is stored, marked partial, and what the session held is handed back. A starter
  the interrupt's receipt names still queued is left untaken, and runs as the next turn.
- A session stays warm 10 minutes after a turn; at most four sessions stay open app-wide, and a session going idle
  past that closes the one idle longest, never one in a turn. Past 70% context, or when a resume fails, the next start
  is fresh from a stored digest.
- A rate limit or a cap pauses the conversation, with one notice and no card, and does not pause the account.
- A model pick is the conversation's at once and reaches a warm session through `SessionHandle.setModel` at its next
  turn; the change is noted only once the session took it, and a failed switch puts the old pick back.
- Agent text and tool calls reach the UI as `conversation.delta` frames that are never stored; finished items are
  stored and announced by id. Full tool output, patches and bodies over 32 KB are kept under
  `<dataDir>/conversations/<id>/items/<itemId>/`, written once the item's write has committed; a call's output keeps
  its last four million characters there.
- A session row is written before the owner prepares the session, with its token's hash, and bills the project's
  account as it is at the start, never the conversation's stored one; a start that goes no further ends it
  `start_failed`.
- Plan's session runs in auto mode under the trust line's attended policy where its judge is `native`, and keeps
  today's rules where it is `rules` (and `tendb`, until 10db's judge exists).
- Plan's own session searches and fetches the web there; its researcher is an option. The checks auto mode's
  classifier doesn't make still apply to every web call, the session's and the researcher's: a query's length cap,
  the researcher's question limit, and a page that is https, public and named. What passes them is the
  classifier's to judge, never allowed outright. Commands are judged, not carded, and may run in the background
  under the lanes' process tracking.
- Auto mode turns Claude Code's subprocess env scrub off, so its children inherit the session env, which holds
  the account's credential. Plan's commands run in the read-only lane sandbox built from that env, which denies
  every credential name to Bash (`credentials.envVars`), as a lane's does; lanes and passes go through the same
  sandbox. No hook command runs, and the project's stdio servers start under srt with no session env. What
  keeps the credential is Claude Code itself and the git it runs, which need it to call the model.
- Plan writes no code. That is its role, and its sandbox stays read-only; its `.env` rule is unchanged.
- Plan's transcript is read through `/conversations/:id/items`, and its messages, Stop and Send Now go through
  the conversation routes; `ShapeViewDto.messages` is removed for `conversationId`, `POST /shapes/:id/messages`
  and `/stop` are gone, and `PROTOCOL_VERSION` is 10.

## Why

- One engine for Plan and Sessions, so the lifecycle, recovery and streaming are written and tested once (spec S4).
- A table that is total over states and events, tested cell by cell, leaves no hole for a stop, a card or a restart.
- Plan's in-memory queue lost messages at quit, and it ignored the interrupt receipt.
- A paused account belongs to its lanes; a chat waiting out a limit should not stop a project's work.
- The open-session cap counts sessions in a turn as well as idle ones, so a sixth conversation going idle while four
  run closes the one idle longest; only idle sessions are ever closed for it.
