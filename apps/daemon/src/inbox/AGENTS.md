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
- A stray-write card could still be owned by a Failed run whose task is open (Retry), so it stays until the task finishes or is abandoned.
- A chat's command outside the sandbox (`judgeBash` with `sandbox.unsandboxed`) is a `chatOnce` ask: no stored rule, carried allowance or project grant answers it, and the card offers Allow once, `allow_chat` and Deny. `allow_chat` remembers the exact tool and command in the broker's closure, so it ends with the session and is never a rule or a decision. Every yes calls `mayRun` again; a refusal denies. A conversation's denial text (`chatDenialMessage`) invites another way instead of saying not to retry. `withdrawStaleConversationCards` withdraws every open conversation permission and question card at start, before any session starts, since the call that raised each ended with the daemon.
- A remembered `allow_chat` call lasts only until the chat changes something: the broker stores the session's change count (`sandbox.unsandboxed.changes`, from `chat/hooks.ts`) and the call's cwd with the key, and a changed count asks again.
- The CI cap card replaces "Pull request checks failed": `stopCiFixing` (`delivery/ci-stop.ts`) withdraws the root's
  `prCardKey.checks` card in the stop card's write, and `pr-watch` raises none while `ciStopped` is set.
