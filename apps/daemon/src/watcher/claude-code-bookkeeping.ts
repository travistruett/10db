import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * What Claude Code writes under a checkout's `.claude/` by itself, which it never reads as config or
 * instructions.
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

export function isClaudeCodeBookkeeping(rel: string): boolean {
  return CLAUDE_CODE_BOOKKEEPING.some((dir) => rel === dir || rel.startsWith(`${dir}/`));
}

/**
 * Whether `rel` under `root` is a real directory (not a link) whose entries are all bookkeeping, or that is
 * empty: a `.claude/` a session start created to hold its staging directory. Such a directory can't change
 * what runs, and anything written into it later arrives as its own event. Anything unreadable counts as not.
 */
export function holdsOnlyBookkeeping(root: string, rel: string): boolean {
  try {
    const path = join(root, rel);
    if (!lstatSync(path).isDirectory()) return false;
    return readdirSync(path).every((name) => isClaudeCodeBookkeeping(`${rel}/${name}`));
  } catch {
    return false;
  }
}
