# Stamping a card-named file is bounded in time, and each checkout's batches run on their own queue

- **Date:** 2026-11-02
- **Amends:** `2026-11-02-an-excused-write-stays-with-its-lane-its-run-and-its-content.md`

## Decision

- A stamp (`stampOrReason`, `writeStamp`) reads asynchronously, a 1 MiB chunk at a time, so the event loop
  turns between chunks. It reads no further than the size its first `fstat` gave; a file that grew meanwhile
  fails the size check after the read and counts as `changing`.
- All of one stamp's attempts together get `STAMP_BUDGET_MS` (30 s). A file the hash can't finish in that
  time, such as a sparse file of petabytes, is given up on with the reason `too-large`. It fails closed like
  `unreadable`: the write is carded and the allow-once card stays unused.
- The 16 MiB cap stays removed: any file a disk reads in 30 s (tens of gigabytes) is still stamped.
- The watcher keeps one queue per checkout (`onRoot`) instead of one chain for every project. A batch or a
  claim-grant re-check waits only for the work already queued in its own checkout, so a slow file holds up
  neither another lane's checkout nor another project, and its own checkout for no longer than the budget.
  `flush` settles when every queue has.
- `allowedWrites` reads the stamps of a batch's card-named paths together, then decides path by path with no
  await between the decisions, against the cards and excused writes as they are after the reads.
- A step end reads a file for another lane's excused stamp only when that lane has an excused write for the
  path, and the reads run together, so another lane's step end waits at most one budget.

## Why

Stamping hashes a whole file, and only for paths a card or an excused write names, so the cost is the builder's
to bear. But a lane that holds such a card can make the file a sparse petabyte (`truncate -s 1P`) or keep
appending to it. With one unbounded read on the watcher's single chain, that stalled every project's batches
and claim re-checks, and the lane's own step end, and in a shared checkout another lane's step end too.
Excused writes survive a restart, so it came back after one.

Turned down: running stamps off the queue entirely, which would let a decision race the state the next batch
reads; and a byte cap, which brings back a size the builder had asked to remove and still lets a slow disk
hold a queue. A time budget bounds the one thing that matters, the wait.
