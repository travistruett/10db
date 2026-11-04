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
  neither another lane's checkout nor another project.
- A checkout holds at most one batch waiting to start. `flush` queues a run for a checkout only when none is
  waiting there, and the run takes the checkout's pending changes when it starts, so events that arrive while
  a slow batch runs join the waiting one. Work in a checkout so waits for at most the batch running and the
  one waiting, each with its stamp reads within four budgets (120 s, below), however often a lane touches a
  slow file. `flush` settles when every queue has.
- `allowedWrites` reads the stamps of a batch's card-named paths together, in at most two rounds of reads.
  The first round reads the paths a card or an excused write names when it starts. A card answered during
  that round names a path it did not read, so the lists are made again and those paths are read together in a
  second round. A card answered only during the second round gets no third round: its path is not read and
  fails closed like an unreadable one (carded, the card left unused). Each round is within one budget, so
  `allowedWrites` waits at most two budgets (60 s), however many paths gain cards. It then decides path by
  path with no await between the decisions, against the cards and excused writes as they are after the
  reads.
- A batch calls `allowedWrites` at most twice: once for the paths it reports, then once for the files of all
  its reported directories not yet allowed, together, however many directories there are. So its stamp reads
  take at most four budgets (120 s), and it may first wait for the batch running ahead of it in its checkout,
  which is bounded the same way. A file read in the first call is read again in the second.
- A step end reads a file for another lane's excused stamp only when that lane has an excused write for the
  path, and those reads run together. A step end does not wait on its checkout's queue: it makes up to three
  rounds of reads one after the other, its own lane's two (`allowedWrites`) and then the others' excused
  stamps, each within one budget, so it waits at most three budgets (90 s). A read that runs out of time
  gives no stamp, so the file is carded (fail closed). A test pins this: a step end settles while another
  lane's batch is still held on a stamp read; another pins that paths whose cards are answered during the
  reads are read together and get no third round; a third pins that two directories' files are read together.

## Why

Stamping hashes a whole file, and only for paths a card or an excused write names, so the cost is the builder's
to bear. But a lane that holds such a card can make the file a sparse petabyte (`truncate -s 1P`) or keep
appending to it. With one unbounded read on the watcher's single chain, that stalled every project's batches
and claim re-checks, and the lane's own step end, and in a shared checkout another lane's step end too.
Excused writes survive a restart, so it came back after one.

Turned down: running stamps off the queue entirely, which would let a decision race the state the next batch
reads; and a byte cap, which brings back a size the builder had asked to remove and still lets a slow disk
hold a queue. A time budget bounds the one thing that matters, the wait.
