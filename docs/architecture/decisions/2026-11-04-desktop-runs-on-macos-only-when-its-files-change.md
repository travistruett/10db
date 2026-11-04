# The desktop check runs on macOS only when a file that can affect it changed

- **Date:** 2026-11-04

## Decision

The required `desktop` check in `.github/workflows/ci.yml` still reports on every pull request, but the job
takes a macOS runner only when the pull request's files can affect what it builds or tests. A new job,
`desktop-scope`, runs on `ubuntu-24.04` first and runs `scripts/desktop-scope.mjs`. `desktop` has
`needs: desktop-scope` and `if: ${{ !cancelled() && needs.desktop-scope.outputs.desktop != 'false' }}`. A skipped
required check counts as passing, as `dependency-review` already relies on. The required check names in
`.github/rulesets/main-protection.json` are unchanged, `desktop-scope` is not required, and nothing needs an
admin step.

The script lists the pull request's files with the pull request files API
(`gh api --paginate repos/<repo>/pulls/<n>/files`, with a renamed file's old name too) and prints
`desktop=false` only when every one of them is a path the desktop job cannot read. It prints `desktop=true`,
and the job runs, when:

- the event is not `pull_request` (a push to `main`, a `merge_group` entry, anything else);
- the repository or pull request number is missing or malformed, `gh` fails, the list is empty, or it holds
  3000 or more entries (the API's cap, which may have cut it short);
- any one file counts as desktop.

If `desktop-scope` itself fails, its output is empty, which is not `'false'`, so `desktop` runs.

**Paths that do not count as desktop** (everything else does, so a new top-level path runs the job):

- `docs/`, `.github/`, `.claude/`, `.codex/`, `.vscode/`;
- `scripts/`;
- `tests/repo/src/`;
- `*.md` files, `LICENSE`, `NOTICE` and `renovate.json` in the root.

**Exceptions inside those, which count as desktop** because the job reads them:

- `.github/workflows/ci.yml`, the job's own definition, and `scripts/desktop-scope.mjs`, which makes the decision;
- `scripts/release/`, whose `install-app.sh` and `installed-app.sh` the macOS self-update test runs;
- `tests/repo/src/self-update-real-processes.test.ts`, which the job runs, and the two files it imports,
  `tests/repo/src/installed-app-sandbox.ts` and `tests/repo/src/workspace.ts`.

So these count as desktop by not being listed: `apps/desktop`, `apps/daemon` (the job runs its sandbox tests
and `apps/desktop` depends on it), every workspace package under `packages/`, `pnpm-lock.yaml`,
`pnpm-workspace.yaml`, the root `package.json`, `Makefile`, `mise.toml`, `mise.lock`, `rust-toolchain.toml`,
`tests/repo`'s config and `tests/git-isolation.setup.ts`.

The decision reads the files and nothing else, not even the event action. An `edited` event (a title change)
lists the same files as the last push, decides the same way, and so runs `desktop` exactly when that push did:
it can never turn a red `desktop` result for a commit into a skip. The note at the top of `ci.yml` and the
tests in `tests/repo/src/ci.test.ts` and `tests/repo/src/desktop-scope.test.ts` pin this.

## Why

On 2026-11-04 a pull request that touched only `.github/`, `scripts/`, `tests/repo/` and docs waited for a
macOS runner for the `desktop` check, and a runner shortage can hold such a change for hours. The job builds
the Tauri shell and runs a few macOS-only tests; a change to files none of that reads cannot change its result.

`paths` filters on the workflow were turned down: a workflow skipped by `paths` never reports, so the required
checks stay pending and block the merge, and `tests/repo/src/ci.test.ts` forbids them. Skipping `desktop` with
an `if` on the event action was turned down for the reason in the note at the top of `ci.yml`. A step-level
skip inside the macOS job was turned down because the job would still wait for the runner. Putting the
decision in a required job was turned down because it would need a new name in the ruleset and an admin step.

The default is to run: a list of paths that are safe to skip can only be wrong by being too short, which
costs a runner, while a list of paths that must run could miss a new package or a changed tool and let a
broken desktop build merge. The files API (merge-base to head, as the Files changed tab shows) is used instead
of a `git diff` between `base.sha` and `head.sha`, since `base.sha` moves when `main` does and the decision
for a head would then change between a push and a title edit.
