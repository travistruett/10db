import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ShapeMessageDto } from '@10db/contracts';
import { expandHome } from '../sandbox';
import {
  PICTURE_POOL_BYTES,
  READ_PICTURES_RESERVE_BYTES,
  readBytesSpent,
  readMeasuredLine,
  readPictureLine,
  type ReadKind,
} from '../screens';
import type { ShapeAccess } from './confinement';

// Shape spec §5.4. A picture or PDF Claude pulls in with `Read` comes back as a tool result, and a resumed
// session resends every earlier tool result with each request, beside the pictures the daemon sends
// itself (`screens/inline-budget.ts`). The two share one pool of 21 MiB, 28 MiB as base64, which leaves the
// API's 32 MB request limit room for text. The daemon never sees a Read's result before it runs, so it
// counts the Read in the PreToolUse hook and refuses the one that would pass what the inline pictures leave
// of the pool; the PostToolUse hook then replaces the allowance with the size the result really had.

export { READ_PICTURES_RESERVE_BYTES, readPictureLine, type ReadKind };

const MIB = 1024 * 1024;

/**
 * What Reads may add to a request, in bytes before base64, once the live session carries `inlineSpent` bytes
 * of inline pictures: what they leave of the pool, never less than the reserve a full inline budget leaves.
 */
export const readCeiling = (inlineSpent: number): number =>
  Math.max(READ_PICTURES_RESERVE_BYTES, PICTURE_POOL_BYTES - inlineSpent);

/**
 * The most one Read picture is charged before its result is measured. Claude Code resizes a picture it
 * reads to at most about 2000 px a side and re-encodes it, so what it returns is not the file's size; this
 * is the allowance for it, and a smaller file is charged its own size, which resizing does not make larger.
 * The PostToolUse hook replaces it with the measured size of what came back (`measuredMediaBytes`); a
 * result it can't measure stays charged this. The live test
 * (`test/shape-session.live.test.ts`, `TENDB_LIVE_CLAUDE=1`) has not run: follow-up task
 * tsk_01a1a578-91d9-7591-beb2-36336144c589 runs it.
 */
export const READ_PICTURE_CHARGE_MAX_BYTES = 1 * MIB;

/**
 * The bytes before base64 of the pictures and documents a Read's result carries: every `base64` string in
 * it, and every `data` string beside `type: "base64"` (an API content block's source). A result that holds
 * none, such as text or a set of page files on disk, measures 0.
 */
export function measuredMediaBytes(response: unknown, depth = 0): number {
  if (typeof response !== 'object' || response === null || depth > 8) return 0;
  if (Array.isArray(response))
    return response.reduce<number>((sum, item) => sum + measuredMediaBytes(item, depth + 1), 0);
  const record = response as Record<string, unknown>;
  let total = 0;
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'string') {
      if (key === 'base64' || (key === 'data' && record['type'] === 'base64'))
        total += Buffer.byteLength(value, 'base64');
    } else total += measuredMediaBytes(value, depth + 1);
  }
  return total;
}

/** The pictures Claude Code's `Read` turns into an image block. */
const PICTURE_NAME = /\.(png|jpe?g|gif|webp)$/i;

/**
 * The most pages one Read of a PDF returns (`pages`: "Maximum 20 pages per request"). What a Read of a PDF
 * returns is either the whole file as a document block or its pages as pictures, and the SDK's types show
 * pictures can come back with no range too, so its size is not the file's: a 100 kB text PDF renders to
 * pictures far larger than itself. So a Read is charged by the page, each page at the per-picture allowance,
 * and one whose pages aren't known, or name more than this, can't be bounded: it is charged without limit,
 * so it is refused, with the reason saying to name them. The allowance is unmeasured like the picture one:
 * follow-up task tsk_01a1a613-b481-766b-b60e-ec76fecb12ca runs the PDF cases of
 * `test/shape-session.live.test.ts`.
 */
const PDF_PAGES_MAX = 20;

const PDF_NAME = /\.pdf$/i;

const PAGE_RANGE = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/;

