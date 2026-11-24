# Card 1: contracts, the send's new columns, the `reply_kind` decision

**Spec:** §7.5 "What a send records" (extended); §8.2 "Reading replies".
**Track:** A, first. Core (what a send records and when a card returns).

## Files

- `packages/contracts/src/judge.ts`: `JudgeDecision.ReplyKind = 'reply_kind'`, with a doc comment ("Stakeholder
  questions: whether a reply answers, asks 10db, asks the builder, or is chatter"). Add it in
  `JudgeConfig.decisions` (`shapeDecision()`), `DEFAULT_JUDGE_CONFIG.decisions` and the patch object.
- `packages/contracts/src/slack.ts`: `ReplyKind`, `AskedQuestion` and `StakeholderReplyInput`, exactly as in the
  index's Interfaces. On `StakeholderSendDto`:
  - add `asked` and `autoAnswers`;
  - add `'asked'` to `returnedReason`.

  Then regenerate `packages/contracts/generated/`.
- `apps/desktop/src/views/settings/decision-catalogue.ts`: the exhaustive `DECISIONS` entry. Its name is "Reply
  Kind" and its description is "Whether a stakeholder's reply answers the question, asks something 10db can
  explain, needs you, or is chatter". Also add its entry in `apps/desktop/src/test/judge-fixtures.ts`.
- `packages/db/src/schema.ts`, `stakeholderSends`:
  - `handled_through_ts` (text, null): the newest reply `ts` already sorted as a question or chatter;
  - `auto_answers` (integer, not null, default 0);
  - `asked` (json `AskedQuestion`, null);
  - widen `returnedReason`'s `$type` with `'asked'`.
- `packages/db/src/store/stakeholder-sends.ts`:
  - `markHandled`, `recordAutoAnswer`, `markAsked` and `answerAsked` (index Interfaces), each `guarded` to
    `sent`, each through `change` so it emits `StakeholderSendChanged`;
  - fill the new fields in `toDto` and `toOpen`;
  - widen `OpenSendRow` and `markReturned`'s reason.
- `apps/desktop/src/test/people-fixtures.ts`: the new DTO fields.
- Generate one migration with `pnpm --filter @10db/db generate` to develop against. The coordinator regenerates
  it last. Never hand-edit it.
- `docs/architecture/db-storage.md`: the three columns, one line each.

## Interfaces

Implements the four store functions quoted in the index, with these rules:
- `handledThroughTs` only moves forward (compare like `setLastRead` does, with `compareTsText`).
- `markAsked` keeps an existing `returnedAt` (row 13: a second ask while already returned) and always replaces
  `asked`. On a send returned by timer or disagreement (T) it keeps `returnedReason` (row 19).
- `answerAsked` refuses (`ConflictError`) a send with no `asked`, and is a no-op when `asked.ts` isn't the given
  `askedTs` (row 22). It clears the return whatever its reason (Q or T, row 19).
- `keepWaiting` also clears `asked`.

## State-table rows

These are design, not tests: 3, 4, 5, 6 (the writes), 9 and 11 (the clears), 13 (the replace), 19 and 22.

## Tests

None. The writes are exercised by card 5's tests through the real store.

## Done when

The checks in Global Constraints pass, `make precheck` is green, and the contracts' generated files are current.
