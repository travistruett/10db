# Delivery test timings under load

- **Status:** Measured. Every figure below is VERIFIED by the runs named here; the "next cost" is a
  measurement of one flow, not a fix.
- **Date:** 2026-11-02
- **Question:** Commit `e30d236` (the origin pair built once per run and copied) removed about 8 git
  spawns per delivery harness and 3 per `teammatePush`. How much headroom under the 30 s test
  timeout (`apps/daemon/vitest.config.ts`) did it buy, and is more needed?

## Method

- Files: `src/delivery/base-update.test.ts` (54 tests), `branch-cleanup.test.ts` (34),
  `landing.test.ts` (32), run together in one `vitest run` with `--reporter=json`, which reports
  each test's `duration`. Files run in parallel workers, as in the gate.
- **Before:** `test/fixtures.ts` with `createTempRepoWithOrigin` and `createTempClone` as at
  `e30d236^` (the bare origin built with `git init` and four `git config` calls, the repository
  copied from the repo template, `remote add`, `push`; the clone's identity set by three `git config`
  calls). **After:** the tree as it is. Nothing else differed. The fixtures were swapped back and
  forth in one worktree and restored.
- The load was whatever the other lanes made; no load was generated. Load averages (1 min) at the
  start and end of each run: before-1 12.4 → 7.6, before-2 7.6 → 6.4, after-1 8.3 → 11.4, after-2
  5.2 → 37.4, after-3 37.4 → 14.8. The runs are therefore comparable only roughly, and after-2
  and after-3 ran under load far above either before-run.

## Per-test durations

Test duration in seconds. "Sum" is the file's tests added up (they run in series within a file),
"median" and "max" are per test.

| Run (load)            | base-update sum / median / max | branch-cleanup sum / median / max | landing sum / median / max |
| --------------------- | ------------------------------ | --------------------------------- | -------------------------- |
| before-1 (12 → 8)     | 119.8 / 1.95 / 5.78            | 66.5 / 1.89 / 4.96                | 54.3 / 1.40 / 4.08         |
| before-2 (8 → 6)      | 113.2 / 1.95 / 4.22            | 60.9 / 1.78 / 3.89                | 46.8 / 1.37 / 3.49         |
| after-1 (8 → 11)      | 123.5 / 1.89 / 8.53            | 66.0 / 1.66 / 6.41                | 52.1 / 1.40 / 4.79         |
| after-2 (5 → **37**)  | 251.9 / 2.51 / **28.50**       | 78.2 / 1.64 / **25.27**           | 63.1 / 1.27 / **20.96**    |
| after-3 (**37** → 15) | 165.8 / 2.63 / 9.74            | 101.7 / 2.67 / 10.56              | 80.8 / 2.14 / 9.14         |

The three tests that failed under the gate's load (seconds, run by run):

| Test                                                                                                             | before-1 | before-2 | after-1 | after-2 | after-3 |
| ---------------------------------------------------------------------------------------------------------------- | -------- | -------- | ------- | ------- | ------- |
| branch-cleanup: "sweeps after a round that failed, so one pull request that breaks the watch holds nothing back" | 3.18     | 3.47     | 6.41    | 3.10    | 4.35    |
| landing: "turns auto-merge on for a pull request an earlier run opened, but not one already merged"              | 3.51     | 3.49     | 3.06    | 2.59    | 6.74    |
| slowest base-update test of the "settling conflicts with the base itself" suite                                  | 3.97     | 4.22     | 8.53    | 4.80    | 8.18    |

### What this says

1. **The change did not move the quiet-machine numbers.** At load 6–12 the medians are the same
   within noise (base-update 1.95 s before, 1.89 s after; branch-cleanup 1.8–1.9 s before, 1.66 s
   after; landing 1.4 s both), and the sums are equal within the spread between two runs of the
   same code. That is what the profile below predicts: the removed spawns were about 0.1 s of a
   1.4–2 s test.
2. **Headroom is set by the load, not by the harness.** Under a load average of 37 the slowest
   tests took 28.5 s, 25.3 s and 21.0 s: 1.05×, 1.2× and 1.4× under the 30 s timeout, and
   tests that touch no `teammatePush` (such as "says nothing when the branch holds the base",
   13 s) slowed the same way. At load 8–15 the slowest test was 4.8–10.6 s, a headroom of
   2.8–6×. A median test of 1.4–2 s has about 15× at a quiet machine, but the slowest tests are
   what time out, and they sit well under the 6× this task asks for under load.

So the headroom the change bought cannot be separated from noise, and under the load that failed the
gate (average 15–37) it is still under 6× for the slowest tests.

## Next biggest cost

Profile of one `start` + `ship` flow (one task, `landing`'s path), counting every process the
daemon and harness spawn (`child_process` wrapped in a throwaway test, load about 11):

| Phase                                                 | wall       | spawns                 | share                         |
| ----------------------------------------------------- | ---------- | ---------------------- | ----------------------------- |
| `createDeliveryHarness` (store, copy, `githubOrigin`) | 70–125 ms  | 1 git                  | harness is no longer the cost |
| `startBatch` to the cut                               | 490–560 ms | 30 git                 | ~16 ms per spawn              |
| finish and ship to the pull request                   | 770–880 ms | 46 git, 1 `taskpolicy` | ~16 ms per spawn              |
| `teammatePush` (clone, add, commit, push, rev-parse)  | 150–175 ms | 5 git                  | clone 47 ms, push 56 ms       |

**The daemon's own git calls are the cost: 71 of the 77 spawns in a start-and-ship flow (29 + 42),
about 1.15 s of the 1.3 s.** The other six are the test's own `commit`, `add` and `rev-parse`, the
harness's `set-url`, one `taskpolicy` and one `fetch` with another `-c` form. By subcommand (start +
ship together):

| Call                                                                            | Spawns | Wall (ms) |
| ------------------------------------------------------------------------------- | ------ | --------- |
| `rev-parse --absolute-git-dir`                                                  | 16     | ~245      |
| `rev-parse --verify`                                                            | 13     | ~217      |
| `remote get-url`                                                                | 7      | ~111      |
| `fetch --no-tags` / `push`                                                      | 2      | ~159      |
| `status --porcelain`, `config`, `symbolic-ref`, `read-tree`, `diff-*`, the rest | ~38    | ~470      |

The first and third rows are likely the git layer (`apps/daemon/src/git`) resolving the pinned
repository and the origin URL for each operation: 23 of the 77 spawns, about 350 ms of a flow that
takes 1.3 s. That is read from the spawn arguments; the call sites were not traced, so whether each
is redundant is unverified. Their cost grows with load the way every spawn does.

A template clone to copy in `teammatePush` would save about 50 ms of a 1.4–2 s test (3%), because
`teammatePush` is 5 spawns against the flow's 77, and its clone is 47 ms of them. It is not the
next target.

**Next step (not done here: it is production code in `src/git`, outside this task's claim):** trace
who calls `rev-parse --absolute-git-dir`, `rev-parse --verify` and `remote get-url`, and read
each once per operation where `pinned()` already reads the pin once, instead of once per call. Then
re-run this note's method, ideally at a stated load, since the load moved the result more than the
change did.
