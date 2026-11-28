# apps/daemon/src/inbox

- Two routes list cards. `GET /inbox` (`?state=OPEN,ANSWERED`, comma-separated `InboxState`s) answers every
  card in those states as an array, most urgent and then oldest first; notifications, Shape's waiting
  permissions and the daemon's own tests read it, and the Inbox's lists and the badge read the page route. `GET /inbox/page` (`InboxPageQuery`, served by
  `pageInbox` in `packages/db/src/store/inbox-page.ts`) answers one page, an `InboxPageDto` (`items`,
  `total`, `page`, `pageSize`), with filtering, sorting and counting done in the query; the Inbox's Open,
  Waiting and Resolved lists, its counts and the chat tab's resolved cards read it. A list that can grow without limit is read through the page route.
- `InboxPageQuery` is a strict object (an unknown key is a 400): `state` (`open`, `waiting` or `resolved`),
  `project`, `kind`, `outcome`, `person`, `sort` (`updatedAt`, `createdAt`, `kind`, `title`, `sentAt`), `dir`,
  `page` (from 1), `pageSize` (1 to 100, 25 by default), `after` (the last row's sort as JSON: the page
  after it), `q` (title or body contains it, ASCII case folded), `since` (Resolved only) and `card` (the
  page holds only that card's row). `after` refuses `page`, `sort` and `dir`; `card` refuses `after` and
  `page`; `since` refuses a state but Resolved; Open refuses `sort`, `dir`, `outcome` and `person`, since its order is fixed. Each refusal is a 400.
  - `open` is an `OPEN` card, answered grouped into rows (a pass's cards are one row): `total` counts rows,
    `rows` lists each row's key, sort and card ids, `items` holds the cards of the rows on the page, and
    `next` is the last row's sort for `after`. `waiting` is an `OPEN` card whose live send is `sent` with no
    `returnedAt`, under every connection; `resolved` is a `RESOLVED` card.
  - Waiting is per workspace, read at each request (`services.ts` passes
    `connectedTeams: slackConnections.connectedTeams()`): Open leaves out a sent, unreturned card whose send is
    in a connected workspace; a send in a workspace that is `refused`, `none`, `unreachable` or `checking`, one
    signed out, or any send with Slack off, stays in Open.
  - `outcome` follows `inboxOutcome` in contracts, in its order: a Slack answer (`answer.via` is `slack`), then
    10db's close (a `detail.resolution` that `CardResolution` accepts), then `answered` for the rest. The SQL
    is one `CASE` built from `CARD_RESOLUTION`, so change it and `inboxOutcome` together.
  - `person` keeps cards with a send to that person as a recipient; in Waiting, the send that is out now.
  - With no `sort`, Resolved is newest updated first, Waiting the longest out first (a card with no send
    last), and Open most urgent then newest. Ties go by id. A page past the last answers the last, with its
    own number in `page`.
- `GET /inbox/:id/context` answers an `InboxCardContextDto`: the last three `message` and `agent_message`
  items, oldest first, of the card's conversation (`inboxCardContext` in
  `packages/db/src/store/inbox-context.ts`). That is the conversation named by `detail.conversationId` when
  it exists, else the task's conversation of the first target's workstream, else none (`{ messages: [] }`).
  Tool calls and reasoning are left out. An unknown card is a 404.
- Open's rows are grouped in code (`openRowsPage`, `packages/db/src/store/inbox-open-rows.ts`) over the open
  cards' light columns, with `inboxRowKey` from contracts, not in SQL
  (`decisions/2026-11-17-the-daemon-groups-inbox-rows-in-its-code-and-the-browser-groups-nothing.md`).
- No index was added for the page, and search is `LIKE`: every page filters on `state` (`inbox_state_idx`) and the send subqueries
  use `stakeholder_sends_card_idx`. A `(state, updated_at)` index is for when resolved cards reach six figures.
- A screen's render token may read `/inbox/page` and `/inbox/:id/context` (`screens/render-access.ts`), as it reads `/inbox`; the app
  names the frame's project in the query.
- Every card has a tier (`CardTier` in `card-tier.ts`: `ask`, `notice`, `status`), and `decisions/2026-11-17-every-card-has-a-tier.md`
  says why. `FlagInput` requires `tier` (an `StoredTier`: a notice is never stored), `urgency` and `closesWhen`
  (`BY_ANSWER`, `{ by: 'event', when }` or `{ by: 'withdrawn', when }`); `flagCard` stores the urgency it is given,
  writes an event closer into `detail.resolvesWhen` on insert and on a refresh, and never throws for a missing tier
  (the contract is the compiler's). A new card builder declares its tier, urgency and `closesWhen`; a notice is
  posted, never flagged.
- A notice is `postNotice(ctx, NoticeInput)` (`notice.ts`; `InboxService.notice` for a caller with no write open): a
  `notice.posted` event appended in the caller's write, with the key cut by `fitNoticeKey` (200 characters, a
  readable head and a sha256) and the line and body by `fitNotice`. A task's notice is on entity `task` (it needs a
  `projectId`, or `InvalidNoticeError`), a project's on `project`, any other on `app`. It never counts, badges or
  notifies.
