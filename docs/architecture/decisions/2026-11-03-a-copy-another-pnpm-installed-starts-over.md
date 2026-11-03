# A copy whose install another pnpm or store made is installed from scratch, at the cut and at the gate

- **Date:** 2026-11-03
- **Amends:** `2026-11-03-a-broken-install-is-not-a-failed-gate.md` (the repair it describes covered only packages already missing)

## Decision

- **Start over before installing.** `WorktreeDependencies.refresh` reads the copy's `node_modules/.modules.yaml`
  (`foreignInstall`, `delivery/install-health.ts`; one file read, no program from the repository). When it names a
  `packageManager` other than `pnpm@<the daemon's pnpm version>`, or a `storeDir` that is not the daemon's
  `pnpm_config_store_dir` or beneath it (pnpm names the store as a version directory under it), the copy's root
  `node_modules` is removed, as for a copy whose packages do not resolve, and the sandboxed install makes it again.
  `refresh` runs at the cut (after the seed clone) and before each gate (`base-update.ts` `install`), so a seed the
  builder installed in the main checkout with another pnpm, and a copy installed outside the sandbox, are both
  covered. Nothing the builder does in the main checkout can stop new copies.
- **The daemon's version** comes from `readPnpmVersion` (`delivery/pnpm-binary.ts`): the resolved pnpm run with
  `--version` from the temp directory with version switching off. When it can't be read, only the store is compared.
- **Start over once more after a failed install.** When the install fails (not a timeout, not a refused host) and
  `checkInstall` then says the copy is broken, `refresh` removes `node_modules` and installs once more in the same
  call. A second failure is reported as it is. This covers what the `.modules.yaml` comparison can't know (a version
  that couldn't be read, another cause of a half-removed `.pnpm`), so the builder never has to press Retry for it.
- **Which pnpm the daemon runs is not changed.** The daemon keeps running the pnpm `resolvePnpm` finds (Homebrew's
  12.9.1 in the incident), not the version `package.json` pins (mise's 12.15.0). Running the pinned version needs
  the daemon to download or locate it outside every checkout and to trust it, which version managers' shims
  (skipped on purpose, since they choose a version from the directory they run in) can't give. With the comparison
  above the mismatch costs one install from scratch per copy (slower than repairing, not wrong), and a pnpm upgrade
  moves the daemon without anyone editing the project. A project that wants the pinned version can make that its own
  decision.

## Why

On 2026-11-03 every new copy failed at the cut with `ERR_PNPM_PACKAGE_MANAGER_REMOVE_MODULES_DIR … Operation not
permitted`: the seed's `.modules.yaml` named pnpm 12.15.0, the daemon's 12.9.1 decided to remove `node_modules/.pnpm`,
and the sandbox refused. The earlier incident was the same on a gate: every link resolved after the outside install,
so `checkInstall` saw nothing broken, the sandboxed install broke it, and only Retry recovered. Both need the copy
started over before pnpm tries to remove anything. Comparing the one file pnpm itself uses to decide to remove
the directory catches it before the sandbox does; the retry after a failure catches the rest.
