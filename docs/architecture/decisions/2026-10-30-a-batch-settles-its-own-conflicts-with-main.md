# A batch settles its own conflicts with its base, and the builder hears only when it can't

- **Date:** 2026-10-30
- **Amends:** `decisions/2026-10-29-gate-with-base.md` (a conflict is the builder's, and the card's wording)

## Decision

Built. The base merge before each gate (`Git.mergeIntoBranch`, asked with `resolve: { generated }`) no longer
stops at every conflict. It works on `merge-tree --write-tree`'s objects, with `merge.conflictStyle=diff3` and
the conflicted file info (`<mode> <oid> <stage> <path>`), and settles a conflict only in these two cases:

- **Both sides only added lines at the same place.** Every conflict hunk of a text file has an empty common
  ancestor section (`conflict-text.ts`), so the merged file keeps both sides' lines, the branch's first. The
  file must have all three stages, one regular mode, be text of at most 1 MB with no NUL, and a `.json` file
  must still parse. The resolved blob is written with `hash-object -w` and put in the merge tree through a
  private index.
- **The path is in a generated directory** (`GENERATED` in `worktree-generated.ts`: `packages/contracts/generated/`
  and `packages/db/drizzle/`). The directory is taken from the base whole (`read-tree --prefix`), so the files the
  branch had there that the base lacks (`dropped`) leave the merge. After the merge commit the daemon runs each
  directory's package's `generate` script in the worktree under the gate's sandbox (`createWorktreeGenerators`,
  the install's pattern: the daemon's resolved pnpm, no repository config picks the program), then commits the
  files that changed under those directories as `Regenerate <dirs> after merging origin/<base>`.

Anything else stays a conflict: two edits of one line, a deletion on one side, a file both sides added, a binary or
large file, a mode change, `pnpm-lock.yaml`, a drizzle journal (`meta/_journal.json`) outside a generated
directory, a JSON file the union breaks. Two tasks that each append a migration to a journal only add lines, so a
union would give two migrations one number; that conflict keeps its card, which says how to generate the
branch's migration again on top of the base (`decisions/2026-10-30-migrations-hazard-takes-the-base-first.md`). When any conflict stays, the whole
merge is refused as before, nothing is written, and the one `base-conflict:<batch id>` card now says for each
file why 10db could not settle it, besides the two ways out it already gave. The card is the only way the
builder hears of a conflict that was not settled, and it goes once the branch holds the base.

A conflict that was settled raises no card. The gate's evidence is headed by a note naming what was settled
("10db merged origin/main into this branch and settled its conflicts with it: <path> (kept both sides' added
lines), <dir> (regenerated from its sources)"), which the task's drawer shows; the merge commit's message lists the
same; and the log has a `base conflicts settled` line.

Two cases leave a merge that stands but needs the builder, and raise one `base-regenerate:<batch id>` card: the
generator fails, can't run or times out; or a `.sql` migration the branch had in a generated directory was
dropped and the generator did not make the same SQL again (a hand-written `--custom` migration, which is
authored once and never regenerated). The card names the directories (or files) and why; the gate's note says
the generated files may not match their sources. The card is not withdrawn by a later merge; the builder
dismisses it once the files are regenerated.

The batch's base and its tasks' starts move as before, to the base that was merged.

## Why

On 2026-10-29 five of six batches conflicted with main and each needed a hand merge, most of them two sides
adding a line, an import or a prop beside the other's, or both sides regenerating the same generated files. A
union of pure insertions is what a reviewer would do by hand, and anything wrong with it (a duplicate key, a
name defined twice) fails the gate that runs on the merged result, where a fix session can reach it, as it
would for any change.

Turned down:

- **A fix session resolves conflicts.** The lane's sandbox denies the git dir and the daemon's commits for a
  lane have one parent, so it can't record a merge (the reason decisions/2026-10-29-gate-with-base.md gave).
- **`merge-file --union` or `-X` strategy options.** They also "settle" two edits of the same line by keeping both
  or one, which is a choice. Requiring an empty ancestor section is what makes a resolution mechanical.
- **Merging generated files by line.** AGENTS.md forbids it: a migration's number, the journal and the snapshots
  must agree with the schema, so the directory is the base's and the generator makes the branch's part again.
- **Regenerating `pnpm-lock.yaml`.** `pnpm install --lockfile-only` needs the network and the registry, which the
  merge step does not hold; the lockfile stays the builder's. A follow-up can add it beside the generators.
- **Undoing the merge when regeneration fails.** The daemon writes no worktree file itself and the branch has
  moved by then; the merge is a valid state, the card says what is missing, and the dropped files are in the
  branch's history.

Left open:

- The migration-number collision between two tasks is covered by "Stop two tasks generating the same migration
  number from different bases"; this only keeps a collision in a generated directory from becoming a conflict
  card.
- Regeneration commits are made by the daemon, one parent, and a crash between the merge and that commit leaves
  the generated directories as the base's until the next gate's merge finds nothing to do. The `base-regenerate`
  card is not raised in that case.
