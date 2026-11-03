# A copy whose packages don't resolve is repaired, or reported as a broken install, and never spent as a failed gate

- **Date:** 2026-11-03
- **Amends:** `2026-10-28-worktree-dependency-install.md` (the install before a gate, and what a failed one means)

## Decision

- **A health check, not a lockfile comparison.** `delivery/install-health.ts` (`checkInstall`) reads the copy's
  `pnpm-lock.yaml` and checks that every direct dependency (`dependencies`, `devDependencies`) of every workspace
  package it names resolves from that package the way Node looks: `node_modules/<name>` in the package's directory
  or any above it, up to the copy's root and never past it (`existsSync` follows the link, so a link into a pruned
  `.pnpm` fails). The walk up keeps a hoisted install (`node-linker=hoisted`, `dedupe-direct-deps=true`), whose
  workspace packages have no `node_modules` of their own, from reading as broken. It runs no program from the repository. An importer path that leaves the copy is ignored,
  since a lane writes the lockfile. `optionalDependencies` are not checked: pnpm leaves out the ones the platform
  cannot use. A lockfile it cannot parse counts as broken.
- **Repair.** `WorktreeDependencies.refresh` removes the copy's root `node_modules` (the daemon, a plain `rm`; a link
  is removed, never followed) before the install when the check says broken, so the sandboxed install starts as the
  first install of a copy did. The base update's install (`base-update.ts` `install`) runs at every gate, not only
  when the lockfile changed, for a copy that was installed (it has a `node_modules`, or an install passed and was
  recorded), and installs again, with `seeded: false` so a copy whose `node_modules` is gone is rebuilt too.
- **Another store starts over too.** `refresh` also removes `node_modules` when its `.modules.yaml` names a store
  other than the one the install is given (`madeFromAnotherStore`). A sandboxed install gets a store of its own in
  its run's temp dir, so a seed from the main checkout, or an earlier run's install, always names another store,
  and pnpm then tries to remove `.pnpm` even when every dependency resolves. A `node_modules` with no record, or a
  record that names no store, is kept. Until the lockfile check could read a pnpm 12 lockfile (#462), every copy
  read as broken and started over, which hid this; once the check read seeds as whole, every new copy's first
  install failed with `ERR_PNPM_PACKAGE_MANAGER_REMOVE_MODULES_DIR`.
- **Report.** When the install does not leave a copy that resolves, `beforeGate` answers `install_broken` with a note
  that names the unresolved dependencies. The gate does not start. The runner fails the task with the new failure
  kind `install_broken` and its card, **without counting a fix attempt** (`attempt` is not raised): a fix session
  cannot repair a copy's packages, and 10db already installed. Retry runs the step again, and the next gate checks
  and installs again. The shipping gate treats `install_broken` as it treats `conflicted`: it does not start, and
  the batch fails with `BatchFailure.InstallBroken` and a card that says the copy's install is broken, names the
  unresolved dependencies and says Retry installs again (`shipCards.installBroken`), never a gate-failed card.
- **Not decided here:** which pnpm the gate's install runs. `resolvePnpm` still skips version managers' shims and so
  runs the Homebrew pnpm, not the version `packageManager` pins. The repair above makes a mismatch recoverable
  instead of fatal; running the pinned version is a separate decision.

## Why

The task on batch 2 (2026-11-03) failed after four gates for a cause outside its code: an install made outside the
sandbox left `node_modules/.modules.yaml` naming another pnpm and store, the next sandboxed install tried to remove
`.pnpm`, the sandbox refused part way, and `node_modules/.pnpm` held 173 of 787 packages. Every gate step then failed
at once with `Cannot find module …/tsx/dist/cli.mjs`, and each failure counted as an attempt. Re-seeding a clone of
the main checkout's `node_modules` and letting the sandboxed install run fixed it, as did the first install of a
copy: the sandboxed install rebuilds from nothing or from a clone, not from a `node_modules` another pnpm made. So
the repair starts from nothing.

A lockfile comparison (the recorded blob) cannot see this: the lockfile did not change. Counting `.pnpm` entries
against the lockfile's snapshots is fragile (names are escaped, peers are suffixed). The direct dependencies of each
workspace package are what the gate's tools need to start, and the check is cheap (a few hundred `stat` calls).

A broken install must not be a failed attempt of the task: the attempt limit exists for code that fails its checks,
and four of them were spent on a broken environment.
