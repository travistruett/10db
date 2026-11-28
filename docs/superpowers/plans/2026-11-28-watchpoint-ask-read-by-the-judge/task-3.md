# Task 3: Merge on the card, Hold in Settings, the read's row in Decisions

Read the index's Brief and Global Constraints first. Size: Feature (one implementer, end to end). Starts after task 2
has merged.

**Files:**

- `apps/desktop/src/views/inbox/watchpoint-card.tsx`: a card with `held` shows Merge and Send Back (with its
  description), the pull request's link when it has one, and each watchpoint's verdict when it has one. Without
  `held` it is today's card.
- `apps/desktop/src/views/settings/watchpoint-loudness.tsx`: offers Hold, with the hint "Holds the pull request
  until you answer Merge."
- `packages/contracts/src/watchpoints.ts`: `notHold` and `NOT_HOLD` removed, so a proposal may set Hold. This
  widens what is accepted; nothing is narrowed.
- `apps/daemon/src/watchpoints/proposal.ts` and its test: Hold accepted.
- `packages/contracts/src/shape-measures.ts`: `ShadowAgreementDto.decision` widens from
  `z.enum(SHAPE_JUDGE_DECISIONS)` to also accept `JudgeDecision.WatchpointRead`.
- `apps/daemon/src/daemon/shape-services.ts`: appends the `watchpoint_read` row where `shadowAgreement`'s rows are
  served.
- `apps/desktop/src/views/settings/decisions-table.tsx`, `decision-numbers.ts`: the row's words.
- `apps/desktop/e2e/inbox.spec.ts`: extended.

**The Decisions row.** From `watchpointReadAgreement(db, null)`: `scored` and `agreed` map as they are; `answered`
is the count of shadow reads that got an answer. `canShow` does not follow the 20 scored at 75% rule: it is whether
the read may act, which until task 4 is "the first shadow read is 7 days old and `cleanButSentBack` is 0", computed
in the daemon with its clock as `shadowAgreement(db, now)` takes it. Task 4 replaces that expression with
`readActs`. With no judge ready the row says the read is not running on this account.

**Provider parity.** The card and the setting are identical on every account kind. The row says what an account
without a judge lacks.

**Test.** Extend the Look card flow in `e2e/inbox.spec.ts` through the real daemon: a watchpoint set to Hold in
Settings, a held card, Merge closes it. No rendered-component test.

**Spec:** watchpoints "S5, hold"; what-reaches-the-builder "5. How self-healing fails, and its guards".
