import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Directories Claude Code writes under a checkout's `.claude/` by itself, and never reads anything in as
 * config or instructions.
 *
 * `.claude/.cc-writes` is its atomic-write staging directory. Every session start creates it (mode 0700, with
 * `.claude/` if that is missing) and adds `.claude/.cc-writes/` to the user's global gitignore. A settings
 * write lands there as a temporary file and is then renamed onto its real path, so the rename arrives as its
 * own event on that path (`.claude/settings.local.json`, say) and is still flagged. Nothing loads a file from
 * inside the directory, so nothing in it can change what a session does.
 *
 * Only this one path qualifies. The other state Claude Code keeps under `.claude/` is read back into a session
 * (`scheduled_tasks.json` holds prompts it runs, `agent-memory-local` and `mailbox` go into agents' context,
 * `worktrees/` holds whole checkouts with their own config) or is written only when a session asks for it.
 */
const CLAUDE_CODE_BOOKKEEPING = ['.claude/.cc-writes'] as const;

/**
 * A path inside a bookkeeping directory. The directory's own path is not: a link or a file there is not
 * what Claude Code makes, so only `isBookkeepingAt`, which looks at it, exempts it.
 */
export function isInsideClaudeCodeBookkeeping(rel: string): boolean {
  return CLAUDE_CODE_BOOKKEEPING.some((dir) => rel.startsWith(`${dir}/`));
}

function isRealDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Whether `rel` under `root` is bookkeeping: inside a bookkeeping directory, or one itself, as a real directory. */
export function isBookkeepingAt(root: string, rel: string): boolean {
  if (isInsideClaudeCodeBookkeeping(rel)) return true;
  return CLAUDE_CODE_BOOKKEEPING.some((dir) => dir === rel) && isRealDirectory(join(root, rel));
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
    return entries.length > 0 && entries.every((name) => isBookkeepingAt(root, `${rel}/${name}`));
  } catch {
    return false;
  }
}
