# The builder's hand edits ride the owning task; the watcher raises no card for a page of an open pass

- **Date:** 2026-11-09
- **Amends:** the watcher's stray and foreign-claim rules (`apps/daemon/src/watcher/`)

## Decision

Before a builder message reaches a page's agent, and at the start of a take-out, the page files that differ from
the task's last kept commit are kept as one more kept commit (`pass/hand-edits.ts`), named on the thread and at
the head of the agent's next message, a file the folder held before the pass marked so. A file last written, or
for a deletion its directory last changed, inside another page's turn is named apart as changed while that page
worked, never as the builder's. Files a put-back wrote are kept at once as the task's own work, so they are
never folded as hand edits. While the page's own turn is open nothing is folded.

While a pass holds its tasks (open, closing or abandoning), a write in Your folder inside a claim a task of the
pass holds raises neither the foreign-claim nor the stray card (`watcher/pass-writes.ts`). A write outside every
claim raises the stray card only while a lane of the pass is working, at that lane's session end, or just after
its turn ended, naming those lanes. Unowned edits listed at close are designed (Workbench spec §5.4).

## Why

In a pass the builder edits the page beside its agent; carding each such write would bury the Inbox. The task
that owns the page is the only one that can carry the edit to sign-off. An agent's shell writes are not seen by
the guard's hook, so a write outside every claim while one works is still carded.

Turned down: attributing by the watcher's event time, which arrives after a debounce and cannot tell a shell
from an editor.
