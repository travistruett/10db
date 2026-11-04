# A Read, Grep or Glob of the worktrees folder outside a lane's own copy is refused, not carded

- **Date:** 2026-11-03
- **Amends:** `2026-10-31-lanes-run-in-auto-mode-inside-the-sandbox.md`

## Decision

`FileAccessContext` (`apps/daemon/src/sandbox/file-access.ts`) carries `worktreeRoot`, the directory the
daemon makes every lane's copy under (`createLaneSandbox`'s `worktreeRoot`, which `startDaemon` passes).
`readAccess` returns `outside-copy` for a real path at or under it that is not in the session's own copy
(the copy is checked first, so it stays `inside`). It is judged on the real path, both readings, like the
other verdicts, so a link out of the copy does not open it, and a Grep, Glob or LS of the folder itself or
of a project folder above the copy is `outside-copy` too.

The guard's file judge (`read`) and the permission broker (`judgeRead`) both refuse it at once, with no
card: "<path> is in the worktrees folder but outside this lane's copy. The copy is <copy>; build paths from
it (or use relative paths), never from the worktrees folder." Protected verdicts keep their own message and
outrank it. The copy's path is named so the next call can be right.

With no `worktreeRoot` (tests, a context built without one) nothing changes: such a path asks as before.

## Why

On 2026-11-03 lanes asked, for Read and Grep, about paths made of the project's worktrees folder plus a
repository path (`…/10db-b83cc7/apps/daemon/src/delivery`), missing the batch's own folder. Ten cards by
23:55 UTC came from every lane. Each parked the lane until a person answered, and one lane repeated the call
minutes after a denial whose note named its copy: a note after a card does not stop it, and a card is the
wrong shape for a path that is never right. Only a refusal the lane reads in the same turn, naming the
copy, lets it correct itself without a person.

Where the folder reaches the session: the daemon's briefing, prompts, MCP results and the sandbox
settings name the copy only (audited: no module that builds them reads `worktreeRoot`; the sandbox profile's
reads and writes are the copy's). What a lane's own commands print is outside the daemon's hands, chiefly
`git worktree list`, which lists every copy of the project by absolute path. The refusal does not depend on
finding every such source, which is why it is the fix; hiding that output is a separate change.

Turned down: adding the whole worktrees folder to the read list (opens other lanes' unmerged work to every
lane), and leaving the card and improving its note (the 2026-11-03 evidence).
