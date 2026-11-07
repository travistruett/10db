# CI's test shards split by seconds

- **Date:** 2026-11-06
- **Amends:** decisions/2026-11-06-ci-splits-the-gate-into-required-jobs.md

## Decision

`vitest.config.ts` sets `sequence.sequencer` to `WeightedShardSequencer` (`tests/repo/src/shard-sequencer.ts`). It
replaces only Vitest's `shard()`: files go to the lightest shard, slowest first, using the seconds in
`tests/repo/src/shard-weights.ts`. A file not listed there counts as 1 second. Order inside a shard stays Vitest's.

The weights are written by hand from a CI run, for files over 4 s, and need refreshing only when shards drift apart.

## Why

Vitest's `--shard` hashes each path, so slow files can land together. The first six-shard run took between 2m22 and
5m05: the average was about 3.5 minutes, but a pull request waits for the slowest shard.

The split must come out the same in each job, because each job works out only its own share. `assignShards` depends
only on its arguments and sorts its input, so it does. A stale weight only makes the shards less even: every file
still lands in exactly one shard, which `tests/repo/src/shard-sequencer.test.ts` checks.

Turned down:

- **Timings restored from `actions/cache`.** A cache miss in one job, but not another, would give the jobs different
  splits, and a file could run twice or not at all. Weights in the repository are the same for every job.
- **More shards.** Each is a ruleset change, and hash shards improve slowly because the slow files stay clumped.
