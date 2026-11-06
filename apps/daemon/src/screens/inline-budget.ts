import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  isShapeImage,
  ScreenMessageBody,
  shapeFileKind,
  ShapeMessageKind,
  type ShapeId,
  type ShapeMessageDto,
} from '@10db/contracts';
import { listShapeFiles, listShapeMessages } from '@10db/db';
import type { StateStore } from '../events';
import { readImageSize } from './image-check';
import { poolBytes, type PictureLimits } from './picture-limits';

// Shape spec §5.4. A resumed session resends every earlier image with each request, whether it arrived in
// a message or as a see_screen result, so dropped images and screens share one budget. The limits it is held
// to are those of the account the session runs on (`picture-limits.ts`): a picture Claude pulls in with `Read`
// is a tool result this budget can't see; the Shape hook counts those (`shape/read-budget.ts`), and they draw
// on one pool with these (`poolBytes`), so Reads past their reserve take from this budget.

const MIB = 1024 * 1024;

/** The transcript line that starts a session with nothing to resume and no digest to say so. */
export const FRESH_START_LINE = 'Session · started fresh';

/**
 * The transcript the live session carries: what follows the latest digest, or the latest fresh-start line,
 * whichever is later. A digest row is written when a session starts from one (§5.5); a session that
 * lost its predecessor before Claude spoke has no digest, so `start` writes the fresh-start line instead.
 */
export function liveMessages(messages: readonly ShapeMessageDto[]): readonly ShapeMessageDto[] {
  const start =
    messages.findLastIndex(
      (m) =>
        m.kind === ShapeMessageKind.Digest ||
        (m.kind === ShapeMessageKind.Tool && m.body === FRESH_START_LINE),
    ) + 1;
  return messages.slice(start);
}

export type ReadKind = 'picture' | 'PDF';

/** The dimmed transcript line that records a counted Read; `readBytesSpent` reads it back. */
export const readCountedLine = (path: string, charge: number, kind: ReadKind = 'picture'): string =>
  `Read · ${path} · ${kind} · ${String(charge)} bytes counted`;

/**
 * The line that replaces a Read's counted charge with the bytes it was measured to return. A PDF's names
 * how many pages those bytes cover, so `largestReadMeasured` can tell what one page weighed.
 */
export const readMeasuredLine = (
  path: string,
  measured: number,
  counted: number,
  kind: ReadKind = 'picture',
  pages?: number,
): string =>
  `Read · ${path} · ${kind} · ${String(measured)} bytes measured in place of ${String(counted)}` +
  (kind === 'PDF' && pages !== undefined ? ` over ${String(pages)} pages` : '');

const COUNTED = /^Read · .* · (?:picture|PDF) · (\d+) bytes counted$/s;
const MEASURED =
  /^Read · .* · (picture|PDF) · (\d+) bytes measured in place of (\d+)(?: over (\d+) pages)?$/s;
const COUNTED_OF = /^Read · (.*) · (picture|PDF) · (\d+) bytes counted$/s;
const MEASURED_OF =
  /^Read · (.*) · (?:picture|PDF) · \d+ bytes measured in place of \d+(?: over \d+ pages)?$/s;

/**
 * The oldest counted Read of this path in the live session that no measured line has replaced yet: what
 * the next result for that path stands in for. Reads of one path measure in the order they were counted,
 * or at least to the same total, since each result replaces one charge. Read it from the transcript, not
 * by recomputing the charge: Reads in one message are counted before any is measured, and the charge
 * changes once one is.
 */
export function unmeasuredRead(
  messages: readonly ShapeMessageDto[],
  path: string,
): { kind: ReadKind; counted: number } | null {
  const open: { kind: ReadKind; counted: number }[] = [];
  for (const message of liveMessages(messages)) {
    if (message.kind !== ShapeMessageKind.Tool) continue;
    const counted = COUNTED_OF.exec(message.body);
    if (counted !== null) {
      if (counted[1] === path)
        open.push({ kind: counted[2] === 'PDF' ? 'PDF' : 'picture', counted: Number(counted[3]) });
    } else if (MEASURED_OF.exec(message.body)?.[1] === path) open.shift();
  }
  return open[0] ?? null;
}

