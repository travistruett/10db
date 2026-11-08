# 10db runs pinned copies of Codex and Claude Code, and tells the builder when a newer release is out

- **Date:** 2026-11-08
- **Amends:** `decisions/2026-11-07-renovate-keeps-the-verified-codex-current.md` (the pin moves to
  `environment/agent-pins.ts`, carries a checksum, and covers Claude Code too; the daemon no longer runs the
  builder's own Codex)

## Decision

- **The pin.** `apps/daemon/src/environment/agent-pins.ts` holds, for Codex and for Claude Code, one release
  (`CODEX_VERIFIED_ON`, `CLAUDE_CODE_VERIFIED_ON`) and the npm checksum of its `darwin-arm64` tarball
  (`CODEX_SHA512`, `CLAUDE_CODE_SHA512`). It is the release 10db is verified on. Bumping it is a change to that one
  version and its checksum; nothing else in the daemon names a release. Releases are Apple Silicon only, so one
  build per tool is pinned.
- **Where the copies live and how they are fetched.** The daemon downloads the tarball from the npm registry
  (`@openai/codex@<v>-darwin-arm64`, `@anthropic-ai/claude-code-darwin-arm64@<v>`) into
  `<data dir>/tools/<tool>-<version>-darwin-arm64/` in the background when it starts, so the app opens at once.
  A tarball whose SHA-512 is not the recorded one is dropped and nothing is installed. Only the part 10db runs is
  unpacked (Codex's `vendor/aarch64-apple-darwin` tree, Claude Code's `claude`), in a staging folder, with a
  `.pin.json` recording the pin and a digest of every file, then locked read-only and renamed into place. At each
  start the copy is verified again: the manifest names this pin and its checksum, the digest still matches, nothing
  on the path is writable by a group or others, and `--version` prints the pinned release. Copies of other releases
  are removed by the daemon once the pinned one is verified, and only from its own folder.
- **A copy that fails is refused.** The adapter for that agent ends every session at once with a message naming
  the tool, the release and why (`PinnedToolError`: checksum, changed files, a writable folder, a version that
  isn't the pin, a download that failed). The system check carries the same text. A recheck (the builder's, or the
  6-hourly one) removes a refused copy and fetches it afresh, checked against the checksum like the first
  download; a copy that is still fetching is left to finish, one fetch per tool at a time, and the recheck answers
  at once with the copy shown as fetching. A refused copy is never replaced without that recheck, so the builder
  sees the refusal first. While a copy is still downloading, sessions end with a message saying so.
- **The builder's own installs are left alone and never run.** `findClaude` and `findCodex` are gone; a
  `claude` in `~/.local/bin` or a `codex` in `/opt/homebrew/bin` changes nothing 10db runs or reports.
  `TENDB_CLAUDE_PATH` still names a binary to run in place of the pinned Claude Code (tests, dev), unchecked.
- **No lane can write the copies.** The data dir is already closed to a lane's reads. The folder
  `<data dir>/tools` is also in every sandbox's `denyWrite` (lane, gate, repo MCP servers), as written and
  resolved, so a checkout that holds the data dir (a project registered at the home folder) still can't write it.
  The files and folders are mode `0555`/`0444`.
- **Claude Code's own updater can't move what runs.** 10db starts Claude Code from the pinned path, never from
  a launcher an updater repoints, and the copy is read-only; sessions, probes and questions also get
  `DISABLE_AUTOUPDATER=1`, set after the session and sandbox env so neither can turn it back on.
- **The prompt.** Every 6 hours, and on a recheck, the daemon reads the `latest` document of each package on npm.
  When that release is later than the pin, the system check carries both versions (`agents[].pinned`,
  `agents[].newerRelease`) and the app shows "Codex 0.168.0 is out", naming the release 10db runs. Nothing is
  upgraded. It clears when a 10db change moves the pin to that release. A registry that can't be reached leaves
  the last answer in place.
- **Renovate.** Each pin has a regex manager over `agent-pins.ts` whose datasource is a custom one reading the
  platform build's release list and `dist.integrity` from the npm registry, so one PR rewrites the version and its
  checksum together. Each has its own group and a PR note naming the live test to run before merging
  (`TENDB_LIVE_CODEX=1 test/codex.live.test.ts`, `TENDB_LIVE_CLAUDE=1 src/sessions/claude-adapter.live.test.ts`).
  Both live tests fetch the pinned copy into a folder of their own (`<data dir>/live-tests/tools`, `ensureAgent`) and run on it, so they verify the release the PR pins without touching the copy the running app runs.

## Why

The builder's Codex sat at 0.154.0 while 0.167.0 was out, and moving to 0.167.0 broke every lane command until
10db was adapted. Whatever the builder had installed decided which release 10db ran, and nothing said so in
either direction. Running the verified release makes the live test the gate for a bump and removes the drift.

Turned down:

- **The vendor installers or GitHub releases.** Claude Code's installer and its own updater write into the
  builder's home and repoint a launcher; npm's tarballs are plain files with a checksum the registry publishes
  and Renovate can read, for both tools.
- **Bundling the binaries in the app.** About 400 MB of binaries per app update, and a bump would need a new
  app build rather than a download.
- **Blocking startup on the download.** The first start on a Mac with neither tool downloads about 270 MB; the app
  opens, shows the download, and the sessions that need a copy wait for it.
- **Hashing only the tarball.** The extracted files are what runs, so the install records a digest of them and
  checks it at each start. The manifest sits beside the files, so it catches a changed file, not someone who can
  write the whole folder; that is the boundary the read-only mode and the sandbox deny hold.
- **Upgrading the copy by itself when a release is out.** An upgrade 10db has not run the live test on can stop
  every lane, as 0.156 did.

The Renovate configuration was not run against Renovate itself; `tests/repo/src/governance.test.ts` checks that its
patterns find the pin and that its replacement template gives back the file as it is. If a Renovate PR arrives
without the checksum, `agent-pins.ts` is where to correct it by hand, from the `dist.integrity` the registry
publishes for the platform build.
