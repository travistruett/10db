import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  unlinkSync,
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
      // A hard link names a file the lane may not read under a path inside its copy.
      if (stat.nlink > 1)
        return { refused: `${spelled}: a file with more than one hard link is never uploaded` };
      total += stat.size;
      if (total > UPLOAD_MAX_BYTES)
        return {
          refused: `${spelled}: the files together are over ${String(UPLOAD_MAX_BYTES / (1024 * 1024))} MB (${String(total)} bytes so far)`,
        };
      const checked = accessRefusal(spelled, resolved, session);
      if ('refused' in checked) return checked;
      if (!openedFileIs(stat, checked.realPath))
        return { refused: `${spelled}: the file changed while it was checked` };
      const bytes = readExactly(fd, stat.size);
      if (bytes === null) return { refused: `${spelled}: the file changed size while it was read` };
      files.push({
        name: basename(resolved),
        mimeType: MIME_TYPES[extname(resolved).toLowerCase()] ?? 'application/octet-stream',
        buffer: bytes,
      });
    } finally {
      closeSync(fd);
    }
  }
  return { files };
}

/** Reads exactly `size` bytes; null when the file holds more or fewer, so its size changed. */
function readExactly(fd: number, size: number): Buffer | null {
  const buffer = Buffer.alloc(size);
  let read = 0;
  while (read < size) {
    const n = readSync(fd, buffer, read, size - read, read);
    if (n === 0) return null;
    read += n;
  }
  return readSync(fd, Buffer.alloc(1), 0, 1, size) === 0 ? buffer : null;
}

const SCREENS_DIR = '10db-screens';

/**
 * Writes `<tempDir>/10db-screens/<screenId>.png` without following a link; null with why when it can't.
 * The directory is a real one directly under the temp dir's real path, held by descriptor; the file is new
 * (`O_EXCL`). A swap of the directory between its check and the file's creation is detected and undone; the
 * file still lands wherever the path led for that instant, which the lane could read anyway.
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
    // The directory is held by descriptor: a swap of it after the check changes its dev or inode.
    const dirFd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const held = fstatSync(dirFd);
      const path = join(dir, `${screenId}.png`);
      const fd = openSync(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        const now = lstatSync(dir);
        const made = fstatSync(fd);
        if (now.dev !== held.dev || now.ino !== held.ino || made.dev !== held.dev) {
          closeSync(fd);
          unlinkSync(path);
          return { path: null, why: `${dir} changed while the copy was written` };
        }
        writeSync(fd, png);
      } finally {
        try {
          closeSync(fd);
        } catch {
          // Already closed above.
        }
      }
      return { path };
    } finally {
      closeSync(dirFd);
    }
  } catch (error) {
    return { path: null, why: error instanceof Error ? error.message : 'the copy was not written' };
  }
}
