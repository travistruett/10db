# The desktop check runs on macOS only when a pull request changes what it tests

- **Date:** 2026-11-18
- **Supersedes:** `decisions/2026-11-04-desktop-runs-on-macos-only-when-its-files-change.md`

## Decision

The mechanism is unchanged. The `desktop-scope` job runs `scripts/desktop-scope.mjs` on `ubuntu-24.04`, which
lists the pull request's files with the pull request files API (a renamed file's `previous_filename` too), and
the required `desktop` job has `if: ${{ !cancelled() && needs.desktop-scope.outputs.desktop != 'false' }}`. A
skipped required check counts as passing. The decision reads the files only, never the event action, and the
ruleset's required check names are unchanged.

What changes is the list. It is now an allowlist: the script prints `desktop=true` only when a file of the pull
request is one the job builds or tests, and a pull request whose files are all unlisted skips the job. A new
top-level path, desktop UI code under `apps/desktop/src`, `apps/desktop/e2e`, daemon code outside the listed
modules and the workspace packages under `packages/` all skip it.

The job still runs whenever the files cannot be known: a non-`pull_request` event (so every push to `main`
runs it), a missing or malformed repository or number, a failing `gh`, an empty list, or one of 3000 or more
entries. A failed `desktop-scope` leaves an empty output, which is not `'false'`, so `desktop` runs.

**What counts**, grouped as `scripts/desktop-scope.mjs` lists it:

- the job: `.github/workflows/ci.yml` and `scripts/desktop-scope.mjs`;
- the install and toolchain: `pnpm-lock.yaml`, `pnpm-workspace.yaml`, the root `package.json`, `mise.toml`,
  `mise.lock`, `rust-toolchain.toml` and `Makefile` (`make rust-check`);
- the Tauri shell: everything under `apps/desktop/src-tauri/`;
- the desktop build `tauri build` runs: `apps/desktop/package.json`, `vite.config.ts`, `postcss.config.cjs`,
  `index.html`, `tsconfig.json` and `scripts/prepare-sidecar.ts`, with the daemon sidecar's
  `apps/daemon/package.json`, `vitest.config.ts` and `scripts/build.ts`;
- the daemon modules the Seatbelt and macOS-only tests exercise: everything under `apps/daemon/src/sandbox/`,
  `src/guard/`, `src/keep-awake/` and `src/verify/` (the gate Seatbelt test runs the gate runner), and
  `src/git/lane-writable.ts`, `src/git/run-as-builder.ts`, `src/session-setup/builder-skills.ts`,
  `src/environment/pinned-install.ts`, `src/environment/agent-pins.ts`, `src/sessions/open-in-root.ts` and
  `src/paths.ts`, with the tests beside them that the job names;
- every `apps/daemon/test/*.seatbelt.test.ts`, and the helpers they import, `apps/daemon/test/fixtures.ts`
  and `apps/daemon/test/pinned-tarball.ts`;
- the self-update test: `tests/repo/src/self-update-real-processes.test.ts`, what it imports
  (`installed-app-sandbox.ts`, `workspace.ts`), everything under `scripts/release/`, and the config that runs
  it: `tests/repo/vitest.config.ts`, `tests/repo/package.json`, the root `vitest.config.ts`,
  `tests/max-workers.ts` and `tests/git-isolation.setup.ts`.

`tests/repo/src/desktop-scope.test.ts` pins the list against the job: every path the `desktop` job's vitest
steps name must give `desktop=true`, so a test added to the job's line without its module on the list fails.

## Why

The 2026-11-04 list was a deny-list, so every path outside `docs/`, `.github/`, `.claude/`, `.codex/`,
`.vscode/` and `scripts/` ran the job. Since 2026-11-14 it ran on 32 of 40 pull request runs. Over six recent
runs it waited 90-613 s for a `macos-15` runner after `desktop-scope` finished and then ran 228-291 s, while the
Linux test shards finish in 390-570 s, so `desktop` was usually the last required check.

The job is for what only macOS checks: Seatbelt, macOS tools and paths, and the Rust and Tauri build. The
frontend's `vite build` already runs on Linux in the e2e jobs, and the daemon bundle builds on Linux in
`apps/daemon/test/bundle.test.ts`.

The full import closure of the job's tests was turned down. The Seatbelt tests import the `src/delivery` and
`src/git` barrels (`delivery/index.ts` alone re-exports from 47 modules), which reach most of the daemon, so the closure
would run the job on nearly every pull request again. That code runs alike on Linux, where the gate jobs test
it. The list follows the first hop of what is macOS-relevant instead.

Keeping the default to run was turned down because it is what ran the job on 80% of pull requests. The cost of
the allowlist is that a file it misses can break only on macOS and merge; the next push to `main` runs the job
and shows it. A dependency change cannot slip past, since a frozen-lockfile install means `pnpm-lock.yaml`
changes with it.
