# The pre-push hook runs the pre-check

- **Date:** 2026-11-06

## Decision

The `check` job in `lefthook.yml`'s pre-push hook runs `make precheck` instead of `make check`: format and lint of the
changed files, typecheck of the changed packages and their dependents, drift, knip, and the rule tests for docs and
agent files. It runs no other tests. `make check` stays as a command to run by hand.

## Why

The hook took 5 to 7 minutes on each push, longer than the CI run the push starts. It rarely saved one: changing a
shared file reaches most of the suite, and `--changed` ran about 81% of test time on a median pull request. It also
blocked a push on a macOS test that passes alone and failed under load, which says nothing about the change.

Every test still runs on CI, and each is a required check, so a push no longer waits for what CI decides anyway. The
pre-check keeps the mistakes that are quick to catch and would otherwise cost a CI round.
