import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  writeSync,
} from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { TaskScreenId } from '@10db/contracts';
import { readAccess } from '../sandbox';
import type { LaneBrowserSession, UploadFile } from '../lane-browser';

type UploadSession = Pick<LaneBrowserSession, 'copy' | 'tempDir' | 'fileAccess'>;

/** All files of one `browser_upload` call together. */
export const UPLOAD_MAX_BYTES = 50 * 1024 * 1024;

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.html': 'text/html',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.zip': 'application/zip',
  '.xml': 'application/xml',
};

const isAtOrUnder = (path: string, root: string): boolean => {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

/**
 * Whether the open file is the one `realPath` names now: the same device and inode. A mismatch means a part
 * of the path was swapped between the open and the check.
 */
export function openedFileIs(
  opened: { readonly dev: number | bigint; readonly ino: number | bigint },
  realPath: string,
): boolean {
  try {
    const named = statSync(realPath, { bigint: true });
    return BigInt(opened.dev) === named.dev && BigInt(opened.ino) === named.ino;
  } catch {
    return false;
  }
}

/** Why a path may not be uploaded, or null when it may; `realPath` is a fresh `readAccess`'s answer. */
function accessRefusal(
  spelled: string,
  resolved: string,
  session: UploadSession,
): { readonly realPath: string } | { readonly refused: string } {
  const { access, realPath } = readAccess(resolved, session.fileAccess, false, session.copy);
  if (access === 'protected' || access === 'contains-protected')
    return { refused: `${spelled}: a secret or a file of 10db's own is never uploaded` };
  if (access === 'outside-copy')
    return { refused: `${spelled}: in the worktrees folder but outside this lane's copy` };
  if (access === 'ask') return { refused: `${spelled}: outside the lane's copy and temp dir` };
  const roots = [session.copy, session.tempDir, ...(session.fileAccess.setupReads ?? [])];
  if (!roots.some((root) => isAtOrUnder(realPath, root)))
    return { refused: `${spelled}: only files in the lane's copy or temp dir are uploaded` };
  return { realPath };
}

/**
 * Opens each path itself (`O_NOFOLLOW`), checks the open file is the one a fresh `realpath` and `readAccess`
 * name (same dev and inode, a regular file) and reads it; refuses the whole call otherwise, naming the path.
 * A relative path is read from the lane's copy.
 */
export function readUploads(
  paths: readonly string[],
  session: UploadSession,
): { readonly files: readonly UploadFile[] } | { readonly refused: string } {
  const files: UploadFile[] = [];
  let total = 0;
  for (const spelled of paths) {
    const resolved = resolve(session.copy, spelled);
    let fd: number;
    try {
      fd = openSync(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return {
        refused: `${spelled}: ${code === 'ELOOP' ? 'a link is never uploaded' : code === 'ENOENT' ? 'no such file' : 'cannot be opened'}`,
      };
    }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile()) return { refused: `${spelled}: not a regular file` };
      total += stat.size;
      if (total > UPLOAD_MAX_BYTES)
        return {
          refused: `${spelled}: the files together are over ${String(UPLOAD_MAX_BYTES / (1024 * 1024))} MB (${String(total)} bytes so far)`,
        };
      const checked = accessRefusal(spelled, resolved, session);
      if ('refused' in checked) return checked;
      if (!openedFileIs(stat, checked.realPath))
        return { refused: `${spelled}: the file changed while it was checked` };
      files.push({
        name: basename(resolved),
        mimeType: MIME_TYPES[extname(resolved).toLowerCase()] ?? 'application/octet-stream',
        buffer: readFileSync(fd),
      });
    } finally {
      closeSync(fd);
    }
  }
  return { files };
}

const SCREENS_DIR = '10db-screens';

/**
 * Writes `<tempDir>/10db-screens/<screenId>.png` without following a link; null with why when it can't.
 * The directory must be a real one directly under the temp dir's real path; the file is new (`O_EXCL`).
 */
export function writeScreenCopy(
  tempDir: string,
  screenId: TaskScreenId,
  png: Uint8Array,
): { readonly path: string } | { readonly path: null; readonly why: string } {
  try {
    const realTemp = realpathSync(tempDir);
    const dir = join(tempDir, SCREENS_DIR);
    try {
      mkdirSync(dir, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (!lstatSync(dir).isDirectory())
      return { path: null, why: `${dir} is not a plain directory` };
    if (realpathSync(dir) !== join(realTemp, SCREENS_DIR))
      return { path: null, why: `${dir} does not lie directly in the temp dir` };
    const path = join(dir, `${screenId}.png`);
    const fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeSync(fd, png);
    } finally {
      closeSync(fd);
    }
    return { path };
  } catch (error) {
    return { path: null, why: error instanceof Error ? error.message : 'the copy was not written' };
  }
}
