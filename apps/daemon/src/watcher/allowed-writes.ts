import { createHash } from 'node:crypto';
import { constants, lstatSync, realpathSync, statSync } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import {
  InboxKind,
  InboxState,
  PermissionChoice,
  type InboxItemDto,
  type InboxItemId,
  type PermissionRuleDto,
  type WorkstreamId,
} from '@10db/contracts';
import { allowedWriteFor, storableRule } from '../permissions';

/** The tools whose permission cards name the file they write (the broker's edit family). */
const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** The states of a permission card its builder has answered. */
export const ANSWERED_STATES = [
  InboxState.Answered,
  InboxState.Delivering,
  InboxState.Resolved,
] as const;

/** How many of a project's latest answered cards are read for an allowance. */
export const ANSWERED_CARDS_READ = 500;

/** A write the builder allowed, as an answered Allow Edit card or a stored rule says. */
export interface EditAllowance {
  /** The card behind it; null for a stored rule. */
  readonly cardId: InboxItemId | null;
  readonly workstreamId: WorkstreamId | null;
  /** What names this allowance's single use; null for a stored rule. */
  readonly useKey: string | null;
  /** The file, as the card or rule names it: absolute, or relative to the lane's checkout. */
  readonly path: string;
  /** Whether it covers every write to the path (a stored rule, or a choice that stored one), not one. */
  readonly standing: boolean;
  /**
   * The SHA-256 of the file this lane's allowed call makes, the only write a single-use card then excuses;
   * null when the card asks for that exact write but none was recorded (it excuses no settled write), absent
   * for a card from before (it excuses the next write to its path).
   */
  readonly expected?: string | null;
}

/**
 * The edits the answered permission cards allowed. `allow_once` allows one write; `allow_workstream` and
 * `allow_project` store a rule that allows every later one, so those stand, unless no rule was storable
 * for the card (then they allow one write, as the card says). A card the builder denied, or
 * one that names no file, allows nothing.
 */
export function cardAllowances(items: readonly InboxItemDto[]): EditAllowance[] {
  const allowed: EditAllowance[] = [];
  for (const item of items) {
    if (item.kind !== InboxKind.Permission || !ANSWERED_STATES.some((s) => s === item.state)) {
      continue;
    }
    const choice = item.answer?.choice;
    const once = choice === PermissionChoice.AllowOnce;
    if (
      !once &&
      choice !== PermissionChoice.AllowWorkstream &&
      choice !== PermissionChoice.AllowProject
    ) {
      continue;
    }
    const tool = item.detail?.['toolName'];
    const path = item.detail?.['path'];
    if (typeof tool !== 'string' || !EDIT_TOOLS.has(tool) || typeof path !== 'string') continue;
    // A choice stands only when answering the card stored a rule (`applyPermissionChoice`); one that
    // stored none, such as a sandboxed path with a glob character, behaves as allow-once.
    const summary = item.detail?.['summary'];
    const stored = typeof summary === 'string' && storableRule(tool, summary) !== undefined;
    // The inbox folds identical cards from several lanes into one, with a target for each lane; the
    // builder's answer allows each of those lanes' write, the one its own call makes.
    for (const target of item.targets) {
      const expected = allowedWriteFor(item.detail, target.workstreamId);
      allowed.push({
        cardId: item.id,
        workstreamId: target.workstreamId,
        useKey: useKey(item.id, target.workstreamId),
        path,
        standing: !once && stored,
        ...(expected === undefined ? {} : { expected }),
      });
    }
  }
  return allowed;
}

/** What names one lane's use of an allow-once card: a folded card allows one write for each lane it targets. */
export function useKey(cardId: InboxItemId, workstreamId: WorkstreamId | null): string {
  return `${cardId}\0${workstreamId ?? ''}`;
}

/** The use keys of every lane the cards target, whether or not they allow an edit. */
export function cardUseKeys(items: readonly InboxItemDto[]): string[] {
  return items.flatMap((i) => i.targets.map((t) => useKey(i.id, t.workstreamId)));
}

/** The stored rules that allow one file's edits: an edit tool's rule scoped to an absolute path. */
export function ruleAllowances(rules: readonly PermissionRuleDto[]): EditAllowance[] {
  return rules
    .filter((r) => EDIT_TOOLS.has(r.toolName) && r.pattern !== null && isAbsolute(r.pattern))
    .map((r) => ({
      cardId: null,
      workstreamId: r.workstreamId,
      useKey: null,
      path: r.pattern ?? '',
      standing: true,
    }));
}

