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

## Hardening after review

- **The program and its directories are the daemon's, not the repository's.** The pnpm that runs is an
  absolute path to a real program that the daemon resolves from the login `PATH` (`delivery/pnpm-binary.ts`).
  It must lie outside every checkout, must not be a script (`#!`, whose interpreter a project's config could
  steer), and neither it nor its real path may pass through a version manager's directory (`shims`,
  `corepack`, `.volta`, `fnm`, `asdf`): those pick the version from the directory they run in. A mise shim is
  the one case that is asked, from the builder's home directory so no project config applies, which program it
  stands for, and the answer passes the same checks. If none qualifies the cut is refused with a card; PATH is
  never used as a fallback. `pnpm_config_manage_package_manager_versions=false`, `COREPACK_ENABLE_STRICT=0`
  and `COREPACK_ENABLE_AUTO_PIN=0` stop `packageManager` and corepack from switching programs, and
  `--store-dir "$pnpm_config_store_dir" --modules-dir node_modules --virtual-store-dir node_modules/.pnpm`
  override whatever `.npmrc` or the workspace file say. Measured with a `package.json` pinning pnpm 9 and an
  `.npmrc` naming another store and directories: pnpm 12 ran, and it wrote only where the command said.
- **The sweep never looks into the path a run could write.** pnpm's lock path is fixed (it ignores `TMPDIR`),
  and the run's grant covers the path itself, so the run could swap the directory for a link at any moment.
  The daemon therefore never reads, changes the mode of or removes anything through that path: it renames it
  (a rename moves a link instead of following it) to `<path>.sweep-<uuid>`, a name no run can guess, and works
  only on that. A link there is unlinked; in a directory, every entry is unlinked (a directory is removed
  only when empty), nothing is followed or removed recursively, and the directory is then removed. The same
  sweep runs before a run starts, for what a crash left, so every install gets a fresh private directory
  and a replaced path is cleared, not reported. Installs of different projects can overlap; a sweep then moves
  the directory from under a live pnpm, which loses a lock's mutual exclusion but gives it no path outside.
- **Cost, stated.** The run's store is empty, so the install downloads the worktree's whole tree each cut
  (about 15 to 25 seconds, 635 packages measured) and the seeded clone is mostly replaced; several cuts at once
  are several downloads, outside the gate slots on purpose. A project whose registry host is not allowed, or an
  offline machine, can no longer cut a pnpm worktree: the card says so. Comparing the lockfile to pnpm's copy
  in the seed to skip the install was measured unreliable (the files differ in form when current).
- **Retry** removes the replaced worktree if the install throws or fails. A daemon killed mid-install is not covered: the worktree then looks whole to the next Retry (a marker written after a successful install is a follow-up).
- **Not done:** a daemon crash during an install leaves its process and any entry it made in the lock directory
  until the next install sweeps them; a startup sweep and a recorded process group are a follow-up.

Not done: a lane that changes `package.json` or the lockfile still cannot install in its own sandbox (no lock
directory, no registry unless allowed), and the gate then reports pnpm's lock error. That needs the same grant
for lanes, which would open the shared directory to code a lane runs, so it waits for its own decision.
