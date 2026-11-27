# Every card builder declares its decider, and a card whose rule is not built yet stays the builder's

- **Date:** 2026-11-27

## Decision

- Every card builder (`FlagInput`, the delivery `Card` and `AccountCard`) requires a `decision`: the rule, the
  judge, a stakeholder or the builder, and for the builder one of the seven things the builder owns. `flagCard`
  stores it in the card's `detail` (`detail.decider`, `detail.owns`), so no column or migration is added. A repo
  test (`tests/repo/src/card-deciders.test.ts`) fails when a builder declares none.
- Open holds only builder cards; a card with no stored decider is the builder's. Every builder card sends a phone
  push, and none is folded or expired by 10db.
- Every kind that exists today is declared the builder's, under the nearest of the seven, because each still waits
  on the builder. A kind moves off the builder in the change that builds its rule: that change posts a notice with a
  `NoticeDecision` (the rule, or the judge and its confidence, and Undo or why not), and the card builder goes.
- Activity shows who decided, Undo where the move can be taken back, and Ask Me Next Time, which sets the row's rule
  to ask for that project (`app_settings` keys `rules.asking` and `activity.undone`); the rule's raiser then raises
  a card instead of a notice.

## Why

- Hiding a card whose rule is not built would lose it. Declaring every kind the builder's keeps Open as it is while
  the filter, the push rule and Activity are in place for the kinds that move later.
- The decider is a property of the kind, so the test catches a new kind the day it is added, and the card header can
  say which of the seven it is without asking the raiser.
- Settings in `app_settings` avoid a migration while only one open pull request may add one; they move to a table
  when a rule's asking state needs history.
- The builder's rulings: every builder card is pushed, nothing of theirs expires or folds, and the Inbox gains no
  Activity tab (Activity stays the Factory's drawer).
