# Card 5: routing replies in the reply watch

**Spec:** S9, S13; §8.2 "Reading replies"; §8.3 "The answer"; §8.5 "Agreeing an answer".
**Track:** A, after card 4. Core: when a card is answered, what a send records, and crash recovery.

## Files

- `apps/daemon/src/stakeholders/conversation.ts`: `ConversationInput` gains `handledThroughTs: string | null`.
  In the lone-recipient branch, only counted messages after it are the reply:
  - `joined(...)` joins them;
  - "only the recipient spoke" is checked over them;
  - none at all → `waiting`.

  The settle path (`settle`, `recipientPicks`) is unchanged: in a group, questions stay part of what the
  conversation said.
- `apps/daemon/src/stakeholders/reply-watch.ts`:
  - `ReplyWatchDeps` gains `writer: AnswerWriter`. Pass `handledThroughTs` into `conversationState`.
  - **Lone (`lone_reply`).** Before `answerLone`, call `classifyReply` with `group: false` and route it:
    - `answer` → `answerLone`, as today. When `open.handledThroughTs !== null` or any automated or builder line
      exists, `conversation` quotes the whole exchange: the recipient's counted messages, plus the thread's
      `auto_answer` lines as "10db (automated)" and its `builder_reply` lines as the builder's name, in `ts`
      order. Find those lines with `findLine`'s metadata.
    - `chatter` → `markHandled(lastTs)`.
    - `builder_question` → `markAsked`. `asked` holds the joined words (cut to 4,000), the recipient's id and
      name, and the last `ts`.
    - `simple_question` → `autoAnswer(...)` (below).
  - **Group.** Only with `!judge.off`. For each counted participant message after `handledThroughTs`, oldest
    first, at most 5 a tick, call `classifyReply` with `group: true`:
    - `simple_question` → `autoAnswer`;
    - `builder_question` → `markAsked`;
    - `answer` and `chatter` → `markHandled`.

    The existing `conversationState` verdict for the tick still runs after, unchanged.
  - **`autoAnswer(client, c, reply)`.** Each step that fails sends the reply to `markAsked` instead:
    1. Check `open.autoAnswers < AUTO_ANSWER_CAP`.
    2. Check the stored binding: `boundTeam(project) === open.teamId`, and `projectSlack(db, project).teamId` is
       not null. A changed binding stays `failSendsToBuilder`'s job, as in `remind`.
    3. Check for the line already posted: `findLine(thread, open.id, 'auto_answer', { key: reply.lastTs })`. If
       found, skip to step 6.
    4. Call `writer({ cardId, question: words, askerName })`.
    5. On `kind: 'answer'`, build `automatedAnswerLine(text, letters, builderName)`, scan it again (a hold →
       `markAsked`), and `postLine` with `line: 'auto_answer'` and `key: reply.lastTs`.
    6. In one write: `recordAutoAnswer(lastTs)` and `setLastRead`.
    7. Record the judge call's outcome: `Acted` when acted on, `BelowFloor` when the floor sent it to the
       builder, as `settleConversation` does.
  - Every route writes `setLastRead` with the handled `ts`, in the same write.
  - A send in Q (returned `'asked'`) never auto-answers (row 13): a `simple_question` there is `markAsked`, so
    `asked` holds the newest.
- `apps/daemon/src/stakeholders/lines.ts`: `automatedAnswerLine(answer, letters, builderName)`. It returns
  `"🤖 *10db (automated reply):* {answer}"`, a blank line, then
  `"_{builder} hasn't reviewed this. {replyWithLine(letters)}_"`. The answer is escaped, and the builder's name
  too.
- `apps/daemon/src/stakeholders/reply-watches.ts` and `daemon/start.ts`: pass the writer through.
- `apps/daemon/AGENTS.md` ("Stakeholder questions") and `apps/daemon/src/stakeholders/AGENTS.md`: a short note on
  the four kinds, the cursor, the cap and the `auto_answer` and `builder_reply` lines.

## Interfaces

Calls `classifyReply`, `AUTO_ANSWER_CAP`, `AnswerWriter`, `markHandled`, `recordAutoAnswer`, `markAsked`,
`findLine` and `postLine`, as quoted in the index or in `bot-lines.ts`.

## State-table rows

1 to 8, 12 to 16 (design).

## Tests

`reply-routing.test.ts` (new), in `apps/daemon/src/stakeholders/`. It runs on a real SQLite store and the real
reply watch, a fake Slack `fetch` (copy the shape of `workspace-sends.test.ts`'s `world()`; don't export it from
there), a fake `Judge` and a fake `AnswerWriter`. Three tests, each core (recovery and when a card is answered):

1. **Escaped bug.** Judge off. Mark replies "what is this for?". After the quiet tick:
   - the card is still Open, and `answerAs` was never called;
   - the send is `sent` with `returnedReason: 'asked'` and `asked.text` set.

   Prove it red on `main`, where the card is answered "In Mark's words".
2. **Automated answer and cap.** The judge says `simple_question` at 0.9, and the writer answers. Four questions,
   each on its own quiet tick:
   - three `auto_answer` posts, each with its key;
   - `autoAnswers` is 3 and the card is Open;
   - the fourth question returns the card `'asked'` with no fourth post.
3. **Crash.** An `auto_answer` line with the reply's key is already in the thread (the fake Slack's replies), and
   the send has `autoAnswers` 0. One tick:
   - no post;
   - `autoAnswers` is 1, and the cursor is past the reply.

## Done when

The checks in Global Constraints pass, and `pnpm vitest related` on the stakeholders folder is green.
