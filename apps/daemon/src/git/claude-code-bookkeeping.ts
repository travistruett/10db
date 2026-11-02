import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

interface BookkeepingEntry {
  /** Repo-relative path with `/`. */
  readonly path: string;
  /** A staging directory (judged by what is inside it) or a single file (ignored outright). */
  readonly kind: 'directory' | 'file';
  /** The Claude Code behaviour that writes it, so a reader can tell why it is on the list. */
  readonly writtenBy: string;
}

/**
 * The one list of what Claude Code writes under a checkout's `.claude/` for its own bookkeeping: unasked by the
 * agent's work, and never read back as config or instructions. `.claude/` itself stays sensitive (`strays.ts`):
 * settings, hooks, agents and skills there change what a session may do, so nothing joins this list unless
 * Claude Code is known to write it by itself and nothing loads it. The watcher logs every write it drops because
 * it is on this list ("ignored a Claude Code bookkeeping write", with the entry's `writtenBy`), so the daemon log
 * shows what the list hides. A file a new Claude Code release starts writing is not on it: it raises a "Write
 * outside every claim" card until it is added here with the behaviour that writes it.
 *
 * Each entry applies in any `.claude/` folder of the copy: Claude Code keeps its bookkeeping under the working
 * directory a command ran in, so `.claude/hooks/.claude/.cc-writes` is the same staging directory. The commit
 * tool leaves these out of every commit (`leftOutOfCommits`).
 *
 * - `directory`: a path inside it is judged like any other (dropped, with a log line, while git ignores it;
 *   checked against the claims when git reports it), since a file left there is still the agent's. The
 *   directory's own path is exempt only as a real directory.
 * - `file`: ignored outright, with a log line and no card, whether git ignores it, reports it or no longer sees
 *   it. A link (symbolic, or a hard link that gives another file's contents this name) or a directory at that
 *   path is not what Claude Code writes and stays flagged.
 *
 * The other state Claude Code keeps under `.claude/` is read back into a session (`scheduled_tasks.json` holds
 * prompts it runs, `agent-memory-local` and `mailbox` go into agents' context, `worktrees/` holds whole
 * checkouts with their own config) or is written only when a session asks for it, so none of it qualifies.
 */
export const CLAUDE_CODE_BOOKKEEPING: readonly BookkeepingEntry[] = [
  {
    path: '.claude/.cc-writes',
    kind: 'directory',
    writtenBy:
      'Its atomic-write staging directory. Every session start creates it (mode 0700, with `.claude/` if that ' +
      "is missing) and adds `.claude/.cc-writes/` to the user's global gitignore. A settings write lands there " +
      'as a temporary file and is then renamed onto its real path, so the rename arrives as its own event on ' +
      'that path and is still flagged. Nothing loads a file from inside the directory.',
  },
  {
    path: '.claude/scheduled_tasks.lock',
    kind: 'file',
    writtenBy:
      "The session's lock for scheduled tasks (loops, cron jobs and wakeups). It is created while a session " +
      'holds the right to run them and removed when the session ends. It names the session that holds it, and ' +
      'nothing loads it as config.',
  },
];

/**
 * How `rel` stands to an entry's path, wherever in the copy that `.claude/` folder is. Claude Code writes its
 * bookkeeping into the `.claude/` under its working directory, so a command run in `.claude/hooks` leaves
 * `.claude/hooks/.claude/.cc-writes`. The entry's path must be the whole tail of `rel` (`at`), or `rel` must
 * continue past it (`inside`); a path that stops short of it, on the way to it, is `way`. Segments are compared
 * whole, so `.cc-writesx` and `x/.cc-writes` are none of these.
 */
function standing(rel: string, entryPath: string): 'at' | 'inside' | 'way' | null {
  const segments = rel.split('/');
  const wanted = entryPath.split('/');
  const matches = (from: number, count: number): boolean =>
    wanted.slice(0, count).every((s, i) => segments[from + i] === s);
  for (let from = 0; from + wanted.length <= segments.length; from++) {
    if (!matches(from, wanted.length)) continue;
    return from + wanted.length === segments.length ? 'at' : 'inside';
  }
  for (let count = wanted.length - 1; count > 0; count--) {
    if (segments.length >= count && matches(segments.length - count, count)) return 'way';
  }
  return null;
}

