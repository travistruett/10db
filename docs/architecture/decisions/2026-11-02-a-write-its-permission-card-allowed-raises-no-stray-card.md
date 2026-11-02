# A write its permission card allowed raises no stray-write card

- **Date:** 2026-11-02

## Decision

The watcher raises no "Write outside every claim" card for a write the builder allowed through the lane's
Allow Edit card, nor for the same file at a step end.

- The broker records the file an edit-family call (`Edit`, `Write`, `MultiEdit`, `NotebookEdit`) writes as
  `detail.path` on its permission card: the real path the file-access judge resolved for a sandboxed lane, the
  call's own `file_path` or `notebook_path` otherwise.
- `allow_once` allows one write. The watcher uses the card up the first time a flagged write to that file
  appears in the lane's checkout (`watcher/allowed-writes.ts`, `allowedWrites`). The same write seen again
  unchanged in a later batch (the file's modification time to the nanosecond) is still that write. A later
  write to the file, with no card behind it, cards as before.
- `allow_workstream` and `allow_project` store a rule that lets the lane's later edits through with no card;
  a stored edit rule scoped to the file excuses every write to it.
- A denied card, a card for another lane or another checkout's copy of the path, and a card for another file
  excuse nothing. Cards answered before the watcher started are used up, since they allowed writes it never saw.
- A step end reads the whole diff, which holds every write of the step, so there any card that allowed the
  workstream to write the file excuses it.
- The sensitive-path rule is unchanged for a write no card allowed. A write inside another workstream's claim
  is a different card and is unchanged.

## Why

On 2026-11-02 two tasks that edited `.claude/hooks/git-guard.mjs` and `.codex/rules/default.rules` each
raised an Allow Edit card and, once it was allowed, a stray-write card naming the same file: about ten cards
for two tasks, each answered by hand. The builder had already decided about that exact write.

Matching on the card keeps the watcher the judge of every write nobody allowed. Excusing the file for the
rest of the session after one allow-once would have hidden a later write the builder never saw. Consuming one
card per write, keyed on the write's modification time, keeps that later write carded without the
double-card when one write arrives as two filesystem events.
