# An excused write stays with its lane, its run and its exact content

- **Date:** 2026-11-02
- **Amends:** `decisions/2026-11-02-a-write-its-permission-card-allowed-raises-no-stray-card.md` (how a write
  an allow-once card excused is remembered)

## Decision

When an `allow_once` Allow Edit card excuses a write, the watcher remembers that write so it is not carded
again in a later batch, at the step end, or after a daemon restart (`watcher/watcher.ts`, `allowedWrites`;
kept in the app setting `watcher.excusedWrites`). Each remembered write now has these limits:

- **Its lane.** An entry is keyed by checkout, path and the workstream the card targeted, and stores the
  card's use key. It excuses that lane's write only. Another lane writing the same path in the same checkout
  needs a card of its own.
- **Its run.** An entry is forgotten when its lane ends (DONE, FAILED or CANCELLED) or no longer exists. It is
  kept in every state a lane passes through while it runs, including QUEUED (between steps, after a send-back,
  after a restart's recovery), RECOVERING and PAUSED_LIMIT. So it survives a daemon restart.
- **Its content.** A write is identified by the file's modification time to the nanosecond, its size and the
  SHA-256 of its content (`watcher/allowed-writes.ts`, `writeStamp`). A file changed behind a restored
  modification time and size is another write. When the file holds another write, the entry is dropped. A
  file that keeps changing while it is read (three tries) has no stamp: it is allowed without using the card,
  so the card still excuses that write once it settles.
- **Deletions.** An allowed deletion is remembered as `gone`. It stays excused for its lane while the file
  stays gone, at the live batch and the step end. It is forgotten as soon as the watcher sees the file there
  again, either on any batch event for that path (checked before git's filter, which drops a file restored
  as it was) or at a step end in that checkout. A later deletion of the same file is then a new write, and
  it is carded unless another card allows it.
- **Cost.** A file is read and hashed only when an unused allow-once card or a remembered write names it for
  one of the lanes in question. Any other write outside every claim is carded without being read.

## Why

An automated security review of #390 found that an entry was keyed only by checkout and path, and was
checked before the card's lane. Any lane's later write with a matching modification time was excused, a
`gone` stamp excused every later deletion, and entries were kept until 500 newer ones pushed them out. The
write itself still happened, but the stray-write card the builder should have seen was missing.

Limiting an entry to its lane's whole run, not to the states a session is live in, keeps #390's fix. A
restart or a step advance requeues the lane, and by then the card that allowed the write counts as used, so
forgetting the entry there would card the write the builder allowed. Hashing only the files a card names
keeps the watcher from reading large changed files on the daemon's event loop when no card concerns them.
