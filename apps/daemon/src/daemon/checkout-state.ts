import { createHash } from 'node:crypto';
import type { Git } from '../git';
import { fileFingerprint } from '../runner';

/**
 * The checkout's HEAD and working tree as one value: HEAD's commit, then each path that differs from it or is
 * untracked and not ignored, with that file's lstat fingerprint. Any commit, edit, new or removed file moves it;
 * a file git ignores does not.
 */
export async function checkoutState(
  git: Pick<Git, 'head' | 'changedPaths'>,
  checkout: string,
): Promise<string> {
  const head = await git.head(checkout);
  const paths = await git.changedPaths(checkout);
  const hash = createHash('sha256').update(head);
  for (const path of paths) hash.update(`\0${path}\0${fileFingerprint(checkout, path) ?? 'gone'}`);
  return hash.digest('hex');
}
