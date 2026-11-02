import { createHash } from 'node:crypto';
import { closeSync, lstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
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
import { storableRule } from '../permissions';

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
    // builder's answer allows each of those lanes' write.
    for (const target of item.targets) {
      allowed.push({
        cardId: item.id,
        workstreamId: target.workstreamId,
        useKey: useKey(item.id, target.workstreamId),
        path,
        standing: !once && stored,
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

/** How many times a file that changes while it is read is read again before it counts as unstampable. */
const STAMP_ATTEMPTS = 3;

/** The SHA-256 of a file's content, read a chunk at a time so a large file is never held whole. */
function hashFile(path: string): string {
  const hash = createHash('sha256');
  const fd = openSync(path, 'r');
  try {
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    for (let n = readSync(fd, chunk); n > 0; n = readSync(fd, chunk)) {
      hash.update(chunk.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

/**
 * What identifies the current write to a file: its modification time to the nanosecond, its size and a
 * hash of its content, so a file changed behind a restored modification time and size is another write.
 * A deletion's stamp for a file that is not there (`deletionStamp`). Null for one that can't be told apart
 * from another write: a directory or other non-file, one that can't be read, or one that kept changing
 * while it was read.
 * It reads the whole file, so it is called only for a path a card or an excused write names.
 */
export function writeStamp(root: string, rel: string): string | null {
  const result = readStamp(root, rel);
  return 'stamp' in result ? result.stamp : null;
}

/** Why a path has no stamp: it is not a regular file, it can't be read, or it kept changing while read. */
export type UnstampedReason = 'not-a-file' | 'unreadable' | 'changing';

/**
 * Why `writeStamp` gives null for `rel`, read again now. A path that stamps this time counts as 'changing':
 * it was moving a moment ago.
 */
export function unstampedReason(root: string, rel: string): UnstampedReason {
  const result = readStamp(root, rel);
  return 'stamp' in result ? 'changing' : result.reason;
}

function readStamp(root: string, rel: string): { stamp: string } | { reason: UnstampedReason } {
  const path = resolve(root, rel);
  try {
    lstatSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') return { reason: 'unreadable' };
    const stamp = deletionStamp(root, path);
    return stamp === null ? { reason: 'unreadable' } : { stamp };
  }
  for (let attempt = 0; attempt < STAMP_ATTEMPTS; attempt++) {
    try {
      const before = statSync(path, { bigint: true });
      if (!before.isFile()) return { reason: 'not-a-file' };
      const hash = hashFile(path);
      // The file changed while it was read: the content may not be the one the time and size name.
      const after = statSync(path, { bigint: true });
      if (after.mtimeNs !== before.mtimeNs || after.size !== before.size) continue;
      return { stamp: `${String(before.mtimeNs)}:${String(before.size)}:${hash}` };
    } catch {
      return { reason: 'unreadable' };
    }
  }
  return { reason: 'changing' };
}
