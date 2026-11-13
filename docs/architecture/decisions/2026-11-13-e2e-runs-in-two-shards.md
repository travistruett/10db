# The end-to-end tests run in two shards, each with its own daemon

- **Date:** 2026-11-13
- **Amends:** decisions/2026-11-06-ci-splits-the-gate-into-required-jobs.md (`gate-e2e` becomes `gate-e2e-1` and
  `gate-e2e-2`)

## Decision

CI's `gate-e2e` job is a matrix of two shards, `gate-e2e-1` and `gate-e2e-2`, each a required check in
`.github/rulesets/main-protection.json`. Each runs `scripts/gate.sh` with `GATE_STEPS=e2e` and
`GATE_E2E_ARGS=--shard=<n>/2`, which the gate hands to `playwright test`, so each shard starts its own daemon and
Vite server with a fresh data dir. Playwright still runs one worker per shard, and files in name order.
`first-run.spec.ts` needs a daemon with no project and is the first file by name, so it runs first in shard 1;
every other spec adds its own project. A local `make gate` runs every spec in one run, as before.

## Why

e2e was CI's longest job: 364 s on `main`'s run 43516806471, 322 s of it in Playwright, against 184 to 334 s for
the test shards. It runs the 11 specs one after another against one daemon, so no shard of the unit tests could
shorten a pull request's CI while it was the long pole. Two shards each take about half the Playwright time plus
the container start (26 s) and install, about 190 to 220 s per job (Estimate, from that run's step times).

Turned down:

- More Playwright workers in one job. The specs share one daemon and data dir; workers would need a daemon each,
  which is what two jobs give without changing the config.
- Three or more shards. With 11 specs whose lengths differ, a third shard adds a container start for little.