function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** `path` relative to the checkout `root` with `/`, whether it names the root by its link or its real path; else null. */
export function relativeIn(root: string, path: string): string | null {
  const target = resolve(root, path);
  for (const base of new Set([root, realOrSelf(root)])) {
    const rel = relative(base, target);
    if (rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) {
      return rel.split(sep).join('/');
    }
  }
  return null;
}

/** What every deletion's stamp starts with. */
const GONE_PREFIX = 'gone:';

/** Whether `stamp` (`writeStamp`) is a deletion's. */
export function isDeletionStamp(stamp: string): boolean {
  return stamp.startsWith(GONE_PREFIX);
}

/**
 * The stamp of a deletion: the nearest ancestor of the missing path, up to `root`, that is there, with its
 * change and modification times to the nanosecond. Adding or removing an entry in a directory changes both,
 * so a file restored and deleted again, even unseen, gives another stamp; the change time can't be set back
 * by hand. Null when not even `root` is there.
 */
function deletionStamp(root: string, path: string): string | null {
  for (let dir = dirname(path); ; dir = dirname(dir)) {
    const rel = relative(root, dir);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
    try {
      const { ctimeNs, mtimeNs } = statSync(dir, { bigint: true });
      return `${GONE_PREFIX}${rel.split(sep).join('/')}:${String(ctimeNs)}:${String(mtimeNs)}`;
    } catch {
      if (rel === '') return null;
    }
  }
}

/**
 * Whether a directory between `root` and `path` (`root` itself excluded: the checkout may be reached by a
 * link) is a symlink. O_NOFOLLOW only checks the last component, so without this a lane that makes `sub` a
 * link to another directory gets 'sub/file' stamped by the content it reaches through the link. An ancestor
 * that is missing, or not a directory, is not a link: the open then fails as before.
 */
function throughSymlink(root: string, path: string): boolean {
  const rel = relative(root, path);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false;
  const parts = rel.split(sep).slice(0, -1);
  let dir = root;
  for (const part of parts) {
    dir = resolve(dir, part);
    try {
      if (lstatSync(dir).isSymbolicLink()) return true;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Whether `path` still leads to the file an open descriptor (`fd`, its `fstat`) is on, checked after the open
 * and the read. `throughSymlink` runs before the open, and the open runs on the thread pool, so a lane that
 * flips a directory above the file between a real directory and a link can have the open follow the link.
 * Looking at the ancestors again and comparing the descriptor's device and inode with an `lstat` of the path
 * closes that window: a descriptor that was reached through a link is on another inode than the path now
 * names, and a link still in place is seen. 'link': a directory above the file is a link. 'moved': the path
 * is gone or names another file (a rename over it is a real write, so the read is tried again).
 */
function descriptorIsAtPath(
  root: string,
  path: string,
  fd: { dev: bigint; ino: bigint },
): 'yes' | 'link' | 'moved' {
  if (throughSymlink(root, path)) return 'link';
  try {
    const at = lstatSync(path, { bigint: true });
    return at.isFile() && at.dev === fd.dev && at.ino === fd.ino ? 'yes' : 'moved';
  } catch {
    return 'moved';
  }
}

/** How many times a file that changes while it is read is read again before it counts as unstampable. */
export const STAMP_ATTEMPTS = 3;

/** The size of one read, and so of one turn of the event loop while a file is hashed. */
const STAMP_CHUNK_BYTES = 1024 * 1024;

/**
 * How long one stamp may spend reading a file, all its attempts together. A file the hash can't finish in this
 * time (a sparse file of petabytes, which costs no disk but reads as zeros at the disk's speed) is given up on
 * as 'too-large', so no file holds a step end or a checkout's batch for longer than this. At about 2 GB/s it
 * still hashes tens of gigabytes, far more than any file a builder allows an edit to.
 */
export const STAMP_BUDGET_MS = 30_000;

/**
 * One read of a regular file through a single descriptor: the file type and the metadata before and after
 * come from that descriptor (`fstat`), never from path lookups that another process could answer differently.
 * A link in a directory above the file is refused by `stampOrReason` (`throughSymlink`) before this opens it,
 * and a swap in the window between that check and the open is caught after the read (`descriptorIsAtPath`).
 * The open is non-blocking, so a FIFO can't block the daemon on the open, and it doesn't follow a link at the
 * path (O_NOFOLLOW), so a symlink, to a file, a FIFO or nothing, fails with ELOOP: not a file. The read is
 * asynchronous, a chunk at a time, so the event loop turns between chunks, and it stops at the size the first
 * `fstat` gave: a file that keeps growing is 'changing', not endless. The result is 'not-a-file' for anything
 * but a regular file, 'changing' when the file changed while it was read, 'too-large' when `deadline` (a
 * `performance.now()` time) passed before the hash was done, and the stamp otherwise. Other errors, ENOENT
 * included, are thrown.
 */
async function readStamp(
  root: string,
  path: string,
  deadline: number,
): Promise<{ stamp: string } | { skip: 'not-a-file' | 'changing' | 'too-large' }> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') return { skip: 'not-a-file' };
    throw error;
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) return { skip: 'not-a-file' };
    const hash = createHash('sha256');
    const chunk = Buffer.allocUnsafe(STAMP_CHUNK_BYTES);
    // Never past the size it started at: bytes appended meanwhile show in the size check below.
    let remaining = before.size;
    while (remaining > 0n) {
      if (performance.now() > deadline) return { skip: 'too-large' };
      const want = remaining < BigInt(chunk.length) ? Number(remaining) : chunk.length;
      const { bytesRead } = await handle.read(chunk, 0, want, null);
      if (bytesRead === 0) break;
      hash.update(chunk.subarray(0, bytesRead));
      remaining -= BigInt(bytesRead);
    }
    // The file changed while it was read: the content may not be the one the time and size name.
    const after = await handle.stat({ bigint: true });
    if (after.mtimeNs !== before.mtimeNs || after.size !== before.size) return { skip: 'changing' };
    // The path must still lead to this descriptor, through no link: see `descriptorIsAtPath`.
    const at = descriptorIsAtPath(root, path, after);
    if (at !== 'yes') return { skip: at === 'link' ? 'not-a-file' : 'changing' };
    return { stamp: `${String(before.mtimeNs)}:${String(before.size)}:${hash.digest('hex')}` };
  } finally {
    await handle.close();
  }
}

