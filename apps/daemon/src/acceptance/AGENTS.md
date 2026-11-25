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
