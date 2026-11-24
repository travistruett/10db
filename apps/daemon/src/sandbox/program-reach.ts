import { realpathSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { isEqualOrUnder } from './protected-reads';

// Whether a lane's shell can run a call's program at all. A program outside what the lane may read (the
// builder's own browser CLI under their home, say) fails in the sandbox however it is approved, so a skip
// of it is not offered as Run these now.

/** A word with no quoting, expansion or shell syntax: the only kind read as a program name. */
const PLAIN_WORD = /^[A-Za-z0-9_.+@%:,/~-]+$/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=\S*$/;

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
 * lies outside what the lane's kernel profile reads (`reads`, its `filesystem.allowRead`, which holds the
 * system roots, the checkout, the toolchain and the lane's own reads): its real path is under none of them.
 * A program that isn't found is runnable, since the shell reports it itself, and so is a command whose
 * program can't be read as a plain word.
 */
export function programRunnable(
  command: string,
  path: string,
  reads: readonly string[],
  checkout: string,
): boolean {
  const word = programWord(command);
  if (word === null) return true;
  const candidates = word.includes('/')
    ? [isAbsolute(word) ? word : resolve(checkout, word)]
    : path
        .split(delimiter)
        .filter((dir) => dir !== '' && isAbsolute(dir))
        .map((dir) => join(dir, word));
  const found = candidates.find(isFile);
  if (found === undefined) return true;
  let real: string;
  try {
    real = realpathSync(found);
  } catch {
    return true;
  }
  return reads.some((root) => isEqualOrUnder(real, root));
}
