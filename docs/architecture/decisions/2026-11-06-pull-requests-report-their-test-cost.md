# Pull requests report what their tests cost

- **Date:** 2026-11-06

## Decision

Each open same-repository pull request gets one comment, updated on every run, with tests added, seconds added and test
lines per code line. It is informational: no ruleset requires the jobs, and neither can hold a merge.

`TestTimingReporter` (`tests/repo/src/test-timing-reporter.ts`) writes each file's tests and seconds when CI sets
`TENDB_TEST_TIMINGS`. Each shard uploads that as an artifact, on `main` too, which gives the baseline.
`scripts/test-report.mjs` compares with the newest run on `main` that is an ancestor of the base and has every shard's
timings. Tests and seconds cover only the test files the pull request touched, and leave out any that `main` changed
after that run. Lines come from the diff against the
base, leaving out generated files and anything that isn't code.

`test-report` runs the script with a read-only token. `test-report-post` has `pull-requests: write`, has no checkout,
and only posts the body. Anything missing leaves a number out and the comment says why.

## Why

The gate grew 6x in nine days with nothing to show it on a pull request. A number in front of the author and reviewer
can't flake, where a time budget would. The same suite took 937 s and 1,004 s, so a budget would fail on noise, and a
failing check reaches a lane through `ci-fix`, the session most tempted to skip a test.

Whole-suite seconds would be noise for the same reason: two runs of the same code differ by more than one pull request
adds. So only touched files count. A baseline can be older than the base, because a newer push cancels a run on `main`;
a touched file that changed since would charge the pull request for what merged in between, so it is left out and
counted.

Every step of the report jobs continues on error, not the job. Job-level `continue-on-error` keeps the run green, but
10db's checks summary reads every check, and a job that concludes as failed could show on the Board as checks failing.

Vitest's JSON reporter measures from the first test's start to the last test's end, which leaves out imports, setup and
`beforeAll`, where a shared fixture's cost sits. The reporter adds those. Setting `reporters` replaces Vitest's
defaults, including the `github-actions` annotations, so `vitest.config.ts` lists the defaults too.

The upload in `gate-test` continues on error. A required job must not go red because an artifact failed to upload, since
that would start a `ci-fix` session over nothing, so it has a short step timeout too, and the reporter catches its own
write errors. `tests/repo/src/ci.test.ts` still forbids that on any step that checks
something, and requires the upload to come after the gate step.

A lane writes the code `test-report` runs, so it gets no write token, and the job with one runs nothing from the
checkout. That stops code run from the checkout, not an edit to `ci.yml` itself: `pull_request` runs the workflow from
the merge ref, as it always has. Fork pull requests get no comment: their token can't write one.

Turned down:

- **A required check on the ratio or the seconds.** It would fail on noise and pressure a lane to delete tests.
- **The job summary instead of a comment.** Nobody opens it, so it would show no growth to anyone.
- **`workflow_run`.** It runs with write access from the default branch, which is more than posting a comment needs.
