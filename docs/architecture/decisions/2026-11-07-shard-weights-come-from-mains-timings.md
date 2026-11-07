# Shard weights come from main's own test timings

- **Date:** 2026-11-07
- **Amends:** decisions/2026-11-06-test-shards-split-by-seconds.md

## Decision

`tests/repo/src/shard-weights.ts` is written by `make shard-weights` (`scripts/shard-weights.mjs`), never by
hand, and committed like any other change.

- **Which runs.** It takes the newest three green CI runs on pushes to `main` whose shards all left their
  `test-timings-<n>` artifact (decisions/2026-11-06-pull-requests-report-their-test-cost.md). A run with a shard
  missing or expired is skipped.
- **Which number.** A file's weight is its median seconds over those runs, rounded to whole seconds. A file two
  shards or projects ran counts once in its run, summed. A file a run didn't have takes the median of the runs
  that had it.
- **Which files.** A file is listed when its median is 4 s or more. The rest count as 1 s, as before.
- **Fewer than three runs.** It writes nothing and exits non-zero.

The arithmetic is in `tests/repo/src/shard-weights-from-timings.ts`, and the gh lookups it shares with the pull
request report are in `scripts/main-timings.mjs`. Rerun the command when the shard jobs' times drift apart, or
after a change that moves a slow file's seconds.

## Why

The hand-written weights had drifted. On `main` run 42407889990, `runner.test.ts` was weighted 118 s and took
157 s, and `pr-catch-up.test.ts` was weighted 109 s and took 69 s. The shards summed 294 to 529 s, against
410 s for an even split.

**The evidence** (Modelled, from the timing artifacts of runs 42388610173, 42407889990 and 42420575807):

- The method: for each run, weights from the median of the other two were fed to the real `assignShards` and
  scored on the held-out run. These are summed seconds on the slowest shard:

  | Held-out run | Old weights | Refreshed | Even split |
  | ------------ | ----------: | --------: | ---------: |
  | 42388610173  |         497 |       386 |        352 |
  | 42407889990  |         529 |       441 |        410 |
  | 42420575807  |         489 |       492 |        452 |

- Per-file seconds move a lot between runs of the same code. `base-update.test.ts` took 67, 101 and 84 s.
  A median of three ignores one slow or fast run. A single run, or a mean, would follow it.
- **The cut-off barely matters.** Listing files from 2 s instead of 4 s moved the slowest shard by 12 s or less in
  each held-out run. Keeping 4 s keeps the file short.

**Why a committed snapshot rather than a generated file the gate checks for drift:**

- The input is CI data, not the repository. A drift check would fail a pull request because another run finished.
- A drift check would need GitHub from inside the gate.
- Each shard job still reads the same committed file, which the 2026-11-06 decision requires so that every job
  computes the same split.

Turned down:

- **Refreshing inside CI and committing the result.** That needs a write token on `main` and makes a bot commit
  the weights. The gain is small next to running a command by hand now and then.
- **Every file weighted.** It gave the most even split on paper. But a file under 4 s barely moves a shard, and
  listing them would make a refresh change hundreds of lines.
