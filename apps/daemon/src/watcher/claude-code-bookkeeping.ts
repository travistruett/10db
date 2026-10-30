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
 * Claude Code is known to write it by itself and nothing loads it. Each Claude Code release can add one. The
 * watcher logs every write to a `file` entry that it ignores ("ignored a Claude Code bookkeeping write"), so a
 * new one is easy to spot in the daemon log and to add here with the behaviour that writes it.
 *
 * - `directory`: a path inside it is judged like any other (dropped while git ignores it, checked against the
 *   claims when git reports it), since a file left there is still the agent's. The directory's own path is
 *   exempt only as a real directory.
 * - `file`: ignored outright, with a log line and no card, whether git ignores it, reports it or no longer sees
 *   it. A link or a directory at that path is not what Claude Code writes and stays flagged.
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

const BOOKKEEPING_DIRECTORIES = CLAUDE_CODE_BOOKKEEPING.filter((e) => e.kind === 'directory').map(
  (e) => e.path,
);

/**
 * A path inside a bookkeeping directory. The directory's own path is not: a link or a file there is not
 * what Claude Code makes, so only `isBookkeepingAt`, which looks at it, exempts it.
 */
export function isInsideClaudeCodeBookkeeping(rel: string): boolean {
  return BOOKKEEPING_DIRECTORIES.some((dir) => rel.startsWith(`${dir}/`));
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
 * file or absent (a lock removed when its session ends), not a link or a directory.
 */
export function ignoredBookkeepingWrite(root: string, rel: string): BookkeepingEntry | null {
  const entry = CLAUDE_CODE_BOOKKEEPING.find((e) => e.kind === 'file' && e.path === rel);
  if (!entry) return null;
  try {
    return lstatSync(join(root, rel)).isFile() ? entry : null;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? entry : null;
  }
}

/** Whether `rel` under `root` is bookkeeping: inside a bookkeeping directory, or one itself, as a real directory. */
export function isBookkeepingAt(root: string, rel: string): boolean {
  if (isInsideClaudeCodeBookkeeping(rel)) return true;
  return BOOKKEEPING_DIRECTORIES.some((dir) => dir === rel) && isRealDirectory(join(root, rel));
}

/**
 * Whether `rel` under `root` is a real directory (not a link) that holds bookkeeping and nothing else: a
 * `.claude/` a session start created to hold its staging directory. Such a directory can't change what runs,
 * and anything written into it later arrives as its own event. An empty or unreadable one counts as not.
 */
export function holdsOnlyBookkeeping(root: string, rel: string): boolean {
  if (!isRealDirectory(join(root, rel))) return false;
  try {
    const entries = readdirSync(join(root, rel));
    return (
      entries.length > 0 &&
      entries.every(
        (name) =>
          isBookkeepingAt(root, `${rel}/${name}`) ||
          ignoredBookkeepingWrite(root, `${rel}/${name}`) !== null,
      )
    );
  } catch {
    return false;
  }
}
