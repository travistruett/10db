# Only the installed app's daemon calls Artificial Analysis

- **Date:** 2026-10-28

## Decision

The daemon reads `TENDB_BENCHMARKS` (`on` or `off`, validated in `apps/daemon/src/env.ts`; absent means
`on`). With `off`, `main.ts` hands the benchmark sync a key reader that never touches the Keychain, so the
sync records `no_key` and makes no request. The e2e Playwright web server, `apps/daemon/scripts/live-acceptance.ts`
and `scripts/dev.sh` set it to `off`; the installed app sets nothing. `tests/repo/src/benchmarks-off.test.ts`
fails when one of them stops setting it. Any other value is an `EnvError`.

## Why

Every daemon reads the builder's one Artificial Analysis key from the Keychain, and a daemon whose data
dir has no successful sync pages up to ten requests at start. Each `make gate` starts an e2e daemon on a
fresh data dir, `pnpm dev` restarts its daemon on every source change, and live acceptance starts more,
so they used up the shared daily quota before the real app could sync.

An explicit switch was chosen over sniffing the data dir or the fake adapter: the signal is visible,
checkable by a repo test, and does not couple benchmarks to unrelated settings. Not setting a key
in those environments was not an option, since the daemon reads the same Keychain entry whatever its data
dir. A machine-level cache shared across data dirs would also cut requests; it is left out of this change.
