# Git hooks run a lefthook from mise, never one in a checkout's node_modules

- **Date:** 2026-11-17
- **Supersedes:** governance decision G5 (`docs/architecture/decisions.md`), "lefthook git hooks, installed by
  the root `prepare` script"

## Decision

- lefthook is pinned in `mise.toml` (and locked in `mise.lock`), not in any `package.json`. The npm `lefthook`
  devDependency, the root `prepare` script (`lefthook install`) and `pnpm-workspace.yaml`'s
  `allowBuilds.lefthook` entry are gone, so `pnpm install` never writes git hooks.
- `make setup` (`scripts/setup.sh`) installs lefthook with the other pinned tools and then runs
  `mise exec -- lefthook install`. A new clone, or a lefthook bump, reruns it (or runs
  `mise install lefthook && lefthook install`).
- `lefthook.yml` sets no `lefthook:` option.
- The repo tests spawn `lefthook` from `PATH`. They skip only when none runs there and `CI` is not `true`; CI's
  `gate-test` job installs lefthook through mise-action. `tests/repo/src/hooks.test.ts` ('installed git hooks')
  installs hooks from a repository and from its linked worktree and checks they are byte-identical, that the
  lefthook they name lies outside every checkout and outside any `node_modules`, and that a commit and push
  from a worktree with no `node_modules` and no lefthook on `PATH` runs pre-commit, commit-msg and pre-push.
  `tests/repo/src/toolchain.test.ts` fails if any manifest depends on lefthook or a package script runs it.

## Why

- **A hook names the lefthook that installed it.** lefthook 2.2.2's hook template embeds `os.Executable()` of
  the process that ran `install` (the template's `LefthookPathCurrent`), in the line
  `elif <path> -h >/dev/null 2>&1`. When `lefthook` is not on `PATH`, that path is what every hook runs. All
  checkouts share one `.git/hooks`, so the npm copy, run by `prepare` on each `pnpm install`, rewrote the hooks
  to name the `node_modules` of whichever checkout installed last. On the builder's Mac that was a worktree's
  `node_modules/.pnpm/lefthook-darwin-arm64@2.2.2/.../bin/lefthook`. Anything that can write that checkout's
  `node_modules` could replace the binary, and the builder's next commit in a terminal would run it outside any
  sandbox. If that checkout is removed, the hook prints `Can't find lefthook in PATH` and exits 0, so no hook
  runs at all.
- **mise's copy is outside every checkout.** It lives under mise's installs directory, is the same path from
  every checkout, and no lane can write it, so the hooks are byte-identical whichever checkout installed them.
- **Turned down: setting `lefthook:` in `lefthook.yml`** to `mise exec -- lefthook`. Hooks would then need
  `mise` on `PATH`, which GUI git clients often lack, and `mise exec` would read `mise.toml`, a file a lane can
  write.
- **Turned down: keeping the npm copy without `prepare`.** Any later `lefthook install` run through
  `pnpm exec` would again write a checkout's path into the shared hooks, and the copy would stay a
  lane-writable binary the hooks could fall back to.
- **Version.** 2.2.2 is the version the repository already ran; Renovate's mise manager bumps it from here.
- **What stays.** The hooks' jobs still run the checkout's own Prettier, ESLint and commitlint through
  `pnpm exec`, as before. The pre-push `make precheck` and CI's policy job are unchanged; neither needs
  lefthook once `prepare` is gone.
