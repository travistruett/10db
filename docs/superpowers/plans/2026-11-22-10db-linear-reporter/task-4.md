# Card 4: the run

**Spec:** "Reporter" › "When" (one reporter per task, 30 s, takes every pending row), "States" (running, failure,
fifth failure, daemon stops), "What it may do" (record through `report_linear_post`), "Where it runs" (a short
session of 10db's own, no repository write access, Efficient tier, 10db's tools and Linear only;
`report_linear_workspace` first).
**Track:** A, after cards 1-3. Card 2 must be merged in first.

## Files

- `apps/daemon/src/linear/reporter.ts` (new): `createLinearReporter(deps)` implementing `LinearReporter`, with its
  constants (index Interfaces).
- `apps/daemon/src/linear/reporter-owner.ts` (new): `reporterHooks(deps): ExploreOwnerHooks` for
  `ConversationOwnerKind.Reporter`.
- `apps/daemon/src/conversation/`:
  - `explore-hooks.ts` and `explore-session.ts`: an optional `ExploreLaunch.observeToolCall?(event)` that
    `explore-session.ts` calls for each `tool_call` event, beside `items.record(event)` (explore-session.ts:132).
  - `explore-engine.ts`: widen `register`'s `kind`. A Reporter conversation is left out of `busy()` (an update
    drain doesn't wait on it; a cut run leaves its rows pending) and out of the warm cap's count (it never evicts
    a builder's chat).
  - `conversation-services.ts` `ownerOf` refuses a Reporter conversation: the chat API never reads or writes one.
    `conversation-files.ts` gets its case.
- `packages/contracts/src/reporter-tools.ts` (new): `ReporterToolName`, the inputs from card 1, and the tool
  descriptions.
- `apps/daemon/src/mcp/server.ts`: a `reporterTools(deps, session)` branch beside `conversationTools`. It offers
  only to a session whose conversation is a Reporter's, and passes the token's session id.
- `apps/daemon/src/daemon/start.ts`:
  - Build the reporter.
  - **Register `reporterHooks` before `exploreEngine.recover()`** (start.ts:2943), so recovery cools a crashed
    reporter conversation like any other.
  - Call `reporter.start()` after recovery and `reporter.stop()` at shutdown, before the engine closes.

## How a run goes

1. **Pickup.** One timer per task, armed through the injected `Clock` at the task's earliest pending `due_at`.
   `start()` arms them from `pendingLinearPosts`, and `poke` re-arms one. When a timer fires and a run is already
   in flight for the task, it re-arms for after that run.
2. **Gate.**
   - If `reporterBlockedBy` gives a reason, drop the project's pending rows, refresh the Inbox card, and stop.
   - Re-read the sign-ins row for the project's account. On `LinearVia.None` with `unchecked: false`, fail the
     rows with the row's `note`. An unchecked row is a maybe and goes ahead, as `refuseSignedOut` treats it
     (`linear/bindings.ts`).
3. **Trigger.**
   - Get or create the task's Reporter conversation (owner id = TaskId, the project's account), with `unretire`
     if it was retired.
   - Mark the task in flight, post a fixed starter ("Report the pending Linear updates."), and call
     `engine.queued`.
   - The starter is only a trigger. A start that fails and hands it back merges two identical lines, which is
     harmless.
4. **Spec (`reporterHooks.spec(conv, start)`).** This is where the session id first exists:
   - `takeLinearPosts(pending rows of the task due now or earlier, start.sessionId)`, then build the
     `ReporterRun` (card 2) in memory under that session id.
   - The prompt is `reporterBrief(readReporterFacts(...))` from card 5 (until card 5 lands, a stub listing the
     rows), sent as the session's instructions or first message, whichever the spec takes for a fresh session.
   - The launch spec, named explicitly rather than copied from the chat's:
     - built-in tools `ToolSearch` only;
     - `agents: {}`, and no plugins or setup dirs (plugins carry hooks and servers);
     - `projectMcpServers: {}`, and `yourMcpServers` limited to the account's `mcp.linear.app` entries (the host
       test in `daemon/linear-sign-ins.ts`);
     - `claudeConnectors: true` only on a Claude plan whose Linear is a connector or unchecked;
     - Codex `webSearch: 'disabled'`, whatever the Web switch says. Codex's search runs at OpenAI with no hook
       call;
     - a read-only sandbox with no project stdio servers. Use `laneSandbox.forSession` with `writes` false, and
       don't run `createShapePreparer`, which starts the repo's servers and builds Plan's broker;
     - `preToolUse: (req) => reporter.verdict(sessionId, req)`, with no judge, no `judgeCall` and
       `canUseTool` deny.
   - The model is the account's Efficient tier, as `daemon/area-namer.ts` resolves it, through `describeModel`.
   - `keepsResume` returns false, and `digest` returns ''.
   - `observeToolCall` passes each Linear tool result to `reporter.observe`. Read `full?.output ?? resultTail`:
     Codex's MCP item has only a tail, which is enough for ids.
