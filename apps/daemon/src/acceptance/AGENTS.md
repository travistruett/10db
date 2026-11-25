# apps/daemon/src/acceptance

- `acceptance/` asks, after a run's final gate passes, whether each acceptance criterion of the task is met by the
  run's change (`docs/superpowers/specs/2026-11-25-acceptance-checks-each-criterion-design.md`, "The questions").
- `read.ts` is the pure rule table. Probability maps are keyed by criterion text, never by position. The first call
  (`acceptance`) settles a criterion only as met (`p >= floor`); every other criterion the builder hasn't accepted
  goes to `secondQuestions`. The second call (`acceptance_second`) reads met (`p >= f`), not met (`1 - p >= f`) or
  unclear. A call with no answer leaves what it was asked `unread`, which never holds a run up. Floors are
  clamped to at least 0.5. `acceptanceMove` is the order the runner decides in, inside its write.
- `ask.ts` is the one place that calls the judge (`checkAcceptance`): it maps question ids (`met_<n>`) to and from
  criterion text, caps the diff at `ACCEPTANCE_DIFF_CAP` characters (past it: the file list and each file's first
  hunks), and never throws. It returns null when the first decision isn't ready. The runner calls it outside its
  write; the verdicts are recorded as one `acceptance` evidence row.

## In the runner

- The pass (spec `docs/superpowers/specs/2026-11-25-acceptance-checks-each-criterion-design.md`; `acceptance/`). After the last Implement step's gate passes (never a no-gate project, never a plan with a `fixedPlan` step), `acceptanceAfter` asks the Acceptance decisions about the task's criteria outside the write (it asks `judge.ready` before any git work, and its calls end on a stop but not on a pause: `Control.acceptAbort`; a read a stop cut short leaves the run Verifying, so the gate and the check run again). `sendBackForAcceptance`, inside the step-ending write, records one `acceptance` evidence row and moves by `acceptanceMove`: a criterion not met goes back to the implement step that just ended while `atRoundLimit(step.acceptanceSentBack, reviewRounds)` allows, as `fix` with `providerSessionId` (and `fixFresh: Pending`) when the rigor's `fixBy` is resumed and the step has a session, else fresh one rung up, with `step.changed` `sentBackBy: 'acceptance'` and no `attempt` counted; at the limit, or with an unclear criterion and no Review, the run goes on and leaves one `acceptance` card the run never waits on (`settle` and recovery skip it). Only an acceptance row with `detail.sentBack` is fix evidence (`outstandingFixEvidence`). A resumed `fix` is kept through a crash, another account or a model change as a fresh one (`nextActionAfterCrash`, `nextActionOnAnotherAccount`, `reviseAfterModelDrift`); `withFreshFixEscalated` steps a fresh `fix` up only for an acceptance send-back (a later gate failure's fix is escalated once, by the gate). A retry clears `acceptanceSentBack` and drops a kept fix's session. A Review's first round is told the unclear criteria of its own implement step's pass.
