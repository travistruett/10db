# Renovate keeps the verified Codex current, and lane entries are keyed by real path

- **Date:** 2026-11-07

## Decision

`CODEX_VERIFIED_ON` (`apps/daemon/src/environment/system-check.ts`) is the Codex release 10db's Codex lanes are
verified on, and Renovate tracks it: a regex custom manager in `renovate.json` reads it against `@openai/codex` on
npm, and its update is a PR of its own (group "Codex CLI"), outside the weekly non-major group. The PR says to
install that release and run `TENDB_LIVE_CODEX=1` `test/codex.live.test.ts`, which CI never runs, before it
merges. The daemon's tests name `CODEX_VERIFIED_ON`, never a version literal, so the bump is one line; the desktop's
and the contracts' tests keep a version as fixture data, which no bump has to change. A repo test
(`tests/repo/src/governance.test.ts`) fails when the manager's pattern no longer finds the constant, which would
otherwise stop the tracking with no error.

The lane profile's file system map keys every entry by its real path (`filesystemOf` in
`sessions/codex-lane-permissions.ts`), so a link and its target are one entry, the stricter kept. Every comparison
between entries is made on real paths too: a read link whose target is in a denied tree the link is not in gets no
entry, a `denyWrite` narrows a write only inside a writable root and outside every deny, under both its own path and
its real path, and never lowers a deny. Its own path keeps a `read` entry, so a link under the checkout (a `.git`
that is a link) can't be swapped. A path that doesn't exist yet takes the real path of the nearest dir that does.

## Why

10db was verified on Codex 0.154.0 while 0.167.0 shipped, and nothing said so: the installed copy (an npm global
under Homebrew's node, which no shell's `npm update` reached) and the constant both stood still. A ChatGPT plan's
newer models are listed only by a newer Codex, so 10db could not route to them.

Moving to 0.167.0 broke every lane command. From 0.156.0 Codex copies every read and deny entry of a
`:minimal` profile into the exclusions of its implicit `/private/tmp` and `/private/var/tmp` write grants
(openai/codex#46571, `seatbelt_scratch.rs`), and macOS's sandbox compiler refuses a rule that large:
`sandbox-exec` exits 65 with "profile compilation failed", so the lane fails closed and runs nothing. On the
builder's Mac the map held 390 entries, most of them toolchain installs listed once per alias (`26`, `26.12`,
`latest` and the version they point to); the ceiling there is about 410. Keyed by real path the map holds 142,
and the live test passes 20 of 20 on 0.167.0. Seatbelt matches real paths, so an alias entry granted nothing more.

Turned down:

- Staying on the verified version until upstream changes: the later upstream code keeps the same exclusions.
- Dropping `:minimal`: commands then abort at start.
- One broad read with denies: it turns the lane's allow list into a deny list, a change to the trust model.
- Auto-upgrading the builder's Codex: an upgrade 10db has not run the live test on can stop every lane, as this
  one did.

The map is still unbounded: a Mac with far more toolchain installs could pass the ceiling again. Codex is
installed from the Homebrew cask, which `brew upgrade` keeps current, in `/opt/homebrew/bin`, where the daemon
looks; the daemon never takes `codex` from `PATH`.
