# 10db's sandbox files leave /private/tmp, and a ChatGPT lane keeps Codex's normal /private/tmp access

- **Date:** 2026-11-05

## Decision

Codex's base Seatbelt policy lets every command read and write all of `/private/tmp` (and `/tmp`, `/var/tmp`), and no
profile entry closes it: with denies on both a folder there and `/private/tmp`, a command still read and wrote that
folder. 10db kept its temp files there, so Travis decided, in four questions on 2026-11-05:

- **ChatGPT lanes keep Codex's normal `/private/tmp` access.** Other software's temp files, Claude Code's own included,
  stay readable to them. Nothing short of a second sandbox closes it.
- **10db's control files go to `~/.10db/run/`:** process ledgers, srt settings files and env files. A forged or swapped
  one could escape a sandbox or read a token. The guard sockets are there too.
- **A ChatGPT lane's temp dir goes to `~/.10db/lanes/`,** apart from other lanes' as Claude lanes' are.
- **Claude lanes', gates' and MCP servers' temp dirs go to `/Users/Shared/10db-<uid>/`,** which keeps ChatGPT lanes out
  of them and fits the 44-byte limit. The limit counts Claude Code's own dir in the temp dir, the path plus
  `/claude-<uid>`: Claude Code falls back to the shared `/tmp/claude-<uid>` without a word when that is longer. So a
  temp dir there is named by six random characters alone, and `/Users/Shared/10db-501/xxxxxx/claude-501` is 40 bytes.
  The uid is in it twice, so it fits for a uid of up to five digits; a longer path is refused. The root is made 0700
  and refused when it is a link or another user's. The uid keeps two macOS users apart, since `/Users/Shared` is
  writable by all of them.

As built:

- **pnpm's store lock directory** (`pnpm-store-operation-locks-<uid>`) stays in the system temp dir, because pnpm names
  it by the literal `/tmp`. A package-install gate may write it, so afterwards the sweep never looks into it in place: it
  renames the directory into the lane temp root (closed to every sandbox), which moves a link rather than following it,
  and walks only the moved name, with tools that never follow a link. Moved trees left over are removed first. What
  can't be removed is logged and left, since no sandbox can reach it and no later run waits on it. If it can't be moved,
  nothing is walked and the run is refused.
- **The system-temp sweep.** Before any lane session or gate, the daemon unlinks its sealed files and ledgers from
  `/private/tmp` and `/private/var/tmp`, so one a crashed daemon left isn't left for a ChatGPT lane to read. Once it
  listens it removes its lane temp dirs there in the background, which `stop()` ends between entries.
- **A daemon mark counts only while its pid's command line names `daemon.mjs` or `src/main.ts`.** A running daemon marks
  a sandbox root (`10db-daemon-<pid>`) and a sweep leaves a root another live daemon marked. In a system temp dir every
  ChatGPT lane can write, so a mark naming any other running process, which a lane could plant, keeps nothing. When `ps`
  can't be read, every live mark counts.
- Codex's base policy closes both `~/.10db` and `/Users/Shared`; a command there got `Operation not permitted`. A lane is
  granted only its own temp dir, and reads control files only through the grants that already name them.

## Why

The goal is that ChatGPT lanes can't read what Claude lanes, gates and MCP servers use, or forge what 10db trusts,
without building a second sandbox. Moving 10db's files closes that for everything 10db owns, and leaves only other
software's files, which is Codex's own bar. The design is `docs/superpowers/specs/2026-11-05-10db-chatgpt-plan-design.md`
(Temp files), and it cites `decisions/2026-10-29-sandbox-is-the-boundary.md` for why the kernel, not the guard, holds the line.