- `GET /activity/page` (`ActivityPageQuery`: `project` or `task`, not both, `q`, `after` a `seq`, `pageSize`) answers
  an `ActivityPageDto` from `pageActivity` (`packages/db/src/store/activity.ts`): notices newest first, a repeat of
  one key, project and task within 10 minutes folded into one row with a count (`groupNotices`). A project's page
  includes its tasks' notices. It reads the events table, so it needs no migration.
- At start `resolveNoticeCards` (`daemon/notice-sweep.ts`) resolves each open card of the 16 kinds that are notices
  now, one write each, with the reason `NOTICE_SWEEP_REASON`. A kind is matched by its raiser's fold key, and by title,
  body or option count where an ask shares the prefix. A new notice kind that replaces a card adds a row and a
  near-miss row to its table.
- A card whose `closesWhen` is `by: 'event'` is a condition card (a `by: 'withdrawn'` card keeps its Dismiss, as an answered one does): `flagCard` writes `detail.closesItself`
  (`CARD_CLOSES_ITSELF`), a repeat of it with the same fold key updates it in place (one that says what the card
  already says writes nothing), and `InboxService.answer` refuses a dismiss of it with `CardClosesItselfError`
  (409), since an option-less condition card is answered only by its closer. The Inbox offers it no Dismiss
  (`isDismissable` in contracts). A condition card with options still takes those answers.
  A condition card is only right when its closer cannot miss. Where the fix can be made somewhere the closer does not
  see, or the card can outlive its event (a repo MCP card, whose cause can be an environment variable or an AWS sign-in;
  a left-out card for a batch that is over), the card is `BY_ANSWER`, keeps its Dismiss, and may
  still carry the event closer by writing `[CARD_RESOLVES_WHEN]` into its own `detail`, so `resolveStaleCards` still closes
  it by itself. A ship-failure card is a condition card whose batch's abandon withdraws it (`shipFailureFoldKey`).
- `stall_cleared` closes a Stuck card once the stall sweep (`stalls/sweep.ts`) no longer finds the stall its
  `key` names.
- The three event closers are `update_installed` (`SelfUpdate.closeInstalled`, at start: a card whose commit is the
  running one or behind it), `branch_ready` (`resolveBranchReadyCards`, from the scheduler's `onBranchReady` and
  after Switch Back) and `mcp_config_changed` (`resolveMcpConfigCards`, on every repo MCP config read; a card
  carries `repoMcpHash` of `.mcp.json` and the hosts file at the project's own checkout, never a worktree's). Each goes through `resolveStaleCards`.
- A card that says where its fix is made carries `detail.opens` (`CARD_OPENS`, a `CardOpens`: a Settings section or a
  path on this Mac); the desktop draws it as a link beside the answers (`views/inbox/card-opens-link.tsx`).
- `repo-mcp-servers.ts` (`createRepoMcpServers`) is Settings › Trust's view of the repo's `.mcp.json` servers: `list`
  raises no card, and `set` answers the server's open approval card through `InboxService` (so `applyMcpApproval`
  writes and the card closes) or, with none open, records the same verdict itself. A hash that is no longer current is
  a `ConflictError`.
