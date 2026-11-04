# A lane reads the Mac's own documentation without a card

- **Date:** 2026-11-04

## Decision

A sandboxed lane's Read, Grep, Glob and LS of a path whose real path is at or under `/usr/share/man`,
`/usr/share/info` or `/usr/share/doc` is `allowed` (`SYSTEM_DOC_ROOTS` in
`apps/daemon/src/sandbox/file-access.ts`, checked in `judgeRead` after the lane's own copy, the protected
paths and the worktrees folder, and after the read list). It raises no Inbox card. Every other path
outside the copy, such as one under the builder's home directory, still asks.

Only lanes get this. `judgeRead` is shared with the Shape judge, so the roots are opt-in: the lane sandbox
sets `FileAccessContext.systemDocRoots` and Shape's context leaves it unset. A Shape session still reads
only its checkout and its conversation's files, and is denied these paths
(`2026-11-02-shape-session-and-convert.md`).

The same list holds the read-only SDK headers and man pages, where a `*` segment stands for exactly one
path segment (an SDK's name): `/Library/Developer/CommandLineTools/SDKs/*/usr/include`, `.../usr/share/man`,
and the same under the Xcode app's macOS SDKs
(`/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/*/…`). Added after a lane
raised two cards on 2026-11-04 for `sys/attr.h` and `man2/setattrlist.2` under `MacOSX26.2.sdk`. Nothing
else under `/Library` (or the SDK, such as its frameworks) is covered: it still asks. A link such as
`MacOSX.sdk` is judged by the SDK it names.

The rule is about reads only. It adds nothing to `judgeWrite`, to the broker's Edit judgement or to the
guard's refusal of a file-tool write outside the repository, so an Edit or Write of a path under
`/usr/share/man` is still never allowed by this rule (the broker still cards it).

## Why

On 2026-11-04 two lanes waited on a card to read `ps.1` and `pkill.1`. Both were allowed once. System
Integrity Protection keeps these directories read-only and they hold no user data, so the card protects
nothing. The check is on the real path, so a link in the copy that leads out of these directories, or a
`..` that climbs out of them, is judged by where it lands. A fixed list in code, not a stored rule, keeps
the allowance out of reach of a project's own rules.
