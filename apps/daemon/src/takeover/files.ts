import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { ConversationId, TerminalAppSchema } from '@10db/contracts';
import { z } from 'zod';

// Sessions spec §7.5: the folder a chat's takeover files live in, `<data dir>/takeovers/<conversation id>/`,
// outside the chat's own files, which its session may read and its sandbox lists.
// The terminal's agent can write there, so every step names what it expects and never follows a link.

/** A takeover file or folder could not be made safely. */
export class TakeoverFilesError extends Error {
  override readonly name = 'TakeoverFilesError';
}

/** The folder under the data dir that holds every chat's takeover folder. */
export const TAKEOVERS = 'takeovers';
const RECORD_FILE = 'takeover.json';
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** What `takeover.json` holds: display data, never read to run or delete anything. */
export const TakeoverRecord = z.object({
  since: z.iso.datetime(),
  app: TerminalAppSchema,
  /** The temp dirs of every set's servers, for the startup sweep to leave alone while the takeover lives. */
  tempDirs: z.array(z.string()),
});
export type TakeoverRecord = z.infer<typeof TakeoverRecord>;

/** The folder a chat's takeover files go in. */
export const takeoverFolderOf = (dataDir: string, conversationId: ConversationId): string =>
  join(dataDir, TAKEOVERS, ConversationId.parse(conversationId));

const isMissing = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

/** Whether `path` is a real directory, not a link to one; null when it isn't there. */
function realDirectory(path: string): boolean | null {
  try {
    return lstatSync(path).isDirectory();
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

function ensureRealDirectory(path: string, mode: number): void {
  if (realDirectory(path) === null) mkdirSync(path, { mode });
  if (realDirectory(path) !== true)
    throw new TakeoverFilesError('a takeover folder is not a real directory');
}

/** Makes the chat's takeover folder, mode 700, and answers its path. Refuses a link on the way. */
export function createTakeoverFolder(dataDir: string, conversationId: ConversationId): string {
  const root = realpathSync(dataDir);
  ensureRealDirectory(join(root, TAKEOVERS), 0o700);
  const folder = takeoverFolderOf(root, conversationId);
  ensureRealDirectory(folder, 0o700);
  chmodSync(folder, 0o700);
  return takeoverFolderOf(dataDir, conversationId);
}

/**
 * Removes the chat's takeover folder with everything in it. A link at the folder is removed as a link; one at
 * the takeovers folder or above it is left alone, with whatever it leads to. Safe to repeat.
 */
export function removeTakeoverFolder(dataDir: string, conversationId: ConversationId): void {
  let root: string;
  try {
    root = realpathSync(dataDir);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  if (realDirectory(join(root, TAKEOVERS)) !== true) return;
  const folder = takeoverFolderOf(root, conversationId);
  const kind = realDirectory(folder);
  if (kind === null) return;
  if (kind) rmSync(folder, { recursive: true, force: true });
  else unlinkSync(folder);
}

/**
 * Writes `name` in the folder with `mode`: an entry already there (a link the agent left, say) is unlinked
 * first, and the file is created exclusively, so nothing is written through anything.
 */
export function writeTakeoverFile(
  folder: string,
  name: string,
  content: string,
  mode: number,
): string {
  if (!FILE_NAME.test(name) || name === '..')
    throw new TakeoverFilesError('a takeover file name is not a plain name');
  const path = join(folder, name);
  try {
    unlinkSync(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const fd = openSync(path, 'wx', mode);
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
  chmodSync(path, mode);
  return path;
}

export function writeTakeoverRecord(folder: string, record: TakeoverRecord): void {
  writeTakeoverFile(folder, RECORD_FILE, JSON.stringify(record), 0o600);
}

/** The record, or null when there is none or it isn't one: the agent can write it, so it is only read. */
export function readTakeoverRecord(folder: string): TakeoverRecord | null {
  try {
    if (!lstatSync(join(folder, RECORD_FILE)).isFile()) return null;
    const parsed = TakeoverRecord.safeParse(
      JSON.parse(readFileSync(join(folder, RECORD_FILE), 'utf8')),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
