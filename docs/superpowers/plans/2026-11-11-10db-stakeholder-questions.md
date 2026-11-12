# Stakeholder questions in Slack: slice 1 implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a lane's question on a task whose questions go to a stakeholder reaches them in Slack, and the
conversation in the thread answers the card: the task resumes with it, and an option a recipient picked or
approved is recorded as their decision.

**Architecture:** Question categories become six (Business added, Environment renamed Access). Routes gain goal
and task scope and topic routes; explicit routes choose a card's recipients by rule when the card is made, and
when none matches, a new judge decision (`question_route`) triages among the project's category and topic routes
right after the insert commits. A tie at one scope makes everyone matched a recipient. A routed card parks its
session at once and gets a draft send in the card's own transaction. A new `slack/` module is a thin `fetch`
client. A new `stakeholders/` module triages, composes, scans, sends and closes. Its reply watch reads each open
conversation from history on the injected clock: a lone recipient's reply is read by rule; a conversation with
others in it settles, a second judge decision (`thread_answer`) reads which option it landed on, and a recipient
approves it. Answers go through `InboxService.answerAs`, which records the send's answer in the same write. A
mention brings someone into a group DM. A reminder at 4 hours and a return to the builder at 8 hours run on
wall-clock time. The desktop gets Settings › People, Who Answers, a routed card preview with Ask Someone…, and the
Inbox's Waiting tab.

**Tech Stack:** TypeScript, Hono, Drizzle on SQLite, zod 4, React with Mantine 9, Vitest, Playwright, Tauri 2.
No Slack SDK in this slice.

**Spec:** `docs/superpowers/specs/2026-11-11-10db-stakeholder-questions-design.md`. Read all of it. The builder's
Slack setup is `docs/slack-app.md`; Slack facts with sources are
`docs/architecture/research/slack-stakeholder-questions.md`. The mockups are the canvas "Stakeholder questions in
Slack" (linked from the PR); where a mockup and the spec differ, the spec wins. The mockups predate triage, ties,
group DMs and the six categories; the spec's §6, §8.4–§8.6 and §10 cover those.

**How it is built:** one batch (one branch, one pull request), one commit per task. Outside 10db:
`git worktree add ../10db-worktrees/stakeholder-questions -b feat/stakeholder-questions origin/main`. Tasks 1–9
are the daemon, in order (2b may run beside 3 once 2 is in). Tasks 10–13 are views; once Task 9 is in, they can
run in parallel, each in its own worktree off the branch. Task 14 is last. It lands as one pull request: Tasks 13
and 14 carry the Board's "waiting on someone" line, DESIGN.md and the decisions that the Waiting tab and the
category rename need.

**Before the build (the builder):**

1. The stakeholders are in the builder's own workspace (spec §14.1): slice 1 sends DMs and group DMs inside it.
2. Make the Slack app and run "Check it before the build" in `docs/slack-app.md`, every step: the thread reply,
   the top-level reply, the group DM and the ✅ reaction. Paste the JSON of each step, with tokens and ids
   redacted, at the end of the research note. Tasks 8b, 8e and 8f assume a thread reply carries `user`, `ts` and
   `thread_ts`; a top-level DM reply appears in `conversations.history`; `conversations.open` with two users
   answers a group DM id (the check returned one starting `C`; nothing assumes a prefix) whose thread replies
   from both people read back the same way; and
   `reactions.get` on the bot's message lists `white_check_mark` with the builder's user id. Note whether
   `conversations.replies` itself carries a `reactions` array: if it does, Task 8f reads the ✅ from the replies it
   already has; if not, it calls `reactions.get` on the open proposal's `ts` once per tick. If any of the rest is
   false, stop and tell the builder.

## Building beside Sessions

The Sessions work (`../10db-worktrees/sessions-plan`, `docs/superpowers/plans/2026-11-12-10db-sessions-*.md`) runs
at the same time and touches some of the same files:

| File                                       | This plan                       | Sessions                                                     |
| ------------------------------------------ | ------------------------------- | ------------------------------------------------------------ |
| `apps/daemon/src/runner/runner.ts`         | Task 6, `onWaitStart` (~2289)   | M2b the lane spec (~2337); M2c the event switch (2535–2990) |
| `apps/daemon/src/inbox/service.ts`         | Tasks 3, 3b, 7a, 8a             | M4b conversation owners                                      |
| `apps/desktop/src/views/inbox/inbox-card.tsx` | Task 11                      | M5a Open Session                                             |
| `packages/db/drizzle/`                     | Tasks 2 and 2b take 0062–0064   | M4a renumbered here to 0065–0070, seeded from 0064            |
| `packages/contracts/src/protocol.ts`, `contracts.test.ts` | Task 2b takes `PROTOCOL_VERSION` 8 | M4b edited here to take 9                    |
| registrations (`app.ts`, `services.ts`, `start.ts`, `events.ts`, `schema.ts`, `sections.ts`, `sync.ts`) | additive | additive |

The order: this pull request and Sessions M1 run in parallel. Once M1 (Mantine 9.8) merges, rebase this branch on
`main` before the view tasks (10–13). This build merges before Sessions M4a and M4b start. The pull request that
carries this plan already edits the Sessions plans on `main` to match: M4a's migrations follow this plan's
(0065–0070, seeded from 0064) and M4b takes `PROTOCOL_VERSION` 9. If this build ends up merging after them
instead, it renumbers its own migrations and takes the next protocol version, and the Sessions plans go back. Don't extend the hand-typed
`codex-protocol.ts` (M1 replaces it); nothing here needs to.

## Global Constraints

- Read `AGENTS.md`, `.claude/rules/code-style.md`, `.claude/rules/testing.md` and the `AGENTS.md` of every
  directory touched (`apps/daemon`, `apps/desktop`, `packages/db`, `packages/contracts`).
