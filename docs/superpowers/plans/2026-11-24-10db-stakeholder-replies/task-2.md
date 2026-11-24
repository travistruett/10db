# Card 2: the reply sorter

**Spec:** S9 (amended), S13; §8.3 "The answer".
**Track:** A, after card 1. Core (a pure rule table that decides whether a reply answers a card).

## Files

- `apps/daemon/src/stakeholders/reply-kind.ts` (new): `AUTO_ANSWER_CAP`, `ruleReplyKind`, `ReplyKindRead` and
  `classifyReply`, as quoted in the index.
- `apps/daemon/src/stakeholders/reply-kind.test.ts` (new).

## `ruleReplyKind` (the fallback, pure)

Read in order; the first row that matches wins:

| Reply | Kind |
|---|---|
| `readReply` reads it as an option (one message, a letter first or a whole label) | `answer` |
| empty after trim | `chatter` |
| contains `?`, or its first word is a question word (what, why, how, who, when, where, which, what's, whats) | `builder_question` |
| anything else | `answer` (own words, as today) |

It never returns `simple_question`: with no judge, 10db doesn't answer by itself. It never returns `chatter` for
words. "thanks" with no judge stays an answer in own words, as today, because guessing chatter could swallow a
real answer.

## `classifyReply` (the judge read)

1. A rule pick (row 1 of the table) returns `{ kind: 'answer', source: 'rule' }` without asking the judge.
2. Group while `!judge.ready(JudgeDecision.ReplyKind)` (no Decisions account, the switch off, or
   `TENDB_JUDGE=off`): return `answer`, source `rule`, without calling `choose`. The caller (card 5) acts on
   nothing but questions in a group, so this means "do as today". A lone reply in the same state takes
   `ruleReplyKind` without calling `choose` either.
3. Otherwise ask `judge.choose`:
   - `decision: JudgeDecision.ReplyKind`;
   - `options: [answer, simple_question, builder_question, chatter]`;
   - `state`: the card's title, its option labels, the author's name and the reply's words, each cut to 1,000
     characters, as `agree.ts` cuts.

   The criteria:
   - `answer`: "It picks an option or says, in their own words, what they want done."
   - `simple_question`: "It asks 10db to explain the question, an option, a term or why it is asked, and the
     question's own text or the task's description can answer it."
   - `builder_question`: "It asks for the builder's intent, judgement, a decision, a date, money, people, or a
     fact not in the question; or it pushes back on the question itself."
   - `chatter`: "Thanks, an acknowledgement, a 'looking now' or 'back tomorrow', or talk between participants that
     asks nothing of 10db or the builder."
4. Map the answer:
   - at or above the floor: the judge's choice;
   - `simple_question` below the floor: `builder_question`;
   - any other choice below the floor, a fallback or a throw: `ruleReplyKind`, with source `rule` (for a group
     with any fallback, `answer`).
5. Return the judge call's `callId` whenever the judge answered, so card 5 records `Acted` or `BelowFloor`.

## State-table rows

5, 7 and 8 (design).

## Tests

`reply-kind.test.ts`, pure, one `it.each` over `ruleReplyKind` (core: a pure rule table that decides whether a
card is answered, and the escaped bug). Rows:
- `"B"` → answer;
- `"b) but quickly"` → answer;
- `"what is this for?"` → builder_question;
- `"Why not C"` → builder_question;
- `"Should be B"` → answer (an auxiliary first word with no "?" is own words);
- `"sounds fine, ship it"` → answer;
- `"   "` → chatter.

The table is new code, so its red is the stub's: write the rows first against a `ruleReplyKind` that returns
`answer`, and see the question rows fail. The escaped bug's real red is card 5's test 1 on `main`. The value
card's `why_new` names the escaped bug: "what is this for?" answered a card.

## Done when

The checks in Global Constraints pass.