- A skipped-calls card (`closeFinishedSkippedCards`) closes when its task is done or abandoned; a later run of the task finishing makes it done. The calls it listed stay in the task's drawer, whose Run These Now (`POST /workstreams/:id/skips/run`, `runSkippedCalls`) makes the follow-up the card's answer makes. A finished task's run raises no card for its skips alone; a card that lists config the run wrote (`detail.listsConfig`) is raised and stays after the task is done, since that config waits on the builder's approval. It keeps Dismiss, also when it rides on a failed run's card.
- The precedent card (`precedent-card.ts`) is one card per project (`precedentFoldKey`). `refreshPrecedentCard`
  raises, rewords or resolves it, dropping every candidate whose key and scope have a `trust_precedents` row in any
  state, read inside its write. `applyPrecedentAnswer`: Approve writes `active`, Keep Skipping writes `declined`,
  Report writes nothing (the desktop copies the report); a kind that already has a row is left alone, and an
  unknown kind is a `ConflictError`. `precedent-service.ts` computes the candidates before it writes, so a slow
  refresh never re-offers an answered kind; it refreshes at start, open cards hourly, and on a doubt skip. Its
  routes are `GET /projects/:id/precedents`, `POST /projects/:id/precedents/answer` and
  `PATCH /projects/:id/precedents/:pid` (`daemon/trust-services.ts`). Run and Make Routine
  (`delivery/skipped-card.ts`) is offered only when every skip is a keyed doubt; it approves each kind in the
  follow-up's write, and `settleHashes` stores the runs hash after the commit. Nothing here writes a trust grant
  (`trust/AGENTS.md` says what a precedent can and can't do).
- Uses and conflicts (`hook-judge.ts`) count only a fresh verdict, never a cached one. An allow by precedent adds
  a use; a limit with `precedentConflict` adds a conflict, and at `PRECEDENT_CONFLICTS_MAX` (3) the row is paused
  and `onPrecedentPaused` raises the conflict card (`precedent-conflict:<id>`, with Keep, Edit and Remove; answered
  by `applyPrecedentConflictAnswer` in `onFlagAnswerInWrite`). A shown precedent whose runs changed since it was
  approved (`changedSince`) posts one notice per id and hash per session. The counts never fail the call. The shown
  precedent is in the verdict key, so approving, pausing or editing one judges its calls again.
- A card that asks nothing of the builder is a notice (`what-reaches-the-builder` spec §3): a write outside every
  claim to a path that is no guardrail (`watcher/AGENTS.md`), a flaky check (`prCards.flakyCheck`, key
  `flaky-check:<name>`; `resolveNoticeCards` closes an older open card of it), and a judge outage whose cause may clear
  alone, a timeout or a 5xx (`createJudgeOutageCard`, key `judge-outage`). No key, no credits, a 401 or 403 and an
  expired AWS sign-in are `hard` (`JudgeOutage.hard`): one card at once, even after a notice for a transient outage.
- Every card builder declares who decides it (`what-reaches-the-builder` spec §1, §3, §9; `card-decider.ts` in contracts):
  `FlagInput.decision` is `decidedByBuilder(BuilderOwns.X)` (one of the seven things the builder owns) or a rule,
  judge or stakeholder, and `flagCard` stores it as `detail.decider` and `detail.owns`. Open (`openRowsPage`) holds
  only builder cards, a card with no stored decider is the builder's, and `shouldNotifyOpened` pushes only a builder
  card; a builder card is never folded away or expired. `tests/repo/src/card-deciders.test.ts` fails when a card
  builder declares none. A card whose rule has not been built yet stays a builder card: moving a kind off the
  builder means posting a notice with a `NoticeDecision` instead, so it shows in Activity with who decided and its
  Undo (`undo: undoable`) or why it is final. `createActivityActions` (`activity-actions.ts`) serves Undo
  (`POST /activity/:seq/undo`, once per row) and Ask Me Next Time (`PUT` and `DELETE /activity/:seq/ask-next-time`):
  a project's asking rules sit in `app_settings` (`rules.asking`, read through `isRuleAsking`), and a raiser of a
  rule-decided notice checks it and raises a card instead when its rule is asking.
- A failed run's card in a batch carries `resolvesWhen: { event: 'batch_over', batchId }` (`flagFailedRun`, from the
  run's `batchId`), and `resolveOverBatchCards` (`delivery/stale-cards.ts`, at start and on every `batch.updated`)
  closes it once the batch's pull request merged, or the batch is closed or abandoned.
- An acceptance card's Accept and Drop are the builder's alone: `InboxService.answer` refuses them from any other `Answerer` (an agent over the API without the builder header, a rule), and its recommendation is always null. Unproven criteria go back for proof by rule with no card while the fix budget lasts (`acceptance/AGENTS.md`).
- A stray-write card could still be owned by a Failed run whose task is open (Retry), so it stays until the task finishes or is abandoned.
- A chat's command outside the sandbox (`judgeBash` with `sandbox.unsandboxed`) is a `chatOnce` ask: no stored rule, carried allowance or project grant answers it, and the card offers Allow once, `allow_chat` and Deny. Its body is only what the agent says, on one quoted line through `visibleLine`, and the warning; the command is `detail.summary`, and `UNSANDBOXED_DETAIL` marks the card, so the desktop shows the command in a block of its own and nothing in it can pass for 10db's text. The loop and pnpm cards, which show only their body in the Inbox, end with `commandParagraph(command)`: the command labelled, on one line with every hidden character shown, after 10db's text. `summary` and the `allow_chat` key stay the raw command. `allow_chat` remembers the exact tool and command in the broker's closure, so it ends with the session and is never a rule or a decision. Every yes calls `mayRun` again; a refusal denies. A conversation's denial text (`chatDenialMessage`) invites another way instead of saying not to retry. `withdrawStaleConversationCards` withdraws every open conversation permission and question card at start, before any session starts, since the call that raised each ended with the daemon.
- A remembered `allow_chat` call lasts for the turn, and only until the chat changes something or the checkout moves (decision `decisions/2026-11-26-a-chats-remembered-yes-outside-the-sandbox-lasts-for-the-turn.md`): the broker stores the session's change count (`sandbox.unsandboxed.changes(toolUseId)`, from `chat/hooks.ts`, which leaves out a Codex escalation's own sandboxed attempt and also moves at the turn's end and when another chat joins) and the checkout's state (`checkoutState`: HEAD and the changed and untracked files) under the key of the call and its cwd. A changed count or state asks again, and so does a state that can't be read; a yes given while the state can't be read is not remembered. `remembers` is false while something that can write the checkout shares it; a waiting chat and a closed pass waiting for its merge don't count.
- The card names the agent that asks (`sandbox.unsandboxed.agent`: "Claude says", "Codex says", and the `allow_chat` option's text). A Codex chat's sandbox escalation reaches the same `chatOnce` ask as a flagged `Bash` call (`sessions/codex-escalation.ts`).
- The out-of-moves card (`out-of-moves-card.ts`) asks Spend More Attempts, Change the Task or Drop It, and has no
  `detail.actions`. Its detail is `detail.outOfMoves` (`OutOfMovesDetail`: `kind`, `more`, `batchId`, `workstreamId`,
  and `outside` on a gate card). The shipper raises the gate's (`shipCards.outOfMoves`, for `gateFailureAction`'s
  `out_of_moves`); the runner raises a run's when its retries are used up (`flagFailed(..., outOfMoves)`), and
  recovery when its attempts are. A run's card keeps `BATCH_CARD_DETAIL` beside it, so `left-out-settle.ts` and the
  shipper's withdrawals still find it; `createBatchCardAnswers` ignores its labels. `createOutOfMovesAnswers` acts in
  `onFlagAnswer`: Change the Task without a note throws `InboxAnswerRefused`, so the card stays. The CI kind's
  answers live in `delivery/ci-stop.ts` (`createCiStopAnswers`): More and Change rerun the failed jobs and lift the
  stop, counting no fix made before the answer; Drop closes the pull request (`Gh.closePullRequest`), and a refused
  close raises the out-of-moves card again beside a card saying why.
- A flag answer whose own move closes the card (a retry cancels its run's cards, an abandon its batch's) is still
  recorded on it: `InboxService.answer` writes the answer to a flag `onFlagAnswer` closed instead of refusing it.
- A lane's stray write onto a guardrail path is a flag card with `detail.guardrailDiff` and the options Keep and Revert
  (`guardrail-card.ts`: the title, `GuardrailStrayChoice`, the options; `guardrail-diff.ts`: the capped diff).
  `applyTrustChoice` takes Keep as it takes Keep It. Revert is `createGuardrailAnswers(...).onAnswer`, called from
  `onFlagAnswerInWrite` in `daemon/start.ts`: it returns a job that runs once the answer commits, never inside the
  transaction, and records what it did in the answered card's note (`updateInboxItem`) or raises the card again
  (`changedSinceCard`, `trusted-writes.ts`) when the file changed or could not be put back. `home` is injected, the
  builder's home by default.
- A CI stop has its card or its pending notice, never neither, and replaces "Pull request checks failed":
  `stopCiFixing` (`delivery/ci-stop.ts`) withdraws the root's `prCardKey.checks` card in the stop's write, and
  `pr-watch` raises none while `ciStopped` is set. A stop at the limit or on an unchanged head shows the
  `ci-out-of-moves` notice, and `pr-watch` replaces it with the out-of-moves card in one write 30 minutes later; a
  missing log or a refused cut raises its card at once. `clearCiStop` lifts a stop and its notice before then. The
  `ci_out_of_moves.<root id>` setting holds the stop time, More's `ignoreFixesBefore`, Change's note (the next fix
  task opens with it) and Drop's `dropped`, which keeps the close's "pull request closed" card away; the write that
  records the merge or close deletes it, last. (Kept here: `delivery/AGENTS.md` is at its word budget.)
- A lane's proposal is routed in `proposal-task.ts` (`decisions/2026-11-27-a-lanes-proposal-is-routed-by-rule.md`):
  `planReviewRoute` turns `plan_review` on Core work into a step, `proposalFiling` lets a `prerequisite` past the size
  rule only, and `fileProposalByItself` files a prerequisite once, matched by its first description line. Each move
  posts a rule notice; a proposal that still cards says what it costs (`proposalCardBody`). Accepting a `plan_review`
  card marks the lane's Plan step as the automatic route does (`acceptPlanReview`); once that step has ended the answer
  is refused, since a yes could add nothing.
