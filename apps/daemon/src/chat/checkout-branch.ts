import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const HEADS = 'refs/heads/';

/**
 * The branch the checkout's HEAD names, read from `.git/HEAD` so a card can say it without waiting on git; null
 * when HEAD is detached or unreadable, or the checkout's `.git` is a file (a worktree).
 */
export function checkoutBranchNow(repoPath: string): string | null {
  try {
    const head = readFileSync(join(repoPath, '.git', 'HEAD'), 'utf8').trim();
    return head.startsWith(`ref: ${HEADS}`) ? head.slice(`ref: ${HEADS}`.length) : null;
  } catch {
    return null;
  }
}
