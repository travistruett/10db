# A lane adds a dependency through `install_dependencies`, which the daemon installs under the gate sandbox

- **Date:** 2026-11-03
- **Amends:** `2026-10-28-worktree-dependency-install.md` ("Not done: a lane that changes `package.json` or the
  lockfile still cannot install in its own sandbox")

## Decision

- A lane that needs a new dependency edits the `package.json` (it holds the `deps` hazard for that) with an **exact
  version**, then calls the MCP tool `install_dependencies`. The daemon (`delivery/dependency-change.ts`) runs it in
  the batch's turn, as a gate does (`BaseUpdates.gate`), so no gate runs on the tree meanwhile.
- **Pinned.** Before anything runs, every dependency the lane added or changed in a `package.json` (the manifests
  changed since the batch's base, committed or not, compared with the base's) must be an exact version
  (`1.2.3`, with an optional pre-release or build part), an `npm:` alias with an exact version, or a reference
  (`workspace:`, `catalog:`, `link:`, `file:`). A range (`^`, `~`, `*`, `latest`, `>=1`) is refused with the file and
  name, and nothing installs. A dependency the lane left as the base had it is not held to the rule.
- **The install** is the worktree install (`2026-10-28-worktree-dependency-install.md`) with `--no-frozen-lockfile`
  instead of `--frozen-lockfile` (`InstallMode` `update`): the same gate sandbox, the project's allowed registry host,
  scripts and the pnpmfile off, the daemon's pnpm and its own store and directories. pnpm resolves the manifests and
  writes `pnpm-lock.yaml` in the copy. A broken `node_modules` is removed first
  (`2026-11-03-a-broken-install-is-not-a-failed-gate.md`), and afterwards `checkInstall` must find every workspace
  package resolving its dependencies, or the tool answers `installed: false` and says what does not resolve.
- **The lane commits** the manifests and the lockfile with the commit tool; the answer lists what changed. The
  install is recorded like a cut's, so the next gate does not install again for the same lockfile. A blocked registry
  host raises the same host card as a failed cut. A task in the builder's own checkout is refused: 10db never
  installs there.
- The lane's prompt says never to run `pnpm add` or `pnpm install` itself.

## Why

In the lane sandbox `pnpm add` fails on the store lock (`ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK`): pnpm keeps it in a
directory under `/tmp` shared with every lane. Opening it to lanes would let code a lane runs write where a later
unsandboxed pnpm reads (the earlier decision's reason for not doing so). Here the program is the daemon's, the
sandbox is the gate's, and the lane's code never runs: only pnpm resolving the manifests the lane edited, as it
installs a lockfile the lane wrote. The alternative the builder was left with, running pnpm by hand in the copy, is
what produced the broken install of 2026-11-03.

The pin rule is the repository's own (AGENTS.md: "Pin every dependency exactly"); the tool enforces it where it can
be enforced, at the point the version enters the manifest.
