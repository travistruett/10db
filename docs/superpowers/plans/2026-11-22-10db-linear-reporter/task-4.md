# Card 4: the run

**Spec:** "Reporter" › "When" (one reporter per task, 30 s, takes every pending row), "States" (running, failure,
fifth failure, daemon stops), "What it may do" (record through `report_linear_post`), "Where it runs" (a short
session of 10db's own, no repository write access, Efficient tier, 10db's tools and Linear only;
`report_linear_workspace` first).
**Track:** A, after cards 1-3. Card 2 must be merged in first (it is pure and small).

## Files

- `apps/daemon/src/linear/reporter.ts` (new): `createLinearReporter(deps)` implementing `LinearReporter` (index
  Interfaces) and its constants.
- `apps/daemon/src/linear/reporter-owner.ts` (new): `reporterHooks(deps): ExploreOwnerHooks` for
  `ConversationOwnerKind.Reporter`, registered on the explore engine in `daemon/start.ts`. Widen
  `ExploreEngine.register`'s `kind` parameter to take Reporter.
- `apps/daemon/src/conversation/explore-hooks.ts` and `explore-session.ts`: an optional
  `ExploreLaunch.observeToolCall?(event)` that `explore-session.ts` calls for each `tool_call` event beside
  `items.record(event)`. It is how the reporter sees Linear's results on every provider. Nothing else uses it.
- `packages/contracts/src/reporter-tools.ts` (new): `ReporterToolName` (`report_linear_workspace`,
  `report_linear_post`), its input schemas from card 1, and its descriptions. `apps/daemon/src/mcp/server.ts`: a
  `reporterTools(deps, session)` branch beside `conversationTools`, offered only when the session's conversation
  is a Reporter's. The handlers call `reporter.reportWorkspace` and `reporter.reportPost` with the session id
  from the token.
- `apps/daemon/src/daemon/start.ts`: build it, `start()` after recovery, `stop()` at shutdown.

## How a run goes

1. **Pickup.** One timer per task, armed through the injected `Clock` at the task's earliest pending `due_at`.
   `start()` arms them from `pendingLinearPosts` and `poke` re-arms one. When it fires, the run is skipped if one
   is already running for the task.
2. **Gate.** If `reporterBlockedBy` (card 3) gives a reason, drop the project's pending rows and stop. If the
   project's account reaches no Linear (`LinearVia.None` in the sign-ins row, re-read), fail the rows with the
   row's `note`.
3. **Session.** Get or create the task's Reporter conversation (owner id = TaskId, on the project's account).
   `takeLinearPosts(rows, sessionId)`. Post the brief from card 5 as the turn's starter (until card 5 lands, a
   one-line stub naming the rows) and `engine.queued(conversationId)`.
4. **Spec (`reporterHooks.spec`).** Take the chat spec builder as the template (`chat/hooks.ts` spec and
   `daemon/shape-session-tools.ts` `createShapePreparer`), but build the reporter's own:
   - `projectMcpServers: {}`, and `yourMcpServers` limited to the account's Linear entries (hosts
     `mcp.linear.app`, the test in `daemon/linear-sign-ins.ts`).
   - `claudeConnectors` only when the account reaches Linear by connector.
   - A read-only sandbox (`writes` false).
   - The model: the Efficient tier for the account, as `daemon/area-namer.ts` resolves it, through
     `describeModel`.
   - `preToolUse: (req) => reporter.verdict(sessionId, req)`, with no judge and no `judgeCall`.
   - `observeToolCall` passes Linear results to `reporter.observe`.
   - The conversation's digest and resume: a reporter run never resumes. `keepsResume` returns false, and
     `digest` returns ''.
5. **The run's `ReporterRun`** (card 2) is held in memory by session id. `linearPrefixes` come from
   `linearToolPrefixes`, and `knownCommentIds` and `knownAttachmentUrl` from the task's recorded rows.
   - `observe` appends the result text to `seenResults`.
   - `reportWorkspace` checks that the ids equal the binding's and that both appear in `seenResults`. If so it
     sets `workspaceConfirmed`. If not, it marks the run failed with "This agent's Linear sign-in reaches
     <what it reported>, but the project is linked to <binding.workspaceName> / <teamKey>." and closes the
     session.
   - `reportPost` refuses ids this session didn't take, and a withheld pattern not in `run.withheld`. Otherwise
     it calls `recordLinearPosts` and adds the comment ids to `knownCommentIds`.
   - A session id with no run is refused: a late call from a closed run writes nothing.
6. **Settle (`onTurnEnded`, or the 15 min deadline, or the session ending).** Rows of the run still pending fail
   with `failLinearPosts(..., dueAt = now + min(5 min × 2^(tries), 6 h), MAX_TRIES)`. Use the reason seen: the
   workspace mismatch, "the session ended without recording", or the end's message. Then `engine.retire` the
   conversation, so the warm session and its token end, and `unretire` it for the next run. Drop the in-memory
   run and re-arm the task's timer. Card 5 refreshes the Inbox here.
7. **Startup.** A Reporter conversation left `running` by a crash is retired at `start()`. Its rows were never
   marked other than pending, so they are due now. Check what the explore engine's own recovery does for an
   owner with no `readBackSpec`, and make it leave Reporter conversations cold.

## State-table rows

pending / due → running; pending / no Linear → failure; running / new event; running / workspace match or
mismatch; running / `report_linear_post` refusals; running / the turn ends; running / no turn end in 15 min;
running / daemon stops; pending / failure and fifth failure; any / reporter off or trust off at pickup → dropped,
and a running session's later writes refused (`verdict` re-reads `reporterBlockedBy` per Linear write).

## Tests

One file, `reporter.test.ts`, core (recovery and the queue), on the real pipeline: the real store, the explore
engine with the fake adapter, and `ManualClock`. Two cases:
- **A linked task's pending row runs after 30 s.** The fake session's script calls `get_workspace` (its scripted
  result contains the binding's ids), `report_linear_workspace`, a `save_comment` on the linked issue, and
  `report_linear_post`. The row is recorded with the comment id. A `save_comment` on `AMP-2` in the same script is
  denied.
- **A session that ends without recording** leaves the row pending with tries 1, due 5 min later. A restart of the
  reporter (stop, then start on the same store) runs it again.

Extend the fake adapter's `tool` step with an optional scripted `result`, emitted on its `tool_call` event, if it
has none. The fake adapter is the boundary mock already, so this is not test-only code in production paths.

## Done when

The checks in Global Constraints pass, and your report names where the reporter's session shows up (or doesn't)
in `GET /chats` and the sidebar: it must not.
