import { statSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve, sep } from 'node:path';
import { readAccess, type FileAccessContext } from './file-access';

// Whether a lane's shell can run a call's program at all. A program outside what the lane may read (the
// builder's own browser CLI under their home, say) fails in the sandbox however it is approved, so a skip
// of it is not offered as Run these now.

/** A word with no quoting, expansion or shell syntax: the only kind read as a program name. */
const PLAIN_WORD = /^[A-Za-z0-9_.+@%:,/~-]+$/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=\S*$/;
/** Where a program's real path is the system's own, which the lane's profile always reads. */
const SYSTEM_ROOTS = ['/usr', '/bin', '/sbin', '/opt', '/System', '/Library', '/nix'];

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** The first word of a command after leading `NAME=value` assignments; null when it isn't a plain word. */
function programWord(command: string): string | null {
  const words = command.trim().split(/\s+/);
  let i = 0;
  while (i < words.length && ASSIGNMENT.test(words[i] ?? '')) i += 1;
  const word = words[i];
  return word !== undefined && PLAIN_WORD.test(word) && !word.startsWith('~') ? word : null;
}

/**
 * False only when the command's program, found as written (relative to the checkout) or on the lane's PATH,
 * lies outside what the lane may read: its real path's `readAccess` is neither `inside` nor `allowed`. A
 * system path (`/usr/bin/git`) the lane's profile always opens is runnable, and so is a program that isn't
 * found, which the shell reports itself, and a command whose program can't be read as a plain word.
 */
export function programRunnable(command: string, path: string, ctx: FileAccessContext): boolean {
  const word = programWord(command);
  if (word === null) return true;
  const candidates = word.includes('/')
    ? [isAbsolute(word) ? word : resolve(ctx.checkout, word)]
    : path
        .split(delimiter)
        .filter((dir) => dir !== '' && isAbsolute(dir))
        .map((dir) => join(dir, word));
  const found = candidates.find(isFile);
  if (found === undefined) return true;
  const { access, realPath } = readAccess(found, ctx);
  if (access === 'inside' || access === 'allowed') return true;
  return SYSTEM_ROOTS.some((root) => realPath === root || realPath.startsWith(root + sep));
}