/**
 * The most one page of a Read PDF is charged before its result is measured, and one Read picture once the
 * session has measured a large one (`readPictureCap`), until the session measures a larger one
 * (`readAllowance`). Claude Code resizes a picture it reads to at most about 2000 px a side and re-encodes
 * it, so what it returns is not the file's size; this is the allowance for it, and a smaller file is charged
 * its own size, which resizing does not make larger. The PostToolUse hook replaces the charge with the
 * measured size of what came back (`measuredMediaBytes`); a result whose bytes stayed on disk stays charged
 * what it was counted, and a failed or `file_unchanged` Read, which added nothing, gives its charge back. The
 * live test (`test/shape-session.live.test.ts`, `TENDB_LIVE_CLAUDE=1`) has not run: follow-up task
 * tsk_01a1a578-91d9-7591-beb2-36336144c589 runs it.
 */
export const READ_CHARGE_MAX_BYTES = 1 * MIB;

/**
 * The largest a single Read picture, or a single page of a Read PDF, measured in the live session: 0 when
 * none has. A PDF's lines give their bytes over their pages; one written before pages were recorded covered
 * as many pages as 1 MiB each made up its counted charge. A page's share is rounded up: it is charged as a
 * bound, and the transcript lines that carry a charge hold whole bytes.
 */
export function largestReadMeasured(messages: readonly ShapeMessageDto[]): number {
  return liveMessages(messages).reduce((largest, message) => {
    if (message.kind !== ShapeMessageKind.Tool) return largest;
    const measured = MEASURED.exec(message.body);
    if (measured === null) return largest;
    const bytes = Number(measured[2]);
    if (measured[1] !== 'PDF') return Math.max(largest, bytes);
    const pages = Number(measured[4] ?? Math.round(Number(measured[3]) / READ_CHARGE_MAX_BYTES));
    return pages >= 1 ? Math.max(largest, Math.ceil(bytes / pages)) : largest;
  }, 0);
}

/**
 * What a PDF page, or a picture once the session has measured one (`readPictureCap`), is charged before its
 * result is measured: the allowance, or the largest the live session has measured when that is more. Reads
 * issued together all pass PreToolUse before any result is measured, so a session that has seen a Read return
 * more than the allowance charges the ones in flight at what it saw, not at the allowance.
 */
export const readAllowance = (messages: readonly ShapeMessageDto[]): number =>
  Math.max(READ_CHARGE_MAX_BYTES, largestReadMeasured(messages));

/**
 * Whether the live session has measured what a picture over the allowance came back as. A smaller one says
 * nothing about that: it is only charged its own size, and a failed or `file_unchanged` Read (0 bytes)
 * measured nothing.
 */
const largePictureMeasured = (messages: readonly ShapeMessageDto[]): boolean =>
  liveMessages(messages).some((message) => {
    if (message.kind !== ShapeMessageKind.Tool) return false;
    const measured = MEASURED.exec(message.body);
    return (
      measured !== null &&
      measured[1] === 'picture' &&
      Number(measured[2]) > 0 &&
      Number(measured[3]) > READ_CHARGE_MAX_BYTES
    );
  });

/**
 * The most a Read picture is charged before its result is measured. Until the session has seen what a large
 * picture comes back as, nothing else bounds a batch, so there is no cap: a picture is charged its file's
 * size, which resizing does not exceed. After that, it is `readAllowance`.
 */
export const readPictureCap = (messages: readonly ShapeMessageDto[]): number =>
  largePictureMeasured(messages) ? readAllowance(messages) : Number.POSITIVE_INFINITY;

/**
 * The bytes of Read pictures and PDF pages the live session carries, from its counted lines: a measured
 * line stands in for the count before it. A restart resumes the session with all of them, so they come
 * from the transcript, not from memory.
 */
export function readBytesSpent(messages: readonly ShapeMessageDto[]): number {
  const total = liveMessages(messages).reduce((sum, message) => {
    if (message.kind !== ShapeMessageKind.Tool) return sum;
    const counted = COUNTED.exec(message.body)?.[1];
    if (counted !== undefined) return sum + Number(counted);
    const measured = MEASURED.exec(message.body);
    return measured === null ? sum : sum + Number(measured[2]) - Number(measured[3]);
  }, 0);
  return Math.max(0, total);
}

export const isImageName = (name: string): boolean => {
  const kind = shapeFileKind(name);
  return kind !== null && isShapeImage(kind);
};