/** How many pages a Read's `pages` names: infinite when it names none, can't be read or is past the most. */
function pagesCharged(pages: string | null): number {
  const range = pages === null ? null : PAGE_RANGE.exec(pages);
  if (range === null) return Number.POSITIVE_INFINITY;
  const first = Number(range[1]);
  const count = Number(range[2] ?? range[1]) - first + 1;
  return first >= 1 && count >= 1 && count <= PDF_PAGES_MAX ? count : Number.POSITIVE_INFINITY;
}

/**
 * What a Read of this path is charged: null for anything but a picture or PDF that exists. `pages` is the
 * Read's own `pages` value, which only a PDF uses.
 */
export function readCharge(
  path: string,
  pages: string | null,
  access: Pick<ShapeAccess, 'checkout' | 'home'>,
): { kind: ReadKind; bytes: number } | null {
  const kind: ReadKind | null = PICTURE_NAME.test(path)
    ? 'picture'
    : PDF_NAME.test(path)
      ? 'PDF'
      : null;
  if (kind === null) return null;
  try {
    const stat = statSync(resolve(access.checkout, expandHome(path, access.home)));
    if (!stat.isFile()) return null;
    return {
      kind,
      bytes:
        kind === 'PDF'
          ? pagesCharged(pages) * READ_PICTURE_CHARGE_MAX_BYTES
          : Math.min(stat.size, READ_PICTURE_CHARGE_MAX_BYTES),
    };
  } catch {
    // Read of a path that isn't there fails, and a failed Read returns text.
    return null;
  }
}

/**
 * The names of the images, among those that went to Claude as a path to Read, that a Read would be refused
 * for: each is charged as a Read charges it (its size, at most the allowance) in order against `room`, the
 * bytes the live session's Reads have left (`readCeiling` less what they spent). An image that doesn't fit
 * is skipped, so a smaller one after it still counts as readable.
 */
export function unreadableImages(
  files: readonly { readonly name: string; readonly size: number }[],
  room: number,
): string[] {
  let left = room;
  const names: string[] = [];
  for (const file of files) {
    const charge = Math.min(file.size, READ_PICTURE_CHARGE_MAX_BYTES);
    if (charge <= left) left -= charge;
    else names.push(file.name);
  }
  return names;
}

/**
 * What the builder is told about images Claude was pointed at but a Read would refuse. It is an estimate, so
 * it says "probably": measured Reads can leave more room or less. The session is what ran out, not the image,
 * so a smaller copy is no remedy: it goes as a path too once the inline budget is full, and is refused.
 */
export const unreadableImagesNotice = (names: readonly string[]): string =>
  `Claude probably won't be able to Read ${names.join(', ')}: this conversation is out of room for pictures. ` +
  `Tell Claude which picture matters most so it Reads that one first, or send ` +
  `${names.length === 1 ? 'it' : 'them'} in a new conversation.`;

/**
 * The bytes of Read pictures the live session carries: the counted lines after the latest digest or
 * fresh-start line, which mark where the session began (§5.5).
 */
export const readPictureBytesSpent = (messages: readonly ShapeMessageDto[]): number =>
  readBytesSpent(messages);

/** The line that corrects a Read's counted charge to what its result measured. */
export { readMeasuredLine };

/**
 * Why a Read is refused, or null when it fits within `ceiling` (`readCeiling`) beside the pictures and
 * PDFs already read.
 */
export function readPictureRefusal(
  path: string,
  charge: number,
  spent: number,
  ceiling: number,
  kind: ReadKind = 'picture',
): string | null {
  if (spent + charge <= ceiling) return null;
  if (kind === 'PDF') {
    const room = Math.min(
      PDF_PAGES_MAX,
      Math.floor((ceiling - spent) / READ_PICTURE_CHARGE_MAX_BYTES),
    );
    const next =
      room > 0
        ? `Read it again with \`pages\` naming one page or range, such as "1-${String(room)}": up to ${String(room)} pages fit`
        : 'No room is left for more pages: work from what is already read';
    return (
      `The PDF ${path} can only be read by the page here, with \`pages\`, and this Read's pages would pass ` +
      `the total of pictures and PDF pages a resumed session can carry under the API's 32 MB request limit. ` +
      `${next}, or ask the builder for its text.`
    );
  }
  return (
    `Too many pictures read in this conversation: ${path} would pass the total a resumed session can carry ` +
    `under the API's 32 MB request limit. Work from the pictures already read, or ask the builder for a ` +
    `smaller one.`
  );
}
