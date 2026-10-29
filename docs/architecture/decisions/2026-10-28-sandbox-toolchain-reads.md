# The sandbox opens mise's installs dir and moves xcrun's cache into the temp dir

- **Date:** 2026-10-28
- **Amends:** decision 132 (the gate runs under srt) and the lane sandbox's toolchain reads
  (`03-trust-boundaries.md`, "Toolchains")

## Decision

- mise's `installs` directory (`$MISE_DATA_DIR/installs`, else `$XDG_DATA_HOME/mise/installs`, else
  `~/.local/share/mise/installs`) is read whole by lanes, gates and MCP servers, when it lies under the
  builder's home and outside every checkout. Every version's `etc` directory is denied again, by its written and
  real path, beside the npmrc paths that were already denied. mise's data dir stays closed apart from `installs`
  and `shims`, and nothing under it, or under its state dir, is writable. nvm and volta are unchanged.
- `prepareCommandEnv` sets `xcrun_db` to `<temp dir>/xcrun_db`, so Apple's xcrun shims (`/usr/bin/git`,
  `/usr/bin/make`) create their lookup cache inside the temp dir. `xcrun_db` joins the env allowlist.
- `prepareCommandEnv` sets `MISE_LOG_LEVEL=error`, which keeps mise's warning about the tracked-config link it
  can't write in its read-only state dir off every command.
- The state dir stays read-only and `MISE_STATE_DIR` is not moved.

## Why

The first real run of 10db's own gate in the sandbox failed its rust step on every run and timed out git-heavy
tests. Two causes, both reproduced under the gate's real profile (macOS, mise 2026.10.11):

- mise reads `installs` and each `installs/<tool>` as directory listings on every command. The profile opened
  only the entries of each version, and Seatbelt allows a listing for a directory opened with its contents, so
  `mise ls` and every shim failed with `Operation not permitted`. The listing alone can't be opened: it would
  take a path with a glob character, which Claude Code's sandbox drops the whole profile for. Opening the dir
  adds only each version's `etc` and a tool's loose files, and `etc` is denied again. The per-version entries
  stay listed for versions linked elsewhere, which the kernel judges by their real path.
- Apple's git and make are xcrun shims. They cache their lookup in `xcrun_db-<random>` in
  `getconf DARWIN_USER_TEMP_DIR` and ignore `TMPDIR`; the sandbox can't write there, so each call printed an
  error and repeated the lookup. `xcrun_db` names the cache file (measured: set, the cache appears at that
  path; unset, nothing is written under the sandbox). Turned down: allowing writes to the Darwin temp dir's
  `xcrun_db*` files (a write grant outside the temp dir, and the random suffix needs a pattern the profile
  can't hold); `DEVELOPER_DIR` plus calling `/Library/Developer/CommandLineTools/usr/bin/git` (the daemon
  drops `DEVELOPER_DIR` from its own git, it isn't on the sandbox's env allowlist, and the real binary's path
  would have to be found and put ahead of the shims on every `PATH`; not measured); `xcrun -n` (a flag of
  `xcrun`, which the shims don't take).
- mise has no setting that turns off tracking. Its failed link is a warning, not the error that exited: the
  error came from the `installs` listing. Moving `MISE_STATE_DIR` into the temp dir would silence it but hide
  the builder's `trusted-configs`, so a project's `mise.toml` would be untrusted in the sandbox, and a lane
  could trust its own config. Lowering the log level to errors costs only mise's own warnings, in a sandbox
  where nobody acts on them.