/** What a Screen message's body says, or null for a body that isn't one. */
export function parseScreenBody(body: string): ScreenMessageBody | null {
  try {
    const parsed = ScreenMessageBody.safeParse(JSON.parse(body));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const keptScreenBytes = (path: string): number => {
  try {
    return statSync(path).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
};

/**
 * The bytes of the screens the live session took. A session started from a digest carries no earlier
 * picture (§5.5), and the digest's own row marks where it began, so a restart loses nothing.
 */
function liveScreenBytes(
  messages: readonly ShapeMessageDto[],
  filesRoot: string,
  shapeId: ShapeId,
): number {
  return liveMessages(messages).reduce((sum, message) => {
    if (message.kind !== ShapeMessageKind.Screen) return sum;
    const name = parseScreenBody(message.body)?.name;
    return name === undefined
      ? sum
      : sum + keptScreenBytes(join(filesRoot, shapeId, 'screens', name));
  }, 0);
}

/**
 * Whether the stored image is within the side cap. One whose size can't be read (cut short, or not
 * what its name says) is not: it would be sent blind, and a model refusing it ends every turn.
 */
function withinSideCap(storedPath: string, maxSide: number): boolean {
  try {
    const size = readImageSize(readFileSync(storedPath));
    return size !== null && Math.max(size.width, size.height) <= maxSide;
  } catch {
    return false;
  }
}

/**
 * An image too big, in bytes or in pixels, to be a content block on its own on this account. The one rule
 * for what goes inline and what is charged for it, so the two can't disagree.
 */
export const tooBigAlone = (
  file: {
    readonly size: number;
    readonly storedPath: string;
  },
  limits: PictureLimits,
): boolean =>
  file.size > limits.imageMaxBytes || !withinSideCap(file.storedPath, limits.imageMaxSide);

/**
 * The image bytes the daemon itself sent that the live session carries: every screen it took and every
 * dropped image one of its turns sent as a block (`shape_files.inline_sent`, which a fresh session
 * clears). Images that went as paths, and pictures of an earlier session, are not charged. `filesRoot` is
 * the data directory's `shapes` folder. An image that passes `tooBigAlone` for `limits` is the only one
 * charged, so this is what the session sends from now on, not what an earlier account let it send:
 * `carriedTooMuch` is the check to resume with.
 */
export function inlinePictureBytes(
  state: StateStore,
  filesRoot: string,
  shapeId: ShapeId,
  limits: PictureLimits,
): number {
  const sent = listShapeFiles(state.db, shapeId).reduce(
    (sum, file) =>
      file.inlineSent && isImageName(file.name) && !tooBigAlone(file, limits)
        ? sum + file.size
        : sum,
    0,
  );
  return sent + liveScreenBytes(listShapeMessages(state.db, shapeId), filesRoot, shapeId);
}

/**
 * What an inline picture is charged against `limits.inlineMaxBytes`: the inline pictures the live
 * session carries, and the Read pictures beyond their reserve, which took room the pool would have given
 * an inline one.
 */
export function inlineBytesSpent(
  state: StateStore,
  filesRoot: string,
  shapeId: ShapeId,
  limits: PictureLimits,
): number {
  const reads = readBytesSpent(listShapeMessages(state.db, shapeId));
  return (
    inlinePictureBytes(state, filesRoot, shapeId, limits) +
    Math.max(0, reads - limits.readReserveBytes)
  );
}

/** Why a resumed session can't be resumed on an account: what it carries is more than that account takes. */
export interface CarriedTooMuch {
  /** Every picture and PDF page the live session would resend, in bytes before base64. */
  readonly carried: number;
  /** What the account's pool takes (`poolBytes`), or the image cap a carried picture is over. */
  readonly allowed: number;
  readonly reason: 'pool' | 'image';
}

/**
 * Whether the live session, resumed on an account with these limits, would resend more than the account's
 * request takes: null when it would not. It counts what the session carries, whatever account let it in:
 * every dropped image a turn sent as a block (`inline_sent`), every screen, and every Read picture and PDF
 * page. `inlinePictureBytes` charges only what passes the account's own per-image caps, which is right for
 * what is sent next but not for a block already in the session's history, so a picture sent on a larger
 * account that is over this one's byte or pixel cap is checked here by itself. A conversation whose account
 * changed between turns, such as a plan falling back to Bedrock, is resumed only when this is null.
 */
export function carriedTooMuch(
  state: StateStore,
  filesRoot: string,
  shapeId: ShapeId,
  limits: PictureLimits,
): CarriedTooMuch | null {
  const messages = listShapeMessages(state.db, shapeId);
  let sent = 0;
  for (const file of listShapeFiles(state.db, shapeId)) {
    if (!file.inlineSent || !isImageName(file.name)) continue;
    if (tooBigAlone(file, limits))
      return { carried: file.size, allowed: limits.imageMaxBytes, reason: 'image' };
    sent += file.size;
  }
  const carried = sent + liveScreenBytes(messages, filesRoot, shapeId) + readBytesSpent(messages);
  return carried > poolBytes(limits)
    ? { carried, allowed: poolBytes(limits), reason: 'pool' }
    : null;
}
