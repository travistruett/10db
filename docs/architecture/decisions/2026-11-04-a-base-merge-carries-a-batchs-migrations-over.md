# A base merge carries a batch's migrations over, under their names, after the base's

- **Date:** 2026-11-04
- **Amends:** `decisions/2026-10-30-a-batch-settles-its-own-conflicts-with-main.md` (a plain run of `generate`
  after taking the base's `packages/db/drizzle/`)

## Decision

Built. When a settled merge took `packages/db/drizzle/` from the base, the base update re-creates the branch's own
migrations after the base's, in their journal order, instead of one plain run of the generator
(`migration-carry.ts`, `generate` in `base-update.ts`).

- **Which migrations:** the journal tags at the merge's first parent that are on neither the base nor the common
  ancestor. The ancestor counts so that a baseline the base regenerated doesn't make the branch's older migrations
  look like its own. A journal that can't be read leaves nothing to carry, and the plain run's checks speak.
- **Generated or custom:** `--custom` leaves the schema as it was, so a migration whose snapshot repeats the one
  before it is custom. The comparison ignores `id`, `prevId`, `_meta` and key order, since `--custom` rewrites the
  snapshot in another key order. The SQL can't tell: its author may replace the stub's first line.
- **How:** one run of the package's `generate` per migration, chained after the contracts' generator:
  `generate --name <name>`, or `generate --custom --name <name>`. A custom migration's SQL is then read from the
  branch's tip as bytes (`Git.bytesAt`) and written over the stub. The generators ran the repository's scripts, so
  the write refuses a link in the path to it. It opens the file non-blocking and goes on only for a regular file
  with one link, truncating after that check, and reads the journal the same way: this runs in the daemon, outside
  the sandbox, so a FIFO would freeze its event loop and a hard link would reach a file outside the worktree.
- **Checked:** the worktree's journal must hold the base's tags, then each migration's name in order. Only then
  are the files committed, as one `Regenerate …` commit. A migration carried over no longer counts as dropped, even
  when its SQL differs because the base changed the same table.
- **When it fails:** a failed run, a migration the generator did not make, a custom SQL it could not put back, or
  a migration that can't be read: 10db restores the directories, commits nothing on top of the merge, and raises
  the one `base-regenerate` card, naming the first migration not carried over and where its file is. A card for a
  run that never got that far (a stop, a failed install) names the `.sql` files the merge dropped.
- **A merge that lost one stops the gate:** whenever a `.sql` the branch added was dropped and the journal at HEAD
  lacks its name, whatever the reason (a failed carry, a failed or broken install, generators that threw, a dirty or
  moved worktree, a stop), `beforeGate` answers `uncarried` and no gate runs. Drift can't be left to catch this: a
  custom migration changes no snapshot. A file the common ancestor had came off because the base removed it, so it
  doesn't count. The migrations go on the batch's `migrations-uncarried` notice, because the merge stands and every
  later gate answers `up_to_date`; each gate reads the notice and answers `uncarried` until the journal holds them,
  then clears it and the card. Telling by name means a stub of the right name clears it, and that a batch which no
  longer wants the migration clears it with an empty custom migration of that name.
- **Who does what with it:** a task's verify gate counts it as a failed gate, so a fix session re-creates the
  migration, told how by the note and the notice in its brief. The shipping gate fails the batch
  (`BatchFailure.BaseConflict`, whose flag card carries the detail, with no second regenerate card), and a Retry reads
  the notice again. A ship with no gate brings no base in, but a lane's launch may have, so it asks too
  (`standingOnly`). A pull request's catch-up pushes nothing, puts the merge back as for any stopped catch-up, keeps
  no notice, and the one catch-up card says why.
- **Telling the batch:** a migration whose tag changed goes on the batch's `migrations-renumbered` notice, old tag
  to new, kept across later merges (a migration moved twice shows its first tag and its last) in the notice's
  `record`. The gate's note says the same. The runner puts the notice's body in the brief of every later session
  of the batch, which also says that docs naming a renumbered migration are the lane's to fix: 10db changes only the
  migrations directory.

## Why

Two incidents on 2026-11-04. `generate` with no name gave a batch's column a random name, and nothing could make a
`--custom` backfill again, so a fix task authored it a second time. Migrations are numbered in order, so the only
correct result of two sides adding them is the base's, then the branch's. The number changes; the name, the order
and a custom migration's bytes need not.

The notice is the store because it needs no schema change, survives a restart, and already reaches the builder's
drawer. It is not cleared: a review step is the usual next step and can't edit, so the implement step after it must
still be told.

**Not solved:** a branch with two or more generated migrations. `generate` diffs the schema as merged, so the first
takes all of the branch's schema changes and the second has nothing left: drizzle-kit exits 0 and writes no file.
That raises the card naming the second migration, and commits nothing. Folding them into one would be wrong as well
as unnamed: some pairs are two steps for a reason (migrations 0027 and 0028 of `packages/db/AGENTS.md`). Making each
step would need the schema as it stood at each migration, merged with the base's.
