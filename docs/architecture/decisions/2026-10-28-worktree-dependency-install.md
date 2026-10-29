# A new worktree's packages are installed from its own lockfile, under the gate's sandbox

- **Date:** 2026-10-28
- **Amends:** `2026-10-27-worktree-seed-by-clone.md` (the seed is no longer the last step before OPEN) and
  decision 132 (the gate sandbox gains one kind of run)

## Decision

- After the seed, and before the batch opens, the cut runs `pnpm install --frozen-lockfile --ignore-scripts
--ignore-pnpmfile` in the new worktree, for a project whose worktree holds a `pnpm-lock.yaml` and a seeded
  `node_modules` (`delivery/worktree-dependencies.ts`). Any other project is left as seeded. The same step runs
  when Retry makes a lost worktree again.
- It runs through the gate runner, so it is a gate run: srt, the project's allowed hosts (the package registry
  among them), loopback if the project allows it, the checkout and the run's own temp dir writable, nothing
  else. It runs no code from the repository: no dependency's install script, no `prepare` script, no pnpmfile.
  pnpm's own work is the only program that runs, from the toolchain the sandbox already opens. It is not
  queued behind the gate slots, which would hold a cut behind a long gate.
- Its failure refuses the cut with a card that names the cause: the exit code or the timeout, the end of pnpm's
  output, the command, the log path, and that a blocked connection means the registry host is not allowed. The
  worktree and branch are removed, as for a failed seed. The step has the gate timeout.
- pnpm keeps its store locks in `<system temp dir>/pnpm-store-operation-locks-<uid>` and ignores `TMPDIR`
  (measured: `TMPDIR` pointed elsewhere, the lock file still appeared under `/private/tmp`). A run that asks for
  `packageInstall` gets that one directory open for reading and writing (pnpm opens its lock files with
  `O_RDWR`; write alone fails with `Operation not permitted`). The daemon makes the directory, refuses one that
  is a link, not a directory, owned by someone else or open to other users, and after the run removes everything
  in it that is not a regular file. No lane and no ordinary gate run gets the directory.
- `scripts/gate.sh` says what a rust step needs: when `rust.log` holds cargo's `CONNECT tunnel failed`, it adds
  one line naming `index.crates.io` and `static.crates.io` to the log and to its output, before the summary.
  Whether a project allows them stays the builder's decision; nothing here adds them to any config.
- `knip.json` names the lefthook config file (`"lefthook": { "config": ["lefthook.yml"] }`). Without it knip's
  lefthook plugin globs `<main checkout>/.git/hooks/*` from a linked worktree, which a sandbox cannot read, and
  the failed read ends knip's whole file walk.

## Why

The first real gate of a worktree task failed five steps for one cause. Measured on the failing task's logs and
reproduced by cutting a worktree the way 10db does, seeding it from the main checkout and running
`apps/daemon/scripts/sandboxed-gate.ts` on it:

- **Stale packages.** The main checkout holds what the builder last installed, which can be older than its own
  lockfile (here `@modelcontextprotocol/sdk` 1.32.1 against the lockfile's 1.32.2). The clone copies that
  faithfully, so typecheck failed on a type the newer SDK changed, and lint reported "could not be resolved" for
  the same packages. In worktree mode no one updates the main checkout, so every base branch that moves its
  lockfile makes the next seed stale.
- **The store lock.** pnpm 12 checks, before any script, that `node_modules` matches the workspace, and
  `node_modules/.pnpm-workspace-state-v1.json` names the main checkout's paths, so a seeded tree always looks
  out of date there. pnpm then installs, and the install needs its store lock in `/tmp`, which a sandbox
  cannot write: `ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK`. The sandbox's temp dir cannot hold it. Granted, the
  lock opens and the install runs (measured: 635 packages in 25 s with a cold store, because the install
  repairs the worktree's own `node_modules` and writes the state file for the worktree's paths, after which
  `pnpm run` no longer tries to install).
- **Why in the sandbox.** The security rule is that no process outside a sandbox acts on lane-writable input:
  a lockfile, a `.npmrc`, a pnpmfile and `packageManager` all steer pnpm, and the lockfile of a branch is what an
  earlier lane merged. Running the install in the daemon would have been faster to build and is exactly what the
  rule rules out. Under srt the install reaches only the allowed hosts and writes only the worktree.
- **Why scripts and the pnpmfile are off.** An install script is repository code, and the root `prepare` script
  (`lefthook install`) writes hooks into the git dir all worktrees share, which a sandbox denies and which a
  worktree must not change anyway. With no repository code in the run, the only thing that can write the lock
  directory is pnpm, so the shared directory is a small exposure; the sweep afterwards removes a link a run
  might have left for a later, unsandboxed pnpm to follow. A project whose lockfile depends on a pnpmfile or
  needs a build script for its tests gets a card naming the failure and not a half-installed worktree; running
  its scripts is a separate decision.
- **Why not "verify and refuse".** The seed would then fail for every task as soon as origin/main moved, since
  the main checkout is never updated by 10db.
- **Why knip.** Measured with `knip --debug` in a linked worktree: "Unable to read <worktree>" appears only in
  the sandbox, and `CONTRACT_SCHEMAS` and `ProjectConfig` are reported unused because the test files that use
  them were never found. The same worktree passes unsandboxed. The earlier advice to gate a plain clone is no
  longer needed.
- **Rust.** The failed rust step is a closed network, not a defect: cargo needs `index.crates.io` and
  `static.crates.io`. To allow them the builder adds two `SandboxNetworkAccess` rules to the project (Settings,
  the project's network hosts): `index.crates.io` and `static.crates.io`. With them the step passes (measured
  in the same sandbox, see the pull request).

Not done: a lane that changes `package.json` or the lockfile still cannot install in its own sandbox (no lock
directory, no registry unless allowed), and the gate then reports pnpm's lock error. That needs the same grant
for lanes, which would open the shared directory to code a lane runs, so it waits for its own decision.
