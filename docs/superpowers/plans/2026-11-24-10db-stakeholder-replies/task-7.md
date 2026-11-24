# Card 7: the invite line, the e2e, the spec section and the decision record

**Spec:** §7.2 "The message" (its last lines).
**Track:** A, last. Small. The opening line (#812) is on main; don't touch it.

## Files

- `apps/daemon/src/stakeholders/lines.ts`: `questionsInviteLine(builderName)`. It returns "Questions? Ask here:
  10db answers what it can and passes the rest to {builder}." with the name escaped.
- `apps/daemon/src/stakeholders/compose.ts`: the closing section becomes three lines:
  1. "The work on this waits for your answer."
  2. `replyWithLine(...)`
  3. `questionsInviteLine(input.builderName)`

  The preview (`previewDraft`) shows it, since it composes the same text.
- `apps/desktop/e2e/stakeholder-questions.spec.ts`: extend the second test (the Board's "Waiting on Mark in
  Slack") or add one step after it, not a new flow. Seed with `asked: "what is this for?"`, then check:
  - the Inbox's Open tab shows "Mark Ellis asked" with the words;
  - with Slack off the reply box is disabled and the outage notice shows;
  - answering the card with an option resolves it, and it leaves Open.

  Update the flow 11 row of `apps/desktop/e2e/AGENTS.md` with one clause.
- `docs/superpowers/specs/2026-11-11-10db-stakeholder-questions-design.md`: a new section "Replies that ask"
  under §8. It holds:
  - the four kinds and the fallback;
  - the automated line and its limits (the context, 700 characters, the scan, a cap of 3);
  - the builder's reply;
  - the provider table, copied from the plan's.

  Add one line to §15 "What the build changed". Mark S8 and S9 as amended there. Never rewrite them.
- A new decision file in `docs/architecture/decisions/`, named
  `2026-11-24-10db-answers-simple-stakeholder-questions-and-routes-the-rest.md`, in the README's format. **Amends** `decisions/2026-11-12-stakeholder-questions-run-on-the-inbox-card.md`.
  The decision is the list in the index's "Decision record" section. The why is the builder's words ("talk to
  10db … route to me"), the escaped bug, and the alternatives turned down:
  - a judge that writes, rejected because the judge only classifies;
  - the Linear reporter's session, rejected because it is a full agent session;
  - holding every automated answer for review, rejected because it brings back the relay.

## Interfaces

Implements `questionsInviteLine`. Uses card 6's `asked` seed.

## State-table rows

None; this card makes the feature visible.

## Tests

The e2e extension above, the one the plan adds. No unit test.

## Done when

The checks in Global Constraints pass, and the e2e spec passes locally on its own
(`pnpm --filter @10db/desktop e2e stakeholder-questions`, or the repo's equivalent named in
`apps/desktop/e2e/AGENTS.md`).
