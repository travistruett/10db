# Plan: 10db answers a stakeholder's question, and routes the deeper ones to you

**Size:** Core (10db's Careful). The plan sends model-written text out of the laptop to a person, and it changes
when a reply answers a card and what a send records. So it gets this index, one card per task and a plan review.
Per card: 1, 2, 4 and 5 are Core; 3 is Core because it is the Codex writer's tool lock; 6 is Feature; 7 is Small.
**Spec:** `docs/superpowers/specs/2026-11-11-10db-stakeholder-questions-design.md`: S8, S9, S13, §7.3, §7.4,
§8.2, §8.3 and §8.5. Card 7 adds a section to it.
**Builds on:** `main` at f46749b2, which already has the friendlier opening line and the calmer Waiting card (#812).
**Review:** round 1 (Fable 5.2) found five blocking issues; this version takes them and most of the rest.

## Brief

**What changes for you.**
- A stakeholder can talk to 10db in the question's thread.
- Today any reply that isn't a letter answers the card as "In Mark's words". That includes "what is this for?",
  which resumes the lane on a non-answer. From now on 10db reads each reply as one of four things:
  - **An answer** (a pick, or own words that answer): it answers the card, as today.
  - **A simple question**, answerable from what 10db already holds: @10db replies in the thread with
    "🤖 *10db (automated reply):* …" and a line saying you haven't reviewed it. The card keeps waiting for the
    pick.
  - **A deeper question** (your intent, your judgement, facts 10db doesn't have), or 10db isn't sure: the card
    comes back to your Inbox's Open tab as **"Mark asked: …"**. You get a notification and a reply box. Your
    reply goes into the thread from @10db as "Travis (via 10db): …", and the card goes back to waiting on Mark.
    You can also just answer the card yourself.
  - **Chatter** ("thanks, looking now"): nothing happens.
- The question message gains a last line: "Questions? Ask here: 10db answers what it can and passes the rest to
  Travis."

**What it buys.** "What is this for?" no longer closes a card. Small clarifications stop costing you a relay, and
the ones that need you reach you with the question quoted, instead of the lane guessing.

**What could go wrong, and how we'd know.**
- **10db says something wrong or too much.** The writer sees only:
  - the card's title, body and options;
  - the task's title, description and acceptance criteria;
  - the lane agent's last three messages on the card (`inboxCardContext`, agent messages only; your own messages
    to the lane never go to the writer);
  - the goal's title.

  It has no tools and no files. Its answer must fit 700 characters and pass the outbound scan (secrets, URLs,
  code blocks, file paths). If it doesn't, or the writer says it can't answer from that context, the question comes to you.
  Each automated line is in the thread for you to read. The writer is told never to choose an option or speak
  for you, and the fixed footer says you haven't reviewed it.
- **It answers forever.** After three automated answers on one question, every further question comes to you.
- **It answers where it mustn't.** Nothing is posted:
  - while the project's Slack is Off;
  - when the send's workspace is no longer the project's;
  - when the judge's `reply_kind` switch or its master switch is off;
  - when you answered, took back or the card closed while the answer was being written (checked again right
    before the post).
- **A crash posts twice.** Every line carries `tendb_send` metadata with the reply's `ts` as its key, and the
  next tick finds it before posting.
- **"Mark asked" floods you.** You get one notification per question that reaches you. Chatter never notifies.

**Calls you might disagree with.**
1. **The judge sorts the reply, and your project's own account writes the answer.** The judge is a fast
   classifier that can't write prose. The writer is a one-shot question to the project's account at its
   Efficient tier, with no tools, so it bills to the project's own line on every provider.
2. **With no Decisions account, or the judge off, 10db never answers a question itself.** The fallback is a rule:
   - a letter or label is a pick;
   - any other reply with a "?" or starting with a question word comes to you;
   - anything else is own words, as today.

   A Claude-plan-only setup therefore gets the routing fix but not automated answers. Cost if wrong: let the
   writer sort replies too, one Claude Code start per reply.
3. **Automated answers skip review, even for people set to Review Each.** A thread that went out was reviewed or
   allowed, and follow-ups in it already skip review (§7.4). The scan still holds. Cost if wrong: hold each answer
   for Review Each people, which brings the relay back.
4. **Your own reply is held only for secrets**, not for a URL or a code block. You are the reviewer, and the URL
   and code holds exist for agent text.
5. **In a group conversation, only the judge sorts replies.** Without it, a "?" between participants ("Ana, what
   do you think?") would pull you in every time, so with no judge a group behaves as today.
6. **On Codex, card 3 adds a tool-locked one-shot turn that only the answer writer calls.** `complete()` on a
   Codex account keeps refusing (`CODEX_NO_QUESTIONS`), so pass review, area naming and hazard assessment behave
   as today; moving them onto the new turn is a follow-up. The lock ships only with a live test proving a shell,
   MCP and web call never run. If it can't be proven, Codex projects ship sending every question to you, the
   Settings › Judge `reply_kind` row says so, and a follow-up task closes the gap.
7. **A declined or held automated answer is not shown to you.** You get Mark's question, not 10db's attempt.
   The attempt never leaves the laptop.
8. **This crosses "sending data out" without your click**, inside the bounds above. You asked for it. The
   context is the question the lane wrote for this person, the lane agent's last messages on the card, and the
   task's own text. Cost if wrong: drop the agent messages too, and answer from the question and task only.
9. **When 10db doesn't answer, the "Mark asked" card says why** (it couldn't answer from what it holds, the
   account is paused, Codex can't yet, the answer was held, or it already answered three).

**What is needed from you.** Nothing to start. For live QA after it lands: Slack on, a Decisions account, and a
person you can ask questions of in a DM.

---

## Global Constraints

- Read `AGENTS.md`, `.claude/rules/code-style.md`, `.claude/rules/testing.md`, `apps/daemon/AGENTS.md` (its
  "Stakeholder questions" section) and `apps/daemon/src/stakeholders/AGENTS.md`, plus each `AGENTS.md` in a
  directory you touch, once each.
- **Never call live Slack or a live model.** Tests use the fake Slack `fetch` (as in
  `stakeholders/workspace-sends.test.ts`), a fake `Judge` and a fake `AnswerWriter`. Agents never read the
  Keychain or the real database.
- **One migration, generated last.** Card 1 generates one to develop against. The coordinator deletes it and
  regenerates after the final merge of `main`. Only one open PR adds migrations at a time.
- **Every Slack line 10db posts** goes through `postLine` with `tendb_send` metadata and a `key`, is escaped,
  is `verbatim`, and is found with `findLine` before it is posted again.
- **Model text never reaches Slack unscanned.** `scanOutbound` runs on the final line text; any `hold` declines.
- **The stakeholder's words are data.** The writer's prompt quotes them as data, never as instructions, the way
  the resumed prompt does (spec §8.3).
- Time comes from the injected `Clock`. Constants are `as const` objects. Every boundary (the writer's output,
  the API body) parses with zod.
- Tests: only those on the cards, each with a value card in its commit.
- While working, run `pnpm vitest related <files> --maxWorkers=2` plus typecheck and lint of the changed
  packages. Before handing back, run `make precheck`. Never the full suite. Never `make check-changed` on the
  integration branch.
- Commits name their paths. Scopes: `daemon`, `desktop`, `contracts`, `db`, `docs`.

## Provider parity

| Project account | Sorting a reply (`reply_kind`) | Writing an answer |
|---|---|---|
| Claude plan | On the Decisions account (OpenRouter, an API key or Bedrock) if one is set; otherwise the rule fallback, so questions come to you | `complete()` through the Claude adapter, on the project's plan, Efficient tier |
| Claude via API key or Bedrock | Same | `complete()` through the Claude adapter, on that account |
| ChatGPT/Codex plan (and OpenRouter, which runs the Codex harness) | Same | `completeWithCodex` (card 3), the tool-locked turn; `CodexAdapter.complete` still refuses. If the lock can't be proven, the writer answers `declined: provider` and questions come to you; Settings › Judge's `reply_kind` row says so |
| Any account paused, over its cap or signed out | Same | The writer answers `declined: no_account`, and the question comes to you |

Everything else (the routing, the builder's reply, the invite line, the notification) runs on the card and the
send after the lane asked, so it is the same on every provider.

## Interfaces

```ts
// packages/contracts/src/judge.ts (card 1)
JudgeDecision.ReplyKind = 'reply_kind'   // + shapeDecision() config, default, patch, desktop catalogue entry

// packages/contracts/src/slack.ts (card 1)
export const ReplyKind = {
  Answer: 'answer', SimpleQuestion: 'simple_question', BuilderQuestion: 'builder_question', Chatter: 'chatter',
} as const;
export type ReplyKind = (typeof ReplyKind)[keyof typeof ReplyKind];
export const AskedQuestion = z.object({ userId: z.string(), name: z.string(), text: z.string(), ts: z.string(),
  /** Why 10db didn't answer it itself; null when the sorter sent it straight to the builder. */
  declined: z.enum(['not_answerable', 'held', 'too_long', 'unparseable', 'failed', 'no_account', 'provider',
    'cap']).nullable() });
// StakeholderSendDto gains:
//   asked: AskedQuestion.nullable()        the question waiting on the builder
//   autoAnswers: z.int().min(0)            automated answers posted on this send
//   returnedReason: z.enum(['timer', 'disagreed', 'asked']).nullable()
export const StakeholderReplyInput = z.strictObject({ text: z.string().trim().min(1).max(2000) });

// packages/db/src/store/stakeholder-sends.ts (card 1); each guarded to `sent`, each one write
export function markHandled(ctx: WriteContext, id: StakeholderSendId, throughTs: string): void;
export function recordAutoAnswer(ctx: WriteContext, id: StakeholderSendId, throughTs: string): void;
/** asked, handledThroughTs; on a send still out (W) also returnedAt and returnedReason 'asked'. On a send
 *  already returned by timer or disagreement (T) the reason is kept, so `afterDisagreement` still reads. */
export function markAsked(ctx: WriteContext, id: StakeholderSendId,
  input: { readonly asked: AskedQuestion; readonly throughTs: string }): void;
/** Only when `asked.ts === askedTs` (else a no-op: a newer question arrived and stays in Q): asked, returnedAt,
 *  returnedReason, remindedAt cleared; waitStartedAt = at. */
export function answerAsked(ctx: WriteContext, id: StakeholderSendId,
  input: { readonly askedTs: string; readonly at: string }): void;
// OpenSendRow gains: handledThroughTs: string | null; autoAnswers: number; asked: AskedQuestion | null

// apps/daemon/src/stakeholders/reply-kind.ts (card 2)
export const AUTO_ANSWER_CAP = 3;
/** The rule when no judge reads the reply. Never SimpleQuestion. */
export function ruleReplyKind(reply: { words: string; messageCount: number },
  options: readonly InboxOption[]): ReplyKind;
export interface ReplyKindRead { readonly kind: ReplyKind; readonly source: 'rule' | 'judge';
  readonly callId: JudgeCallId | null }
export function classifyReply(
  deps: { readonly judge: Judge; readonly floor: () => number; readonly log: Logger },
  input: { readonly card: InboxItemDto; readonly words: string; readonly messageCount: number;
           readonly author: string; readonly group: boolean },
): Promise<ReplyKindRead>;

// apps/daemon/src/sessions/codex-complete.ts (card 3), exported from the sessions entry point
// One ephemeral, tool-locked Codex turn. Only the answer writer calls it; CodexAdapter.complete keeps rejecting
// with CODEX_NO_QUESTIONS. CompletionSpec and CompletionError are unchanged.
export function completeWithCodex(spec: CompletionSpec, opts: CodexCompleteOptions): Promise<string>;

// apps/daemon/src/stakeholders/question-context.ts (card 4)
export interface QuestionContext {
  readonly card: { title: string; body: string; options: string[]; recommendation: string | null };
  readonly task: { title: string; description: string; acceptanceCriteria: string[] } | null;
  readonly goalTitle: string | null;
  /** The lane agent's own messages only; the builder's messages to the lane never reach the writer. */
  readonly laneMessages: readonly { text: string }[];
  readonly projectName: string;
  readonly builderName: string;
}
export function questionContext(db: DbReader, cardId: InboxItemId): QuestionContext;

// apps/daemon/src/stakeholders/answer-writer.ts (card 4)
export const ANSWER_LIMIT = 700;
export type WrittenAnswer =
  | { readonly kind: 'answer'; readonly text: string }
  | { readonly kind: 'declined';
      readonly reason: 'not_answerable' | 'held' | 'too_long' | 'unparseable' | 'failed' | 'no_account' | 'provider' };
export type AnswerWriter = (input: {
  readonly cardId: InboxItemId; readonly question: string; readonly askerName: string;
  readonly signal?: AbortSignal }) => Promise<WrittenAnswer>;   // never throws
/** Pure: the model's raw output to a WrittenAnswer (zod parse, size cap, scan). */
export function acceptWritten(raw: string): WrittenAnswer;
// apps/daemon/src/daemon/answer-writer-launch.ts (card 4): createAnswerWriter(deps): AnswerWriter

// apps/daemon/src/stakeholders/lines.ts (cards 5, 6, 7)
export function automatedAnswerLine(answer: string, letters: readonly string[], builderName: string): string;
export function builderReplyLine(builderName: string, text: string): string;
export function questionsInviteLine(builderName: string): string;

// apps/daemon/src/stakeholders/sends.ts (card 6)
replyAsBuilder(cardId: InboxItemId, text: string): Promise<InboxItemDto>;
// API (card 6): POST /inbox/:id/stakeholder-reply  body StakeholderReplyInput → InboxItemDto
```

## State table (design, not a test list)

Keys: **W** = sent and out (no `returnedAt`). **Q** = returned, `returnedReason: 'asked'`. **T** = returned by
timer or disagreement (today). A **group** is a conversation with more than one participant
(`participants.length > 1`), whoever has spoken. Routing follows `conversationState`'s path: a conversation on
the lone branch (one recipient, only they spoke) takes the lone route even when others were brought in; the
per-message group route covers only conversations on the settle path. "Reply" means a lone recipient's messages after
`handledThroughTs`, joined, on their quiet tick. In a group, it means one new participant message after
`handledThroughTs`. `handledThroughTs` is the sorting cursor only; `lastReadTs` still moves only when the card
is answered, so settling and the quoted exchange read the whole conversation as today.

| # | State | Event | Outcome |
|---|---|---|---|
| 1 | W | reply picks a letter or label (rule) | answered as today; the judge is not asked |
| 2 | W | reply sorted `answer` | answered as own words, as today; the lane gets the conversation, automated and builder lines included |
| 3 | W | sorted `simple_question`, autoAnswers < 3, binding ok, writer answers | `automatedAnswerLine` posted (key = reply ts); `recordAutoAnswer`; stays W |
| 4 | W | `simple_question` but autoAnswers = 3, or the writer declines, or binding Off/changed | `markAsked` → Q |
| 5 | W | sorted `builder_question`, or `simple_question` below the floor | `markAsked` → Q |
| 6 | W | sorted `chatter` | `markHandled`; stays W; no line |
| 7 | W | judge can't run, lone reply ends "?" or starts with a question word | `markAsked` → Q (the escaped bug: "what is this for?") |
| 8 | W | judge can't run, group message | as today (no sorting) |
| 9 | Q | builder replies | `builderReplyLine` posted (key = asked ts + text hash); `answerAsked` → W, timers restart |
| 10 | Q | builder answers the card | as today: send closed, "Travis answered this one" |
| 11 | Q | Keep Waiting / Take Back | as today; Keep Waiting also clears `asked` |
| 12 | Q | Mark answers (rows 1–2) | answered; card leaves Open |
| 13 | Q | Mark asks again | `asked` replaced by the newest; one more notification; no automated answer while in Q |
| 14 | Q or T | timers | none fire (returned sends owe nothing, `dueTimers`) |
| 15 | W | crash after an `auto_answer` post, before its write | next tick: `findLine(…, 'auto_answer', { key })`, the key being the reply's first `ts` after `handledThroughTs`, finds it; the write runs; nothing reposts, even if Mark wrote again meanwhile |
| 16 | W | proposal open (group) | unchanged; `approval_read` and settle rules as today |
| 17 | W | during the writer's call: the builder answers or takes back, the card closes, Slack goes Off or the binding changes, or another write moved `handledThroughTs` | re-read before the post finds it; nothing posts; nothing written (the next tick re-sorts if still W) |
| 18 | W | `recordAutoAnswer` or `markAsked` meets a `ConflictError` (the send moved) | caught and logged for that send only; the tick goes on to the other sends |
| 19 | T | Mark asks anything | `markAsked` sets `asked` and keeps the reason; one notification; never an automated answer. The card shows the question and the reply box (they key on `asked !== null`); the builder's reply clears the return and restarts the timers, as in Q |
| 20 | Q | group disagreement or settle | as for T today: `settleConversation` doesn't check `returnedAt`, so proposals and which-way lines still post; unchanged |
| 21 | Q | crash after a `builder_reply` post, before `answerAsked` | stays Q; the builder's Send Reply again finds the line by its key and only writes |
| 22 | Q | Mark asks again between the builder's post and `answerAsked` | `answerAsked` with the older `askedTs` is a no-op; the newer question stays in Q |

## Tracks and tasks

Track A runs in order: 1 → 2 → 4 → 5 → 6 → 7. Track B is card 3, built alone after card 1; its switch of the writer's Codex branch lands after card 4. Card 4 lands with a
writer that declines `provider` on Codex; card 3, once its live test passes, switches the writer's Codex branch
to `completeWithCodex`.

1. `task-1.md`: contracts, the send's new columns and store functions, the `reply_kind` decision. Core.
2. `task-2.md`: the reply sorter: rule fallback and judge read. Core; one pure rule-table test.
3. `task-3.md`: `completeWithCodex`: an ephemeral, tool-locked turn for the answer writer only. Core (the
   tool lock); one live test.
4. `task-4.md`: the question context and the answer writer. Core; one pure test of `acceptWritten`.
5. `task-5.md`: routing in the reply watch: answer, auto-answer, ask the builder, chatter. Core; the
   escaped-bug regression and the routing tests.
6. `task-6.md`: the builder's reply: route, service, the Open card's "Mark asked", the notification. Feature.
7. `task-7.md`: the invite line, the e2e extension, the spec section, the decision record and the notes. Small.

## Decision record (card 7)

A new file in `docs/architecture/decisions/`, named
`2026-11-24-10db-answers-simple-stakeholder-questions-and-routes-the-rest.md`. It amends `decisions/2026-11-12-stakeholder-questions-run-on-the-inbox-card.md` and spec S8 and S9, and records:
- the four reply kinds;
- the judge sorts and the project's account writes;
- the rule fallback;
- the bounded context, the cap of 3, the 700-character limit and the scan;
- automated answers skip review;
- the builder's reply is held only for secrets;
- groups are sorted only by the judge;
- provider parity.

## Live QA (after the merge, on the installed app)

1. A Codex project: a simple question is answered in the thread, and a question that asks the writer to list
   files gets no command run (card 3's lock).
2. A Claude-plan project with a Decisions account: "what does option B mean?" gets an automated line, and "can we
   push this to next week?" reaches Open as "Mark asked" with a notification. Your reply lands in the thread, and
   the card goes back to Waiting.
3. With the `reply_kind` switch off: "what is this for?" reaches Open, and nothing is posted.

## Follow-ups (not in this plan)

- Move pass review (`delivery/pass-review.ts`), area naming (`daemon/area-namer.ts`) and hazard assessment
  (`hazards/assess.ts`) onto `completeWithCodex` on Codex accounts, and retire `CODEX_NO_QUESTIONS`.
- If card 3 ships without the tool lock: the Codex writer.
