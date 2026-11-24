# Card 6: the builder's reply, the "Mark asked" card and its notification

**Spec:** §8.3 "The builder answers instead"; §10.2 "The question card"; §10.3 "The Inbox's Waiting tab".
**Track:** A, after card 5. Feature. The calmer Waiting card (#812) is on main; build on it.

## Files

- `apps/daemon/src/stakeholders/sends.ts`: `replyAsBuilder(cardId, text)`:
  1. Find the live send. It must be `sent` with `asked !== null` (Q, or T with a question, row 19), else `ConflictError`: "This question
     isn't waiting on your reply".
  2. Use the send's own client. A workspace that isn't signed in, or a binding that has changed, gets a
     `ConflictError` that names it.
  3. Scan the text for secrets only: hits whose pattern is in `SECRET_PATTERN_NAMES`. A hit is an
     `InvalidError` naming the pattern and line, never the text.
  4. Build `builderReplyLine(builderName, text)`.
  5. Read the thread since `asked.ts`, and look for `findLine(thread, send.id, 'builder_reply', { key })`, where
     key = `asked.ts` + the first 12 hex digits of the text's SHA-256. If it is missing, `postLine` it.
  6. In one write, `answerAsked({ askedTs: asked.ts, at: now })`. If a newer question arrived meanwhile, it is a
     no-op and the card stays in Q with the newer question (row 22).
  A crash between 5 and 6 leaves Q (row 21): Send Reply again finds the line by its key and only writes.
  7. Return the card.
- `apps/daemon/src/stakeholders/lines.ts`: `builderReplyLine(builderName, text)`. It returns
  `"*{builder} (via 10db):* {text}"`, the name and the text escaped.
- `apps/daemon/src/api/services.ts` and `app.ts`: `POST /inbox/:id/stakeholder-reply`, with the body parsed by
  `StakeholderReplyInput`, returning `InboxItemDto`. Errors map as `keep-waiting`'s do. Wire it in the daemon's
  services.
- `apps/desktop/src/views/inbox/stakeholder-extras.tsx`: in `SentNotice`, when `send.asked` is set (whatever the
  return's reason), show:
  - the title "{asked.name} asked";
  - their words, quoted, as `pre-wrap` text;
  - when `asked.declined` is set, one dimmed line on why 10db didn't answer it itself ("10db couldn't answer this
    from what it holds", "the project's account is paused", "10db can't answer on Codex yet", "10db's answer was
    held by the outbound check", "10db already answered three of Mark's questions");
  - a `Textarea` labelled "Reply To {first name}", and a **Send Reply** button (primary). It is disabled while
    empty or while Slack isn't connected for the send's workspace; then the outage notice shows.
  - **Keep Waiting** and **Take Back**, as for a timer return.

  Answer Myself stays the card's own options below. Add a `useStakeholderReply` mutation beside
  `useKeepWaiting`; it invalidates the inbox. An error shows under the box.
- `apps/desktop/src/desktop/notify-card.ts`: `askedNotices(before, now)`. It returns one notice per card whose
  `send.asked.ts` is new since `before`: title "{name} asked", body the question's first 200 characters. Wire it
  in `sync.ts` beside `disagreementNotices`.
- The Board line (`Waiting on Mark in Slack`): no change. A returned send already reads as the builder's.
- `docs/architecture/api.md` or the route list the repo keeps (find where `keep-waiting` is listed): one line.

## Interfaces

Implements `replyAsBuilder` and `builderReplyLine`. Calls `answerAsked(ctx, id, { askedTs, at })`,
`StakeholderReplyInput`, `findLine` and `postLine`.

## State-table rows

9, 10, 11, 13 (the notification), 19 (the card), 21 and 22.

## Tests

No unit test (not core; `.claude/rules/testing.md`). Card 7's e2e covers the card.

Seed it here: `apps/daemon/scripts/seed-waiting-question.ts` gains an optional `asked` field in its zod `Seed`.
When given, the seeded send is returned `'asked'` with that question from Mark (written through `markAsked`; a
seeding script may write to the idle database). Before review, click through the card against a real daemon
with that seed. With Slack off, the reply box shows the
outage notice; that is enough for the click-through. Show the builder screenshots (`screens` skill).

## Done when

The checks in Global Constraints pass, and the screenshots of the Open card are shown.
