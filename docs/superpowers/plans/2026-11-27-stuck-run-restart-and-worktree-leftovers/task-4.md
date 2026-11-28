# Task 4: files found nowhere else are saved under `~/.10db/kept/`

Read the index's Brief and Global Constraints first. Size: Core (data loss). Independent of tasks 1 to 3. Nothing
calls it yet.

**Files:**

- New `apps/daemon/src/delivery/kept-files.ts`: `KEPT_DIR_MODE`, `keptRoot`, `isRewritten`, `onlyHere`,
  `saveKept`, `KeptCopyError`.
- `apps/daemon/src/delivery/build-output.ts`: unchanged; `isRewritten` calls `isBuildOutput` and adds its own
  exact names (`next-env.d.ts`, `.DS_Store`). `looseWork` keeps its meaning for the hand-made check.
- New `apps/daemon/src/delivery/kept-files.test.ts`. `apps/daemon/src/delivery/AGENTS.md`: one line.

**Implements** (index, Interfaces), exactly: the `kept-files.ts` block.

**`onlyHere`.** For each worktree-relative file: dropped when `isRewritten`; dropped when the checkout has a
regular file at the same relative path with the same size and the same SHA-256; kept otherwise. A path that is a
symlink is compared by its target text. A file that can't be read counts as only here.

**`saveKept`.**

- The folder is `<root>/<name>/<at as YYYYMMDD-HHmmss>/`, made with `mkdir` recursive and mode `KEPT_DIR_MODE`,
  then `chmod` to it (the umask may have narrowed or an older folder widened it). `root` and `<root>/<name>` get
  the same mode. A second save for one name never writes into an earlier folder.
- Each file is copied to the same relative path: parents made 0700, the file copied without following a link
  (`lstat` first; a link is recreated with `symlink`), its mode set from the source's.
- `name` and every relative path are checked to stay inside the folder (`surelyInside` from `../git`); one that
  does not throws.
- After the copies, each regular file is read back: size and SHA-256 must equal the source's, read again then. Any
  difference, or any error, throws `KeptCopyError` naming the file. What was already copied stays; nothing in the
  worktree is touched by this module, ever.
- Answers the folder and the files saved.

**Test.** One file on a temp directory, real files:

- `onlyHere` drops an identical copy and a `.tsbuildinfo`, keeps a file that differs and one the checkout lacks.
- `saveKept` writes each file under a 0700 folder with its content and its mode (0600 and 0755 sources), saves a
  symlink as a link, and refuses a relative path that climbs out.
- A source that changes between the copy and the check (an injected `hash` dependency with a production default)
  throws `KeptCopyError`.

Show the mode case red with the `chmod` left out.

`Value: protects=a worktree's only copies being saved whole, private and checked before anything is removed;
fails_when=a saved file differs from its source, loses its mode, lands outside the kept folder or in a folder
others can read, or a file with an identical copy in the checkout is treated as lost; why_new=data loss;
no_claim=that any worktree is removed`.

**Spec:** "3.2 What 10db does instead of asking" item 3 in the inbox-cards spec; the "Kept worktree…" row of "3. The
decision-rights table" in the what-reaches-the-builder spec.
