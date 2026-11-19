# The pre-check runs the repo rule tests for files they read

- **Date:** 2026-11-18
- **Amends:** decisions/2026-11-06-the-pre-push-hook-runs-the-precheck.md

## Decision

`make precheck` (`scripts/check-changed.mjs --precheck`) runs all of tests/repo, alone after format, lint,
typecheck and knip, when the diff touches a file those tests read:

- a file outside the packages that the script places (docs, scripts, the agent files, GitHub's templates, and the
  root files below);
- a package file `READ_BY_REPO_TESTS` lists (manifests, Markdown, env files, vitest and vite configs, the Tauri
  shell, the apps' e2e and scripts folders, the daemon's git tests, a grab-bag module);
- a file of tests/repo itself.

A change only in a package's source runs no tests/repo tests. It replaces the two hand-picked docs rule tests
(architecture-docs and agent-docs) the pre-check ran before.

`ROOT_READ_BY_REPO_TESTS` places five root files that tests/repo pins and no package builds, typechecks or lints
from: `lefthook.yml`, `renovate.json`, `release-please-config.json`, `.release-please-manifest.json` and
`commitlint.config.js`. A change to one runs format, knip and tests/repo instead of every package's checks, and
`make check-changed` runs tests/repo for it instead of the full gate. Every other root file stays unplaced, so the
pre-check runs every package's checks for it, and tests/repo with them.

## Why

On #686 a pre-push job added to `lefthook.yml` broke `tests/repo/src/hooks.test.ts`, which pins the hook's job
list. The author ran `vitest related` on the changed files, which follows imports only, and the test reads
`lefthook.yml` as a file, so the failure first showed in CI and cost a push and a full CI run. `make check-changed`
already ran tests/repo for such files, but agents no longer run it: on an integration branch it widens to every
package's suite.

tests/repo takes about a minute on the Mac and 55 CPU-seconds in CI, so a pre-check on a change outside the
packages stays under about two minutes.

Turned down:

- A map from each file to the tests/repo files that read it: it drifts from the tests, and a miss is silent. A
  root file missing from `ROOT_READ_BY_REPO_TESTS` instead falls back to every package's checks, tests/repo
  included, so a miss costs time and is never silent.
- Running tests/repo beside lint: its git fixtures and deadlines flake under load.