/**
 * What identifies the current write to a file: its modification time to the nanosecond, its size and a
 * hash of its content, so a file changed behind a restored modification time and size is another write.
 * A deletion's stamp for a file that is not there (`deletionStamp`). Null for one that can't be told apart
 * from another write: a directory or other non-file, one that can't be read, one that kept changing
 * while it was read, or one too large to read within `budgetMs`.
 * It reads the whole file, so it is called only for a path a card or an excused write names.
 */
export async function writeStamp(
  root: string,
  rel: string,
  budgetMs: number = STAMP_BUDGET_MS,
): Promise<string | null> {
  const result = await stampOrReason(root, rel, budgetMs);
  return 'stamp' in result ? result.stamp : null;
}

/**
 * Whether the file `stamp` (`writeStamp`) was taken from has the content hash `expected`, the file an allowed
 * call makes. A deletion never does: no edit call deletes its file.
 */
export function stampMatchesExpected(stamp: string, expected: string): boolean {
  return !isDeletionStamp(stamp) && stamp.split(':')[2] === expected;
}

/**
 * Why a path has no stamp: it is not a regular file, it can't be read, it kept changing while read, or it was
 * too large to read within the time budget. Like an unreadable path, a too-large one fails closed.
 */
export type UnstampedReason = 'not-a-file' | 'unreadable' | 'changing' | 'too-large';

/**
 * The stamp of `rel` (`writeStamp`), or why it has none, from one read: at most STAMP_ATTEMPTS reads of the
 * file, all within `budgetMs`, so the reason is the one that read found and never another read's.
 */
export async function stampOrReason(
  root: string,
  rel: string,
  budgetMs: number = STAMP_BUDGET_MS,
): Promise<{ stamp: string } | { reason: UnstampedReason }> {
  const path = resolve(root, rel);
  const deadline = performance.now() + budgetMs;
  for (let attempt = 0; attempt < STAMP_ATTEMPTS; attempt++) {
    if (throughSymlink(root, path)) return { reason: 'not-a-file' };
    try {
      const read = await readStamp(root, path, deadline);
      if ('stamp' in read) return read;
      if (read.skip !== 'changing') return { reason: read.skip };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return { reason: 'unreadable' };
      const stamp = deletionStamp(root, path);
      return stamp === null ? { reason: 'unreadable' } : { stamp };
    }
  }
  return { reason: 'changing' };
}
