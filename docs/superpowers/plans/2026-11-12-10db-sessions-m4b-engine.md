# 10db Sessions M4b: the explore engine, with Plan on it — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One engine owns the live session of every explore conversation by the §6.7 state table, streams agent
text and tool calls to the UI as live frames with offsets, keeps what an early end streamed, queues durably with
"Send now" after a restart, and runs Plan; Plan streams, shows tool cards and keeps its queue. Plan's own session
runs in auto mode under the trust line's attended policy, with the web (trust line §8, §12).

**Architecture:** A pure reducer (`conversation/explore-state.ts`) turns (state, event, facts) into the next state
and a list of effects; the engine (`conversation/explore-engine.ts`) applies the effects, one at a time per
conversation, to a session opened through `AgentAdapter.open`, writes items through M4a's stores and delivery
library, and keeps in-memory live buffers that coalesce deltas into `conversation.delta` frames, sent on the event
socket and never stored. An owner plugs in through `ExploreOwnerHooks`; Plan's is `shape/explore-owner.ts`, and
`shape/service.ts` loses its own turn engine. The desktop applies frames by absolute offset and renders Plan's
transcript from conversation items with the M3 kit.

**Tech Stack:** TypeScript, Hono, Drizzle on SQLite, zod 4, `ws`, React 19 with Mantine 9.8, TanStack Query, Vitest,
Playwright (WebKit).