/**
 * A path inside a bookkeeping directory, in any `.claude/` folder. The directory's own path is not: a link or
 * a file there is not what Claude Code makes, so only `bookkeepingAt`, which looks at it, exempts it.
 */
export function isInsideClaudeCodeBookkeeping(rel: string): boolean {
  return CLAUDE_CODE_BOOKKEEPING.some(
    (e) => e.kind === 'directory' && standing(rel, e.path) === 'inside',
  );
}

/**
 * The bookkeeping entries a commit must leave out: a path inside a bookkeeping directory, or an entry that
 * is a file (as `ignoredBookkeepingWrite` judges it), in any `.claude/` folder of the copy.
 */
export function leftOutOfCommits(root: string, rel: string): readonly BookkeepingEntry[] {
  if (isInsideClaudeCodeBookkeeping(rel)) {
    const dir = CLAUDE_CODE_BOOKKEEPING.find(
      (e) => e.kind === 'directory' && standing(rel, e.path) === 'inside',
    );
    return dir ? [dir] : [];
  }
  const file = ignoredBookkeepingWrite(root, rel);
  return file ? [file] : [];
}

function isRealDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The `file` entry that `rel` under `root` is, when it is what Claude Code writes: that exact path, as a regular
 * file with no other name or absent (a lock removed when its session ends). Not a symbolic link, not a hard link
 * (a second name for a file that may be config, such as `settings.local.json`), not a directory.
 */
export function ignoredBookkeepingWrite(root: string, rel: string): BookkeepingEntry | null {
  const entry = CLAUDE_CODE_BOOKKEEPING.find(
    (e) => e.kind === 'file' && standing(rel, e.path) === 'at',
  );
  if (!entry) return null;
  try {
    const st = lstatSync(join(root, rel));
    return st.isFile() && st.nlink === 1 ? entry : null;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? entry : null;
  }
}

/** The `directory` entry that `rel` under `root` is inside, or is itself as a real directory. */
function bookkeepingDirectoryAt(root: string, rel: string): BookkeepingEntry | null {
  for (const e of CLAUDE_CODE_BOOKKEEPING) {
    if (e.kind !== 'directory') continue;
    const where = standing(rel, e.path);
    if (where === 'inside' || (where === 'at' && isRealDirectory(join(root, rel)))) return e;
  }
  return null;
}

/**
 * The entries in `rel` under `root` when it is a real directory (not a link) on the way to a bookkeeping entry
 * and holds bookkeeping and nothing else: a `.claude/` a session start created to hold its staging directory.
 * Such a directory can't change what runs, and anything written into it later arrives as its own event. An
 * empty or unreadable one, or any other directory, gives none.
 */
function heldBookkeeping(root: string, rel: string): BookkeepingEntry[] {
  if (!CLAUDE_CODE_BOOKKEEPING.some((e) => standing(rel, e.path) === 'way')) return [];
  if (!isRealDirectory(join(root, rel))) return [];
  try {
    const held: BookkeepingEntry[] = [];
    for (const name of readdirSync(join(root, rel))) {
      const child = `${rel}/${name}`;
      const entry = bookkeepingDirectoryAt(root, child) ?? ignoredBookkeepingWrite(root, child);
      if (!entry) return [];
      held.push(entry);
    }
    return held;
  } catch {
    return [];
  }
}

/**
 * The entries that make `rel` under `root` bookkeeping, empty when it is not: a path inside a bookkeeping
 * directory or one itself (as a real directory), a `file` entry as `ignoredBookkeepingWrite` judges it, or a
 * directory that holds bookkeeping and nothing else.
 */
export function bookkeepingAt(root: string, rel: string): BookkeepingEntry[] {
  const own = bookkeepingEntryAt(root, rel);
  return own.length > 0 ? own : heldBookkeeping(root, rel);
}

/**
 * The entry `rel` under `root` is by itself, empty when it is not: a path inside a bookkeeping directory, one
 * itself as a real directory, or a `file` entry as `ignoredBookkeepingWrite` judges it. A directory that merely
 * holds bookkeeping is not (`bookkeepingAt` judges that). The commit tool leaves such a path out of what it
 * names to `git add`, since git refuses a named path an ignore rule covers.
 */
export function bookkeepingEntryAt(root: string, rel: string): BookkeepingEntry[] {
  const entry = bookkeepingDirectoryAt(root, rel) ?? ignoredBookkeepingWrite(root, rel);
  return entry ? [entry] : [];
}