- Migrations are forward-only (`v0.1.0` is tagged; `packages/db/AGENTS.md`): change `packages/db/src/schema.ts`,
  run `pnpm --filter @10db/db generate`, and commit the generated file. Never edit `packages/db/drizzle/` by
  hand. A change that adds columns and a CHECK to an existing table is two generates (columns by `ALTER`, then the
  CHECK's rebuild), as 0039 and 0040 were. Task 2b's rename of stored values is the one hand-written
  `drizzle-kit generate --custom` migration: written once, never changed.
- Contract changes are additive, with one exception: Task 2b drops the `environment` category, which narrows
  the contract, so it bumps `PROTOCOL_VERSION` from 7 to 8 and records a decision (`packages/contracts/AGENTS.md`).
  Nothing else is narrowed (`PersonInput` keeps `handle`; `InboxItemDto.assignee` stays). New DTOs are
  registered in `CONTRACT_SCHEMAS`, and generated files are regenerated, never edited by hand.
- Tests and the gate never reach Slack or OpenRouter. `slack/` takes an injected `fetch` and `Clock`, and so does
  the judge. `DaemonOptions.slack` is off unless given. `TENDB_SLACK=off` is set by every launcher of a throwaway
  daemon, and `tests/repo/src/benchmarks-off.test.ts` checks it (Task 4).
- The Slack token lives only in the Keychain, account `slack-bot`. It never appears in a log line, an error
  message, the database, an event or a DTO.
- Only `question` cards are routed or sent. "Park the task" never reaches Slack, and a Slack reply can never
  choose it.
- Every string from a card or from Slack (a person's name) that reaches Slack goes through `escapeMrkdwn`, in a
  `verbatim: true` text object, in a post with `unfurl_links: false` and `unfurl_media: false`. The only mentions
  10db posts are its own, built from stored user ids.
- Time comes from the injected `Clock`. No `Date.now()` and no `setTimeout` in logic. The reminder and the
  return are wall-clock durations from the send, so a clock jump past them fires them once.
- Copy is the spec's, verbatim, where the spec gives it (§6.1, §7.2, §8.1, §8.3–§8.6, §10). Buttons are Title
  Case, labels sentence case, counts a `CountBadge` (DESIGN.md).
- No TypeScript `enum`, no `any`, no `as` outside a validated boundary, no non-null `!`, no versions in names,
  and no grab-bag modules. Branded IDs come from the ID module: new prefixes `pcn_` (contact) and `snd_` (send).
- Commits are Conventional Commits, single-quoted, naming every path: `git add a b && git commit -m '...'`. Each
  newly tested behaviour carries one value card in the commit that adds it; the cards below are those.
- Per task, run only the changed packages' tests, typecheck and lint. A lane in 10db leaves `make gate` to 10db;
  a session outside 10db runs it once, in Task 14.

## Defaults this plan pins

| Default                         | Value                                                     | Task         |
| ------------------------------- | --------------------------------------------------------- | ------------ |
| New questions a day, per person | 10, or off (`dailyLimit: null`); only a new thread counts | 1, 2, 7b, 10 |
| Remind after                    | 4 hours, or off                                           | 1, 8d, 10    |
| Back to you after               | 8 hours                                                   | 1, 8d, 10    |
| A conversation settles after    | a letter and a quiet tick, or 30 minutes quiet            | 5            |
| Triage and `thread_answer`      | on, `typesafe/jev-1.13`, floor 0.8 (the judge's defaults) | 1, 3b, 8f    |
| Ticked for a new stakeholder    | Product, Design, Business                                 | 11, 13       |

## Test strategy

- Pure rules (compose, escape, scan, read a reply, which messages count, mentions, settling, approval,
  disagreement, choose recipients from rows, triage options and their fallback, the timers) are table-driven pure
  tests, one named row per case. They are nearly free; be generous with rows.
- Store functions use a real SQLite file (`createTestStore`).
- The Slack client is tested against a fake `fetch` (the network is a boundary): real request shapes, and reply
  bodies copied from Slack's method pages and the builder's live check. The judge is faked at its `fetch` in the
  engine and as a `Judge` in store-level tests (it is a boundary to OpenRouter).
- `createTestEngine` (`apps/daemon/test/engine.ts`) gains the stakeholder service and its watch, wired as
  `start.ts` wires them, with a fake Slack `fetch` and a fake OpenRouter `fetch`. Use the engine only for what
  needs the parts together: the loop, restarts, races and clock jumps. Those rows stay on that rung even though
  they repeat.
- Desktop components use `renderWithDaemon`. Playwright (Task 14) covers only what jsdom can't, without Slack.
- Don't grow `runner.test.ts`: new runner cases go in `apps/daemon/src/runner/routed-wait.test.ts`.

## Review Focus

1. **A message from someone outside the conversation, the bot's own message, or a reply to an earlier question in
   the same thread answers the card; or a ✅ from someone who isn't a recipient approves it.** Only participants'
   messages after the question's own `ts` count, in a thread with follow-ups a reply answers the newest, and only
   a recipient's pick or approval writes a decision. Pinned in Tasks 5, 8b and 8f.
2. **The Mac sleeps overnight with three sends open; on wake every reply is picked up once, none twice, including
   across a crash between reading and answering; a reminder and a return that came due during sleep each fire
   once.** Pinned in Tasks 8b and 8d.
3. **The builder answers in the Inbox at the moment a reply or approval is read.** The first answer wins; the
   other is a no-op, there is no second resume, and nobody is told "Travis answered this one" about their own
   answer. Pinned in Tasks 7c, 8b and 8f.
4. **Agent text holds `<!channel>`, `<@U123>`, `<https://x|y>` or a bare `https://…`.** It reaches Slack as plain
   text that neither pings, links nor unfurls; a URL holds the send. Pinned in Task 5.
5. **Identical questions on two tasks routed to different people.** Two cards, two sends; one reply never answers
   both. A card triaged elsewhere still folds an identical ask. Pinned in Tasks 3 and 3b.
6. **The token is revoked while sends are open, and someone replies during the outage.** A 10db card says so, the
   cards show in Open, and after reconnecting the reply answers its card once. Pinned in Task 8c.
7. **Mark answers "D" when the lane gave three options.** D is not Park: it reads as his own words. Pinned in
   Task 5.
8. **Two recipients disagree, or one approves while the other pushes back in the same tick.** No decision is
   recorded; the card is in the builder's Open with the conversation. Pinned in Task 8f.
9. **A mention moves the question to a group DM, and a reply then arrives in the old DM thread.** It still
   counts, once. Pinned in Task 8e.
10. **Triage times out, or the judge answers a route that no longer exists.** The lane's tags decide; nothing is
    routed to a stale route. Pinned in Task 3b.

---

### Task 1: Contracts

**Files:**

- Modify: `packages/contracts/src/team.ts` (people, contacts, scoped and topic routes, timers),
  `packages/contracts/src/entities.ts` (`InboxItemDto.send`, `assignees`, `routedBy`, `routeSuggestion`,
  `RecordedAnswer`), `packages/contracts/src/states.ts` (`SendState`, `SendMode`, `ContactKind`,
  `SourceKind.SlackReply`, `RoutedBy`), `packages/contracts/src/judge.ts` (`JudgeDecision.QuestionRoute`,
  `JudgeDecision.ThreadAnswer`), `packages/contracts/src/events.ts`, `packages/contracts/src/mcp-tools.ts`
  (`ask_human.topic`, `ContextPack.pendingAnswer`), `packages/contracts/src/json-schema.ts` (`CONTRACT_SCHEMAS`),
  the ID prefixes' module (`PersonContactId` `pcn_`, `StakeholderSendId` `snd_`),
  `apps/desktop/src/views/knowledge/knowledge-labels.ts` (a label for `slack_reply`) and
  `apps/desktop/src/views/settings/decisions-section.tsx` (labels for the two decisions), so the exhaustive
  switches stay green
- Create: `packages/contracts/src/slack.ts`; export it from `src/index.ts`
- Test: `packages/contracts/src/contracts.test.ts` (extend), `packages/contracts/src/judge.test.ts` (extend)

**Interfaces:**

- Produces:
  - `SendMode = { Review: 'review', Auto: 'auto' } as const`; `ContactKind = { Slack: 'slack' } as const`.
  - `SendState = { Draft: 'draft', Sending: 'sending', Sent: 'sent', Answered: 'answered', Closed: 'closed', Failed: 'failed' } as const`.
  - `RoutedBy = { Rule: 'rule', TriagePending: 'triage_pending', Judge: 'judge', Builder: 'builder' } as const`.
  - `SlackContactDto = { teamId: string; userId: string; dmChannelId: string | null; sendMode: SendMode; dailyLimit: number | null }`
    (`dailyLimit` an integer 1–100, default 10; `null` is off).
  - `StakeholderTimersDto = { remindAfterHours: number | null; returnAfterHours: number }` (remind 1–72 or null,
    default 4; return 1–168, default 8), stored as an app setting like the judge's config. A refinement refuses
    `remindAfterHours >= returnAfterHours`.
  - `PersonInput` stays `{ handle, name }` and gains `slack: SlackContactInput | null` (optional, default null);
    `SlackContactInput` omits `dmChannelId`. `PersonDto` gains `slack: SlackContactDto | null`, defaulting to null
    on parse.
  - `RoutingRuleInput` gains `goalId: GoalId | null`, `taskId: TaskId | null` and `topic: string | null` (1–120
    characters), all defaulting to null, and `category` becomes nullable. The rules ("exactly one of `category`
    and `topic`", "a topic has no `goalId`, `taskId` or `area`", "at most one of `goalId` and `taskId`", "no
    `area` with `taskId`") are a refinement on `RoutingRulesInput` (the list), with the duplicate rule over
    `(goalId, taskId, category, topic, area, personId)`; the same category at one scope for two people is allowed
    (a tie). `RoutingRuleDto` extends the unrefined object; check `.extend` against zod 4.6.7, which refuses to
    extend a refined object.
  - `JudgeDecision` gains `QuestionRoute: 'question_route'` and `ThreadAnswer: 'thread_answer'`, read with
    `shapeDecision()`'s defaults when a stored config lacks them, in `JudgeConfig`, `DEFAULT_JUDGE_CONFIG` and
    `JudgeConfigPatch`.
  - `ask_human` gains `topic: z.string().max(120).optional()`, described as "One of the project's topics from your
    briefing, when the question is about one".
  - `OutboundHit = { pattern: string; line: number; severity: 'hold' | 'warn' }`.
  - `SendPersonDto = { personId: PersonId | null; userId: string; name: string; recipient: boolean }`.
  - `StakeholderSendDto = { id; inboxItemId; state: SendState; people: SendPersonDto[]; text: string; hits: OutboundHit[]; permalink: string | null; sentAt: string | null; remindedAt: string | null; answeredAt: string | null; returnedAt: string | null; returnedReason: 'timer' | 'disagreed' | null; heldBy: 'review' | 'first_send' | 'limit' | 'scan' | null; proposal: { choice: string; confidence: number } | null; askedWhichWay: boolean; conversation: { userId: string; name: string; text: string; ts: string }[]; reply: { text: string; userId: string; ts: string } | null; replyVia: 'thread' | 'top_level' | null; readAs: 'option' | 'own_words' | 'approved' | null; answeredBy: PersonId | null; error: string | null }`.
  - `InboxItemDto` gains `send: StakeholderSendDto | null`, `assignees: string[]` (handles in routing order;
    `[assignee]` on parse when absent), `routedBy: RoutedBy` (default `rule`) and
    `routeSuggestion: { personIds: PersonId[]; confidence: number } | null`, all optional on parse.
  - `RecordedAnswer = InboxAnswer.extend({ answeredBy: z.string().optional(), via: z.enum(['inbox', 'slack']).optional(), words: z.string().max(20000).optional(), with: z.array(z.string()).optional() })`.
    `InboxItemDto.answer` becomes `RecordedAnswer | null`. The HTTP answer body stays `InboxAnswer`, whose parse drops
    unknown keys.
  - `ContextPack.pendingAnswer` gains `answeredBy: string | null`, `via: 'inbox' | 'slack'`, `words: string | null`
    and `conversation: { name: string; text: string }[]`.
  - `SlackConnectionDto = { state: 'off' | 'none' | 'connected' | 'refused' | 'unreachable'; teamId; teamName; botUserId; checkedAt; error }`
    (all but `state` nullable).
  - `SlackMemberDto = { userId; teamId; name; realName; title: string | null; email: string | null; avatarUrl: string | null }`.
  - `SendInput = { text?: string; overrideLimit?: boolean }` (text max 3000; `overrideLimit` is Send Anyway). `AskSomeoneInput = { personIds: PersonId[] (1–8); always: { categories: QuestionCategory[]; goalId: GoalId | null; taskId: TaskId | null } | null }`.
  - `QuestionRouteDto = { category: QuestionCategory | null; topic: string | null; people: PersonDto[]; from: 'task' | 'goal' | 'area' | 'project' | 'topic' }`.
  - Events: `person.removed`, `stakeholder_send.changed`, `slack.connection.changed`,
    `stakeholder_timers.changed`, and `inbox.triaged` (`{ routedBy: RoutedBy; toBuilder: boolean }`)
    (`person.saved` exists).

- [ ] **Step 1: Write the failing tests** in `contracts.test.ts`: `RoutingRulesInput` refuses a row with both ids,
      a row with `taskId` and an `area`, a row with both a category and a topic, a row with neither, a topic row
      with a `goalId`, and two identical rows; accepts the same category at project and goal scope, and the same
      category at one scope for two people; `InboxAnswer.parse({ choice: 'B', answeredBy: 'mark' })` has no
      `answeredBy`; `InboxItemDto` and `PersonDto` parse payloads without `send`, `assignees` and `slack`, and an
      old `InboxItemDto` gets `assignees: [assignee]`; `PersonInput` without `slack` parses; a contact with
      `dailyLimit: null` parses and one with 0 doesn't; `StakeholderTimersDto` defaults to 4 and 8, and refuses a
      reminder of 8 hours with a return of 8; `SlackConnectionDto` accepts `unreachable`. In
      `judge.test.ts`: a stored config without the two new decisions reads with their defaults, and the patch
      accepts each.
- [ ] **Step 2: Run** `pnpm --filter @10db/contracts test`. Expected: FAIL on the missing fields.
- [ ] **Step 3: Implement** the schemas, register them, regenerate the generated files, add the desktop labels.
- [ ] **Step 4: Run** the contracts tests and `pnpm -r typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(contracts): people with a slack contact, scoped and topic routes, and stakeholder sends`.

`Value: protects=a client can't answer as someone else, old payloads and judge configs still parse, and a route names one category or one topic; fails_when=answeredBy survives the HTTP parse, a payload without send is refused, or a route holds both; why_new=no contract has these fields; no_claim=that anything uses them`.

### Task 2: Storage

**Files:**

- Modify: `packages/db/src/schema.ts` (`person_contacts`, `stakeholder_sends`, `stakeholder_send_people`,
  `routing_rules.goal_id`, `task_id` and `topic` with `category` nullable and their CHECK, `inbox_items.assignees`,
  `rule_assignees`, `routed_by` and `route_suggestion`), `packages/db/src/store/team.ts` (`insertPerson` takes the
  contact; `updatePerson`; `removePerson`), `packages/db/src/store/routing-rules.ts`, `packages/db/src/store/inbox.ts`
  (`toDto` joins the send and its people; `setInboxRecipients`), `packages/db/src/store/goal-removal.ts`
  (`removeDraftGoal` deletes the goal's routes), `packages/db/src/index.ts`
- Create: `packages/db/src/store/stakeholder-sends.ts`, `packages/db/src/store/stakeholder-timers.ts`, two
  generated migrations (columns, then the CHECK)
- Test: `packages/db/src/store/stakeholder-sends.test.ts`, `packages/db/src/store/team.test.ts` (extend),
  `packages/db/src/store/goal-removal.test.ts` (extend)

**Interfaces:**

- Consumes: Task 1.
- Produces (synchronous, over `DbReader` or `WriteContext`; each write emits its event):
  - `insertPerson(ctx, input: PersonInput)` and `updatePerson(ctx, id, input)` write the contact too (`dailyLimit`
    null stored as null); `removePerson(ctx, id)` refuses the builder, a goal's owner, a person on a goal criterion
    and a person a route names (`ConflictError` naming which), and deletes their `team_members` rows;
    `listPeople(db)`; `setDmChannel(ctx, personId, channelId)`; `getDmCursor(db, personId)` and
    `setDmCursor(ctx, personId, ts)`; `markTopLevelNudged(ctx, personId, at)` (sets the contact's
    `topLevelNudgedAt` once; answers whether it was already set).
  - `getStakeholderTimers(db)` and `setStakeholderTimers(ctx, input)` over the app settings, as
    `store/judge-config.ts` does.
  - `setInboxRecipients(ctx, id, { assignees, routedBy, suggestion })` writes `assignees`, `assignee`
    (`assignees[0]`, or the builder when empty), `routed_by` and `route_suggestion`, emitting `inbox.changed`.
  - Sends: `insertDraft(ctx, { inboxItemId, recipients: PersonId[], text, hits })` (unique per card; one
    `stakeholder_send_people` row per recipient); `updateDraft(ctx, id, { text, hits })`;
    `markSending(ctx, id, { textSha256, threadTs: string | null, startedAt })`;
    `markSent(ctx, id, { channelId, threadTs, messageTs, permalink, at })` (sets `lastReadTs = messageTs` and
    `waitStartedAt = at`); `setHeldBy(ctx, id, heldBy)`;
    `markSettled(ctx, id, throughTs)`; `markAskedWhichWay(ctx, id, { at, ts, throughTs })`;
    `markApprovalSeen(ctx, id, { at, by } | null)`;
    `moveSend(ctx, id, { channelId, threadTs, messageTs, permalink, added: SendPersonInput[] })` (keeps the old
    channel and thread as `moved_from` with its cursor); `addPeopleToSend`; `markReminded(ctx, id, at)`;
    `setProposal(ctx, id, { choice, confidence, ts } | null)`; `markAnswered(ctx, id, { reply, readAs, answeredBy, replyVia })`;
    `closeSend(ctx, id, reason: 'builder' | 'taken_back' | 'cancelled')`; `failSend(ctx, id, error)`;
    `markReturned(ctx, id, reason: 'timer' | 'disagreed')` and `keepWaiting(ctx, id, at)` (clears the return and
    the reminder, and restarts both timers from `at`); `dropDraft(ctx, id)`.
  - Reads: `sendForCard(db, inboxItemId)`; `openSends(db): OpenSendRow[]` (state `sent`, with people, channel,
    thread, `messageTs`, `lastReadTs`, `movedFrom`, `sentAt`, `waitStartedAt`, `remindedAt`, `returnedAt`,
    `proposal`, `settledThroughTs`, `askedWhichWayAt` and its `ts`, `approvalSeenAt` and `approvalBy`); `sendsInThread(db, channelId, threadTs)`;
    `latestThreadFor(db, recipients, taskId): { channelId; threadTs; reviewed: boolean } | null`;
    `newThreadsSince(db, personId, since): number` (sent new threads only: a failed send, a follow-up, a move or a
    line 10db posts in a thread never counts); `everSent(db, personId): boolean`; `sendingSends(db)` (with `threadTs` and
    `startedAt`).
  - Each move is guarded. `markSending` only from `draft`, `markSent` only from `sending`, `moveSend`,
    `markReminded`, `setProposal` and `markAnswered` only from `sent`, `closeSend` from `draft`, `sending` or
    `sent`, `failSend` from `sending` or `sent`, `markReturned` and `keepWaiting` only on `sent`. Anything else
    throws `ConflictError` and writes nothing.
  - `setRoutingRules(ctx, projectId, rules)` replaces every scope's rows, as today, and refuses a `goalId` or
    `taskId` from another project.

- [ ] **Step 1: Write the failing tests**: a table over every `(from state, move)` pair for sends (allowed moves
      land; the rest throw and leave the row unchanged); `markSent` sets the cursor to the message's own `ts` and
      `waitStartedAt`; the settle, which-way and approval marks round-trip; a failed send isn't counted by
      `newThreadsSince`;
      `moveSend` keeps the old thread as `moved_from`; `newThreadsSince` counts a new thread once per recipient and
      never counts a follow-up, a move or a reminder; a contact with `dailyLimit` null round-trips; the timers
      read 4 and 8 with nothing stored and round-trip; `keepWaiting` clears `remindedAt` and `returnedAt`;
      `removePerson` refuses each of its four cases and deletes team rows; goal-, task- and topic-scoped routes
      round-trip; `setRoutingRules` refuses another project's goal; the CHECK refuses both ids, both a category and
      a topic, and a topic with a goal (raw SQL); `removeDraftGoal` with a goal route removes it;
      `setInboxRecipients` with two handles sets `assignee` to the first.
- [ ] **Step 2: Run** `pnpm --filter @10db/db test -- stakeholder-sends team goal-removal`. Expected: FAIL.
- [ ] **Step 3: Implement**, then generate the two migrations.
- [ ] **Step 4: Run** the db tests and typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `feat(db): person contacts, stakeholder sends, and goal, task and topic routes`.

`Value: protects=a send moves only along its states, the daily limit counts only new threads, and people and routes stay consistent; fails_when=a reply or close lands on a finished send, a follow-up counts toward the limit, or removing a goal or person breaks a foreign key; why_new=no table holds sends or scoped routes; no_claim=that Slack was called`.

### Task 2b: Six question categories

**Files:**

- Modify: `packages/contracts/src/states.ts` (`QuestionCategory` gains `Business: 'business'`, `Environment`
  becomes `Access: 'access'`; `DECISION_CATEGORIES` gains Business; `QUESTION_CATEGORY_HINTS` with the spec §6.1
  hint and "covers" text per category), `packages/contracts/src/protocol.ts` (`PROTOCOL_VERSION` 8),
  `packages/contracts/src/mcp-tools.ts` (`ask_human.category` gets a `.describe` built from the hints),
  `apps/daemon/src/mcp/tools.ts` (the `ask_human` description names the six with their hints), every test fixture
  that uses `'environment'` and `apps/daemon/src/inbox/permission-broker.ts:398` and `:471`
  (`QuestionCategory.Environment` becomes `QuestionCategory.Access`) (`apps/desktop/src/views/shape/waiting-permissions.test.tsx`, `working-line.test.tsx`,
  `views/inbox/inbox-view.test.tsx`, `views/workbench/pass-workspace.test.tsx`, `apps/daemon/src/inbox/inbox.test.ts`,
  `shape/session-tools.test.ts`, `watcher/watcher.test.ts`, `packages/db/src/store/denied-permissions.test.ts`),
  generated contracts
- Create: a `drizzle-kit generate --custom` migration (`UPDATE inbox_items SET category = 'access' WHERE category =
  'environment'` and the same for `routing_rules`), and in the decisions folder a file named
  `access-replaces-environment-and-business-is-a-question-category`, dated the day it is written
- Create: `packages/db/src/migrations-test-support.ts`, holding `migrationsBefore` moved out of
  `migrations-model-ids.test.ts:27`, which then imports it; Sessions M4a's migration test can use it too
- Test: `packages/db/src/migrations-categories.test.ts` (a database migrated through `migrationsBefore` this one,
  seeded with an `environment` card and route, migrated forward), `packages/contracts/src/contracts.test.ts`
  (`:49-50`, the `PROTOCOL_VERSION` row moves from 7 to 8), `apps/daemon/src/inbox/inbox.test.ts` (extend the
  decision-recording rows near `:704`), the desktop's `record-decision` table
  (`inbox-view.test.tsx:1379`, rows for `business` and `access`)

**Interfaces:**

- Produces: the six categories, their hints from one table, `business` answers recorded as decisions, `access`
  and `other` not. Every place that lists categories reads `QuestionCategory` or the hints table, never a literal
  list.

- [ ] **Step 1: Write the failing tests**: `contracts.test.ts`'s `PROTOCOL_VERSION` row expects 8 (red until the
      bump); the migration test (the seeded card and route read `access` after it);
      `ask_human` refuses `environment` and accepts `business` and `access`; `recordAnswerDecision` records a
      `business` answer and not an `access` one; the desktop's Record Decision shows for `business` and not for
      `access`.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement**, write the custom migration, bump the protocol, write the decision, regenerate, and
      move the fixtures to `access`.
- [ ] **Step 4: Run** the contracts, db, daemon and desktop tests that changed, and `pnpm -r typecheck`.
      Expected: PASS.
- [ ] **Step 5: Commit** `feat(contracts): business joins the question categories, and access replaces environment`
      (the body says the protocol moves to 8 and names the decision).

`Value: protects=the six categories agents tag and people route, stored rows carried across, and which answers become decisions; fails_when=an old environment row is left unreadable, business answers aren't recorded, or a list of categories drifts from the enum; why_new=the enum and DECISION_CATEGORIES have no test of membership or migration; no_claim=that agents tag well`.

### Task 3: Choosing the people, and folding by them

**Files:**

- Modify: `packages/db/src/store/routing-rules.ts` (`assigneesFor`), `packages/db/src/store/inbox.ts`
  (`insertInboxItem` takes the targets' task ids and stores `rule_assignees`), `apps/daemon/src/inbox/service.ts`
  (the fold key is the recipients the rules give a new ask)
- Test: `packages/db/src/store/assignee.test.ts` (extend), `apps/daemon/src/inbox/inbox.test.ts` (fold rows)

**Interfaces:**

- Produces: `assigneesFor(db, input: { projectId: ProjectId; kind: InboxKind; category: QuestionCategory; topic: string | null; taskIds: readonly TaskId[] }): { handles: string[]; tier: 'task' | 'goal_area' | 'goal' | 'project_area' | 'triage' | 'builder' }`,
  per spec §6.2: a non-question card, a card with no task, or tasks resolving to different recipients go to the
  builder, and so does a card asked by a Workbench pass's page (`askedByPassPage`, `inbox/service.ts:229`: the
  builder is working through that pass live; spec §6.2 records it as the design's call, reversible); per task,
  the task routes, the goal's area routes, the goal's category routes, the project's area routes. Each tier
  collects every person matching at that tier (a tie), in routing order (the order the routes were added). A tie
  of more than eight people goes to the builder with the spec §6.2 note in the card's detail. When none matches and the
  project has category or topic routes, the tier is `triage` and `handles` is the lane's fallback: the topic
  route's people when `topic` names one, else the category's project routes, else the builder. Task 3b uses it.
  `InboxService.ask` computes it for the new ask before looking for a card to fold into, and folds only into an
  open card with the same `rule_assignees`.
- Per provider: routing and ties read the card and the routes, after the lane has asked, the same for a Claude
  plan, Bedrock or an API key, and a ChatGPT/Codex plan.

- [ ] **Step 1: Write the failing table** in `assignee.test.ts`, one named row each: project area beats nothing
      else; goal category beats project area; goal area beats goal category; task beats goal; a task route for
      `design` doesn't catch `product`; a permission card with a matching route goes to the builder; a card with
      no task under a project route goes to the builder (a change from today: state it in the commit); two tasks
      routed to Mark and Dana go to the builder; two tasks both routed to Mark go to Mark; a task with no goal uses
      the project; a cancelled task's route is ignored; Mark and Ana both on a goal's product route are both
      recipients, Mark first when his route was added first, and Ana first when hers was; nine people on one route
      go to the builder with the note; a pass page's question under a matching route goes to the builder; a goal route for Mark beats a project route for Ana (no tie across scopes); project category and
      topic routes only give tier `triage`, with the topic's people when the lane named the topic, the category's
      people when it didn't, and the builder when neither matches; an unknown topic falls to the category. In
      `inbox.test.ts`: the same question asked on a task routed to Mark and one routed to Dana makes two cards;
      asked twice on tasks with the same rules, one card; a tie whose routes were added in either order folds
      (the fold compares recipients as a set).
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.** Resolve each task's goal and areas in one query; keep the choice a pure function of
      the rows.
- [ ] **Step 4: Run** the db and inbox tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(db): a question goes to its task's, goal's or project's people, ties included`.

`Value: protects=who a question goes to by rule, and that a tie asks everyone; fails_when=a goal or task route is skipped, a tie drops a person, a tie spans scopes, or one card folds two people's questions; why_new=assignee tests cover project scope and one person only, and nothing re-routes a fold; no_claim=triage (Task 3b) or that anyone is told`.

### Task 3b: Triage by the judge

**Files:**

- Create: `apps/daemon/src/stakeholders/triage.ts`, `apps/daemon/src/stakeholders/triage-options.ts`
- Modify: `apps/daemon/src/judge/judge.ts` and `openrouter.ts` (`JudgeRequest.criteria`, an optional description
  per option: `askSystemOne` sends it as the choice's `criteria`, `askChat` puts it in the prompt, and the logged
  `question` carries the options and their criteria as text), `apps/daemon/src/inbox/service.ts` (introduces
  `onQuestionOpened(ctx, item): (() => void) | null`, called inside a question card's insert, whose callback runs
  after the commit, as `onCheckAnswer` does; `ask` reads whether the judge can run inside the insert),
  `packages/db/src/store/inbox.ts` (`setInboxRecipients` emits `inbox.triaged` when it moves a card off
  `triage_pending`), `apps/daemon/src/daemon/start.ts`, `apps/daemon/test/engine.ts`
- Test: `apps/daemon/src/stakeholders/triage-options.test.ts`, `apps/daemon/src/stakeholders/triage.test.ts`,
  `apps/daemon/src/judge/judge.test.ts` (extend), `apps/daemon/src/inbox/inbox.test.ts` (rows)

**Interfaces:**

- Consumes: Tasks 1, 2, 2b and 3. Drafting a routed card is Task 7a's and parking its session is Task 6's: both
  hang off `afterRouted`, which this task calls and leaves a no-op.
- Produces:
  - `triageOptions(rows, people, hints): { options: [string, ...string[]]; criteria: Record<string, string>; peopleFor: Record<string, PersonId[]> }`,
    pure: one `category:<c>` option per category with project routes, one `topic:<routeId>` per topic route, and
    `nobody`, each with its spec §6.3 criterion; `peopleFor` lists each route's people in routing order.
  - `triageState(card, task, goal): string`: the card's title, body and options, the lane's category and topic,
    the task's and goal's titles, as named JSON fields.
  - **Decided at insert when the judge can't run.** `InboxService.ask` reads `judge.off` and the judge config
    (the master switch and `question_route`'s) inside the insert's transaction; when the judge can't run, a
    `triage`-tier card takes Task 3's fallback with `routedBy: 'rule'` and is never pending. Otherwise it is
    inserted `routedBy: 'triage_pending'`, assigned to the builder, and `onQuestionOpened`'s callback starts
    `run`.
  - `createTriage(deps: { state; judge: Judge; afterRouted: (id: InboxItemId) => void; log }): { run(cardId): Promise<void> }`.
    `run` never throws and never routes before its first `await` (the judge's call), so `onWaitStart` has always
    run first. Every outcome moves the card off pending in one `setInboxRecipients` write: a route at or above the
    floor gives its people and `routedBy: 'judge'`; `nobody` at or above the floor gives the builder and
    `routedBy: 'builder'`; below the floor gives the builder, `routedBy: 'builder'` and `routeSuggestion` (the top
    route's people, unless it is `nobody`); a fallback (no key, timeout, error, a route removed meanwhile, or any
    exception inside `run`, caught) gives Task 3's `handles` and `routedBy: 'rule'`. A card no longer OPEN keeps
    its recipients and only leaves pending (`routedBy: 'builder'`). Then `afterRouted(cardId)`. Each judge outcome
    is recorded with `recordJudgeOutcome`.
  - `inbox.triaged` (entity the card, `{ routedBy, toBuilder }`) is emitted by the write that leaves pending; the
    desktop notifies a card that lands with the builder then (Task 12).
  - Without the judge the result is the same on every provider: triage reads only the card.

- [ ] **Step 1: Write the failing tests.** `triage-options`: one row per shape (categories only, topics only, a
      tie on a category gives both people in routing order, no routes gives only `nobody`), and the criteria
      text. `judge.test.ts`: a request with `criteria` sends them in the System One body and in the chat prompt,
      and logs them in the question; one without sends `null` as today. `triage.test.ts` (real store, fake
      `Judge`), each row asserting the card's `routedBy` and that it is no longer pending: a confident `topic:`
      routes to Sarah (`judge`); a confident `category:product` with Mark and Ana routes to both (`judge`);
      `nobody` keeps the builder with no suggestion (`builder`); 0.64 keeps the builder with Sarah suggested
      (`builder`); a timeout uses the lane's topic (`rule`); a judge that throws, and a store read that throws
      inside `run`, both use the fallback (`rule`); a removed route falls back (`rule`); a card answered before the
      judge answers keeps its answer and leaves pending (`builder`); `inbox.triaged` carries `toBuilder` true for
      the builder outcomes and false for a route; `afterRouted` is called once per outcome. `inbox.test.ts`: with
      `TENDB_JUDGE=off`, and with `question_route` switched off, a project category route gives Mark at insert
      with `routedBy: 'rule'`, no pending state and no judge call. One engine row through the wiring (fake
      OpenRouter `fetch`): the lane asks, and the card is routed to Sarah with `inbox.triaged`.
- [ ] **Step 2: Run** `pnpm --filter @10db/daemon test -- triage judge inbox`. Expected: FAIL.
- [ ] **Step 3: Implement.** **Step 4: Run**. Expected: PASS.
- [ ] **Step 5: Commit** `feat(daemon): the judge triages a question among a project's categories and topics`.

`Value: protects=a question with no explicit route still reaches the person who owns its subject, an unsure judge only suggests, and no card stays pending; fails_when=a low-confidence answer routes anyway, a timeout or exception leaves the card pending, a tie collapses to one person, a stale route is used, or a card left with the builder is never announced; why_new=nothing classifies a question and the judge sends no criteria; no_claim=that Jev classifies well (judge_calls and Settings › Decisions show it)`.

### Task 4: The Slack client and keeping test daemons off Slack

**Files:**

- Create: `apps/daemon/src/slack/client.ts`, `apps/daemon/src/slack/responses.ts`, `apps/daemon/src/slack/errors.ts`,
  `apps/daemon/src/slack/index.ts`
- Modify: `apps/daemon/src/env.ts`, `apps/daemon/.env.example`, `apps/daemon/src/daemon/options-from-env.ts`
  (`TENDB_SLACK: on | off`, default on for the installed app), `apps/daemon/src/environment/keychain.ts`
  (`SLACK_BOT_ACCOUNT = 'slack-bot'`), `apps/daemon/AGENTS.md` (`slack` in the first tier, `stakeholders` beside
  `delivery`; the `TENDB_SLACK` paragraph), every throwaway launcher (`scripts/dev.sh`,
  `apps/daemon/scripts/live-acceptance.ts`, `apps/desktop/e2e/playwright.config.ts`, the daemon tests that spawn
  the entry), `tests/repo/src/benchmarks-off.test.ts` (rows for `TENDB_SLACK`)
- Test: `apps/daemon/src/slack/client.test.ts`

**Interfaces:**

- Produces:
  - `createSlackClient(deps: { fetch: typeof fetch; token: () => Promise<string | null>; clock: Clock; timeoutMs: number }): SlackClient`.
  - Each method posts to `https://slack.com/api/<method>` with `Authorization: Bearer` and JSON, and parses the reply
    with its zod schema: `authTest()`, `listMembers(cursor?)` (drops deleted users, bots and members of another
    team), `openDm(userId): Promise<string>`, `openGroup(userIds: readonly string[]): Promise<string>` (2–8 users,
    `conversations.open` with `users` joined by commas),
    `post({ channel, text, blocks, threadTs?, metadata? }): Promise<{ ts: string }>` (always `unfurl_links: false`,
    `unfurl_media: false`), `permalink(channel, ts)`, `replies(channel, threadTs, oldest)` and
    `history(channel, oldest)` (both with `include_all_metadata`; each message keeps `reactions: { name; users }[]`
    when present), `reactions(channel, ts): { name; users }[]` (`reactions.get` with `timestamp`), and
    `addReaction(channel, ts, name)` (`reactions.add`, scope `reactions:write`, for the ✅ 10db seeds on its
    proposal), and `userInfo(userId)` (the name of someone brought in). Channel ids are kept as Slack returns them;
    no method checks a `D`, `G` or `C` prefix.
  - `SlackError extends Error` (`name = 'SlackError'`) with `code` (Slack's `error`, or `http_<status>`, `timeout`,
    `unreachable`, `bad_reply`, `no_token`) and `retryAfterSeconds` for `ratelimited`. Its message names the method
    and code, never the token. `slackRefusedToken(error): boolean` covers `invalid_auth`, `token_revoked`,
    `account_inactive` and `not_authed`.

- [ ] **Step 1: Write the failing tests** against a fake `fetch`: each method's URL, headers and body; `post`
      always sends both unfurl flags off; `openGroup` refuses one user and nine; a reply's `reactions` parse, and
      so does `reactions.get`'s;
      `ok: false` becomes a `SlackError` with the code; HTTP 429 with `Retry-After: 30` gives
      `retryAfterSeconds: 30`; a reply that fails its schema is `bad_reply`; a `fetch` that never settles aborts
      with `timeout` once the `ManualClock` passes `timeoutMs`; `no_token` with an empty Keychain; no error's
      `message` or `stack` holds the token (a row per method). In `benchmarks-off.test.ts`: each launcher sets
      `TENDB_SLACK=off`.
- [ ] **Step 2: Run** `pnpm --filter @10db/daemon test -- slack/client` and the repo test. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run**, plus the daemon's typecheck and lint. Expected: PASS.
- [ ] **Step 5: Commit** `feat(daemon): a slack client that never shows its token, and test daemons stay off slack`.

`Value: protects=talking to Slack, reading its refusals, and no test daemon messaging real people; fails_when=an error leaks the token, a refusal reads as success, or a launcher forgets TENDB_SLACK=off; why_new=no Slack code exists; no_claim=that Slack accepts these calls live (the builder's check does)`.

### Task 5: Compose, escape, scan and read

**Files:**

- Create: `apps/daemon/src/stakeholders/compose.ts`, `outbound-scan.ts`, `read-reply.ts`, `conversation.ts`,
  `lines.ts`, `index.ts`
- Test: `compose.test.ts`, `outbound-scan.test.ts`, `read-reply.test.ts`, `conversation.test.ts`, `lines.test.ts`
  beside them

**Interfaces:**

- Produces:
  - `escapeMrkdwn(text: string): string` (`&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`; backticks dropped).
  - `stakeholderOptions(card: InboxItemDto): InboxOption[]` (the card's options without `isParkChoice` ones).
  - `composeSlackQuestion(input: { card: InboxItemDto; projectName: string; goalTitle: string | null; builderName: string; recipientNames: string[] }): { text: string; blocks: SlackBlock[] }`:
    the spec §7.2 layout and copy ("has a question for you" for one recipient, "for Mark and Ana" for several),
    every text object `verbatim: true`, options from `stakeholderOptions` lettered A–D, the recommendation marked
    `_(recommended)_`, the body cut at 2,500 characters with " (shortened)".
  - `scanOutbound(text: string): OutboundHit[]`, from one table `OUTBOUND_PATTERNS: readonly { name: string; pattern: RegExp; severity: 'hold' | 'warn' }[]`
    holding the spec §7.3 rows (secrets, any URL and a fenced code block hold; a file path warns).
  - `readReply(reply: { words: string; messageCount: number }, options: readonly InboxOption[]): { answer: InboxAnswer | null; readAs: 'option' | 'own_words' }`:
    a reply of one message whose first word is `A`–`D` (bare, or with `.`, `)` or `:`, or wrapped in `( )`), in any
    case and within the options' count, or whose whole text equals an option's label, picks it, with the words as
    the note. A reply joined from more than one message is always own words ("B" then "wait, C" must never read as
    B). Anything else is own words (`answer: null`; Task 8a builds that answer).
  - In `conversation.ts`, all pure over `SlackMessage[]` and the send's people:
    - `newMessages(input: { messages; participants: string[]; botUserId; afterTs })`: participants' messages after
      `afterTs` that aren't the bot's, aren't bot messages and aren't edits, in order, with their authors.
    - `mentionsToAdd(messages, participants, botUserId): string[]`: user ids mentioned (`<@U…>`) by a participant
      that aren't the bot or a participant.
    - `conversationState(input: { messages; recipients; participants; botUserId; quietSince; now; proposal; settledThroughTs; askedWhichWay: { at; ts } | null; approvalSeen: { at; by } | null }): { kind: 'waiting' } | { kind: 'lone_reply'; words; messageCount; lastTs } | { kind: 'settled' } | { kind: 'approval_seen'; by: string } | { kind: 'approved'; by: string } | { kind: 'picked'; by: string; choice: string } | { kind: 'disagreed' } | { kind: 'withdrawn' }`
      (`recipients` in routing order):
      a lone recipient who alone replied gives `lone_reply` once a tick sees nothing new from them (§8.2); with
      anyone else or several recipients, `settled` after a message naming a letter and a quiet tick, or 30 minutes
      with no new message, and never again for messages at or before `settledThroughTs` (a quiet conversation after
      a proposal or a which-way line answers `waiting`); after a which-way line, a lone recipient's own reply is
      `lone_reply`. With a proposal open, a recipient's approval (a ✅ reaction — `white_check_mark`,
      `heavy_check_mark` or `+1` — on the proposal whose `users` holds a recipient, the bot's own id ignored, or a
      reply of exactly "yes", "approve", "approved", "ok" or "👍", any case, trailing punctuation ignored) first
      gives `approval_seen` (the earliest such recipient in routing order); with `approvalSeen` stored, the next tick
      gives `approved` when that approval still stands and no other recipient wrote since, and `withdrawn` when the
      ✅ was removed. A recipient's letter gives `picked`; recipients naming different letters, or an approval and
      another recipient's non-approval in the same tick, give `disagreed`; any other new message withdraws the
      proposal.
  - In `lines.ts`, the templates (spec §8.4–§8.6, §8.1): `broughtInLine`, `movedLine`, `couldntAddLine`,
    `fullLine`, `proposalLine(choiceLetter, label, favouredNames, recipientUserIds)`, `whichWayLine(letters,
    recipientUserIds)`, `reminderLine()`, `replyHereLine()` ("↳ Reply in this thread with a letter or your own
    words.", the last line of every question message, which `composeSlackQuestion` appends) and
    `topLevelNudgeLine()`. Names are escaped; mentions are built only from the ids passed in. These fixed lines
    live together in `lines.ts`; Task 7c's closing lines reuse it.

- [ ] **Step 1: Write the failing tables.** compose (snapshot rows): the spec §7.2 card renders the spec's text
      exactly, ending with the reply-here line; with no goal it names the project; two recipients read "for Mark
      and Ana", and their message ends with the same line; Park is gone even when the card lists it;
      a 3,000-character body is cut; `<!channel>`, `<@U123>`, `<https://x|y>` and `&` in the title, body or
      options come out escaped; every text object is verbatim. scan: a row per pattern that hits, with its
      severity; near-misses that don't (`sk-` inside a word, `ghp` with no suffix, `and/or`, `24/7`, a date);
      `/pricing/annual` warns and doesn't hold. readReply: `B`, `b`, `B.`, `b) yes`, `(b)`, `B, we can't…`, the
      exact label, `D` with three lane options (own words, never Park), `E` with four options,
      `Before we decide…`, an empty reply, and "B" then "wait, C" as two messages (own words). conversation:
      another participant's message counts and a non-participant's doesn't; the bot's own; a bot message; an edit;
      a message before `afterTs`; a lone reply on a first tick waits and on a quiet second tick is `lone_reply`;
      Priya's message makes it settle-only; a letter then a quiet tick settles; 29 minutes quiet waits and 30
      settles; Mark's ✅ is `approval_seen` and, still there next tick, `approved`; the bot's own ✅ alone is
      `waiting`; Mark's ✅ removed before the next tick is `withdrawn`; two recipients' ✅ in one tick credit the first
      in routing order; a quiet conversation with `settledThroughTs` at its newest message is `waiting`; Priya's ✅
      doesn't approve; Mark's "Yes." approves; Mark's "yes but" withdraws; Mark's
      "C" is `picked`; with Mark and Ana, Ana's ✅ approves as Ana, Mark "B" and Ana "C" is `disagreed`, Mark's ✅
      and Ana's "hold on" in one tick is `disagreed`; mentions of the bot, of a participant and of a new person.
      lines: each template's exact text, an escaped name, and mentions only from ids.
- [ ] **Step 2: Run** `pnpm --filter @10db/daemon test -- stakeholders/`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run**. Expected: PASS.
- [ ] **Step 5: Commit** `feat(daemon): a stakeholder question reads plainly, leaks nothing, and a conversation is read by rule`.

`Value: protects=what leaves the laptop, which words count, and when a conversation is settled, approved or contested; fails_when=agent text pings, links or unfurls, a secret or URL is sent unreviewed, "D" parks the task, a half-typed reply is taken, a non-recipient's ✅ approves, or a disagreement reads as agreement; why_new=no outbound or inbound text exists; no_claim=that Slack renders the blocks as drawn`.

### Task 6: Park a routed question at once

**Files:**

- Modify: `apps/daemon/src/runner/runner.ts` (`onWaitStart`, `parkFor`), `apps/daemon/src/daemon/start.ts` (Task
  3b's `afterRouted` parks the card's sessions when it was routed away from the builder)
- Test: `apps/daemon/src/runner/routed-wait.test.ts`

**Interfaces:**

- Consumes: Task 3 (`item.assignees`), Task 3b (`afterRouted`).
- Produces:
  - `onWaitStart` re-reads the card (`getInboxItem`) instead of trusting the item it is handed, since triage or
    Ask Someone may have routed it since the ask. For a `question` card whose recipients aren't the builder, the
    session parks at once (abort the waits, then stop the handle, as the timer's callback does) instead of arming
    the timer, **even when another wait is already open** (`openWaits() > 1`): every wait aborts, and the session
    parks on its oldest open card. Each card's answer then arrives through `onParkedAnswer`. A builder card with
    another wait open keeps today's rule (the existing timer stands). A `triage_pending` card waits as a builder
    card.
  - `Runner.parkFor(inboxId)` parks every live session with a wait on the card, including the sessions whose
    identical asks folded into it, so a stakeholder's words never reach a live `ask_human` call unquoted. Task
    3b's `afterRouted`, Task 7b's `askSomeone` and Task 8a's `answerAs` call it.

- [ ] **Step 1: Write the failing tests** with `createTestEngine`: a goal route sends `product` to Mark; the
      script calls `ask_human` with `category: 'product'`; with no clock advance the session has stopped and the
      workstream is `WAITING_HUMAN` with an `answer` action; answering the card requeues it and the resumed prompt
      holds the answer. Rows: `engineering` still waits (live after `advance(9 * 60_000)`); `AskUserQuestion` on a
      route for `other` parks the same way; the same flow on a Codex account parks the same way (the fake
      adapter's Codex path); a tie to Mark and Ana parks; a session already waiting on a builder card asks a
      second question routed to Mark and parks at once, and both cards' answers later requeue it; a card routed
      by triage after `onWaitStart` (fake OpenRouter `fetch`, Task 3b) parks its session; a card rerouted between
      the ask and `onWaitStart` parks (the re-read); two sessions whose asks folded into one card are both parked
      by `parkFor`; `parkFor` on a live builder card parks it. A guard row (it passes before and after, since
      recovery doesn't change): a restart while parked on a routed card keeps it parked with its action.
- [ ] **Step 2: Run** `pnpm --filter @10db/daemon test -- routed-wait`. Expected: FAIL (the session is still live).
- [ ] **Step 3: Implement.** Wire `afterRouted` to `parkFor`.
- [ ] **Step 4: Run**, plus `runner.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(daemon): a question routed to someone else parks its session at once`.

`Value: protects=a lane isn't held for an answer that takes hours, and a stakeholder's words never reach a live ask_human; fails_when=a routed card keeps a live session for humanWaitMinutes, a second wait or a folded session stays live, a stale item arms the timer, or a builder card parks early; why_new=runner tests cover the timer for builder cards only; no_claim=anything about Slack`.

### Task 7a: A routed card gets its draft in the same write

**Files:**

- Create: `apps/daemon/src/stakeholders/drafts.ts`
- Modify: `apps/daemon/src/daemon/start.ts` (adds `draftFor` to Task 3b's `onQuestionOpened` hook, and to Task
  3b's `afterRouted`), `apps/daemon/test/engine.ts`
- Test: `apps/daemon/src/stakeholders/drafts.test.ts`

**Interfaces:**

- Produces: `draftFor(ctx, item, deps: { projectName; goalTitle; builderName }): (() => void) | null` writes the
  composed text and its hits when every recipient is a person with a Slack contact (a recipient without one makes
  the card the builder's with Copy for them, spec §5), and returns an after-commit callback that calls Task 7b's
  `afterDraft` (as `onCheckAnswer` returns one). The hits come from scanning the card's raw title, body and options
  before escaping as well as the composed text, so a fenced code block holds even though composing drops
  backticks. A failure to compose or scan is caught and logged: the card is written without a draft and stays with
  the builder (in Open) until the next start's sweep, and the lane's question is never refused. A
  `triage_pending` card gets no draft: triage's `afterRouted` drafts it once routed. `sweepDrafts(ctx)` runs at
  start: a routed open question with no send gets its draft, a draft whose card's recipients changed is dropped,
  and an OPEN card left `triage_pending` by a crash takes Task 3's fallback (`routedBy: 'rule'`) in one write; a
  pending card no longer OPEN only leaves pending.

- [ ] **Step 1: Write the failing tests**: a routed card has its draft in the same transaction; a tie's draft
      holds both recipients; a compose that throws leaves the card written, without a draft, assigned to the
      builder; a person without a contact gets no draft; a permission card never gets one; a pending card gets
      none, and gets one when triage routes it to Sarah (`afterRouted`, moved here from Task 3b); a card body with
      a fenced code block gives a draft held on `code`; the start sweep drafts a routed card that has none, drops a
      draft whose card was rerouted, settles a stranded OPEN pending card to `rule`, and only clears the pending
      mark on an answered one.
- [ ] **Step 2: Run**. Expected: FAIL. **Step 3: Implement.** **Step 4: Run**. Expected: PASS.
- [ ] **Step 5: Commit** `feat(daemon): a routed question's message is drafted with the card`.

`Value: protects=no routed card is left without its message; fails_when=a crash between the card and its draft, or during triage, strands it; why_new=nothing drafts; no_claim=sending`.

### Task 7b: Sending

**Files:**

- Create: `apps/daemon/src/stakeholders/sends.ts`
- Modify: `apps/daemon/src/stakeholders/index.ts`, `apps/daemon/src/daemon/start.ts`, `apps/daemon/test/engine.ts`
- Test: `apps/daemon/src/stakeholders/sends.test.ts`

**Interfaces:**

- Consumes: Tasks 2, 4, 5 and 7a.
- Produces: `createStakeholderSends(deps: { state: StateStore; slack: SlackClient | null; clock: Clock; log: Logger }): StakeholderSends` with:
  - `afterDraft(cardId)`: sends at once only when every recipient's mode is `auto`, nothing holds, every recipient
    was sent to before, and every recipient with a limit has `newThreadsSince(24h) < dailyLimit`; or when the card
    is a follow-up in a conversation that already had a reviewed send (only a hold stops that). Otherwise it sets
    the draft's `heldBy`, first match wins: `scan`, `first_send`, `limit`, `review`.
  - Names in the message and on the card are in routing order (`assignees`).
  - `send(cardId, input: SendInput)`: rescans the text (edited or not) and refuses a hold (`InvalidError` naming
    the patterns); refuses a draft held by `limit` unless `overrideLimit` (Send Anyway); `markSending` with the text's hash, the target `threadTs` (null for a new thread) and the
    clock's time; opens the DM (one recipient, `openDm` when the contact has none) or a group DM (several,
    `openGroup`); posts in `latestThreadFor(recipients, task)` when there is one, else a new message, with Slack
    message `metadata` `{ event_type: 'tendb_send', event_payload: { sendId } }`; `markSent` with the ids and
    permalink and the clock's time (`waitStartedAt`); `failSend` with Slack's code when Slack refuses, and the card
    goes back to the builder (a failed send never counts toward anyone's limit).
  - `askSomeone(cardId, input: AskSomeoneInput)`: writes the routes for `always` (appended to the project's rules
    in the same write, one per person and category), sets the card's recipients (`setInboxRecipients`,
    `routedBy: 'builder'`), drops any old draft and drafts for the new recipients, parks a session still waiting on
    the card (`Runner.parkFor`, Task 6), then `afterDraft`. It never sends past review itself.
  - `takeBack(cardId)`: closes the send `taken_back` (Task 7c posts the line) and sets the card back to the
    builder, so it is in Open again.
  - `recoverSending()`: at start, for each `sending` send, reads `replies(channel, threadTs, oldest: startedAt)`
    for a follow-up or `history(channel, oldest: startedAt)` for a new thread, with `include_all_metadata`; the
    bot message whose metadata names this send makes it `sent` with that `ts`; none posts it again.
  - `slack: null` (off, or no token) leaves every draft as it is.

- [ ] **Step 1: Write the failing tests** with a real store and a fake Slack client: auto mode sends at once;
      review mode leaves the draft with `heldBy: 'review'` and calls nothing; the first send to a person waits even
      in auto mode (`first_send`); a URL holds even in auto mode (`scan`); a path warns and still sends in auto
      mode; the eleventh new thread in 24 hours waits (`limit`) and the tenth doesn't; `send` on a `limit` draft
      without `overrideLimit` is refused and with it posts; a failed send doesn't count toward the limit, so the
      next one sends; a person with the limit off never waits on it; a follow-up on the same task
      posts in the first thread with its `thread_ts`, skips review and doesn't count toward the limit; a tie opens
      one group DM with both, posts once, and names them in routing order; a tie with one recipient on review waits; a tie with one recipient at
      their limit waits, and a sent tie counts once for each; `send` with an edited text posts that text and stores
      its hash; `channel_not_found` fails the send and the card goes to the builder; `askSomeone` with `always`
      writes one goal route per category and leaves a draft in review mode, and parks a session still waiting on
      the card; `takeBack` closes the send and returns the card to the builder; `recoverSending` finds a posted new
      thread by its metadata and doesn't post twice, finds a posted follow-up inside its thread the same way, and
      posts when it finds none; a route change before sending drops the draft.
- [ ] **Step 2: Run** `pnpm --filter @10db/daemon test -- stakeholders/sends`. Expected: FAIL.
- [ ] **Step 3: Implement.** **Step 4: Run**. Expected: PASS.
- [ ] **Step 5: Commit** `feat(daemon): a routed question is sent to its people in slack, after review when asked`.

`Value: protects=when and what 10db sends, and that a tie asks everyone in one place; fails_when=a first message, a held message or an eleventh thread goes unreviewed, a follow-up starts a new thread or counts toward the limit, a tie splits into two DMs, or a crash posts twice; why_new=nothing sends; no_claim=that the reply comes back`.

### Task 7c: Closing lines

**Files:**

- Create: `apps/daemon/src/stakeholders/closing-lines.ts`
- Modify: `apps/daemon/src/stakeholders/sends.ts` (`onCardChanged`), `apps/daemon/src/daemon/start.ts` (subscribe to
  `inbox.changed`)
- Test: `apps/daemon/src/stakeholders/closing-lines.test.ts`

**Interfaces:**

- Produces: `closingLine(reason: 'builder' | 'taken_back' | 'cancelled', builderName: string, choice: string | null): string`
  (the spec §8.3 copy, posted in every thread the send used, the current one and its `moved_from`, re-reading
  the send after each post, whenever Task 7b's `takeBack` or any of the cases below closes a send) and `onCardChanged(item)`. It acts only on a card whose send is `sent` or `sending`,
  and never on a card answered `via: 'slack'`. The builder's answer is `builder`; a Park answer or Take Back is
  `taken_back`; a cancelled, resolved or withdrawn card is `cancelled`. A send still `sending` is closed after
  its post lands. A Slack error on a closing line is logged and never retried. A closing line never counts toward
  the daily limit.

- [ ] **Step 1: Write the failing tests**: the builder's answer posts "Travis answered this one: B. Thanks!" once;
      a Park answer posts the take-back line, never "Park the task"; a cancelled card, a resolved card and a
      withdrawn card each post "This one is no longer needed. Thanks!"; a card answered via Slack posts nothing; a
      card closed while its send is in flight gets the line after the question; a moved send gets the line in the
      group DM and in the DM it moved from; a send moved while its closing line is posting gets it in both threads; the builder answering a disagreed card posts the builder line; a failing closing line raises no
      card.
- [ ] **Step 2: Run**. Expected: FAIL. **Step 3: Implement.** **Step 4: Run**. Expected: PASS.
- [ ] **Step 5: Commit** `feat(daemon): a question settled without the stakeholder tells them so`.

`Value: protects=nobody is left answering a dead question or told the builder answered their own answer; fails_when=a park leaks its label, a cancelled card stays silent, a moved conversation gets the line in the old thread, or a Slack answer echoes back; why_new=nothing posts after a send; no_claim=how Slack shows it`.

### Task 8a: Answering as the person

**Files:**

- Modify: `apps/daemon/src/inbox/service.ts` (`answerAs`; `createInboxService` takes
  `parkWaiting(id: InboxItemId): void`, wired to Task 6's `Runner.parkFor`), `apps/daemon/src/knowledge/capture.ts`
  (`recordAnswerDecision` takes the answerer and who else spoke), `apps/daemon/src/briefing/context-pack.ts` and
  `prompts.ts`
- Test: `apps/daemon/src/inbox/inbox.test.ts` (extend), `apps/daemon/src/briefing/briefing.test.ts` (extend)

**Interfaces:**

- Produces:
  - `InboxService.answerAs(id, input: { readAs: 'option' | 'own_words' | 'approved'; answer: InboxAnswer | null; words: string; conversation: { name: string; text: string }[] }, by: { personId: PersonId; permalink: string; with: string[] }, inTx: (ctx: WriteContext, item: InboxItemDto) => void): InboxItemDto`.
    It refuses a park choice and a `personId` that isn't one of the send's recipients, skips `assertKnownChoice`
    only for `own_words` (choice "In <Name>'s words", note the words cut at 4,000 characters), stores
    `RecordedAnswer` with `answeredBy`, `via: 'slack'`, `with` and the `words` cut at the schema's 20,000 (the send
    keeps them whole), so no reply can make the Inbox's DTO fail to parse, and runs `inTx` in the same
    transaction. **It never resolves a live waiter:** after the commit it takes the card's waiters out of the map,
    calls `parkWaiting(id)` so their sessions park (their `ask_human` calls end with the session, never with the
    answer), and delivers every target through `onParkedAnswer`, so the words reach the lane only in the quoted
    resume. An already-answered card is a `ConflictError` that changes nothing.
  - `recordAnswerDecision(ctx, item, answer, project, by?: { handle: string; permalink: string; with: string[] })`:
    for a Slack answer, an option pick or approval is recorded with `decidedBy: handle`, "with Priya" in its
    rationale when others spoke, and a `slack_reply` source; own words record nothing.
  - The resumed prompt for `via: 'slack'` is the spec §8.3 text for a lone reply and the §8.5 text for a
    conversation, every quoted message between `«` and `»` with its author (any `«` or `»` inside replaced by `"`),
    plus the `record_decision` line for own words. `pendingAnswer` carries `answeredBy`, `via`, `words` and
    `conversation`.

- [ ] **Step 1: Write the failing tests**: `answerAs` with an option records Mark's decision with the permalink;
      with own words it records none and the card's answer holds the words; an approval with Priya records Mark's
      decision naming Priya; Ana answering a tie records Ana's; a non-recipient's `personId` is refused; a park
      choice is refused; a 5,000-character reply is cut in the note and whole in `words`; a 50,000-character reply
      is cut in `words` and the card's DTO still parses; `inTx` throwing rolls back the answer; a card with a live
      waiter is answered without resolving it: `parkWaiting` is called and every target goes to `onParkedAnswer`; a
      second
      `answerAs` or a builder answer after it is a conflict that changes nothing. Briefing rows: the resumed prompt
      for an option, for own words (with the `record_decision` line), for an approved conversation (each author
      quoted), and for words holding `»`.
- [ ] **Step 2: Run**. Expected: FAIL. **Step 3: Implement.** **Step 4: Run**, plus the inbox and briefing tests.
      Expected: PASS.
- [ ] **Step 5: Commit** `feat(daemon): an answer can come from a stakeholder, in their own words or a conversation`.

`Value: protects=the lane hears who answered and exactly what was said, and only a recipient's pick or approval is recorded in their name; fails_when=own words are refused, someone can park, a non-recipient answers, or a free-text reply becomes a decision nobody made; why_new=answers are always the builder's and always an option; no_claim=reading Slack`.

### Task 8b: The reply watch

**Files:**

- Create: `apps/daemon/src/stakeholders/reply-watch.ts`
- Modify: `apps/daemon/src/daemon/start.ts` (start after `recoverOnStartup`, `recoverBatches` and `recoverSending`;
  awaited in `stop()`), `apps/daemon/test/engine.ts`
- Test: `apps/daemon/src/stakeholders/loop.test.ts`, `apps/daemon/src/stakeholders/reply-watch.test.ts`

**Interfaces:**

- Consumes: Tasks 5, 7b and 8a.
- Produces: `createReplyWatch(deps: { state; slack; inbox; judge; clock; log; intervalMs: number }): { start(): void; stop(): Promise<void>; tick(): Promise<void> }`,
  `intervalMs` 60,000. One tick at a time; the next is scheduled when one ends. A tick reads each open send's
  conversation from its cursor (and its `moved_from` thread from that cursor), applies `conversationState` for the
  newest open send in each thread, and for `lone_reply` answers through `answerAs` with `inTx` running
  `markAnswered` and `setLastRead`. A card already answered by this reply is done; one answered otherwise just
  advances the cursor. A tick that starts more than three intervals after the last runs another at once (the Mac
  slept). `ratelimited` waits `retryAfterSeconds`. The other states are Tasks 8e and 8f's.

- [ ] **Step 1: Write the failing loop test** (`loop.test.ts`): route product to Mark in auto mode (sent to
      before); the lane asks; the fake Slack gets the message; its thread gains `B, we can't give away a week of
      service.`; two ticks; the card is answered by `mark`, the send `answered`, a decision by `mark` with a
      `slack_reply` source exists, and the resumed prompt starts "Mark answered your question in Slack." and quotes
      him.
- [ ] **Step 2: Write the failing engine rows** (`reply-watch.test.ts`; the pure cases are Task 5's): a restart
      between reading and the next tick doesn't deliver twice; a restart after Mark replies but before the watch saw
      it picks the reply up once; three sends and a two-hour clock jump answer all three, once each; the builder
      answers first, then Mark replies: no second answer, no second resume, no closing line about Mark; Mark's reply
      first, then the builder's Send Answer: a 409 and nothing changes; a follow-up in the same thread is answered
      by the reply after it, not by Mark's earlier reply. The words-never-reach-a-live-waiter row: with
      `TENDB_JUDGE=off` and Mark in auto mode (sent to before), a project category route gives Mark at insert; the
      lane asks; Mark replies at minute 3, before `humanWaitMinutes`; the session parked at the ask, its
      `ask_human` call never returned his words, and the lane gets them only in the quoted resume.
- [ ] **Step 3: Run** `pnpm --filter @10db/daemon test -- stakeholders`. Expected: FAIL.
- [ ] **Step 4: Implement.** **Step 5: Run**. Expected: PASS.
- [ ] **Step 6: Commit** `feat(daemon): a stakeholder's slack reply answers the card as them and resumes the task`.

`Value: protects=the answer coming back by itself, once; fails_when=a reply is missed after sleep, delivered twice after a restart, raced with the builder, or taken from an earlier question in the thread; why_new=no inbound path exists; no_claim=Slack's live delivery timing`.

### Task 8c: A refused token, and replies outside a thread

**Files:**

- Create: `apps/daemon/src/daemon/slack-services.ts` (modelled on `judge-services.ts`: the token's set, remove and
  status, and the connection state; Task 9 adds its routes)
- Modify: `apps/daemon/src/stakeholders/reply-watch.ts`, `apps/daemon/src/daemon/start.ts` (an `onFlagAnswer`
  handler for the "replied outside a thread" card)
- Test: `apps/daemon/src/stakeholders/reply-watch.test.ts` (extend)

**Interfaces:**

- Produces: a refused token stops the watch and sets the connection `refused` (`GET /slack` serves it; the desktop
  draws the card and puts the sent cards in Open in Task 12). Three ticks in a row that fail with `unreachable`,
  `timeout` or an HTTP 5xx set the connection `unreachable`; the next good tick sets it `connected` again. A
  removed token sets `none`. Task 12 treats every state but `connected` as an outage for Open. Sends stay `sent`. Reconnecting starts the watch from
  each send's cursor. The DM's top level is read from the contact's cursor, with the same quiet rule as a thread.
  A message there from a person with one open send answers it (`replyVia: 'top_level'`; a thread reply in Task 8b
  records `thread`). The first time a person replies at the top level, 10db posts `topLevelNudgeLine()` in that
  question's thread (for several open sends, in the thread of the one the flag card attaches it to) and sets the
  contact's `topLevelNudgedAt`, so it is never posted to them again. With several open sends, it opens one `flag` card on the
  newest open send's project ("<Name> replied outside a thread"). Its options are short labels ("Question 1",
  "Question 2", …, and "Dismiss"), the full questions are listed in its body, and `detail` maps each label to its
  card id; an option label is at most 80 characters and a question can be 2,000. Answering it hands the words to
  that card through `answerAs`; a card answered meanwhile is a conflict the handler logs and treats as done, so
  the flag always closes. A group DM's top level is read the same way, for its participants' open send there.

- [ ] **Step 1: Write the failing rows**: `token_revoked` on a tick sets `refused` once over five ticks and calls
      nothing more; two failing ticks leave `connected`, the third sets `unreachable` and a good one clears it;
      deleting the token with sends open sets `none` and stops the watch; Mark replies during the outage, the token is reconnected, the next tick answers his card once;
      a top-level message with one open send answers it with `replyVia: 'top_level'` and posts the nudge line in
      its thread; the person's second top-level reply gets no nudge; an in-thread reply never gets it and records
      `replyVia: 'thread'`; with two, one flag card, not raised again on the next tick
      or after a restart; answering the flag card with "Question 2" answers that card with his words; answering it
      after that card was answered closes the flag and changes nothing else; two open questions with 2,000-character
      titles give a flag whose DTO parses.
- [ ] **Step 2: Run**. Expected: FAIL. **Step 3: Implement.** **Step 4: Run**. Expected: PASS.
- [ ] **Step 5: Commit** `feat(daemon): a revoked slack token loses no reply, and a reply outside a thread finds its question`.

`Value: protects=no answer lost to an outage or to how people reply in a DM; fails_when=a reconnect drops replies written meanwhile, or a top-level reply raises a card every minute; why_new=Task 8b reads threads only, with a working token; no_claim=Slack's own error wording`.

### Task 8d: The reminder at 4 hours and the return at 8

**Files:**

- Create: `apps/daemon/src/stakeholders/timers.ts`, `apps/daemon/src/stakeholders/timer-watch.ts`
- Modify: `apps/daemon/src/daemon/start.ts` (the timer watch starts with the daemon, whatever Slack's state, and
  is awaited in `stop()`), `apps/daemon/src/stakeholders/reply-watch.ts` (a reminder owed while Slack wasn't
  connected is posted on reconnect), `packages/db/src/store/stakeholder-sends.ts` (`markReminded` and
  `markReturned` work out due-ness again inside their write), `packages/db/src/store/inbox.ts` (the DTO says the
  card is returned)
- Test: `apps/daemon/src/stakeholders/timers.test.ts`, `apps/daemon/src/stakeholders/reply-watch.test.ts` (extend)

**Interfaces:**

- Produces:
  - `dueTimers(send: { waitStartedAt; remindedAt; returnedAt; loneReplyPendingSince: string | null }, timers: StakeholderTimersDto, now): 'none' | 'remind' | 'return'`,
    pure, in wall-clock time from `waitStartedAt` (set by `markSent` and by Keep Waiting): `return` once
    `returnAfterHours` has passed and the send isn't returned; else `remind` once `remindAfterHours` (when not
    off) has passed and the send wasn't reminded. When both are due, `return` wins and the reminder is skipped. A
    return that comes due while a lone reply already waits for its quiet tick (`loneReplyPendingSince` set before
    the return was due) is `none` for that one tick.
  - The **timer watch** runs on its own interval (60,000 ms) on the injected clock, and on wake, with or without
    Slack: it never calls Slack. On `return` it calls `markReturned(timer)`, which recomputes `dueTimers` from the
    row inside its write and does nothing if it is no longer due, so two ticks never return a send twice; the card
    then counts in Open (Task 12 reads `send.returnedAt`). On `remind` with Slack connected, the reply watch posts
    `reminderLine()` in the conversation's thread (no review, never counted toward the limit) and `markReminded`
    recomputes the same way. A reminder due while Slack isn't connected waits, and is posted on reconnect if the
    send hasn't returned by then.
  - Keep Waiting (`keepWaiting`) restarts both. A reply after the return still answers the card. Changing the
    settings applies to open sends from the next tick.
  - Per provider: the timers run on the send, after the lane has asked, the same for every account kind.

- [ ] **Step 1: Write the failing rows.** `timers.test.ts`: 3h59m none; 4h remind; reminded at 4h, 7h59m none;
      8h return; both due (asleep from 1h to 9h) return without a reminder; reminder off, 8h return; a Keep Waiting
      at 9h restarts (13h remind, 17h return); a timer setting of 2h reminds at 2h; a lone reply seen at 7h59m
      holds the return one tick, and one first seen after 8h doesn't. Engine rows in `reply-watch.test.ts`: at 4
      hours one reminder is posted in the thread, once over three more ticks; a clock jump from 3h to 6h fires one
      reminder on the wake tick and no return; a clock jump from 3h to 10h returns the send once and posts no
      reminder; a reply at 9 hours answers the card and clears the return; a reminder posted to a moved send goes
      to the group DM; the token deleted with two sends open, then 8 hours pass: both return, with no Slack call;
      ticks that fail as `unreachable` across 8 hours: the send returns on time, and the reminder owed is posted on
      the first good tick only if the send hasn't returned; two timer ticks racing on one due send return it once.
- [ ] **Step 2: Run**. Expected: FAIL. **Step 3: Implement.** **Step 4: Run**. Expected: PASS.
- [ ] **Step 5: Commit** `feat(daemon): a quiet question gets one reminder at four hours and comes back to the builder at eight`.

`Value: protects=no task parked for long on a silent stakeholder, even with Slack disconnected, and timers that came due during sleep fire once on wake; fails_when=a reminder repeats, a return is missed after sleep or while Slack is down, or both fire after a long sleep; why_new=nothing times a send; no_claim=that the reminder gets a reply`.

### Task 8e: Bringing someone in

**Files:**

- Create: `apps/daemon/src/stakeholders/bring-in.ts`
- Modify: `apps/daemon/src/stakeholders/reply-watch.ts`
- Test: `apps/daemon/src/stakeholders/bring-in.test.ts`

**Interfaces:**

- Consumes: Tasks 4, 5 and 8b.
- Produces: on a tick, `mentionsToAdd` over the new messages; for new people, `openGroup(participants + new)` (at
  most eight people besides the bot: past it, `fullLine`), `userInfo` for each new name, a post of
  `broughtInLine` and the question's sent text in the group DM, `movedLine` in the old thread, and `moveSend` in one
  write. A refused open posts `couldntAddLine` in the current thread and changes nothing else. A follow-up question
  on the same task posts in the current conversation. None of these posts is reviewed or counted toward the daily
  limit. The repost carries the send's `tendb_send` metadata. Before reposting, 10db searches the group DM's
  history since the mention's `ts` for a bot message whose metadata names this send; found, it uses that message's
  `ts` for `moveSend` instead of posting again, so a crash between the post and `moveSend` never reposts. A group
  DM's channel id is used as Slack returns it, with no assumption about its prefix (the builder's check returned
  `C…`).
- Per provider: it runs on the send, after the lane has asked, the same for every account kind.

- [ ] **Step 1: Write the failing rows** (real store, fake Slack): Mark mentions Priya → one group DM with Mark
      and Priya, the brought-in line and the question posted there, the moved line in the DM, the send moved with
      Priya as a participant, not a recipient; the next tick reads Priya's reply in the group DM; a reply in the
      old DM thread after the move still counts, once; Priya mentions Dana → a new group DM with all three; a
      mention of the bot or of Mark himself does nothing; a ninth person gets the full line; a refused open gets the
      couldn't-add line and the send stays; a restart between the repost and the move finds the repost by its
      metadata in the group DM's history and doesn't repost; a group DM id starting `C` works like any other; the
      daily limit is unchanged after a move.
- [ ] **Step 2: Run**. Expected: FAIL. **Step 3: Implement.** **Step 4: Run**. Expected: PASS.
- [ ] **Step 5: Commit** `feat(daemon): a stakeholder brings a colleague into the question's conversation`.

`Value: protects=a mention reaches the person mentioned, and no reply is lost across the move; fails_when=a mention in a one-to-one DM goes nowhere, a reply in the old thread is dropped, or a crash reposts the question; why_new=nothing reads mentions or moves a conversation; no_claim=that Slack shows the group DM as drawn`.

### Task 8f: Agreeing an answer

**Files:**

- Create: `apps/daemon/src/stakeholders/agree.ts`
- Modify: `apps/daemon/src/stakeholders/reply-watch.ts`
- Test: `apps/daemon/src/stakeholders/agree.test.ts`

**Interfaces:**

- Consumes: Tasks 5, 8a, 8b and 8e; the judge.
- Produces: each tick passes the send's stored marks (`settledThroughTs`, `askedWhichWayAt` and its `ts`, the
  proposal and its `ts`, `approvalSeenAt` and `approvalBy`) to `conversationState`, and for what it answers:
  - `settled` (only when a message newer than `settledThroughTs` exists): asks `thread_answer` (options: the card's
    letters and `no_clear_answer`, each letter's label sent as its criterion; state: the question, the options and
    every participant message with its author). At or above the floor on a letter: posts `proposalLine` (the names
    of the participants whose messages favoured it, from the judge's state; every recipient mentioned), adds the
    ✅ to it at once (`addReaction(channel, ts, 'white_check_mark')`, so a recipient clicks the ✅ already there),
    and writes the proposal and `settledThroughTs` in one write. Reading an approval ignores the bot's own id in
    the reaction's `users`: approval means a recipient is there. A failed `addReaction` is logged; a typed "yes"
    and a ✅ added by hand still work. Otherwise (below the floor, `no_clear_answer`, or a
    fallback): posts `whichWayLine` and writes `askedWhichWayAt`, its `ts` and `settledThroughTs`. The outcome is
    recorded with `recordJudgeOutcome`. A quiet conversation after either line posts nothing more.
  - `approval_seen`: writes `approvalSeenAt` and `approvalBy` (the earliest approving recipient in routing order
    when two approve in one tick). The next tick confirms it as `approved` only if the ✅ is still there (or the
    "yes" stands) and no other recipient wrote since; otherwise the mark is cleared.
  - `approved` or `picked`: `answerAs` for that recipient (`readAs: 'approved'` or `'option'`), with the
    conversation and the other speakers in `with`.
  - `lone_reply` after a which-way line: Task 8b's path, with the conversation quoted; own words answer the card
    as own words.
  - `disagreed`: clears the proposal and `markReturned(disagreed)`; the card is in Open with the conversation.
  - `withdrawn`: clears the proposal; the next settle asks again.
  - A restart between a line's post and its write finds the line by its `tendb_send` metadata and doesn't post
    again.
  - Per provider: it reads the send's conversation, after the lane has asked, the same for every account kind.

- [ ] **Step 1: Write the failing rows** (real store, fake Slack, fake `Judge`): Priya says "B is the only option
      legal will sign off on", the conversation settles, the judge answers B at 0.9 → the proposal line naming
      Priya and mentioning Mark, with the bot's own ✅ added to it, and the judge was sent each letter's label as
      its criterion; the bot's own ✅ never approves, over three ticks; Mark's click on the pre-seeded ✅ (his id
      joins its `users`) approves; Mark's ✅ seen on one
      tick approves only on the next: the card is answered as Mark, approved, with Priya, and the decision names
      both; a ✅ removed before the confirming tick approves nothing; Mark's "C" instead → his pick; Mark's "hmm,
      not sure" → the proposal is withdrawn and the next settle asks again; Priya's ✅ approves nothing; quiet for
      two hours after a proposal posts nothing more; the judge at 0.6 → the which-way line, and quiet for two hours
      after it posts nothing more; Mark's own words after a which-way line answer the card as own words, with the
      conversation quoted; Mark's "B" after it answers B; the judge off → the which-way line; a tie (Mark and Ana):
      the proposal mentions both, Ana's ✅ answers as Ana; Mark's ✅ and Ana's ✅ in one tick answer as Mark (first
      in routing order); Mark "B" and Ana "C" → returned `disagreed`, no decision; Mark's ✅ and Ana's "hold on" in
      one tick → disagreed; a restart after the proposal is posted doesn't post it twice; the builder answering a
      card with an open proposal wins, and a later ✅ changes nothing.
- [ ] **Step 2: Run**. Expected: FAIL. **Step 3: Implement.** **Step 4: Run**. Expected: PASS.
- [ ] **Step 5: Commit** `feat(daemon): a conversation's answer is proposed by the judge and approved by a recipient`.

`Value: protects=a discussion becomes one decision only when a recipient approves it, nothing is posted twice, and disagreement reaches the builder; fails_when=a non-recipient's ✅ decides, a removed ✅ approves, a quiet thread is asked again every tick, a disagreement records a decision, the judge's unsure answer is proposed, or a restart proposes twice; why_new=nothing reads a conversation with more than one person; no_claim=that the judge reads conversations well (judge_calls shows it)`.

### Task 9: The lane hears who answers, and the API

**Files:**

- Create: `packages/db/src/store/question-routes.ts` (`questionRoutesForTask`)
- Modify: `apps/daemon/src/briefing/context-pack.ts` and `prompts.ts` (the spec §7.1 section with the topics line),
  `apps/daemon/src/api/app.ts`, `apps/daemon/src/api/services.ts` (`ApiServices`), `apps/daemon/src/api/app.test.ts`
  (the stub), `apps/daemon/src/daemon/services.ts`, `apps/daemon/src/daemon/slack-services.ts` (Task 8c made it),
  `apps/daemon/src/screens/render-access.ts`
- Test: `apps/daemon/src/briefing/briefing.test.ts` (extend), `apps/daemon/src/api/stakeholders-routes.test.ts`

**Interfaces:**

- Produces routes (each body parsed with its Task 1 schema; each new GET classified in `render-access.ts`):
  - `GET /slack` → `SlackConnectionDto`; `PUT /slack/token { token }` (checked with `authTest` before it is saved; a
    refusal is 400 with Slack's code in words); `DELETE /slack/token`.
  - `GET /slack/members?query=` → `SlackMemberDto[]` (kept in memory for 10 minutes).
  - `GET /people`, `POST /people`, `PUT /people/:personId`, `DELETE /people/:personId`.
  - `GET /stakeholders/timers` and `PUT /stakeholders/timers` (`StakeholderTimersDto`).
  - `GET/PUT /projects/:projectId/routing-rules` with goal, task and topic routes.
  - `GET /tasks/:taskId/question-routes` → `QuestionRouteDto[]`.
  - `POST /inbox/:id/send` (`SendInput`), `POST /inbox/:id/ask` (`AskSomeoneInput`), `POST /inbox/:id/take-back`,
    `POST /inbox/:id/keep-waiting`, and `GET /inbox/:id/compose?personIds=` → `{ text: string; hits: OutboundHit[] }`.
  - `GET /inbox` items carry `send`, `assignees`, `routedBy` and `routeSuggestion`.
- `questionRoutesForTask(db, taskId): QuestionRouteDto[]` is a pure read over rows; the briefing and the route both
  use it. The briefing names each category route's people, says who gets the rest, and lists the project's topics
  for `ask_human`'s `topic` when there are any.

- [ ] **Step 1: Write the failing tests**: briefing rows for a task routed to Mark (the §7.1 text with his name and
      categories), a tie (both names), a project with topic routes (the topics line), and an unrouted task (no
      section). Routes through `app.request()`: each answers its DTO; `PUT /slack/token` with a refused token
      answers 400 and stores nothing (memory keychain); `PUT /stakeholders/timers` refuses 0 hours, refuses a reminder at or after the return, and stores 6;
      `POST /inbox/:id/send` on a held draft answers 400 naming the pattern; the answer route ignores `answeredBy`;
      `POST /inbox/:id/ask` with `always` writes the routes; the compose route answers the text for a person without
      Slack.
- [ ] **Step 2: Run**. Expected: FAIL. **Step 3: Implement.** **Step 4: Run**. Expected: PASS.
- [ ] **Step 5: Commit** `feat(daemon): the lane is told who answers, and people, slack, timers and routes are served`.

`Value: protects=the lane writing for its reader and the routes' contracts; fails_when=a stakeholder's question is written for an engineer because the lane wasn't told, a topic never reaches the lane, or a client answers as someone else; why_new=no route serves people, slack or sends; no_claim=the UI`.

### Task 10: Settings › People and the Slack connection

**Files:**

- Create: `apps/desktop/src/views/settings/people/people-section.tsx`, `slack-connection.tsx`, `person-modal.tsx`,
  `member-select.tsx`, `stakeholder-timers.tsx`, `slack-manifest.ts`, `apps/desktop/src/daemon/people.ts`
- Modify: `apps/desktop/src/views/settings/sections.ts` (a global People section), `section-body.tsx`,
  `apps/desktop/src/daemon/events.ts` (`INVALIDATIONS`: `person`, `slack` and `stakeholder_timers` refetch theirs),
  `tests/repo/src` (a test that `docs/slack-app.md`'s manifest equals `slack-manifest.ts`'s)
- Test: `people-section.test.tsx`, `person-modal.test.tsx`, `stakeholder-timers.test.tsx`

Spec §10.1 and §10.5; artboards 5–7.

- [ ] **Step 1: Write the failing tests** (`renderWithDaemon`): not connected shows the three steps, and Copy
      Manifest copies the manifest; a refused token shows Slack's reason beside Connect; connected shows "Connected
      to Acme · as @10db"; Add Person picks a member, proposes the handle, and saves review mode and limit 10; the
      limit's Off switch saves `dailyLimit: null`; the limit's description says replies, follow-ups and the
      conversation in a thread never count; "Someone not in Slack" saves a person with no contact; removing a
      routed person shows the daemon's refusal; the builder's row has no Remove; the timers show 4 and 8 hours,
      Remind After can be turned off, and a change saves. Repo test: the doc's manifest matches.
- [ ] **Step 2: Run** `pnpm --filter @10db/desktop test -- people stakeholder-timers`. Expected: FAIL.
- [ ] **Step 3: Implement.** **Step 4: Run**. Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): people, the slack connection and the stakeholder timers in settings`.

`Value: protects=connecting Slack, binding a person by pick, and setting the limit and timers; fails_when=a refused token reads as connected, a person is saved without a member id, or the limit can't be turned off; why_new=no people UI exists; no_claim=Slack's live install`.
`Value: protects=the setup guide and the app agree on the manifest; fails_when=one changes without the other; why_new=nothing compares them; no_claim=that Slack accepts it`.

### Task 11: The routed card and Ask Someone…

**Files:**

- Create: `apps/desktop/src/views/inbox/slack-preview.tsx`, `ask-someone.tsx`, `route-line.ts`
- Modify: `apps/desktop/src/views/inbox/inbox-card.tsx`, `card-answer.ts`, `use-inbox-keys.ts`
- Test: `slack-preview.test.tsx`, `ask-someone.test.tsx`, `route-line.test.ts`

Spec §10.2; artboards 1 and 2.

- [ ] **Step 1: Write the failing tests**: a card with a draft opens on "Mark will get" and the draft's text; ⌘↵
      sends (no `text` in the body unless edited) and a bare Enter or a digit does nothing in the preview; Edit then
      Done sends the edited text; Answer Myself shows today's options, and Enter answers; a draft with
      `heldBy: 'scan'` shows the spec's alert and Send is disabled; `heldBy: 'limit'` shows "Mark has had 10 new
      questions today" and Send Anyway, which posts `overrideLimit: true`; `heldBy: 'first_send'` shows "First
      message to Mark: check it before it goes"; `heldBy: 'review'` shows the plain preview; a warning shows the dimmed line and Send stays enabled; a tie reads "Mark
      and Ana will get" and Send to Mark and Ana; a pending card shows "Finding who answers…"; a suggestion shows
      "Suggested: Sarah (64%)" and opens the popover on Sarah with Always unticked; on a routed card Change opens
      the popover and there is no footer Ask Someone…; on an unrouted card Ask Someone… (variant default) with
      Product, Design and Business offered and Product and Design ticked at goal scope posts `always` with both and
      the card turns into the preview; choosing a person without Slack makes the primary Copy for Priya, which
      copies the compose route's text; a card with no send renders as today (the same role tree). `route-line`
      table: each scope's words, the triaged words with the confidence, and a tie.
- [ ] **Step 2: Run**. Expected: FAIL. **Step 3: Implement.** **Step 4: Run**. Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): a routed question shows what its people will get, and any question can be sent`.

`Value: protects=reviewing before anything leaves; fails_when=a keystroke meant for the next card sends a message, or a held message can be sent; why_new=the card has no send path; no_claim=Slack's rendering`.
`Value: protects=filling the routing table from the card, and acting on the judge's suggestion; fails_when=Always writes the wrong scope or only one of the ticked categories, or a suggestion opens on the wrong person; why_new=nothing writes routes from the UI; no_claim=the table view (Task 13)`.

### Task 12: The Inbox's Waiting tab, its counts and its cards

**Files:**

- Create: `apps/desktop/src/views/inbox/waiting-inbox.tsx`, `waiting-row.tsx`, `conversation-view.tsx`
- Modify: `inbox-view.tsx` (three tabs), `inbox-rows.ts` and `inbox-count.ts` (Open, the sidebar and the menu bar
  leave out cards whose send is `sent` and not returned, and `triage_pending` cards), `resolved-inbox.tsx`,
  `system-cards.ts` (the refused-token card from `GET /slack`), `apps/desktop/src/daemon/events.ts`
  (`stakeholder_send` refetches the inbox, goals and workstreams), `apps/desktop/src/desktop/sync.ts` (no
  notification for a card that goes straight to Waiting or is pending triage at `inbox.opened`; one on
  `inbox.triaged` with `toBuilder`, worded as for a new card; one when a stakeholder answers: "Mark answered:
  <question>"; one when recipients disagree: "Mark and Ana disagree: <question>")
- Test: `waiting-inbox.test.tsx`, `inbox-rows.test.ts` (extend), `system-cards.test.ts` (extend)

Spec §10.3; artboard 3.

- [ ] **Step 1: Write the failing tests**: a sent card is in Waiting and in no count; a pending card is in no
      count; a draft is in Open; a failed send is in Open with Slack's words; a send returned by its timer is in
      Open with "Mark hasn't answered in 8 hours", Answer Myself, Keep Waiting and Take Back; a disagreed send is in
      Open with "Mark and Ana disagree" and the conversation; while the Slack connection is `refused`, `none`,
      `off` or `unreachable` (a row each), every sent card is in Open with that state's notice and leaves again
      when it is `connected`; Take Back from Waiting moves it to Open; ↗
      opens the permalink through the app's opener; the Waiting badge is the neutral tone; a row for a tie reads
      "Mark Ellis + Ana Ortiz", one with Priya brought in adds "with Priya", and a reminded one "reminded 1h ago";
      the expanded row shows the conversation and "Proposed B, waiting for Mark's ✅"; Resolved shows "Answered by
      Mark in Slack", "Read as B", "In his own words" or "Approved B · with Priya", and the words; a refused
      connection shows the 10db card; the notification rows, including none at `inbox.opened` for a pending card
      and one at `inbox.triaged` when triage leaves it with the builder, and none when triage routes it away.
- [ ] **Step 2: Run**. Expected: FAIL. **Step 3: Implement.** **Step 4: Run**. Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): questions out with other people wait in their own tab`.

`Value: protects=Open meaning "needs you"; fails_when=a question waiting on Mark counts in the badge, or one back after eight hours or after a disagreement doesn't; why_new=the Inbox has two tabs and no notion of someone else; no_claim=goals`.

### Task 13: Who Answers, the drawer, the Board card and Factory

**Files:**

- Create: `apps/desktop/src/views/settings/who-answers-section.tsx`, `add-route-modal.tsx`,
  `apps/desktop/src/views/board/question-routes-line.tsx`
- Modify: `sections.ts` (Routing rules becomes Who Answers, `built: true`), `section-body.tsx`,
  `views/board/task-drawer.tsx`, `views/board/task-state.ts` and the card's border rule, the workstream DTO and its
  store (`waitingOn: { names: string[]; since: string } | null`, set only while the task's card has a `sent` send
  that isn't returned, so the line never contradicts Open; daemon tests that `toEqual` a whole `WorkstreamDto` gain
  the field),
  `packages/db/src/store/goal-digest.ts` (`GoalStatus.WaitingOnSomeone`; Needs you by the same rule as Open;
  `GoalDigestDto` gains who each waiting card is on), the Factory goal view, `apps/desktop/src/daemon/events.ts`
  (`routing_rules` refetches Who Answers and question routes), `DESIGN.md` (the Waiting tab; "waiting on someone"
  is a line, never a yellow border)
- Test: `who-answers-section.test.tsx`, `add-route-modal.test.tsx`, `question-routes-line.test.tsx`,
  `goal-digest.test.ts` (extend), the card-state table

Spec §10.4; artboards 8–10.

- [ ] **Step 1: Write the failing tests**: Who Answers groups rows by Task, Goal, Area, Project and Topic, with the
      dimmed "Everything else → You", the precedence line, and the "Without Jev…" line when the judge is off; a
      project category with two people shows both; Add Route writes one row per ticked category, and a topic route
      with its words; a topic can't be given a goal scope; the drawer reads "Questions go to Mark (product,
      design), from the goal · Change"; a task waiting on Mark keeps its own border and says "Waiting on Mark in
      Slack · 3h", one waiting on a tie says "Waiting on Mark and Ana in Slack · 3h", while one waiting on the
      builder keeps the yellow border; the goal's status is waiting on someone when only a sent card is open, and
      waiting on you when a draft or a builder card is.
- [ ] **Step 2: Run**. Expected: FAIL. **Step 3: Implement.** **Step 4: Run**. Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): who answers what, and waiting on someone, everywhere a task shows`.

`Value: protects=seeing who a task waits on without opening it; fails_when=a goal waiting on Mark reads "waiting on you"; why_new=WaitingOnSomeone is never derived; no_claim=reminders`.
`Value: protects=reading and editing routes in one place, topics and ties included; fails_when=a scope's rows go missing from the table, or a topic route is written with a goal; why_new=Routing rules is a planned section; no_claim=routing itself (Tasks 3 and 3b)`.

### Task 14: End to end, the decision and the docs

**Files:**

- Create: `apps/desktop/e2e/stakeholder-questions.spec.ts`, and in the decisions folder a file named
  `stakeholder-questions-run-on-the-inbox-card`, dated the day it is written (named apart here, because a repo
  test refuses a citation of a decision file that doesn't exist yet)
- Modify: `apps/daemon/AGENTS.md`, `apps/desktop/AGENTS.md`, `docs/slack-app.md` (Status: built),
  `docs/open-items.md` (slices 2–4 of the spec's §12, and the follow-up for someone outside the workspace), the
  goals spec §10 (a pointer to this spec)

The decision records S1 (the loop runs on the card, not after goals phase 2), S12–S14 (triage by the judge, a
conversation approved by a recipient, ties asked together), amends the goals spec's §9 escalation (a 4-hour
reminder and an 8-hour return, not `humanWaitMinutes`) and §12 (phase 3's stakeholder loop is this), and amends
DESIGN.md's "every Inbox card waits on the builder" and
`decisions/2026-11-08-the-inbox-holds-what-needs-the-builder.md`: Open keeps that promise, and Waiting holds what
the builder waits on.

- [ ] **Step 1: Write the e2e spec**, without Slack (the e2e daemon runs with `TENDB_SLACK=off`, `TENDB_JUDGE=off`
      and no Keychain; the Slack leg is Tasks 8b–8f's tests and the builder's live acceptance). Flow: add Priya as
      "Someone not in Slack", route product questions on the project to her from a card's Ask Someone… with Always
      ticked, see the card offer Copy for Priya, answer it as the builder, and see the row in Who Answers. Run axe
      on People, the card and Who Answers. It is a new flow over finished wiring, so it is written green; say so in
      the commit.
- [ ] **Step 2: Run** `pnpm --filter @10db/desktop e2e -- stakeholder-questions`. Expected: PASS.
- [ ] **Step 3: Write the decision and the docs.**
- [ ] **Step 4:** Outside 10db, run `make gate` and read the end of its output for `GATE PASS`. In a 10db lane, leave
      it to 10db.
- [ ] **Step 5: Commit** `test(desktop): routing a question to someone outside slack, end to end` and
      `docs: stakeholder questions run on the inbox card`.

`Value: protects=routing from a card through the real daemon and UI; fails_when=the route, card and table don't agree in the running app; why_new=unit tests render components alone; no_claim=Slack or the judge, which are off in e2e`.

**Live acceptance (the builder, after merge):** connect the real app; add yourself as a second person, "Me in
Slack" (your own Slack user), and a colleague who agrees to help; route product questions on a scratch project to
"Me in Slack"; start a task whose description makes the lane ask a product question; Send; reply in Slack from
your phone; watch the task resume. Then ask a second one, mention the colleague in the thread, let them answer in
the group DM, and approve the "Sounds like" line with ✅. Add a topic route ("billing") to the colleague and see a
billing question triaged to them. Then close the lid for five hours with a question out, open it, and see the
reminder posted once; reply, and see the reply picked up within two minutes.

## After this slice

Slices 2–4 are in spec §12. Each gets its own plan once slice 1 has run for a week of real questions. Look first at
how often a preview was edited before sending (that decides the LLM rewrite), how many replies were "in their own
words" (that decides buttons and reply reading), and how often triage and `thread_answer` fell below the floor
(Settings › Decisions shows it).
