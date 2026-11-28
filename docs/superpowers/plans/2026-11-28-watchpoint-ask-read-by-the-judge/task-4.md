# Task 4: the read acts

Read the index's Brief and Global Constraints first. Size: Core (it changes when a pull request merges). Starts after
task 3 has merged, and can merge any day: the wait is in the daemon.

**Files:**

- `apps/daemon/src/watchpoints/read-agreement.ts`: `readActs` (pure), and the app-setting key builder for the
  builder's answer, one per project, read through zod.
- `apps/daemon/src/watchpoints/read.ts`: `acted` is true when `readActs(...).acts` and
  `judge.ready(JudgeDecision.WatchpointRead)` both hold; the judge row is then logged as an acting decision.
- `apps/daemon/src/watchpoints/card.ts`: acts on verdicts; the disagreement card and its answer.
- `apps/daemon/src/daemon/shape-services.ts`: the Decisions row's `canShow` comes from `readActs`.
- `apps/daemon/src/watchpoints/read.test.ts`, `apps/daemon/src/delivery/ship.test.ts`,
  `apps/desktop/e2e/loop.spec.ts`: extended.
- `apps/daemon/src/watchpoints/AGENTS.md`: as built.

**Implements** (index, Interfaces): `readActs`. **Calls:** `watchpointReadAgreement`, `readVerdict`, `holdsMerge` (both task 1's, in `read.ts`),
`watchpointHoldOf` (unchanged: it already reads `acted` reads).

**When it acts.** `readActs`'s five rows, with the clock injected. Zero scored reads still act after 7 days: a
project with no Ask hits that week has nothing to disagree with, so add no minimum. `firstAskedAt` and
`cleanButSentBack` are the project's (`watchpointReadAgreement(db, projectId)`).

**What an acted read does** (`announceWatchpointReading`, per Ask hit with `acted: true`):

- `clean`: no card. It posts the notice a Show hit posts today, which is what For You lists, and it does not hold.
  `watchpointReviewReason` is unchanged, so Review still follows.
- `finding`, `doubt`, `destructive`: the held Look card of task 2, with the verdict on its watchpoint entry;
  `watchpointHoldOf` holds the pull request. Where the landing can't be held, today's card.
- `unread`, and every read with `acted: false`: today's card, no hold.

A workstream with clean and holding hits gets one card naming only the holding ones.

**The disagreement card.** When `readActs` answers `ask`, raise one card per project (a fold key from the project
id), `decidedByBuilder(BuilderOwns.ProductAndTaste)`, `closesWhen: BY_ANSWER`: "The judge read N watchpoint changes
as clean that you sent back", naming them, with Let It Act and Keep Asking Me. The answer is stored as `allowed` in
the answer's write. Until it is answered the read stays in shadow, so nothing waits on the builder.

**Provider parity.** With no judge ready, `acted` is never true and every Ask hit is today's card. Hold watchpoints
hold on every account.

**State-table rows:** `readActs`'s five rows; the moment table's first two rows for a verdict.

**Tests.**

- `read.test.ts`: one table test over `readActs`'s rows. Red first.
  `Value: protects=the judge's read of a watchpoint hit acts only after its shadow week and never over a clean read
the builder sent back; fails_when=it acts early, acts after a disagreement without the builder's answer, or waits
for a minimum count; why_new=merge rule table; no_claim=the judge's accuracy`.
- `ship.test.ts`: an Ask hit with an acted `finding` ships held, with one card. It extends task 2's test and its
  value card.
- `e2e/loop.spec.ts`, test 1: an Ask hit read clean by the fake judge leaves a notice and no Look card.

**Spec:** what-reaches-the-builder "3. The decision-rights table", row "Watchpoint hit"; "9. Stages", stage 9; "5.
How self-healing fails, and its guards".
