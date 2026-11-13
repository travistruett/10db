import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type Stats,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, sep } from 'node:path';

/** The largest file whose previous text an edit card shows. */
export const BEFORE_TEXT_MAX_BYTES = 1_048_576;

/** A file's text before an edit; `absent` is a file that doesn't exist yet, `unread` one 10db won't read. */
export type BeforeText =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unread' };

/** The `node:fs` calls the read makes, so a caller can stand between them. */
export interface CheckoutFs {
  lstatSync(path: string): Stats;
  openSync(path: string, flags: number): number;
  fstatSync(fd: number): Stats;
  readSync(
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number | null,
  ): number;
  closeSync(fd: number): void;
  realpathSync(path: string): string;
}

const nodeFs: CheckoutFs = {
  lstatSync: (path) => lstatSync(path),
  openSync: (path, flags) => openSync(path, flags),
  fstatSync: (fd) => fstatSync(fd),
  readSync: (fd, buffer, offset, length, position) =>
    readSync(fd, buffer, offset, length, position),
  closeSync: (fd) => {
    closeSync(fd);
  },
  // The native call gives the name the volume stores, so a path differing only in case can't pass the
  // comparison by its spelling.
  realpathSync: (path) => realpathSync.native(path),
};

const UNREAD: BeforeText = { kind: 'unread' };
const ABSENT: BeforeText = { kind: 'absent' };

const codeOf = (error: unknown): string | null =>
  error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : null;

const within = (root: string, path: string): boolean =>
  path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);

/** Reads the whole of a descriptor's file, up to `size` bytes. */
function readAll(fs: CheckoutFs, fd: number, size: number): string {
  const buffer = Buffer.alloc(size);
  let filled = 0;
  while (filled < size) {
    const read = fs.readSync(fd, buffer, filled, size - filled, filled);
    if (read === 0) break;
    filled += read;
  }
  return buffer.subarray(0, filled).toString('utf8');
}

/**
 * A file's text as it is before an agent writes it (sessions spec §11). It is read only when it is a
 * regular file inside the checkout with one link, through a descriptor opened without following a
 * link, and only when its folder still resolves to where it did before the read. Never throws.
 */
export function readCheckoutText(
  checkout: string,
  path: string,
  fs: CheckoutFs = nodeFs,
): BeforeText {
  try {
    const realCheckout = fs.realpathSync(checkout);
    const checkoutDev = fs.lstatSync(realCheckout).dev;
    const absolute = isAbsolute(path) ? path : join(checkout, path);
    const parent = dirname(absolute);
    let realParent: string;
    try {
      realParent = fs.realpathSync(parent);
    } catch (error) {
      return codeOf(error) === 'ENOENT' ? ABSENT : UNREAD;
    }
    if (!within(realCheckout, realParent)) return UNREAD;
    // The file is named from its real folder, never by the path as given.
    const target = join(realParent, basename(absolute));
    let seen: Stats;
    try {
      seen = fs.lstatSync(target);
    } catch (error) {
      return codeOf(error) === 'ENOENT' ? ABSENT : UNREAD;
    }
    if (!seen.isFile()) return UNREAD;
    let fd: number;
    try {
      fd = fs.openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      return UNREAD;
    }
    let text: string;
    try {
      const opened = fs.fstatSync(fd);
      if (
        !opened.isFile() ||
        opened.size > BEFORE_TEXT_MAX_BYTES ||
        opened.dev !== seen.dev ||
        opened.ino !== seen.ino ||
        opened.dev !== checkoutDev ||
        // A hard link inside the checkout to a file outside it shares the inode the lstat saw.
        opened.nlink !== 1
      )
        return UNREAD;
      text = readAll(fs, fd, opened.size);
    } finally {
      fs.closeSync(fd);
    }
    // A folder swapped to a link and back between the checks would otherwise go unseen.
    if (fs.realpathSync(parent) !== realParent) return UNREAD;
    return { kind: 'text', text };
  } catch {
    return UNREAD;
  }
}
