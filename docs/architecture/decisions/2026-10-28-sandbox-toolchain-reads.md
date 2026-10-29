# The sandbox lists mise's installs by name and moves xcrun's cache into the temp dir

- **Date:** 2026-10-28
- **Amends:** decision 132 (the gate runs under srt) and the lane sandbox's toolchain reads
  (`03-trust-boundaries.md`, "Toolchains")

## Decision

- mise's `installs` directory (`$MISE_DATA_DIR/installs`, else `$XDG_DATA_HOME/mise/installs`, else
  `~/.local/share/mise/installs`) can be _listed_ by lanes, gates and MCP servers, when it lies under the
  builder's home and outside every checkout, and so can each tool dir in it (`installs/<tool>`). Nothing in
  either opens: a listing shows names. The grants are two exact-match patterns per installs dir (written path,
  and real path when the dir is a link inside a granted read): the dir with its last character as a
  one-character set (`.../install[s]`), and its children (`.../installs/*`). Each version's contents open entry
  by entry, as before, from what is installed when the profile is built; a version installed later matches no
  pattern and stays closed, its `etc` and npmrc files with it. No deny is written inside an opened tree. mise's
  data dir stays closed apart from `installs` (listing only) and `shims`, and nothing under it, or under its
  state dir, is writable. nvm and volta are unchanged.
- `prepareCommandEnv` sets `xcrun_db` to `<temp dir>/xcrun_db`, so Apple's xcrun shims (`/usr/bin/git`,
  `/usr/bin/make`) create their lookup cache inside the temp dir. `xcrun_db` joins the env allowlist.
- A lane's session env, which Claude Code and the git it runs use outside the sandbox, holds no variable whose
  value is the temp dir or a path in it, except `CLAUDE_CODE_TMPDIR` (`withoutTempDirPaths`). That is
  `xcrun_db`, mise's config variables (`MISE_CONFIG_DIR`, `MISE_GLOBAL_CONFIG_FILE`, `MISE_SYSTEM_DIR`,
  `MISE_SYSTEM_CONFIG_FILE`), `XDG_CONFIG_HOME`, `CARGO_HOME` and the npm, pnpm and corepack caches. The
  sandboxed shell has all of them: a lane's `CLAUDE_ENV_FILE` carries every one, and a gate's inner env does.
  `LaneSession.commandEnv` is the full set. The same rule would cover a variable added later.
- `prepareCommandEnv` sets `MISE_LOG_LEVEL=error`.
- The state dir stays read-only and `MISE_STATE_DIR` is not moved.
- The listing patterns are held to exactly the two shapes `listingGrant` and `childListingGrant` emit (never the
  root), only from `toolchainListings`, and a listing of a dir that is or lies under a protected read or secret
  file is dropped like any other read. An installs dir whose name the profile can't hold refuses the session,
  naming the path.

## Why

The first real run of 10db's own gate in the sandbox failed its rust step on every run and timed out git-heavy
tests. Two causes, both reproduced under the gate's real profile (macOS, mise 2026.10.11):

- mise reads `installs` and each `installs/<tool>` as directory listings on every command. The profile opened
  only the entries of each version, so `mise ls` and every shim failed with `Operation not permitted`. A
  listing needs only a grant on the directory itself, but srt renders a plain path as a subtree (the whole
  tree below it) and only a pattern as an exact match. Opening `installs` as a plain path was tried first and
  rejected: it reaches every version installed after the profile is built, `etc/npmrc` and
  `lib/node_modules/npm/npmrc` included, and denying individual secrets inside an opened tree fails open for
  any that appear later. The pattern spelling lists the dir and nothing in it (measured under the real srt: the
  dir and its tool dirs list; a version dir, its `etc/npmrc` and a version created after the run started do not
  read). Claude Code's sandbox takes the same patterns (measured with Claude Code 2.1.312, `claude -p` with the
  profile as `--settings`: the listing grants worked, a version dir and its `etc/npmrc` stayed denied, and the
  sandbox stayed on). The profile schema holds a pattern only as one of those two shapes, and only from
  `toolchainListings`; any other pattern, in any field, still refuses the profile.
- Variables that name a path the lane can write are a way to run lane-written code from outside the sandbox.
  Reproduced with mise: a `config.toml` with `[env] _.source = "<script>"`, read through
  `MISE_GLOBAL_CONFIG_FILE=<it> ~/.local/share/mise/shims/node --version`, runs the script. `XDG_CONFIG_HOME`
  is read by git (`git/ignore`, `git/attributes`) and by Claude Code 2.1.312 (`anthropic/active_config`,
  `anthropic/configs/*.json`, its auth profile dir); cargo reads `config.toml` (`rustc-wrapper`) from
  `CARGO_HOME`. The session env had carried all of these since lanes got their own temp dir. The unsandboxed
  Claude Code needs none of them (measured by the live lane test, which passes with them gone), and the shell
  gets them from the env file.
- Apple's git and make are xcrun shims. They cache their lookup in `xcrun_db-<random>` in
  `getconf DARWIN_USER_TEMP_DIR` and ignore `TMPDIR`; the sandbox can't write there, so each call printed an
  error and repeated the lookup. `xcrun_db` names the cache file (measured: set, the cache appears at that
  path; unset, nothing is written under the sandbox). xcrun execs whatever the cache names, and the temp dir
  is writable by the lane, so the variable must never reach a process outside the sandbox: Claude Code runs
  its own git with the session env, so the lane's session env leaves it out (with the rest, above) and the
  sandboxed shell sets it from the env file. Turned down: allowing writes to the Darwin temp dir's `xcrun_db*` files (a write grant
  outside the temp dir, and the random suffix needs a pattern the profile can't hold); `DEVELOPER_DIR` plus
  calling `/Library/Developer/CommandLineTools/usr/bin/git` (the daemon drops `DEVELOPER_DIR` from its own git,
  it isn't on the sandbox's env allowlist, and the real binary's path would have to be found and put ahead of
  the shims on every `PATH`; not measured); `xcrun -n` (a flag of `xcrun`, which the shims don't take).
- mise has no setting that turns off tracking. Its failed link is a warning, not the error that exited: the
  error came from the `installs` listing. Moving `MISE_STATE_DIR` into the temp dir would silence it but hide
  the builder's `trusted-configs`, so a project's `mise.toml` would be untrusted in the sandbox, and a lane
  could trust its own config; making `tracked-configs` writable would open a write into the builder's state dir.
  mise has no setting that mutes one warning, so `MISE_LOG_LEVEL=error` is the narrowest switch there is. It
  also hides mise's other warnings (a new version being available, a hint), none of which a sandboxed
  command's reader can act on; mise's errors still print and still fail the command.
