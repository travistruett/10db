import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProjectDto } from '@10db/contracts';
import type { Git } from '../git';
import { within } from './make-rules';

/** The most of a file `readCommitted` reads, from the base and from the checkout. */
export const MAX_COMMITTED_BYTES = 256 * 1024;

/**
 * A repository file as `readCommitted` finds it: the base's text, which the checkout holds byte for byte;
 * in neither; or anything else (changed, created, deleted, a link, too large, unreadable).
 */
export type CommittedFile =
  | { readonly kind: 'same'; readonly text: string }
  | { readonly kind: 'absent' }
  | { readonly kind: 'differs' };

/** Reads a path relative to the repository root as `readCommitted` does. */
export type CommittedReader = (path: string) => Promise<CommittedFile>;

type Found =
  | { readonly kind: 'file'; readonly bytes: Buffer }
  | { readonly kind: 'absent' }
  | { readonly kind: 'other' };

/** The Mac's file system matches names without case, so `gnumakefile` is opened for `GNUmakefile`. */
const folded = (name: string): string => name.normalize('NFC').toLowerCase();

/**
 * The checkout's file at `path`, each part of it found under its exact name and none a link. A part found
 * only under another case is `other`, since the file system would open it for this name.
 */
async function inCheckout(checkout: string, path: string, maxBytes: number): Promise<Found> {
  const parts = path.split('/');
  let at = checkout;
  for (const [i, part] of parts.entries()) {
    let names: string[];
    try {
      names = await readdir(at);
    } catch (error) {
      return error instanceof Error && 'code' in error && error.code === 'ENOENT'
        ? { kind: 'absent' }
        : { kind: 'other' };
    }
    if (!names.includes(part))
      return names.some((name) => folded(name) === folded(part))
        ? { kind: 'other' }
        : { kind: 'absent' };
    at = join(at, part);
    const stat = await lstat(at);
    const last = i === parts.length - 1;
    if (last ? !stat.isFile() || stat.size > maxBytes : !stat.isDirectory())
      return { kind: 'other' };
  }
  return { kind: 'file', bytes: await readFile(at) };
}

/** The base's file at `path`: its bytes, absent, or `other` for a link, a folder or a file over the cap. */
async function inBase(
  git: Pick<Git, 'remoteTrackingCommit' | 'fileAt' | 'bytesAt'>,
  project: Pick<ProjectDto, 'repoPath' | 'baseBranch'>,
  path: string,
  maxBytes: number,
): Promise<Found> {
  const commit = await git.remoteTrackingCommit(project.repoPath, project.baseBranch);
  if (commit === null) return { kind: 'absent' };
  const bytes = await git.bytesAt(project.repoPath, commit, path, maxBytes);
  if (bytes !== null) return { kind: 'file', bytes };
  const file = await git.fileAt(project.repoPath, commit, path, maxBytes);
  return file.kind === 'missing' ? { kind: 'absent' } : { kind: 'other' };
}

/**
 * A reader of repository files as committed at `refs/remotes/origin/<base>`, for text a judge may trust: a lane
 * writes its checkout, so a file's text is given only while the checkout holds the base's exact bytes there.
 * A path in neither is `absent`; anything else, including a path that leaves the repository, is `differs`.
 * Never throws.
 */
export function readCommitted(
  git: Pick<Git, 'remoteTrackingCommit' | 'fileAt' | 'bytesAt'>,
  project: Pick<ProjectDto, 'repoPath' | 'baseBranch'>,
  checkout: string,
  maxBytes: number = MAX_COMMITTED_BYTES,
): CommittedReader {
  return async (path) => {
    const inside = within('', path);
    if (inside === null || inside === '') return { kind: 'differs' };
    try {
      const [base, here] = await Promise.all([
        inBase(git, project, inside, maxBytes),
        inCheckout(checkout, inside, maxBytes),
      ]);
      if (base.kind === 'absent' && here.kind === 'absent') return { kind: 'absent' };
      if (base.kind === 'file' && here.kind === 'file' && base.bytes.equals(here.bytes))
        return { kind: 'same', text: base.bytes.toString('utf8') };
      return { kind: 'differs' };
    } catch {
      return { kind: 'differs' };
    }
  };
}