5. **Inside the run** (`reporter.ts`, by session id):
   - `observe` appends a successful result of `whoami`, `get_workspace`, `get_team` or `list_teams` to
     `run.identityResults`, and card 7's `prepare_attachment_upload` results to its own list.
   - `verdict` runs `reporterBlockedBy`. If blocked, it denies every Linear write. Otherwise it runs
     `judgeReporterCall`, and on `withheld` adds the pattern to `run.withheld`.
   - `reportWorkspace` runs `confirmWorkspace`:
     - `confirmed` sets `workspaceConfirmed`;
     - `not_seen` answers "Not seen in a Linear result yet: call get_workspace and get_team, then report again";
     - `mismatch` records the reason "This agent's Linear sign-in reaches <reported>, but the project is linked to
       <binding.workspaceName> / <teamKey>" and leaves writes refused.
   - `reportPost` refuses ids this session didn't take, and a withheld pattern not in `run.withheld`. A row
     dropped meanwhile is a no-op, not an error. Otherwise it calls `recordLinearPosts`, and the comment ids join
     `knownCommentIds`.
   - A session id with no run is refused, so a late call from a closed run writes nothing.
6. **Settle.** It runs once per run and is idempotent. It is triggered by `onTurnEnded`, by `onState` when an
   in-flight run's conversation leaves the busy states without a turn end (a start failure, a pause for the
   account, an end in error), and by the 15-minute deadline (which stops the conversation first).
   - Synchronously, in the hook: the run's taken rows still pending become withheld with the first pattern when
     `run.withheld` is non-empty. The rest fail with `failLinearPosts(..., dueAt = now + min(5 min ×
     2^(tries before this failure), 6 h), MAX_TRIES)` and the reason seen: the mismatch, "the session ended
     without recording", or the end's message.
   - Then drop the in-memory run and refresh the Inbox card (card 5).
   - **Off the effect chain** (`void engine.retire(id).then(() => rearm(taskId)).catch(log)`): the hook must not
     await `retire`, which awaits the chain the hook is on.
7. **`stop()`** cancels the timers, and leaves every row as it is, pending rows pending, per the "daemon stops"
   row. It never awaits the engine.

## State-table rows

These rows are handled here:
- pending: due → running; no Linear → failure; failure; fifth failure.
- running: a new event; workspace confirmed, not seen or mismatched; the `report_linear_post` refusals; the turn
  ends; a start failure or pause; no turn end within 15 min; the daemon stops.
- any: reporter off or trust off at pickup → dropped, and a running session's later writes refused.

## Tests

One file, `reporter.test.ts`, core (recovery and the queue). It runs on the real pipeline: the real store, the
explore engine with the fake adapter, and `ManualClock`. Two cases:
- **A pending row on a linked task runs after 30 s.** The fake session's script:
  - `get_workspace` and `get_team`, each with a scripted result containing the binding's ids;
  - `report_linear_workspace`;
  - a `save_comment` by issueId;
  - `report_linear_post`.

  The row is recorded with the comment id. A `save_comment` by the `AMP-1` identifier in the same script is
  denied.
- **A session that ends without recording** leaves the row pending with tries 1, due 5 min later. A new reporter
  on the same store (stop, then start) runs it again when the clock reaches that time.

If the fake adapter's `tool` step has no scripted `result`, add one, emitted on its `tool_call` event. The fake
adapter is already the boundary mock.

## Done when

The checks in Global Constraints pass. Your report confirms that a Reporter conversation appears in none of
`GET /chats`, search, Recent or the sidebar (grep their queries for `ownerKind`), and names what you checked.
