# CI splits the gate into required jobs

- **Date:** 2026-11-06

## Decision

On CI, the single `gate` job becomes eight jobs, each a required check in `.github/rulesets/main-protection.json`:

| Check                          | Runs                             |
| ------------------------------ | -------------------------------- |
| `gate-static`                  | typecheck, build, drift and knip |
| `gate-test-1` to `gate-test-6` | `pnpm test --shard=<n>/6`        |
| `gate-e2e`                     | the desktop end-to-end tests     |

- Each job runs `scripts/gate.sh`, with `GATE_STEPS` naming its steps. `GATE_TEST_ARGS` adds arguments to the test
  step, so a shard keeps the gate's logs and its `FAILED test:` line.
- Format and lint leave the gate on CI, because the required `policy` job already runs them. They run there even
  after an earlier policy step fails, so neither hides behind another failure. Rust stays in `desktop`.
- `tests/repo/src/ci.test.ts` fails when a step in `gate.sh` runs in no required job, and when the shard matrix and
  `--shard` disagree. `tests/repo/src/governance.test.ts` keeps the ruleset equal to the checks `ci.yml` reports.
- `fail-fast` is off, and no job uses `--bail`: every shard reports all of its failures.
- `make gate` does not change. It still runs every step in one place.
- `MAX_LOGGED_JOBS` in `apps/daemon/src/delivery/ci-fix.ts` rises from 3 to 8, so a fix task can carry every gate job's
  log.

## Rollout

The ruleset has no bypass actors, so a pull request that removes `gate` can't merge while `gate` is required, and
once the ruleset changes no pull request can merge without the new checks. The order is:

1. Open the pull request, hold lanes' ships, and confirm `gh pr checks` shows exactly the eight new names.
2. Run `make github-settings` from the branch, with the branch current with `main`.
3. Merge at once.
4. Give every open pull request a new event, a push or a title edit. Rerunning its old run replays the old workflow
   and adds no new checks.

A change that applies with no merge in between can't let a pull request through: a required check that never
reported leaves it blocked.

## Why

The gate took about 22 minutes on one 4-vCPU runner, and a single failing test cost a full round. It grew from 210 s
on 2026-10-28 to 1,315 s. The test step is limited by CPU, and standard runners are free on a public repository, so
parallel jobs cost nothing. On its first real run with four shards the jobs took 3m40 to 5m12, with `gate-e2e` at 3m29. Six shards bring the test
jobs near that floor, and a shard count is a ruleset change, so it was set before the ruleset was applied.

Each job is required, rather than rolled up under one `gate` job, because 10db reads required checks alone
(`parseRequiredChecks` in `apps/daemon/src/github/gh.ts`). A roll-up over a cancelled shard would report a failure, so
10db would spend one of its two CI fixes on a runner shortage instead of rerunning the job, and a fix session would
read the roll-up's one-line log. With the real jobs required, the daemon needs no other change. The cost is that a new
shard count is a ruleset change, applied by hand.

`--bail` was turned down: a fix session would see one failure per round, and a pull request stops after two fixes.
Running previously failed files first was turned down too: a job's status changes only when the job ends, so without
`--bail` the order brings no failure forward.

Selecting tests by what changed was turned down for pull requests. Replaying the last 60 merged pull requests through
the import graph, the median one would still run about 81% of test time.