**Spec:** `docs/superpowers/specs/2026-11-11-10db-sessions-design.md` (v3): §6.1 (`ExploreOwnerHooks`), §6.2 rule 5
and the 32 KB body cap, §6.3–§6.8, §5.2 (full output on disk, `ToolCallView.refusal`), §10 (DTOs, the conversation
routes, the events), §8 (state words), §13 (the reducer, the delta reducer, the WebSocket test, the restart rows),
§14 (the M4b record). The coordinator's additions: M4b writes full output and patches to disk, closes reasoning
items, and adds `SessionHandle.setModel`. Trust line (`docs/superpowers/specs/2026-11-12-10db-trust-line-design.md`)
§5 (attended), §8 (Plan's row) and §12 ("Plan gets it in Sessions M4b"): Task 16b.

**Needs:** M4a (stores, ids, the delivery library, `AgentSessionCore.conversationId`) and M3 (the kit) merged; so
M2a–M2c, and the trust line's T2 and T3, too. Consumed from them:

- T2 (`2026-11-12-10db-trust-t2-setup-comes-along.md`): the builder's setup on Plan's session (instructions,
  skills and plugin dirs), and the Settings › Trust switches, Web among them.
- T3 (`2026-11-12-10db-trust-t3-policy-and-auto-mode.md`): `TrustPolicy` and the `trust/` module that builds it
  for a surface, attended or not; the auto-mode settings it renders (`"$defaults"` first, then the policy's
  lines, the limits as `soft_deny`); `capabilities.judge` with the model; the guard slimmed to coordination and the
  `rules` floor; auto mode for lanes and passes. Task 16b uses them for Plan. Find the names in T3's plan.

- M2b: `AgentAdapter` (`open`, `capabilities`, `readClientUuids`), `ExploreSessionSpec`, `AgentCapabilitiesDto`
  (`steer`, `receipts`, `readBack`, `modelSwitch`), and the fake's `FakeSessionClashError`, which already refuses two
  open handles on one agent session (not re-added here; Tasks 9 and 14 rely on it).
- M2c: the events `text_delta`, `reasoning_delta`, `message`, `tool_call` (with `appended` on Codex output deltas),
  `commands`, `plan_update` (`PlanStep`, `PlanStepStatus`; Codex from `turn/plan/updated`); `ToolCallView`, with
  `refusal` and `deniedBy` (spec §5.2; the coordinator has M2c add them); the fake's `say`, `think`, `plan`,
  `tool_call` steps and its explore reply (two `text_delta`s and a `message`). The old `activity` of kind `tool` is
  gone.
- M4a: `conversations.ts`, `conversation-items.ts`, `conversation-files.ts`, `transcript-kinds.ts`, `createDelivery`,
  `ConversationItemBody`, `ConversationState`, the `conversation/` module.
- M3 (`2026-11-12-10db-sessions-m3-kit.md`), in `apps/desktop/src/conversation/`: `Markdown`, `ToolCallCard`
  (with `Diff` per hunk, and `loadFull?: (callId: string) => Promise<string>`), `ConversationList({ entries,
  highlight, loadFull? })`, and the view model `ConversationEntry` (`builder`, `reply` with `partial`, `reasoning`,
  `tool` with `deniedBy`, `notice`, `divider` with an action, `custom`). Plan's `views/shape/plan-entries.ts`
  (`planEntries(messages)`) maps Plan's rows to entries; Task 18 replaces it with a map from items (call 15).

## Global Constraints

- Branch `feat/sessions-m4b`, in `../10db-worktrees/sessions-m4b`:
  `git worktree add ../10db-worktrees/sessions-m4b -b feat/sessions-m4b origin/main`, after M4a and M3 merged.
- Read `AGENTS.md`, `.claude/rules/code-style.md`, `.claude/rules/testing.md`, and the `AGENTS.md` of
  `apps/daemon`, `apps/desktop`, `packages/contracts` and `packages/db`.
- File:line citations are to `main` at c4da899. M2a–M4a move many of them (`shape/service.ts` above all); find the
  code by the name the step gives.
- Concurrent state and recovery: small red-first steps, one commit per behaviour. Every engine test runs on real
  SQLite (`createTestStore`), M2b's fake adapter and a `ManualClock`; no sleeps. Each red step names the failure it
  expects.
- Time comes from the injected `Clock`. The constants: `IDLE_MS = 10 * 60_000`, `STOP_GRACE_MS = 10_000` (call 4),
  `WARM_CAP = 4` idle warm explore sessions app-wide, `FRAME_MS = 50` per item, `freshAtContextPct = 70` for Plan,
  `BODY_CAP_CHARS = 32_768` (call 31).
- A live frame is never written to `events` and never advances the replay seq (§6.5). A frame's text is the agent's,
  so it is never logged.
- Full output, patches and over-cap bodies are written under
  `<dataDir>/conversations/<conversationId>/items/<itemId>/`, the path made from ids only.
- Messages are ordered by `seq`, never by comparing ids as text (M4a's rule; a new `cvi_` id sorts before a migrated
  one).
- No label names a provider except one that shows `capabilities.label`. The UI never imports `providerOf`
  (M2b's lint rule).
- These stay unmodified and green: `runner/pass-lane.test.ts`, `test/crash-recovery.test.ts`,
  `sessions/codex-guard.test.ts`, `sessions/codex-session.test.ts`, `apps/desktop/e2e/workbench.spec.ts`.
  `shape/confinement.test.ts` stays green through Task 16; Task 16b changes only the rows the trust line retires,
  and names each. `apps/desktop/e2e/shape.spec.ts` stays green; Task 18 lists the lines that
  change.
- Plan on a ChatGPT account stays refused (M5b lifts it).
- Code style as in M4a's plan: `as const` objects, no `enum`, no parameter properties, no `any`, `!` or unvalidated
  `as`, zod at every boundary (a frame read by the desktop is one), exhaustive switches.
- Commits: Conventional, single-quoted, every path named; the value card as a second `-m`; the last `-m` is
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Per task `make check-changed`; `make gate` once, in
  Task 19.

## Calls made here

Each is marked **(call)** where it is used.

1. **The queue is durable and is the conversation's untaken turn starters:** items not delivered and not pushed (or
   handed back) that are a builder `message`, or a `shape_event` whose body has a `prompt`. Plan's Propose and
   Rehearse presses are such `shape_event`s (their note stays the transcript row, and their instruction is the
   `prompt`), so they survive a restart under "Send now" too.
2. **Plan's builder messages are written queued** from here on. M4a wrote them delivered at once (M4a call 3), since
   nothing else delivered them.
3. **The engine mints the item id** (`cvi_`) at an adapter item's first event and keeps a map from the adapter's
   item or call id to it; frames and the stored item share it, so the UI swaps the live item for the stored one by
   id. `ToolCallView.id` stays the adapter's. `insertItem` gains its caller-given `id` here, for this.
4. **`STOP_GRACE_MS` is 10 s, defined here.** The spec calls it "the pass's grace", but no 10 s constant exists
   (the adapters stop within 5 s).
5. **`ExploreOwnerHooks` gains `outgoing`:** what a queued item sends, so Plan keeps putting its notes, files,
   mis-sized tasks and converted rows ahead of a message, and marks them told once sent. §6.1's four hooks cannot
   carry that.
6. **A paused account, per kind.** A rate limit pauses the conversation, never the account (Plan never paused one;
   lanes keep theirs). A start the account runtime blocks reads as `ended: rate_limited or capped` from `starting`.

   | Account kind | What pauses it | When the conversation resumes |
   | --- | --- | --- |
   | `claude_subscription` | a rate limit; a pause the account runtime holds | at the reported reset, else after the runtime's default pause; at the pause's `until` |
   | `anthropic_api_key`, `bedrock`, `gateway` | a rate limit (429) | as above |
   | the same, at the monthly cap | `accountBlocked` answers a pause with no `until` | one notice, then no timer loop: it re-checks once on the account's `account.changed` (saved, cap raised, card answered) and once at the next calendar month's first instant (UTC), and stays paused, silently, while still blocked |
   | `codex_signin` | Plan is refused before any start (today's `BRAINSTORM_REFUSED_ON_CHATGPT`) | n/a until M5b, which adds its row (a usage limit waits for its reset) and the follow-up task for Plan's subagents |

7. **An `ended` of `error`, `billing_refused`, `account_refused`, `sandbox_refused` or `model_refused` is
   `ended: error`;** `completed` or `stopped` that the engine did not ask for is `ended: … unasked`.
8. **Resume fails** is an `ended` before `started` while resuming. It is the §6.4 rule, an extra reducer row beside the
   table's `starting × ended: error`: a fresh start from the digest, once.
9. **After a crash the partial text is lost** (live buffers are memory). A clean stop (`close`) stores partials. At
   the next start, `recover` writes the notice "The turn was interrupted when 10db stopped." for a conversation found
   `running`, `waiting_card` or `stopping` with no partial stored since its last turn began (spec §6.3, §6.4).
10. **A reasoning item is stored** when the next item of the turn begins or the turn ends, complete, with
    `partial: true` only when the turn ended early.
11. **One `plan` item per turn**, updated in place by each `plan_update` (`conversation.item_updated`).
12. **A new builder message resolves the "Send now" line** and starts the turn with every waiting message.
13. **A model pick goes to the live session through `SessionHandle.setModel`** when `capabilities.modelSwitch` is
    `next_turn` (Claude `setModel`, Codex the next `turn/start`'s `model`); with `none`, the warm session closes. A
    pick during a turn is refused, as Plan's is today.
14. **Plan's hook lines.** The engine's typed cards replace Plan's research, command, refusal and "waiting for your
    answer" lines. A call the guard refused is the adapter's own `tool_call`, stored as the adapter sent it, with
    `status: 'denied'` and the `deniedBy` (M2c's `builder` or `10db`, or null) and `refusal` it set; the engine writes
    no literal `deniedBy`. Plan keeps the lines its own MCP tools write (`propose_plan · refused · …`,
    `see_screen · refused · …`) and its read-budget lines, as `10db.plan` tool items (M4a call 4).
15. **The kit split with M3.** M3's kit renders `ConversationEntry`s. M4b maps stored items and live items to
    entries (a live reply is a `reply` entry until the stored one replaces it under the same id; the "Send now" line
    is a `divider` with a Send Now action), adds one prop, `busy` (the list's `aria-busy` while a reply streams, UI
    spec §7.4), passes `loadFull`, and builds the kit's `WorkingLine`, which Plan is the first to use. `Composer`,
    `PermissionRequest` and `Announcer` are M5a's; Plan keeps its composer and `waiting-permissions.tsx`.
16. **`ShapeViewDto` loses `messages`** (the transcript moves to `/conversations/:id/items`) and gains
    `conversationId`; `PROTOCOL_VERSION` goes from 8 to 9 (the stakeholder questions build takes 8), recorded in the M4b decision.
17. **Refusal words the table leaves blank:** `starting` "The session is starting", `waiting_card` "Answer the card
    first", `stopping` "The turn is stopping", `sealed` "This session handed its work to a task". Send Now where
    nothing would run: "Nothing can run while <the state's words>" (call 29).
18. **"Send now" covers every waiting message.** A restart adds it, when anything is queued, in every state that goes
    to `idle_cold` (`idle_warm`, `starting`, `running`, `waiting_card`, `stopping`) and in `idle_cold` itself;
    `ended: error` and `ended: … unasked` add it too, when anything is queued, so neither an errored session nor one
    that ended by itself runs a queue unattended. `taken_over` keeps its held messages for Hand Back, and
    `paused_account` waits for the account.
19. **Plan's `ExploreProfile.shapeId` goes;** the core's `conversationId` names the conversation (M2b call 3).
20. **The fake's explore sessions are keyed by conversation** where M2a keyed them by shape.
21. **The restart rows run on the engine's own rung, not `createTestEngine`.** §13 names `createTestEngine`, which
    builds the runner and no explore engine. Task 15 restarts a second engine, with its own fake and clock, over the
    same real store, and Task 16 repeats the queue rows through Plan's `createServiceFixture().restart()`, which is
    the wiring.
22. **An end that is not a `turn_complete` hands back what it held.** Before it reduces a stop-grace `stop()`, an
    `ended` of any kind or a clean close, the engine runs `markItemsHandedBack` on every pushed, undelivered item, so
    none is left pushed to a session that is gone. After a stop-grace stop the queue then runs (the reducer's
    `run_queue`), as a `stillQueued` message does (§6.3); after `ended: error` or `ended: … unasked` it waits under
    Send now (call 18).
23. **A hold parks before the reducer.** While Convert's hold or the update drain holds, a `builder_message` is not
    reduced and `facts.queued` counts 0, so the state stays `idle_cold` or `idle_warm` and a `turn_complete` lands
    in `idle_warm`; the release reduces one `builder_message` when anything is queued. Stop while parked is
    `idle_cold`'s `drop_pending_start`: it clears the parked mark, so the release starts nothing and the messages stay
    queued. `parked(id)` answers whether a queue waits on a hold; Plan's view reads it for `waitingForUpdate`.
24. **Effects run one at a time per conversation.** Each runtime chains its effects on one promise, and a `start`
    waits for the previous handle's `stop()` to resolve, so a message that lands while an idle, context, model,
    LRU or archive close is stopping the old session never opens a second handle on it.
25. **Events carry their turn.** The runtime numbers each turn as it begins; an event of an earlier turn that arrives
    after that turn settled (a late `turn_complete` after a receipt settled a stop) is dropped. Storing an item under
    an id that exists updates it (`putItem`). `close` detaches the handle's events, all but its `ended`, before it
    calls `stop()`.
26. **Offsets are absolute.** A text item's offset is its length before the delta; a call's output offset is the
    output's length before the appended text. `/live` answers a call's last 4,096 characters with `outputOffset`,
    where that tail starts.
27. **Coalescing sends from the lowest offset changed** since the item's last frame, so a delta repeated inside one
    50 ms window adds nothing. `finish` drops a pending frame: the stored item, announced by
    `conversation.item_added`, replaces the live one in the UI.
28. **`busy()` counts `starting`, `running`, `waiting_card` and `stopping` only.** A queue waiting under Send now, on
    a hold or on a paused account is not a turn in progress, so the update drain never waits on it.
29. **Send Now acts only when something runs.** `sendNow` reduces `builder_message` and resolves the marker only when
    the outcome starts, pushes or injects; otherwise it is refused (409, call 17) and the marker stays.
30. **Stop and Redo replaces the message it redoes.** When the interrupt's receipt names the builder's last message
    `stillQueued` (the agent would run it by itself), the engine stops the handle, deletes that never-taken message,
    and queues the edited one, so only the edit is sent, to a resumed session.
31. **The body cap is 32 KB of a new item's JSON** (`BODY_CAP_CHARS`, UTF-16 units, above `TASK_MESSAGE_MAX_CHARS`).
    The engine applies it to the items it writes: a text item keeps its first 30,000 characters and its whole text
    goes to `body.txt`; an edit call keeps the hunks that fit, with `truncated: true`, and its patch goes to
    `patch.diff`. The item's DTO says `hasFull`. Migrated bodies and the old services' writes are left as they are
    (spec §6.2, §9.1).
32. **A model change is a notice item.** `modelChanged` stores a `notice` whose body is `{ kind: 'model_change',
    label, model }` (`label` the model's display name, `model` its id) when the model really changes, so Plan and,
    from M5a, Sessions draw it as a divider ("Now on {label} · {model}", UI spec). `ConversationItemBody.notice` is defined here as
    the union `{ text } | { kind: 'model_change', label, model }`, which M5a's Task 1 then finds in place.
33. **`ConversationDto.costUsd` is filled here:** the sum of the conversation's sessions' `cost_usd`, null unless
    `capabilities.costUsd`. M5a reads it.
34. **Plan's session gets auto mode here, after it moves onto the engine** (trust line §12), so its session code is
    rewritten once. Where `capabilities.judge` is `native`, Plan runs in `permissionMode: 'auto'` with T3's attended
    policy rendered as `settings.autoMode`. On `tendb` and `rules` it keeps `default` mode and today's hook rules:
    no adapter reports `tendb` until T5, which then sends Plan's calls to 10db's judge (roadmap T5 row). The switch
    over `judge` is exhaustive, with a `tendb` branch now. Plan still has no edit tools: that is its role, not a
    security line (trust line §8). Its sandbox stays read-only. Its `.env` behaviour stays as
    today: M4b lands before T4, which builds the attended and unattended `.env` split and its switch and extends
    them to Plan (spec §7.1).
36. **Plan says how it is judged.** On `rules` only (T5 revisits `tendb`), the kit's `JudgeLine` shows the UI spec's
    dimmed line, "Judged by 10db's rules. Add an OpenRouter key in Settings › Decisions for 10db's judge." It lives in
    `apps/desktop/src/conversation/`, so Sessions reuses it in M5a.
37. **Plan's list passes the kit's `onAllow`** (M3 call 8), which posts "Go ahead: {title}" as the builder's message,
    so a soft deny in Plan offers Allow This.
35. **Plan's own session has the web** where its judge is `native`: `WebSearch` and `WebFetch` run there, judged,
    with no card, and its researcher stays as an option. The researcher's question limit and URL rules go (trust
    line §8). A command the read-only line doesn't pass is judged, not carded. Commands may run in the background,
    under the lanes' process tracking, and stop when the session ends.

## Review Focus

1. **A frame lost or repeated across a reconnect.** The text shown must equal the stored item once it lands, with no
   doubled or missing run. Pinned by the delta table in Task 1 and the WebSocket test in Task 6, plus Task 18 render
   tests that reconnect mid-reply and mid-command.
2. **Stop pressed in the instant a turn completes.** The receipt and `turn_complete` race; the conversation must end
   in exactly one of `idle_warm` or `running` with the next turn, and store the partial once. Pinned in Task 10 (both
   orders, and a late `turn_complete` dropped).
3. **Five conversations warm and a sixth sent a message.** The longest idle closes, a running one never does, and
   the closed one resumes on its next message without a second handle. Pinned in Task 14.
4. **The daemon quits during a turn with two messages queued.** Nothing runs at the next start; both wait under one
   "Send now", and Send Now sends both in order. Pinned in Task 15 and through Plan in Task 16.
5. **A tool that prints a megabyte.** Frames carry only appended output, the stored item keeps the tail, and the full
   output is on disk and served by `/full`. Pinned in Tasks 3, 8, 9, 17 and 18.

## The §6.7 state × event table

Verbatim from the spec. Task 2's test table has one row per cell.

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

**Reading the cells** (each phrase is one effect; "store" is not an effect, because the engine stores the item
before it reduces, by rule 1):

| Phrase | Outcome |
| --- | --- |
| `start → starting` | `start` |
| `push → running`, `push the first queued message → running` | `push` |
| `inject or queue` | `inject` when `facts.steer` is `inject`, else nothing; the state stays |
| `(queued)`, `held` | nothing; the state stays |
| `if queued: drop the queue's pending start…` | `drop_pending_start` when `facts.queued > 0`, else nothing |
| `cancel the start`, `cancel` | `cancel_start` |
| `interrupt → stopping` | `interrupt` |
| `withdraw the card`, `withdraw` | `withdraw_card` |
| `re-push stillQueued; queue non-empty → running, else idle_warm` | `store_partial`, `on_turn_ended`, `repush_still_queued`, then `next_turn` and `running` when `facts.queued > 0`, else `idle_warm`. `repush_still_queued` is M4a's delivery rule 4 (`Delivery.interrupt`): a message the receipt names runs by itself as the next turn's start, and one it does not name is pushed again |
| `stop()` → idle_cold; partial stored (the stop-grace cell) | `stop_handle`, `store_partial`, `on_turn_ended`, and `run_queue` when `facts.queued > 0` (§6.3: what the stopped session did not take starts the next turn; call 22) |
| `partial stored`, `partial` | `store_partial` |
| `queue non-empty → next turn; else → idle_warm; onTurnEnded` | `on_turn_ended`, then `next_turn` (state `running`) or `idle_warm` |
| `(as above)` | the "receipt or `turn_complete` after Stop" cell |
| `close` | `close` |
| `next start is fresh from the digest` | `fresh_next` |
| `run the queue`, `run held messages` | `run_queue` |
| `(after a restart: "Send now")`, `"Send now"`, `queued messages wait under "Send now"` | `send_now` (with `facts.restartedWhilePaused` for the first; with `facts.queued > 0` for the others) |
| `notice (§7.5)` | `hand_back_notice` |
| `refused ("…")`, `refused` | `{ refused: words }`; blank words per call 17 |
| `no provider id: … else …`, `id: … none: …` | split on `facts.providerSessionId` |
| `archive` | `archive` |
| `Stop, then archive` | `interrupt`, `archive_after_stop`; the state `stopping` |
| `withdraw; Stop; archive` | `withdraw_card`, `interrupt`, `archive_after_stop`; the state `stopping` |
| `after the stop` | `archive_after_stop`; the state stays `stopping` |
| `confirm "End takeover and archive?"` | refused with those words unless `event.confirmed`, then `archive` → `idle_cold` |
| blank, `n/a`, `stays` | nothing; the state stays |

**Rows beyond the table**, each a test row named by its section:

- §6.3: every early end stores what streamed and tells the owner, so `stop grace passes` and every `ended` from
  `running`, `waiting_card` and `stopping` carry `store_partial` and `on_turn_ended` (`TurnEnd.how` `stopped` or
  `ended`), `waiting_card` and `stopping` included where their cells name no partial.
- §6.4: `ended: rate_limited or capped` carries `paused_notice` (the reset time); `starting × ended: error` with
  `facts.resuming` is `starting` with `start_fresh_from_digest` (call 8); a restart adds `send_now` in `idle_cold`,
  `idle_warm`, `waiting_card` and `stopping` when `facts.queued > 0`, and `ended: error` and
  `ended: completed or stopped, unasked` add it from every state when `facts.queued > 0` (call 18).
- §6.3 and call 23: Stop in `idle_cold` with a parked start is `drop_pending_start`, which clears the parked mark.
- §6.7 `sealed`: a builder message, Stop and Open in Terminal are refused (call 17); archive is `archive`; anything
  else is nothing. The `do_it` event (M6 sends it) moves any state to `sealed`: `idle_warm` with `close`, `starting`
  with `cancel_start`, `running` and `stopping` with `stop_handle, store_partial`, `waiting_card` with
  `withdraw_card, stop_handle, store_partial`; `taken_over` refuses it ("Hand back first").

## File structure

| Path | Job |
| --- | --- |
| `packages/contracts/src/conversation-dto.ts` (new) | `ConversationDto`, `ConversationItemDto`, `ConversationLiveDto`, `ConversationDeltaFrame`, `ConversationFullDto`, the route inputs |
| `packages/contracts/src/events.ts` | `conversation.item_added`, `conversation.item_updated`, `conversation.state` |
| `packages/db/src/store/conversation-items.ts` | `insertItem` with an id, `putItem`, `updateItem`, the queue, the item events |
| `apps/daemon/src/conversation/explore-state.ts` (new) | the reducer |
| `apps/daemon/src/conversation/live-buffers.ts` (new) | in-flight items, absolute offsets, 50 ms coalescing, item-id map |
| `apps/daemon/src/conversation/warm-cap.ts` (new) | which idle warm session closes |
| `apps/daemon/src/conversation/partial.ts` (new) | what an early end stores |
| `apps/daemon/src/conversation/full-output.ts` (new) | full output, patches and over-cap bodies on disk; the body cap |
| `apps/daemon/src/conversation/explore-engine.ts`, `explore-session.ts`, `explore-recovery.ts` (new) | the engine: effects, one session's events, restart |
| `apps/daemon/src/events/live-frames.ts` (new) | the live channel |
| `apps/daemon/src/api/stream.ts`, `api/app.ts`, `api/services.ts`, `daemon/conversation-services.ts` (new) | frames on the socket; the conversation routes |
| `apps/daemon/src/sessions/types.ts`, `claude-session.ts`, `codex-session.ts`, `fake-session.ts` | `setModel`; `full` on a finished `tool_call` |
| `apps/daemon/src/shape/explore-owner.ts` (new), `shape/service.ts`, `daemon/start.ts` | Plan's hooks; its turn engine removed; the engine wired |
| `apps/desktop/src/conversation/live-items.ts`, `working-line.tsx` (new), `conversation-list.tsx` (M3's) | applying frames; the state line; `busy` |
| `apps/desktop/src/daemon/events.ts`, `daemon/conversation-queries.ts` (new) | frames off the socket; the conversation queries |
| `apps/desktop/src/views/shape/*` | Plan on conversation items |
| `docs/architecture/decisions/<date>-one-explore-engine-runs-sessions-and-plan.md` (new) | the S4 record |

---

### Task 1: The conversation DTOs, the live frame, the stored events, and applying a frame

**Files:**
- Create: `packages/contracts/src/conversation-dto.ts`, `conversation-dto.test.ts`
- Modify: `packages/contracts/src/conversation.ts` (`shape_event` body gains `prompt?: string` and
  `rehearsing?: { taskKey: string; hash: string }[]`, call 1; `notice` becomes the union `{ text: string } |
  { kind: 'model_change'; label: string; model: string }`, call 32), `events.ts` (`EventType`), `json-schema.ts`,
  `index.ts`
- Create: `apps/desktop/src/conversation/live-items.ts`, `live-items.test.ts`

**Interfaces:**
- Produces, in `@10db/contracts`:

```ts
export const ConversationDto = z.object({
  id: ConversationId, owner: z.object({ kind: z.enum(ConversationOwnerKind), id: z.string() }),
  state: z.enum(ConversationState), capabilities: AgentCapabilitiesDto, model: z.string().nullable(),
  contextPct: z.number().nullable(), queued: z.int().nonnegative(),
  costUsd: z.number().nonnegative().nullable(), // the sum of its sessions' cost_usd; null unless capabilities.costUsd
  sendNow: z.boolean(),                    // an open "Send now" line waits
  pausedUntil: Timestamp.nullable(),       // paused_account's reset, null when it waits on the account
});
const ItemCommon = { id: ConversationItemId, conversationId: ConversationId, seq: z.int().positive(),
  author: z.enum(ConversationItemAuthor), partial: z.boolean(), hasFull: z.boolean(),
  deliveredAt: Timestamp.nullable(), createdAt: Timestamp };
export const ConversationItemDto = z.discriminatedUnion('kind', [
  // message, agent_message, reasoning, notice, digest: { ...ItemCommon, kind, text }
  // tool_call: { ...ItemCommon, kind, call: ToolCallView }
  // card: { inboxItemId }; plan: { steps }; shape_event: { event: ShapeEventKind, text }; turn_marker: { marker, resolvedAt }
]);
export const ConversationItemsPage = z.object({ items: z.array(ConversationItemDto), nextAfterSeq: z.int().nullable() }); // pages of 200
export const LiveItemDto = z.discriminatedUnion('kind', [
  z.object({ itemId: ConversationItemId, kind: z.enum(['agent_message', 'reasoning']), text: z.string() }),
  z.object({ itemId: ConversationItemId, kind: z.literal('tool_call'), call: ToolCallView,
    output: z.string(), outputOffset: z.int().nonnegative() }),             // the tail, and where it starts (call 26)
]);
export const ConversationLiveDto = z.object({ conversationId: ConversationId, items: z.array(LiveItemDto) });
export const ConversationDeltaFrame = z.object({
  live: z.literal(true), type: z.literal('conversation.delta'), conversationId: ConversationId,
  itemId: ConversationItemId, kind: z.enum(['agent_message', 'reasoning', 'tool_call']), offset: z.int().nonnegative(),
  text: z.string().optional(),
  callPatch: z.object({ view: ToolCallView.optional(), output: z.string().optional() }).optional(),
});
export const ConversationFullDto = z.object({ output: z.string().nullable(), patch: z.string().nullable(),
  text: z.string().nullable() });
export const PostConversationMessage = z.object({ text: z.string() });       // pictures: multipart, as the thread's
```

  `EventType` gains `ConversationItemAdded: 'conversation.item_added'` (data `{ id, seq, kind }`),
  `ConversationItemUpdated: 'conversation.item_updated'` (`{ id }`), `ConversationState: 'conversation.state'`
  (`{ state }`). Register the DTOs, the page, the live DTO, the full DTO and the frame in `CONTRACT_SCHEMAS`.
- Produces, in `apps/desktop/src/conversation/live-items.ts` (pure):

```ts
export interface LiveText { readonly kind: 'agent_message' | 'reasoning'; readonly text: string }
export interface LiveCall { readonly kind: 'tool_call'; readonly call: ToolCallView | null;
  readonly output: string; readonly outputOffset: number }   // output holds the text from outputOffset on
export type LiveItems = ReadonlyMap<ConversationItemId, LiveText | LiveCall>;
export function liveItemsOf(dto: ConversationLiveDto): LiveItems;
/** Applies one frame by absolute offset; `gap` asks the caller to read `/live` again. Frames of a stored item are dropped. */
export function applyFrame(items: LiveItems, frame: ConversationDeltaFrame, stored: ReadonlySet<ConversationItemId>):
  { readonly items: LiveItems; readonly gap: boolean };
```

  A call's held length is `outputOffset + output.length`; a frame at that offset appends; one wholly below it is
  dropped; one that overlaps applies its tail; one past it is a gap. The UI keeps the last 4,096 characters, moving
  `outputOffset` on.

- [ ] **Step 1: Write the failing tests.** `conversation-dto.test.ts`: one valid row per item kind and per frame shape;
  a frame without `live: true` is refused; a `ConversationDto` with an unknown state is refused. `live-items.test.ts`,
  one row each: in order (`offset 0 'Hel'`, `offset 3 'lo'` → `'Hello'`); duplicate (`offset 0 'Hel'` twice →
  `'Hel'`); overlap (`'Hello'`, then `offset 3 'lo, you'` → `'Hello, you'`); gap (`'Hel'`, then `offset 5 'x'` →
  unchanged, `gap: true`); interleaved (two items, frames alternating → each its own text); a frame for a stored id →
  dropped; a tool frame with `view` sets the call, then `output` frames append by offset with the same duplicate and
  gap rules; after `/live` answers a call with `outputOffset: 10_000` and a 4,096-character tail, a frame at offset
  14,096 appends, one at 9,000 is dropped, and one at 15,000 is a gap (Review Focus 5).
- [ ] **Step 2: Run them and watch them fail.**
  `pnpm --filter @10db/contracts exec vitest run src/conversation-dto.test.ts` and
  `pnpm --filter @10db/desktop exec vitest run src/conversation/live-items.test.ts`. Expected: FAIL, the modules are
  missing.
- [ ] **Step 3: Implement**, then `pnpm --filter @10db/contracts generate`.
- [ ] **Step 4: Run them and watch them pass.** Same commands, then `make check-changed`.
- [ ] **Step 5: Commit** (`feat(contracts): conversation DTOs, the live delta frame, and applying frames by offset`),
  with the value card: `Value: protects=a streamed item reads the same whatever order, repeat or gap its frames arrive in, long command output included; fails_when=a duplicate frame doubles text, a gap is applied, or a tail fetched by /live loops on gaps; why_new=no frame existed; no_claim=that the daemon sends correct offsets (Task 3)`.

---

### Task 2: The reducer, one row per cell

**Files:**
- Create: `apps/daemon/src/conversation/explore-state.ts`, `explore-state.test.ts`
- Modify: `apps/daemon/src/conversation/index.ts`

**Interfaces:**
- Produces:

```ts
export type ExploreEvent =
  | { readonly type: 'builder_message' } | { readonly type: 'started' }
  | { readonly type: 'card_raised' } | { readonly type: 'card_settled' }
  | { readonly type: 'stop' } | { readonly type: 'stop_settled' } | { readonly type: 'stop_grace_passed' }
  | { readonly type: 'turn_complete' } | { readonly type: 'idle_close' } | { readonly type: 'context_full' }
  | { readonly type: 'ended'; readonly how: 'error' | 'paused' | 'unasked' }
  | { readonly type: 'account_resumed' } | { readonly type: 'open_terminal' } | { readonly type: 'hand_back' }
  | { readonly type: 'daemon_restart' } | { readonly type: 'archive'; readonly confirmed: boolean }
  | { readonly type: 'do_it' };
export interface ExploreFacts {
  readonly queued: number; readonly providerSessionId: boolean; readonly restartedWhilePaused: boolean;
  readonly steer: SteerMode; readonly resuming: boolean;
}
export const ExploreEffect = { Start: 'start', Push: 'push', Inject: 'inject', DropPendingStart: 'drop_pending_start',
  CancelStart: 'cancel_start', Interrupt: 'interrupt', WithdrawCard: 'withdraw_card',
  RepushStillQueued: 'repush_still_queued', NextTurn: 'next_turn', StopHandle: 'stop_handle',
  StorePartial: 'store_partial', Close: 'close', FreshNext: 'fresh_next', StartFreshFromDigest: 'start_fresh_from_digest',
  OnTurnEnded: 'on_turn_ended', PausedNotice: 'paused_notice', RunQueue: 'run_queue', SendNow: 'send_now',
  HandBackNotice: 'hand_back_notice', Archive: 'archive', ArchiveAfterStop: 'archive_after_stop' } as const;
export type ExploreOutcome =
  | { readonly next: ConversationState; readonly effects: readonly ExploreEffect[] }
  | { readonly refused: string };
export function reduceExplore(state: ConversationState, event: ExploreEvent, facts: ExploreFacts): ExploreOutcome;
```

- [ ] **Step 1: Write the failing test.** `explore-state.test.ts` holds `CELLS`, one row per cell of the table above
  (blank and `n/a` included, which the next assertion needs), each `[event, state, words, facts?, expected]` with the
  spec's words as the row's name, read by **Reading the cells**; a conditional cell is two rows, one per side. Then
  the rows beyond the table, named by section. Two more assertions: every (state × event) pair, `sealed` and `do_it`
  included, has exactly one row per facts case (so the table is total), and no outcome's effects repeat.

```ts
it.each(CELLS)('%s in %s: %s', (event, state, _words, facts, expected) => {
  expect(reduceExplore(state, event, { ...BASE_FACTS, ...facts })).toEqual(expected);
});
```

- [ ] **Step 2: Run it and watch it fail.** `pnpm --filter @10db/daemon exec vitest run src/conversation/explore-state.test.ts`.
  Expected: FAIL, `reduceExplore` is missing.
- [ ] **Step 3: Implement** a switch on `state`, then on `event.type`, both exhaustive.
- [ ] **Step 4: Run it and watch it pass.** Same command, then `make check-changed`.
- [ ] **Step 5: Commit** (`feat(daemon): the explore conversation's state table as a reducer`), with the value card:
  `Value: protects=every state and event of spec §6.7 gives the table's next state and effects, early ends tell the owner, and an errored queue waits for Send now; fails_when=a cell moves to another state, loses an effect (a withdrawn card, a stored partial, onTurnEnded) or a refusal opens; why_new=no state machine existed for a conversation; no_claim=that the engine applies the effects (Tasks 9–15)`.

---

### Task 3: Live buffers, coalescing and the warm cap

**Files:**
- Create: `apps/daemon/src/conversation/live-buffers.ts`, `live-buffers.test.ts`, `warm-cap.ts`, `warm-cap.test.ts`

**Interfaces:**
- Consumes: M2c's `SessionEvent` stream variants, `ToolCallView`; `Clock`, `ManualClock`.
- Produces:

```ts
export interface LiveBuffers {
  /** The item id an adapter item or call is shown and stored under, minted at its first sight (call 3). */
  itemIdOf(adapterId: string): ConversationItemId;
  text(adapterId: string, kind: 'agent_message' | 'reasoning', offset: number, delta: string): void;
  call(view: ToolCallView, appended?: string): void;
  /** Removes a finished item, drops its pending frame (call 27), and answers what it held. */
  finish(adapterId: string): LiveItemDto | null;
  snapshot(): ConversationLiveDto['items'];
  /** Every in-flight item, for partial capture. */
  inFlight(): readonly LiveItemDto[];
  dispose(): void;
}
export function createLiveBuffers(deps: { conversationId: ConversationId; clock: Clock;
  send: (frame: ConversationDeltaFrame) => void; frameMs?: number }): LiveBuffers;
export function warmToClose(warm: readonly { id: ConversationId; idleSince: number }[], cap: number): ConversationId | null;
```

  A text buffer holds the item's whole text; a delta writes its text at its own offset (M2c's offsets are the
  item's length before it). The first change after a frame schedules a flush in `frameMs` (50); the flush sends one
  frame of the text from the lowest offset changed since the last frame (call 27). A call's `view` goes as soon as
  it is first seen and on each status change; its output goes as appended text only, at the output's absolute
  offset, and the buffer keeps the last `OUTPUT_TAIL_CHARS` with `outputOffset` for `snapshot`.

- [ ] **Step 1: Write the failing tests.** `live-buffers.test.ts` with a `ManualClock` and a frame recorder: three
  deltas within 50 ms → one frame, `offset 0`, the joined text; a delta 60 ms later → a second frame at the right
  offset; a delta repeated inside one window (`offset 0 'Hel'`, `offset 0 'Hel'`, `offset 3 'lo'`) → one frame,
  `'Hello'`, not `'HelHello'`; two items interleaved → frames keep their own offsets; a call seen running, then output
  `'ab'` and `'cd'` 60 ms apart → a `view` frame, then output frames at offsets 0 and 2; a status change to `done` →
  a `view` frame; `finish` with a frame pending → no frame sent, and the item gone from `snapshot`; one million
  characters of output → the snapshot holds a 4,096-character tail and `outputOffset` 995,904 (Review Focus 5);
  `itemIdOf` answers the same `cvi_` id for the same adapter id. `warm-cap.test.ts`: four warm → null; five → the
  smallest `idleSince`; ties → the first.
- [ ] **Step 2: Run them and watch them fail.** `pnpm --filter @10db/daemon exec vitest run src/conversation/live-buffers.test.ts src/conversation/warm-cap.test.ts`.
  Expected: FAIL, the modules are missing.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and watch them pass**, then `make check-changed`.
- [ ] **Step 5: Commit** (`feat(daemon): live buffers that coalesce deltas into frames with absolute offsets`), value
  card: `Value: protects=at most one frame per item per 50 ms, offsets that match the item's text even when a delta repeats, and output frames that carry only what was appended; fails_when=frames flood, an offset drifts, a repeat doubles text, or a frame carries the whole output; why_new=nothing buffered a stream; no_claim=that frames reach a socket (Task 6)`.

---

### Task 4: Partial capture

**Files:**
- Create: `apps/daemon/src/conversation/partial.ts`, `partial.test.ts`

**Interfaces:**
- Consumes: `LiveItemDto[]` from `LiveBuffers.inFlight()`; Task 5's `putItem`.
- Produces: `partialItems(inFlight: readonly LiveItemDto[], now: string): readonly NewItem[]` (pure: a text item is
  its kind with `partial: true`; a running call is a `tool_call` with `status: 'failed'`; an empty text item stores
  nothing) and `storePartial(ctx: WriteContext, conversationId: ConversationId, inFlight: readonly LiveItemDto[]):
  ConversationItemId[]`, which keeps each item's id.

- [ ] **Step 1: Write the failing tests.** Pure rows: text `'Half a sen'` → `agent_message`, `partial: true`, the text;
  reasoning → `reasoning`, `partial: true`; a running command call → `failed`, output tail kept; empty text → nothing.
  One real-SQLite row: `storePartial` writes them under their live ids, `seq` after the conversation's last item.
- [ ] **Step 2: Run them and watch them fail.** `pnpm --filter @10db/daemon exec vitest run src/conversation/partial.test.ts`.
  Expected: FAIL, the module is missing.
- [ ] **Step 3: Implement** (after Task 5, whose `putItem` it writes through).
- [ ] **Step 4: Run them and watch them pass**, then `make check-changed`.
- [ ] **Step 5: Commit** (`feat(daemon): what a turn streamed is kept, marked partial, when it ends early`), value card:
  `Value: protects=words the builder saw stream are stored when a turn stops, fails or is cut off, and running calls read failed; fails_when=partial text is dropped or a running call is stored as running; why_new=nothing stored a partial turn; no_claim=which ends store it (the reducer's store_partial, Task 2)`.

---

### Task 5: Item ids, upserts, the queue, and the item and state events

Run this task before Task 4.

**Files:**
- Modify: `packages/db/src/store/conversation-items.ts` (`insertItem` gains `id?: ConversationItemId` (call 3); new
  `putItem`, `updateItem`, `listQueuedTurnStarters`), `conversations.ts` (`patchConversation` with a `state`),
  `conversation-items.test.ts`

**Interfaces:**
- Produces: `insertItem(ctx, conversationId, input & { id? })` appends `conversation.item_added { id, seq, kind }`
  (entity `conversation`, the conversation's id); `putItem(ctx, conversationId, input & { id })` inserts, or, when
  the id exists in that conversation, updates its body and `partial` (call 25); `updateItem(ctx, id, patch: { body?:
  Json; partial?: boolean })` appends `conversation.item_updated { id }`; a `patchConversation` that changes `state`
  appends `conversation.state { state }`; `listQueuedTurnStarters(db, conversationId): ConversationItemRow[]` (call 1).
  The task and Plan adapters keep their own events beside these.

- [ ] **Step 1: Write the failing tests** (real SQLite): an insert emits one `item_added` with its seq and kind; an
  insert with an id keeps it; `putItem` twice with one id → one row, the second body, one `item_added` and one
  `item_updated`; an update emits one `item_updated`; a state change one `conversation.state`, and a patch that leaves
  the state emits none; `listQueuedTurnStarters` answers a builder message and a `shape_event` with a `prompt` that are
  neither delivered nor pushed, in `seq` order, and leaves a pushed one, a delivered one and a `shape_event` with no
  `prompt`.
- [ ] **Step 2: Run them and watch them fail.** `pnpm --filter @10db/db exec vitest run src/store/conversation-items.test.ts`.
  Expected: FAIL, `putItem` and `listQueuedTurnStarters` are missing and no `conversation.item_added` is emitted.
- [ ] **Step 3: Implement.** The desktop's `INVALIDATIONS` gains `conversation` in Task 18, not here.
- [ ] **Step 4: Run them and watch them pass**, then `pnpm --filter @10db/db exec vitest run` and `make check-changed`.
- [ ] **Step 5: Commit** (`feat(db): conversation items take an id, upsert, and announce themselves; the durable queue`),
  value card: `Value: protects=each stored item and state change reaches the UI as one id-only event, a live item stored twice is one row, and the queue is read from rows; fails_when=an event carries a body, a second store of an item fails on its key, or a queued turn starter is missed; why_new=the adapters' events name tasks and shapes, not items; no_claim=none`.

---

### Task 6: Live frames on the event socket

**Files:**
- Create: `apps/daemon/src/events/live-frames.ts`; modify `events/index.ts`
- Modify: `apps/daemon/src/api/stream.ts` (send frames once live), `api/services.ts` (`subscribeLive`),
  `daemon/start.ts` (one `LiveFrames`, given to the services and, in Task 16, to the engine)
- Create: `apps/daemon/src/daemon/live-frames.test.ts` (a real daemon and a real `ws` client, as
  `daemon/start.test.ts:249-270` does)

**Interfaces:**
- Produces: `interface LiveFrames { publish(frame: ConversationDeltaFrame): void; subscribe(listener): () => void }`,
  `createLiveFrames(onListenerError?)`. `streamEvents(after, services, send, sendLive)` sends each frame after the
  replay has gone live and never touches `lastSent`.

- [ ] **Step 1: Write the failing test.** Start a daemon in a temp data dir; connect `ws://…/events/stream?after=0`;
  publish a stored event (any `state.write` with an event) and a frame; the client receives both, the frame with
  `live: true`. Reconnect with `after=<the stored event's seq>`: the client receives no frame and no repeat of the
  event. `GET /events/head` still answers the stored seq.
- [ ] **Step 2: Run it and watch it fail.** `pnpm --filter @10db/daemon exec vitest run src/daemon/live-frames.test.ts`.
  Expected: FAIL, no frame arrives.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run it and watch it pass**, then `pnpm --filter @10db/daemon exec vitest run src/api src/daemon/start.test.ts`
  and `make check-changed`.
- [ ] **Step 5: Commit** (`feat(daemon): live frames ride the event socket and never advance the replay`), value card:
  `Value: protects=a live frame never advances the replay seq and a reconnect replays no live frame (spec §10); fails_when=a frame is stored, counted in the seq or replayed; why_new=the socket carried stored events only; no_claim=what the UI does with a frame (Task 18)`.

---

### Task 7: `SessionHandle.setModel`

**Files:**
- Modify: `apps/daemon/src/sessions/types.ts` (`SessionHandle`), `claude-session.ts` (the live query's
  `setModel`), `codex-session.ts` (the next `turn/start` carries `model`), `fake-session.ts` (records it)
- Test: `apps/daemon/src/sessions/claude-shape.test.ts` (the explore profile's file); `codex-session.test.ts` stays
  unmodified, so the Codex row goes in `apps/daemon/src/sessions/codex-model-switch.test.ts`

**Interfaces:**
- Produces: `SessionHandle.setModel(model: string): Promise<void>`: applies from the next turn; between turns only
  (the engine calls it in `idle_warm`).

- [ ] **Step 1: Write the failing tests.** Claude: after a turn, `setModel('claude-sonnet-5-5')` calls the query's
  `setModel` with the account's launch id for it, and the next turn runs under it. Codex: after `setModel`, the next
  `turn/start` params name the model; a `turn/steer` names none. Fake: `setModel` is recorded.
- [ ] **Step 2: Run them and watch them fail.** `pnpm --filter @10db/daemon exec vitest run src/sessions/claude-shape.test.ts src/sessions/codex-model-switch.test.ts`.
  Expected: FAIL, `setModel` is not a function on the handle.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and watch them pass**, then `pnpm --filter @10db/daemon exec vitest run src/sessions` and
  `make check-changed`.
- [ ] **Step 5: Commit** (`feat(daemon): a live session takes a model for its next turn`), value card:
  `Value: protects=a model pick reaches a warm session at its next turn on both agents; fails_when=the pick is lost until a restart or applied mid-turn; why_new=only a new session took a model; no_claim=the engine's choice to call it (Task 9)`.

---

### Task 8: Full output, patches and the body cap, on disk

**Files:**
- Modify: `apps/daemon/src/sessions/types.ts` (the `tool_call` event gains `full?: { readonly output?: string;
  readonly patch?: string }` on a finished call), the Claude and Codex tool-call mappers (M2c Tasks 5 and 8): Claude
  sets `output` to the whole `tool_result` text (a command's output or an MCP call's result) when it is longer than
  the tail, and `patch` to the edit's unified patch when `truncated`; Codex sets `output` to the command's
  aggregated output when it is longer than the tail, and `patch` for a truncated `fileChange`
- Create: `apps/daemon/src/conversation/full-output.ts`, `full-output.test.ts`

**Interfaces:**
- Produces: `fullOutputDir(dataDir, conversationId, itemId): string` (ids only);
  `writeFullOutput(dataDir, conversationId, itemId, full: { output?: string; patch?: string; text?: string }):
  boolean` (writes `output.txt`, `patch.diff` and `body.txt`, mode 600, answers whether it wrote any);
  `readFullOutput(dataDir, conversationId, itemId): ConversationFullDto`; and the cap (call 31):
  `capItemBody(kind: ConversationItemKind, body: Json): { body: Json; full: { text?: string; patch?: string } | null }`
  (pure): a body whose JSON is at most `BODY_CAP_CHARS` (32,768) is kept as it is; a longer text item keeps its first
  30,000 characters; a longer edit call keeps the hunks that fit, `truncated: true`, its patch in `full.patch`.

- [ ] **Step 1: Write the failing tests.** Mapper rows (pure): a Claude result of 10,000 characters → `full.output`
  holds all of it and the view's tail 4,096; a short result → no `full`; a 1,600-line edit → `full.patch`. Cap rows
  (pure): a 32,768-character body is kept; a 40,000-character agent text keeps 30,000 and `full.text` holds 40,000;
  an edit whose hunks make 100 KB keeps fewer hunks under the cap, `truncated: true`. Disk rows (temp dir): write
  then read each file; an id with `/` or `..` is refused by the id schema before any path is made; a missing folder
  reads as nulls.
- [ ] **Step 2: Run them and watch them fail.** `pnpm --filter @10db/daemon exec vitest run src/conversation/full-output.test.ts src/sessions`.
  Expected: FAIL, `full-output.ts` is missing and the mappers set no `full`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and watch them pass**, then `make check-changed`.
- [ ] **Step 5: Commit** (`feat(daemon): full output, patches and over-cap bodies are kept on disk`), value card:
  `Value: protects=what the 4 KB tail, the 1,500-line hunk cap and the 32 KB body cap cut off is still there for the card to expand; fails_when=a long result, patch or reply is lost or written to a path not made of ids, or a body over the cap is stored whole; why_new=M2c keeps tails only, and nothing capped a body; no_claim=the route that serves it (Task 17)`.

---

### Task 9: The engine: a turn from a queued message to a warm session

**Files:**
- Create: `apps/daemon/src/conversation/explore-engine.ts`, `explore-session.ts`, `explore-engine.test.ts`
- Modify: `apps/daemon/src/conversation/index.ts`

**Interfaces:**
- Consumes: Tasks 2–8; M4a's stores and `createDelivery`; `AgentAdapter`; `LiveFrames`; `Hold` (`verify`);
  `WaitObserver` (`inbox`, used in Task 13).
- Produces:

```ts
export interface Outgoing { readonly text: string; readonly images: readonly ShapeImage[];
  readonly blocks: readonly ConversationFileId[]; sent(ctx: WriteContext): void }
export interface ExploreStart { readonly sessionId: SessionId; readonly mcpToken: string; readonly resume: string | null;
  readonly digest: string | null; readonly first: Outgoing; readonly observer: WaitObserver }
export interface ExploreLaunch { readonly spec: ExploreSessionSpec; readonly limits: PictureLimits;
  readonly expiresAt: string | null; readonly accountId: AccountId; readonly model: string;
  release(): Promise<void>; track(pid: number): void }
export interface TurnEnd { readonly how: 'complete' | 'failed' | 'stopped' | 'ended';
  readonly starters: readonly ConversationItemId[] }
export interface ExploreOwnerHooks {
  spec(conv: ConversationRow, start: ExploreStart): Promise<ExploreLaunch>;
  digest(conv: ConversationRow): string;
  outgoing(conv: ConversationRow, item: ConversationItemRow, session: { readonly fresh: boolean;
    readonly digest: string | null; readonly limits: PictureLimits }): Outgoing;          // (call 5)
  onTurnEnded(conv: ConversationRow, end: TurnEnd): Promise<void>;
  readonly freshAtContextPct: number;
}
export interface ExploreEngine {
  register(kind: typeof ConversationOwnerKind.Shape | typeof ConversationOwnerKind.Chat, hooks: ExploreOwnerHooks): void;
  /** A turn starter was stored (rule 1); reduces `builder_message`, or parks it behind a hold (call 23). */
  queued(id: ConversationId): void;
  stop(id: ConversationId): Promise<void>;
  /** Stop, then the edited message as the next turn (call 30). */
  redo(id: ConversationId, post: () => ConversationItemRow): Promise<ConversationItemRow>;
  /** Refused with the state's words when nothing would run (call 29). */
  sendNow(id: ConversationId): void;
  modelChanged(id: ConversationId, model: string | null): Promise<void>;
  holdStarts(id: ConversationId): void;
  releaseStarts(id: ConversationId): void;
  view(id: ConversationId): ConversationDto;
  live(id: ConversationId): ConversationLiveDto;
  /** Conversations `starting`, `running`, `waiting_card` or `stopping`: what an update drain waits for (call 28). */
  busy(): readonly ConversationId[];
  /** A queue waits on a hold; Plan's view reads it for `waitingForUpdate`. */
  parked(id: ConversationId): boolean;
  settled(id: ConversationId): Promise<void>;
  recover(): Promise<void>;       // Task 15
  close(): Promise<void>;         // Task 15
}
export function createExploreEngine(deps: { readonly state: StateStore; readonly adapter: AgentAdapter;
  readonly clock: Clock; readonly log: Logger; readonly dataDir: string; readonly frames: LiveFrames;
  readonly hold?: Hold; readonly bus: EventBus;
  readonly accountBlocked: (accountId: AccountId, projectId: ProjectId) => { readonly until: Date | null } | null;
  readonly defaultPauseMs: number; readonly idleMs?: number; readonly stopGraceMs?: number; readonly warmCap?: number }): ExploreEngine;
```

  The engine keeps one runtime per conversation: a state mirror, the live handle, its delivery, its buffers, its
  timers, a turn counter and one effect chain. Each change of state goes through `reduceExplore`, is written with
  `patchConversation({ state })`, and has its effects appended to the chain, which runs them one at a time; a
  `start` waits for the previous handle's `stop()` (call 24). A start inserts the session row
  (`insertSession({ conversationId })`), mints the MCP token, asks `hooks.spec`, and opens the handle; `started`
  stores the provider session id on the conversation and the session. Events of a turn that has settled are dropped
  (call 25). Events map to items through `capItemBody` and `putItem`: a `message` stores an `agent_message` under its
  live id (`finish`); a `tool_call` that is not `running` stores or updates its `tool_call` item and writes `full`
  to disk (Task 8); a `reasoning_delta` begins a reasoning buffer that is stored at the next item or the turn's end
  (call 10); a `plan_update` writes or updates the turn's `plan` item (call 11); `commands` are kept on the runtime
  for M5a. `consumed` and `turn_complete.dropped` go to the delivery library; `turn_complete` marks the turn's
  starters delivered (rule 3). `turn_complete.text` is not stored: the `message` events carry the reply. A model
  pick in `idle_warm` calls `setModel` (call 13). A hold parks before the reducer (call 23). A live session past
  `expiresAt` minus 5 minutes is closed (`idle_close`) before a push, so the next start resumes with fresh
  credentials.

- [ ] **Step 1: Write the failing tests** in `explore-engine.test.ts`. The owner is the smallest real one, defined in
  the test file (an owner is the engine's input, like Plan's and Sessions'; it is not a mock of the engine): its
  `spec` builds an explore spec on the fake, `outgoing` sends the message text, `digest` joins the items. Rows:
  - a queued message in `idle_cold` → `starting`, a session row on the conversation, `started` → `running`, the
    message pushed under its row's uuid (rule 2);
  - the fake's reply (two deltas and a `message` at one clock instant) → one stored `agent_message` under the id the
    buffers minted, no frame left pending after `finish` (call 27), `live()` empty; the turn ends → `idle_warm`, the
    message delivered, `onTurnEnded` called once with `how: 'complete'` and it as starter. Frame timing is Task 3's;
    a `tool_call` row below checks frames reach `LiveFrames`;
  - a second message while `idle_warm` → pushed into the same handle, no new session;
  - 10 minutes idle (ManualClock) → the handle stopped, `idle_cold`; the next message resumes by the stored provider
    session id;
  - the idle timer fires and a message arrives in the same tick (Review Focus 3, call 24) → one handle open at a
    time (the fake would throw `FakeSessionClashError`), the message sent on the resumed session;
  - two messages queued during `starting` → after `started`, the first pushed; at its `turn_complete`, the next turn
    starts at once with the second;
  - a model pick in `idle_warm` → `setModel` on the handle, no close, the conversation's `model` updated, and one
    `notice` item `{ kind: 'model_change', label, model }` stored (call 32); a pick of the model already set stores
    none;
  - `view` answers `costUsd` as the sum of the conversation's sessions' `cost_usd` on a metered fake account, and
    null on a subscription one (call 33);
  - a hold → a message stays queued, the state stays `idle_cold`, `parked` is true, `busy()` is empty; the release
    starts the turn (call 23);
  - a hold taken while a turn runs with a second message queued → `turn_complete` lands in `idle_warm` (no next turn
    runs, nothing sits in `running`); the release pushes the second (the parked `next_turn`);
  - a `tool_call` running, then output 60 ms later, then `done` with `full.output` → a `view` frame and an output
    frame on `LiveFrames`, then one `tool_call` item and `output.txt` on disk;
  - reasoning then text → the reasoning item stored before the message, complete.
- [ ] **Step 2: Run them and watch them fail.** `pnpm --filter @10db/daemon exec vitest run src/conversation/explore-engine.test.ts`.
  Expected: FAIL, `createExploreEngine` is missing.
- [ ] **Step 3: Implement** `explore-engine.ts` (runtimes, reducing, the effect chain, timers) and `explore-session.ts`
  (one open handle: its events to buffers, items, delivery and reducer events). Keep each under about 400 lines.
- [ ] **Step 4: Run them and watch them pass**, then `make check-changed`.
- [ ] **Step 5: Commit** (`feat(daemon): the explore engine runs a turn from a queued message to a warm session`),
  value card: `Value: protects=a queued message starts or reaches a session, its reply is stored once, the session stays warm 10 minutes and resumes after, a hold parks without a stuck state, and a close never races a new handle; fails_when=a message is pushed before it is stored, a reply is stored twice or not at all, an idle session never closes, a hold leaves the state at starting or running, or two handles open on one session; why_new=Plan's engine was in shape/service.ts and kept no durable queue; no_claim=stop, fresh sessions, pauses, cards and restart (Tasks 10–15)`.

---

### Task 10: The engine: Stop, the stop grace, Stop and Redo, steering

**Files:** `explore-engine.ts`, `explore-session.ts`; test `explore-engine.test.ts` (`describe('Stop')`)

- [ ] **Step 1: Write the failing tests:**
  - Stop while `running` → `interrupt()` → `stopping`; the receipt names one of two pushed messages `stillQueued` →
    the other is pushed again (rule 4), the partial stored once, `onTurnEnded` with `how: 'stopped'`, and the next
    turn runs (`running`); with no queue → `idle_warm`.
  - Review Focus 2, both orders: `turn_complete` then the interrupt's receipt, and the receipt then `turn_complete` →
    one settle, one partial, one next turn; a `turn_complete` that arrives after the receipt settled the stop and the
    next turn began is dropped (call 25), and that turn keeps running.
  - The stop grace with one message injected and not consumed: no receipt and no `turn_complete` in 10 s
    (ManualClock) → `stop()` → `idle_cold`, partial stored, the message handed back (`pushed_at` null,
    `handed_back_at` set, call 22), and it starts the next turn (the reducer's `run_queue`).
  - Stop in `starting` → the start cancelled, no session opened, `idle_cold`; Stop in `idle_cold` with a queued
    message → it stays queued and nothing starts until a new message or Send Now.
  - Stop while a start is parked behind a hold → the parked mark cleared; the hold's release starts nothing, and the
    message stays queued (call 23).
  - Redo → Stop, the edited message stored queued while `stopping`, and it starts the next turn; when the receipt
    names the original message `stillQueued` → the handle is stopped, the original deleted, and the next start
    (resumed) is sent the edit alone (call 30).
  - A message while `running` on an agent whose `steer` is `inject` → pushed at once; on `queue` (a capability row
    of the fake) → waits for the turn's end.
- [ ] **Step 2: Run them and watch them fail**, same command as Task 9. Expected: FAIL, `stop` and `redo` are
  unimplemented: Stop leaves the state `running`, and the grace row's message stays pushed.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and watch them pass**, then `make check-changed`.
- [ ] **Step 5: Commit** (`feat(daemon): Stop, Stop and Redo and steering in the explore engine`), value card:
  `Value: protects=Stop always ends the turn within 10 s, keeps what streamed once, hands back what the session held, and re-sends only what the receipt says was not taken; Redo sends the edit alone; fails_when=a stop hangs, a message is lost, stranded pushed or sent twice, a late turn_complete ends the next turn, or Redo sends both; why_new=Plan ignored the interrupt receipt; no_claim=a restart during a stop (Task 15)`.

---

### Task 11: The engine: a fresh session past 70%, and when a resume fails

The engine owns the `digest` item (it stores `hooks.digest` before a fresh start that follows the agent's speech);
Plan's `FRESH_START_LINE` is Plan's `outgoing`, in Task 16.

**Files:** `explore-engine.ts`, `explore-session.ts`; test `explore-engine.test.ts` (`describe('fresh sessions')`)

- [ ] **Step 1: Write the failing tests:**
  - A turn ending at 71% context → `idle_warm` then `context_full` → closed, `idle_cold`, the provider session id
    cleared, the notice "Continued in a fresh session. Nothing is lost." stored; the next message starts with no
    resume, a `digest` item stored before it, and `outgoing` given the digest.
  - A turn ending at exactly 70% → stays warm (strictly past, as Plan's is).
  - A resume that ends before `started` → one fresh start from the digest (a `digest` item); a second failure →
    `ended_error`.
- [ ] **Step 2: Run them and watch them fail**, Task 9's command. Expected: FAIL, a 71% turn stays `idle_warm` and a
  failed resume goes straight to `ended_error`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and watch them pass**, then `make check-changed`.
- [ ] **Step 5: Commit** (`feat(daemon): fresh explore sessions from the digest, past 70% or when a resume fails`),
  value card: `Value: protects=a long or unresumable conversation continues in a fresh session that is told the digest, and says so; fails_when=a full context keeps resuming, a failed resume ends the conversation, or the digest is not stored; why_new=Plan's own rule had no resume-failure path; no_claim=a fallback account's config dir (it fails to resume, which this covers)`.

---

### Task 12: The engine: ends, paused accounts and their resumption

**Files:** `explore-engine.ts`, `explore-session.ts`; test `explore-engine.test.ts` (`describe('ends')`)

- [ ] **Step 1: Write the failing tests**, the paused rows one per call 6 table row:
  - `claude_subscription`, `ended: rate_limited` while `running` with a reset in 20 minutes → partial stored,
    `paused_account`, `pausedUntil` set, a notice naming the reset; no card raised; a message sent meanwhile is
    stored queued; at the reset (ManualClock) → `idle_cold` and the queue runs. With no reset reported → it waits the
    default pause.
  - A start the account runtime blocks with an `until` → `paused_account` with that `until`, resumed at it.
  - A metered account at its cap (`accountBlocked` answers `{ until: null }`) → one notice, `pausedUntil` null, no
    timer but the month's; three more starts asked meanwhile add no notice; an `account.changed` on the bus while
    still blocked → no new notice and no loop; then unblocked and `account.changed` → `idle_cold` and the queue runs.
  - `ended: error` while `running` with one message injected and not consumed → partial stored, the message handed
    back (call 22), `ended_error`, one Send now line (call 18); the next builder message starts afresh with both.
  - `ended: completed` the engine did not ask for, while `running` → `idle_cold`; while `starting` → `ended_error`.
    While `running` with one message injected and not consumed → the message handed back, `idle_cold`, one Send now
    line, and nothing starts (call 18).
  - Each `model_refused` end marks the model as Plan does today (`markModelUnusable`).
- [ ] **Step 2: Run them and watch them fail**, Task 9's command. Expected: FAIL, a rate-limited end leaves the state
  `running` and no pause timer runs.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and watch them pass**, then `make check-changed`.
- [ ] **Step 5: Commit** (`feat(daemon): explore conversations wait out a paused account and keep partial turns`),
  value card: `Value: protects=a rate limit or cap pauses the conversation with one notice and resumes it when the account can run again, with no card and no loop, and an errored turn's messages wait under Send now; fails_when=a paused conversation spends tokens, never resumes, repeats its notice, raises a card, or strands a pushed message; why_new=Plan turned a limit into a notice and dropped the queue; no_claim=a restart while paused (Task 15); Codex (M5b)`.

---

### Task 13: The engine: cards

**Files:**
- Modify: `apps/daemon/src/inbox/permission-broker.ts:58-61,264` and `inbox/service.ts:86-87,577-579` (the owner
  gains `{ workstreamId: null; conversationId: ConversationId; shapeId?: ShapeId }`, and a card's detail gains
  `conversationId` beside Plan's `shapeId`)
- Modify: `explore-engine.ts`, `explore-session.ts`; tests `explore-engine.test.ts` (`describe('cards')`),
  `apps/daemon/src/inbox/shape-permissions.test.ts` (one row)

- [ ] **Step 1: Write the failing tests:** a card raised through `start.observer.onWaitStart` while `running` →
  `waiting_card` and a `card` item naming the Inbox item; answered (`onWaitEnd`) → `running`; Stop while
  `waiting_card` → the card withdrawn, `stopping`; `ended: error` while `waiting_card` → withdrawn, `ended_error`. The
  inbox row: a card raised for a conversation owner carries `conversationId` and `shapeId` in its detail.
- [ ] **Step 2: Run them and watch them fail.** `pnpm --filter @10db/daemon exec vitest run src/conversation/explore-engine.test.ts src/inbox/shape-permissions.test.ts`.
  Expected: FAIL, a raised card leaves the state `running` and writes no `card` item, and the broker refuses a
  conversation owner.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and watch them pass**, then `make check-changed`.
- [ ] **Step 5: Commit** (`feat(daemon): a card an explore session waits on is a conversation item and a state`),
  value card: `Value: protects=a waiting card shows in the conversation, holds the state, and is withdrawn by Stop or an end; fails_when=a stopped turn leaves its card open or the state stays running; why_new=Plan only wrote a "waiting" line; no_claim=the kit's inline card (M5a)`.

---

### Task 14: The engine: at most four idle warm sessions

**Files:** `explore-engine.ts`; test `explore-engine.test.ts` (`describe('the warm cap')`)

- [ ] **Step 1: Write the failing tests** (Review Focus 3): five conversations each finish a turn, a minute apart →
  the first to go idle is closed when the fifth goes idle, with no notice; four running and one idle warm, then a
  sixth goes idle → only an idle one closes; the closed one resumes by its provider session id on its next message;
  an LRU close and a message to that conversation in the same tick → one handle at a time (call 24).
- [ ] **Step 2: Run them and watch them fail**, Task 9's command. Expected: FAIL, five idle sessions stay warm.
- [ ] **Step 3: Implement** with `warmToClose`.
- [ ] **Step 4: Run them and watch them pass**, then `make check-changed`.
- [ ] **Step 5: Commit** (`feat(daemon): at most four idle explore sessions stay warm`), value card:
  `Value: protects=idle warm sessions never pass four app-wide, a running one is never closed for the cap, and a close never races a new message; fails_when=a fifth idle session stays, a running one closes, or two handles open; why_new=Plan had no cap; no_claim=memory use per session`.

---

### Task 15: The engine: restart, clean close, "Send now" and read-back

**Files:**
- Create: `apps/daemon/src/conversation/explore-recovery.ts`, `explore-recovery.test.ts`
- Modify: `explore-engine.ts` (`recover`, `close`, `sendNow`). Its wiring into `daemon/start.ts` is Task 16's.

**Interfaces:**
- `recover()`: for each conversation whose profile is `explore`: end its live session rows (`daemon_restart`); apply
  rule 5 to its pushed, undelivered items (with `capabilities.readBack`, `adapter.readClientUuids` and
  `markItemsTakenUnder`; the rest `markItemsHandedBack`); write the interrupted notice for a conversation found
  `running`, `waiting_card` or `stopping` with no partial stored since its turn began (call 9); reduce
  `daemon_restart` with the queue counted after that; `send_now` writes one `turn_marker { marker: 'send_now',
  resolvedAt: null }` after the last item when none is open; a conversation found `paused_account` is remembered as
  restarted while paused. `close()`: detaches each handle's events (call 25), hands back pushed items (call 22),
  stores each runtime's partials, stops every handle, and leaves the states for `recover` to settle. `sendNow(id)`
  reduces `builder_message` and, only when the outcome starts, pushes or injects, resolves the marker
  (`updateItem`, `resolvedAt`); otherwise it throws `ConflictError` with call 17's words (call 29). A new builder
  message resolves an open marker the same way (call 12).

- [ ] **Step 1: Write the failing tests** (`explore-recovery.test.ts`, real SQLite). A restart is a second engine over
  the same store with **its own fake adapter and its own `ManualClock`**. A clean stop calls `close()` on the first
  engine; a crash drops the first engine without `close()`, its fake's handles left open in that fake only. One row
  per state of the restart row, each checking the state, the items, and that the second fake opened nothing:
  - `idle_warm` → `idle_cold`; `starting` with two queued → `idle_cold`, one `send_now` marker, nothing sent
    (Review Focus 4); `running` after a clean close → partial stored, `idle_cold`, Send now; `running` after a crash →
    no partial, the notice "The turn was interrupted when 10db stopped." (call 9), `idle_cold`, Send now;
    `waiting_card` with a queued message → the card withdrawn, the notice after a crash, `idle_cold`, Send now;
    `stopping` → `idle_cold`, the notice after a crash; `taken_over`, `paused_account` → stay; `ended_error` with a
    queued message → stays, under its one Send now line (no second marker).
  - Send Now → both queued messages sent, in `seq` order, in one turn; the marker resolved.
  - A new message instead of Send Now → the same, the marker resolved.
  - Send Now while `paused_account`, `taken_over` or `starting` → `ConflictError`, the marker still open (call 29).
  - Rule 5: a pushed message on an agent with `readBack` whose read-back holds its uuid → delivered, not re-sent; one
    without `readBack` → handed back, under Send now.
  - `paused_account` after a restart, then the reset passes → `idle_cold` and Send now, not a run.
  - `busy()` after a restart with messages under Send now → empty (call 28).
- [ ] **Step 2: Run them and watch them fail.** `pnpm --filter @10db/daemon exec vitest run src/conversation/explore-recovery.test.ts`.
  Expected: FAIL, `recover` is missing, so the second engine finds the states as left.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and watch them pass**, then `pnpm --filter @10db/daemon exec vitest run src/conversation test/crash-recovery.test.ts`
  and `make check-changed`.
- [ ] **Step 5: Commit** (`feat(daemon): explore conversations recover by the restart row and wait under Send now`),
  value card: `Value: protects=after a restart nothing spends tokens unattended, every waiting message is kept under one Send now, an interrupted turn says so, Send Now acts only when something can run, and a message Codex took is not sent again; fails_when=a queued message runs by itself after a crash, is lost, is delivered twice on read-back, or Send Now clears its line with nothing sent; why_new=Plan lost its queue at quit; no_claim=partial text after a crash, which memory cannot keep`.

---

### Task 16: Plan on the engine

**Files:**
- Create: `apps/daemon/src/shape/explore-owner.ts`
- Modify: `apps/daemon/src/shape/service.ts` (remove `Turn`, `Runtime`, `runtimeOf`, `onEvent`, `consume`, `start`,
  `closeLive`, `armIdle`, `runTurn`, `pump`, `interrupt`, `settled` and their constants, `:420-523`, `:528-560`,
  `:694-1505`; `send`, `propose`, `rehearse`, `stop`, `chooseModel`, `view`, `settled`, `turnsInProgress`
  (`engine.busy()` of Plan's conversations), `runningTurns`, `close` and Convert's hold call the engine),
  `shape/service-fixture.ts` (builds an engine), `daemon/start.ts:1246-1300` (one engine, `register('shape', …)`,
  `engine.recover()` before the API serves and `engine.close()` on stop beside `shape.close()`),
  `packages/db/src/store/shape-state.ts` (Plan's `send` writes its message queued, call 2),
  `sessions/types.ts` (`ExploreProfile.shapeId` removed, call 19), `sessions/fake-session.ts` (explore keyed by
  conversation, call 20)
- Rewrite: `apps/daemon/src/shape/held-turns.test.ts` (the restart rows through Plan)
- Modify: `apps/daemon/src/shape/research.test.ts:85-142` and `session-tools.test.ts:162` (call 14)
- Create: `docs/architecture/decisions/<today>-one-explore-engine-runs-sessions-and-plan.md`
- Modify: `apps/daemon/AGENTS.md` (the `conversation/` bullet gains the engine; the Shape bullets lose the turn
  engine), `packages/db/AGENTS.md` (the queue and the item events)
- Second commit: `packages/contracts/src/ids.ts` (M4a's `ShapeMessageId` and `ShapeFileId` aliases go) and their
  users, which name `ConversationItemId` and `ConversationFileId`

**Interfaces:**
- Consumes: Tasks 9–15.
- Produces: `createShapeOwner(deps): ExploreOwnerHooks` in `explore-owner.ts`: `spec` is today's `start` body
  (`service.ts:952-1290`) less the session row, the token and the handle, which the engine owns, and less the digest
  item, which the engine stores (Task 11); its never-spoke list of earlier builder messages takes them by position in
  the `seq`-ordered transcript, as M4a fixed `service.ts:1022`; `outgoing` is today's intake, budget,
  unreadable-image, `told` and `FRESH_START_LINE` logic (`:800-950`, `:1006-1013`, `:1352-1380`); `digest` is
  `buildDigest`; `onTurnEnded` is today's propose, empty-plan and rehearsal checks (`:1418-1445`), run for every
  `TurnEnd.how`, so a stopped Propose is told as today; `freshAtContextPct: 70`. `ShapeService`'s interface is
  unchanged. Propose and Rehearse write a `shape_event` with `prompt` (and `rehearsing`), queued, and call
  `engine.queued` (call 1). The hook no longer writes research, command, refusal or wait lines (call 14).

- [ ] **Step 1: Rewrite `held-turns.test.ts` first, red.** Its rows become, through `createServiceFixture` and its
  `restart()` (the real Plan, store and fake): a message queued while a turn runs, then a restart → no notice, no
  session, one Send now line, the message queued; Send Now sends it. The same for a queued Propose and a queued
  rehearsal. A message sent after `close()` → stored queued, not run, waiting under Send now at the next start. "Says
  nothing when the turn ran before the quit" stays.
- [ ] **Step 2: Run the shape suite and record the reds.** `pnpm --filter @10db/daemon exec vitest run src/shape`.
  Expected: FAIL in `held-turns.test.ts` only (the "never ran" notices). Note any other red: it is a behaviour the
  move must keep.
- [ ] **Step 3: Move Plan onto the engine** and wire it in `start.ts`. Then rewrite only what call 14 retires:
  `research.test.ts`'s first case asserts the stored `tool_call` items (a `subagent` call with the question as
  `promptPreview`, then `web` calls under its `parentId`), and its three refusal cases assert a `denied` call with
  the `deniedBy` and `refusal` the adapter set (on Claude, `deniedBy: '10db'` and the guard's reason; a Codex row, if
  one is added, `deniedBy: null`) where they matched `… · refused · …` lines (call 14); the `session-tools.test.ts`
  row asserts a `card` item in place of the "waiting for your answer" line. `tools.test.ts:96` and `files.test.ts:483`
  (lines Plan's own tools write) stay.
- [ ] **Step 4: Run them and watch them pass.**
  `pnpm --filter @10db/daemon exec vitest run src/shape src/conversation src/daemon test/crash-recovery.test.ts` and
  `make check-changed`. Every shape test other than those named above passes unmodified; `confinement.test.ts` too.
- [ ] **Step 5: Write the decision record.**

```markdown
# One explore engine runs Sessions and Plan

- **Date:** <today>
- **Amends:** `decisions/2026-11-02-shape-session-and-convert.md` (the session's lifecycle)

## Decision

- An explore conversation's live session belongs to the engine in `apps/daemon/src/conversation/`, which follows
  spec §6.7's state table as a pure reducer (`explore-state.ts`) and applies its effects one at a time per
  conversation. Plan plugs in through `ExploreOwnerHooks` (`spec`, `digest`, `outgoing`, `onTurnEnded`,
  `freshAtContextPct`); Sessions does too, from M5a.
- The queue is durable: a turn starter (a builder message, or a Plan `shape_event` with a `prompt`) is stored before
  anything is sent, and stays queued until a turn takes it. After a restart, or a turn that ended in an error, waiting
  messages wait under one "Send now" line; nothing runs unattended. This replaces Plan's "10db quit before Claude
  read…" notices.
- Stop interrupts; if the turn is not reported ended within 10 s (`STOP_GRACE_MS`), the session is stopped. What a
  turn streamed before an early end is stored, marked partial, and what the session held is handed back.
- A session stays warm 10 minutes after a turn; at most four idle sessions stay warm app-wide. Past 70% context, or
  when a resume fails, the next start is fresh from a stored digest.
- A rate limit or a cap pauses the conversation, with one notice and no card, and does not pause the account.
- A model pick reaches a warm session through `SessionHandle.setModel` at its next turn.
- Agent text and tool calls reach the UI as `conversation.delta` frames that are never stored; finished items are
  stored and announced by id. Full tool output, patches and bodies over 32 KB are kept under
  `<dataDir>/conversations/<id>/items/<itemId>/`.
- Plan's transcript is read through `/conversations/:id/items`; `ShapeViewDto.messages` is removed and
  `PROTOCOL_VERSION` is 9.

## Why

- One engine for Plan and Sessions, so the lifecycle, recovery and streaming are written and tested once (spec S4).
- A table that is total over states and events, tested cell by cell, leaves no hole for a stop, a card or a restart.
- Plan's in-memory queue lost messages at quit, and it ignored the interrupt receipt.
- A paused account belongs to its lanes; a chat waiting out a limit should not stop a project's work.
```

- [ ] **Step 6: Commit** (`feat(daemon): Plan runs on the explore engine`), naming every file but the alias change,
  with the value card: `Value: protects=Plan keeps every behaviour its suite pins on the shared engine, a message queued at quit waits under Send now, and the engine recovers and closes with the daemon; fails_when=a Plan turn, proposal check, picture budget or hold rule changes, or a queued message is lost; why_new=held-turns.test.ts pinned the old notices; no_claim=the UI (Task 18)`.
- [ ] **Step 7: Retire the Shape id aliases, in their own commit.** Remove `ShapeMessageId` and `ShapeFileId` from
  `ids.ts` and rename their users (`git grep -l 'ShapeMessageId\|ShapeFileId'`); `pnpm --filter @10db/contracts generate`
  leaves `generated/` unchanged; run the contracts, db, daemon and desktop typechecks, then commit
  (`refactor(contracts): retire the Shape message and file id names`).

---

### Task 16b: Plan in auto mode, with the web (trust line §8, §12)

Small red-first steps, one commit per behaviour. Calls 34 and 35.

**Files:**
- Modify: `apps/daemon/src/shape/explore-owner.ts` (`spec` reads `capabilities.judge` and T3's attended policy),
  `apps/daemon/src/sessions/claude-query-options.ts` and its test (the explore profile's auto-mode rows),
  `apps/daemon/src/shape/policy.ts` and `policy.test.ts` (the main session's tools), `apps/daemon/src/shape/confinement.ts`
  and `confinement.test.ts` (the rows the trust line retires), `apps/daemon/src/shape/research.test.ts` (the
  question limit and URL rows)
- Modify: `docs/architecture/decisions/<today>-one-explore-engine-runs-sessions-and-plan.md` (Task 16's record
  gains the bullets below)

**Interfaces:**
- Consumes: T3's `TrustPolicy` for an attended surface, its auto-mode settings and `capabilities.judge`; T2's setup.
- Produces: Plan's `spec` on a `native` judge: `permissionMode: 'auto'`, `settings.autoMode` from the policy,
  `WebSearch` and `WebFetch` in the session's own tools, `Bash` with background jobs allowed. On `rules`: today's
  spec, unchanged. Edit, Write and NotebookEdit stay disallowed on both.

- [ ] **Step 1: Write the failing options rows** in `claude-query-options.test.ts` (pure). M2a's row "never gives
  the explore profile project settings, auto mode or the harness plugin dir" splits:
  - explore with a `native` judge: `permissionMode: 'auto'` and `settings.autoMode` equal to T3's rendering of the
    attended policy, with `"$defaults"` first in each list
  - explore with a `rules` judge, and with a `tendb` one: `default` mode and no `settings.autoMode`, as today
  - both: `settingSources: []`, and never the harness plugin dir
- [ ] **Step 2: Write the failing Plan rows** in `shape/policy.test.ts` and `confinement.test.ts` (pure tables), on
  a `native` judge:
  - a `WebFetch` and a `WebSearch` from the main session are allowed, with no card
  - a command the read-only line doesn't pass is allowed to the judge, not answered `ask`
  - a background command (`run_in_background`, `&`, `nohup`) is allowed
  - an `Edit` or `Write` is still refused, and the refusal says Plan writes no code
  - the researcher's question, query and URL limits no longer refuse
  - on a `rules` judge and on a `tendb` one, every row keeps today's answer
  - Plan's sandbox keeps today's `.env` rule on every judge (call 34); T4 changes it

  Name each retired row of `confinement.test.ts` in the commit, and the trust line rule that retires it.
- [ ] **Step 3: Run them and watch them fail.**
  `pnpm --filter @10db/daemon exec vitest run src/sessions/claude-query-options.test.ts src/shape/policy.test.ts src/shape/confinement.test.ts`.
  Expected: FAIL, because the explore profile has no auto-mode branch and Plan's rules refuse the web and ask about
  commands.
- [ ] **Step 4: Implement.** `explore-owner.ts`'s `spec` asks the adapter's capabilities for the conversation's
  account and model and passes the judge to the profile. `claudeQueryOptions` renders auto mode for an explore
  profile on a `native` judge. `confinement.ts` drops the web, command-card and research-limit rules when the
  session's judge is `native`, and keeps the coordination rules, the read-only file rules and the `rules` floor.
  Background commands register with the lanes' process tracking, keyed by the conversation's session, and stop when
  it closes.
- [ ] **Step 5: Run Plan's suites and one pipeline row.**
  `pnpm --filter @10db/daemon exec vitest run src/shape src/conversation src/sessions` and `make check-changed`.
  Add one row to `research.test.ts`, through the service fixture on the fake: a Plan turn on a `native` account
  calls `WebFetch` from its own session and stores a `web` call, not denied.
- [ ] **Step 6: Extend the decision record:**
  - Plan's session runs in auto mode under the trust line's attended policy where its judge is `native`, and keeps
    today's rules where it is `rules`.
  - Plan's own session searches and fetches the web; its researcher is an option. Commands are judged, not carded,
    and may run in the background under the lanes' process tracking.
  - Plan writes no code. That is its role, and its sandbox stays read-only.
- [ ] **Step 7: Commit** (`feat(daemon): plan runs in auto mode with the web, where its judge is native`), with the
  value card: `Value: protects=Plan's own session searches the web and runs commands without a card on an auto-mode account, keeps today's rules elsewhere, and never edits; fails_when=Plan's web or commands still card on a native judge, a rules account loses a refusal, or Plan gains an edit tool; why_new=the options table and confinement rows pinned Plan's read-only, default-mode session; no_claim=auto mode's own verdicts (live check L2) or Codex (M5b)`.

---

### Task 17: The conversation routes

**Files:**
- Modify: `apps/daemon/src/api/app.ts`, `api/services.ts`; create `apps/daemon/src/daemon/conversation-services.ts`
- Test: `apps/daemon/src/api/conversation-routes.test.ts` (`app.request()` over a real store and engine)

**Interfaces:**
- Produces (spec §10): `GET /conversations/:id` → `ConversationDto`; `GET /conversations/:id/items?afterSeq=` →
  `ConversationItemsPage` (200 a page); `GET /conversations/:id/live` → `ConversationLiveDto`;
  `POST /conversations/:id/messages` (`PostConversationMessage`) → `ConversationItemDto`, dispatched by owner (a
  shape: `shape.send`); `POST /conversations/:id/send-now` (409 with the words when nothing would run, call 29),
  `/stop`, `/redo` (`PostConversationMessage`); `GET /conversations/:id/items/:itemId/full` → `ConversationFullDto`,
  404 when every field is null. The Plan routes these replace (`POST /shapes/:shapeId/messages`, `/stop`,
  `app.ts:518,564`) are removed in Task 18, with their callers.

- [ ] **Step 1: Write the failing tests:** each route's contract on a Plan conversation: items page by `afterSeq` with
  `nextAfterSeq`; `live` while a fake turn streams holds the in-flight text; a message posts and is queued; `stop`
  answers once the state is `stopping` or settled; `send-now` with no open marker, or while `paused_account`, is 409;
  `full` serves `output.txt` and `body.txt`; an unknown id is 404 everywhere; a task's conversation answers `GET` but
  refuses `messages` (409, its thread's routes stay until M4c).
- [ ] **Step 2: Run them and watch them fail.** `pnpm --filter @10db/daemon exec vitest run src/api/conversation-routes.test.ts`.
  Expected: FAIL, 404 on every route.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and watch them pass**, then `make check-changed`.
- [ ] **Step 5: Commit** (`feat(daemon): the conversation routes`), value card:
  `Value: protects=the UI reads items, live state and full output, and sends, stops, redoes and Send Nows through one set of routes for every explore owner; fails_when=a route answers another conversation's data, accepts a message for a task, or Send Now answers 200 with nothing sent; why_new=Plan's routes were shape-shaped; no_claim=chats (M5a)`.

---

### Task 18: Plan's UI on conversation items, with live frames

A vertical slice through the real daemon (`renderWithDaemon`), then e2e.

**Files:**
- Modify: `apps/desktop/src/daemon/events.ts:110-205` (`receive` parses `ConversationDeltaFrame` before
  `DaemonEvent`; a frame goes to the live store and never touches `lastSeq`; `INVALIDATIONS` gains `conversation`)
- Create: `apps/desktop/src/daemon/conversation-queries.ts` (`useConversation`, `useConversationItems`,
  `useConversationLive`, `useSendConversationMessage`, `useStopConversation`, `useRedoConversation`,
  `useSendNow`, `useToolCallFull`)
- Create: `apps/desktop/src/conversation/working-line.tsx`, `working-line.test.tsx` (call 15)
- Create: `apps/desktop/src/conversation/judge-line.tsx`, `judge-line.test.tsx` (call 36): one render row per judge
  value; only `rules` shows the line (T5 revisits `tendb`)
- Modify: Plan's transcript passes `onAllow` to `ConversationList` (call 37), with a render row: a soft `judge` row's
  Allow This posts the go-ahead once; a hard one shows no button
- Modify: `apps/desktop/src/conversation/conversation-list.tsx` (M3's): one prop, `busy?: boolean` (call 15). Plan
  passes M3's `agentLabel` from `conversation.capabilities.label`
- Modify: `apps/desktop/src/views/shape/plan-entries.ts` (M3's): `planEntries(messages)` becomes
  `planItemEntries(items: readonly ConversationItemDto[], live: LiveItems, sendNow: () => void):
  readonly ConversationEntry[]`, M3's table read by item: `message` → `builder`; `agent_message` → `reply` with its
  `partial`; `reasoning` → `reasoning`; a `tool_call` whose `harnessTool` is `10db.plan` → M3's tool-line rule
  (M3 call 2) over its `title`, any other → `tool` (the call as stored; M3 reads `call.deniedBy` and `call.refusal`
  itself, after its round-1 fix M3-1); a `notice` with text → `notice`, a `model_change` notice → `divider` "Now on
  {label} · {model}" (UI spec §7, call 32); `digest` and
  `shape_event` `edit` → nothing; `shape_event` `propose` → "You pressed Propose.", `rehearse` and `event` → its
  text, `screen` → `custom` `Screenshot`; `card` → nothing (Plan's `waiting-permissions.tsx` shows it); `plan` →
  `notice` "Made a plan · N steps"; an open `turn_marker` → `divider` "Send now" with the action **Send Now**. Live
  items follow, in first-seen order: text as `reply` (not partial), reasoning as `reasoning`, calls as `tool`
- Modify: `apps/desktop/src/views/shape/conversation-pane.tsx`, `transcript.tsx`, `heard-so-far.tsx`,
  `history-button.tsx` (read items), and `working-line.tsx` (removed; the kit's replaces it); `loadFull` maps a call
  id to its item and reads `/full`
- Modify: `packages/contracts/src/shape-view.ts:176` (`messages` removed, `conversationId` added),
  `protocol.ts` (9), `apps/daemon/src/shape/view.ts`, `api/app.ts` (the two Plan routes removed),
  `apps/desktop/src/daemon/shape-queries.ts`, `apps/desktop/AGENTS.md` (the Plan bullet)
- Modify: `apps/desktop/e2e/shape.spec.ts`, only these lines: the long-transcript test (`:195-300`) fulfils
  `GET /conversations/:id/items` instead of `GET /shapes/:id`, building 2,000 `ConversationItemDto` rows
  (`message` and `agent_message`, `seq` 1…2,000, ids derived as today) with the proposals' `sourceMessageIds` from
  them, and reads rows by M3's `[data-entry-id]` where it read `[data-message-id]` (`:225`, `:297`). The first-run,
  round, summary, convert and Why? assertions are unchanged.
- Test: `apps/desktop/src/daemon/events.test.tsx`, `apps/desktop/src/views/shape/shape-view.test.tsx`,
  `plan-entries.test.ts` (M3's table, one row per item kind and `shape_event` kind, plus a live reply and an open and
  a resolved "Send now"), `apps/desktop/src/conversation/working-line.test.tsx`

**Interfaces:**
- `WorkingLine({ conversation: ConversationDto; streaming: 'text' | 'reasoning' | 'tool' | null; tool?: string })`,
  outside the windowed list, words from the UI design: `starting` "Waking up the session…"; `running` "Working ·
  12 s", "Thinking…" while reasoning streams, "Writing…" while text streams, "Working · 3 min · reading `a.ts`" with a
  tool; `waiting_card` "Waiting for your answer above"; `stopping` "Stopping…"; `paused_account` "Paused: usage
  limit, resumes 3:40", or "Paused: the account's monthly limit" with no `pausedUntil`; idle and error states:
  nothing (the transcript says). Never a provider name.

- [ ] **Step 1: Write the failing tests.**
  - `events.test.tsx`: a frame does not move the cursor, and the reconnect URL still carries the last stored seq; a
    frame reaches `useConversationLive`'s data.
  - `working-line.test.tsx`: one row per state above, and no row's text contains "Claude" or "Codex".
  - `shape-view.test.tsx` (`renderWithDaemon`, a Plan conversation on the fake): a sent message shows at once; the
    reply streams (the transcript shows the partial text before `turn_complete`), then the stored reply replaces it
    with no doubled text; a tool call shows as a `ToolCallCard`; Stop shows "Stopping…" then nothing; a reconnect
    mid-reply refetches `/live` and shows the same text (Review Focus 1); a reconnect mid-command, after 10,000
    characters of output, refetches `/live` and goes on appending with no refetch loop (Review Focus 5); after a
    restart the Send now row sends the waiting message.
- [ ] **Step 2: Run them and watch them fail.** `pnpm --filter @10db/desktop exec vitest run src/daemon/events.test.tsx src/conversation src/views/shape`.
  Expected: FAIL, frames are dropped by `receive` and the kit has no `WorkingLine`.
- [ ] **Step 3: Implement**, then `pnpm --filter @10db/contracts generate`.
- [ ] **Step 4: Run them and watch them pass**, then `pnpm --filter @10db/desktop exec vitest run`,
  `pnpm --filter @10db/daemon exec vitest run src/api src/shape` and `make check-changed`.
- [ ] **Step 5: Click through.** `scripts/dev.sh` with `TENDB_FAKE_SCRIPTS="$PWD/apps/desktop/e2e/script-book.json"`
  (free) in light and dark: a Plan message streams; a tool call shows as a card; Stop mid-reply keeps the partial;
  quit the daemon mid-turn and start it, and the Send now row sends; no label names a provider. Then one turn on the
  builder's own Claude account (one turn, morning only) to see real streaming.
- [ ] **Step 6: e2e.** `pnpm --filter @10db/desktop e2e`. `shape.spec.ts` passes with only the lines listed in Files
  changed; `workbench.spec.ts` unmodified.
- [ ] **Step 7: Commit** (`feat(desktop): Plan streams its transcript from conversation items and live frames`), value
  card: `Value: protects=Plan shows a reply as it streams, swaps in the stored item without a flicker or doubled text, recovers a stream or a long command across a reconnect, and offers Send Now; fails_when=a frame moves the replay cursor, text doubles, a reconnect loops, or a state shows no line; why_new=Plan rendered finished messages only; no_claim=Sessions' tabs (M5a)`.

---

### Task 19: Review, gate, pull request

- [ ] **Step 1: Review.** Dispatch `code-reviewer` (opus) with this plan, Tasks 1–18 and the base commit; round 1,
  with the Review Focus. Fix blocking findings in one commit; round 2 checks only those and what the fixes broke.
- [ ] **Step 2: Gate.** `make gate` → `GATE PASS`.
- [ ] **Step 3: Pull request.** Push `feat/sessions-m4b`; open a PR titled
  `feat: one explore engine runs Plan, streaming with a durable queue`, its body naming the decision, the calls, the
  `PROTOCOL_VERSION` bump, the click-through and the e2e result.

---

## Review round 1: where each finding went

| Finding | Where |
| --- | --- |
| B1 (blocking) pushed, unconsumed messages stranded by a grace stop or a non-`turn_complete` end | Call 22; Task 10 (grace-stop row with an injected message); Task 12 (`ended: error` row with an injected message); Task 15 (`close` hands back) |
| B2 (blocking) a parked `start` stuck in `starting`, a parked `next_turn` in `running` | Call 23 (park before the reducer, `facts.queued` 0, one `builder_message` on release); Task 9 (hold rows, including a parked `next_turn`) |
| B3 (high) a message during a close opens a second handle | Call 24 (one effect chain per conversation; `start` awaits the previous `stop()`); Task 9 (idle timer and message in one tick); Task 14 (LRU close and message) |
| B4 (high) a late `turn_complete`, a `message` after `store_partial`, events during `close` | Call 25 (turn counter, `putItem`, `close` detaches); Task 5 (`putItem` rows); Task 10 (late `turn_complete` dropped); Task 15 (`close`) |
| B5 (high) `/live` tail versus absolute frame offsets | Call 26; Task 1 (`LiveItemDto.outputOffset`, `applyFrame` rows at 10,000); Task 3 (`outputOffset` in the snapshot); Task 18 (reconnect mid-command) |
| B6 (medium) a duplicate inside a coalescing window doubles text | Call 27; Task 3 (slice from the lowest changed offset; the duplicate-in-window row) |
| B7 (medium) Task 9 row 2 can't give two frames; `finish` with a pending frame | Call 27 (`finish` drops it); Task 3 (the `finish` row); Task 9 (row 2 asserts the stored item, the frame row advances the clock) |
| B8 (medium) `busy()` must count only live turn states | Call 28; Task 9 interface and hold row; Task 15 (`busy()` empty under Send now); Task 16 (`turnsInProgress`) |
| B9 (medium) `sendNow` resolves the marker when nothing runs | Call 29; Task 15 (`ConflictError` rows); Task 17 (409) |
| B10 (medium, spec) an interrupted notice after a crash | Call 9 (the words); Task 15 (`recover` and its crash rows) |
| B11 (medium, provider parity) a capped metered account loops | Call 6 (the per-kind table); Task 12 (one row per table row, the cap row with no loop); Task 18 (the cap's words) |
| B12 (medium) `ToolCallView.refusal` and `deniedBy` | Needs (M2c adds them); call 14 (the guard's refusals become denied calls with `refusal`); Task 16 Step 3 (the research tests); Task 18 (`deniedBy` on tool entries) |
| B13 (medium) `recover()` and `close()` wired in Task 16 | Task 15 Files (no wiring); Task 16 Files and Step 3 |
| B14 (medium) `waiting_card` Send now; `ended_error` with a queue; `on_turn_ended` on every end; archive's `interrupt` | Call 18; Reading the cells (`re-push` row, the archive rows); Rows beyond the table (§6.3, §6.4); Task 15 rows; Task 16 (`onTurnEnded` for every `how`) |
| B15 (low) the crash simulation | Call 21; Task 15 Step 1 (its own fake and clock; dropped without `close()`) |
| B15 (low) `shape.spec.ts` changes | Task 18 Files and Step 6 |
| B15 (low) digest and `FRESH_START_LINE` in one task each | Task 11 (the digest item) and Task 16 (`FRESH_START_LINE` in `outgoing`) |
| B15 (low) the `seq` fix in `explore-owner`; the alias removal in its own commit | Task 16 Interfaces and Step 7 |
| B15 (low) Redo with the original `stillQueued` | Call 30; Task 10 Redo row |
| B15 (low) drop `parked(id)` unless production calls it | Kept: Plan's view reads it for `waitingForUpdate` (call 23, Task 9 interface) |
| B15 (low) a failure reason in each red step | Tasks 9–15 Step 2 |
| A7 (from M4a) the 32 KB body cap needs an owner | Call 31; Task 8 (`capItemBody` and its rows); Task 9 (the engine writes through it) |
| A8 (from M4a) `insertItem({ id })` belongs where it has a caller | Call 3; Task 5 |

## Review round 2: where each finding went

| Finding | Where |
| --- | --- |
| `deniedBy` (must fix): M2c's enum is `builder` or `10db`, so a literal `'guard'` fails `ToolCallView` | Call 14 (the adapter's `tool_call` is stored as sent; the engine writes no `deniedBy`); Task 16 Step 3 (the research tests assert `'10db'` on Claude and `null` on Codex); Task 18 (the call passes through; M3 reads `deniedBy` itself; coordinator correction) |
| B1 gap (a): the stop-grace cell had no `run_queue` | Reading the cells (the stop-grace row adds `run_queue` when `facts.queued > 0`); call 22; Task 10's grace row names it |
| B1 gap (b): `ended: … unasked` with a handed-back message started nothing and showed no Send now | Call 18 and call 22; Rows beyond the table (§6.4); Task 12's unasked row with an injected message |
| Stop while parked must clear the parked mark | Call 23; Rows beyond the table; Task 10 row |
| Cross-plan: `agentLabel` | Task 18 Files (Plan passes `capabilities.label`) |
| Cross-plan: model-change notice | Call 32; Task 1 (the `notice` body union); Task 9 row; Task 18 (`model_change` → `divider`) |
| Cross-plan: `ConversationDto.costUsd` | Call 33; Task 1 (`costUsd` on the DTO); Task 9 row |
