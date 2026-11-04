import { statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { expandHome } from '../sandbox';
import {
  PICTURE_POOL_BYTES,
  READ_CHARGE_MAX_BYTES,
  READ_RESERVE_BYTES,
  largestReadMeasured,
  readAllowance,
  readBytesSpent,
  readCountedLine,
  readMeasuredLine,
  readPictureCap,
  unmeasuredRead,
  type ReadKind,
} from '../screens';
import type { ShapeAccess } from './confinement';

// Shape spec §5.4. A picture or PDF Claude pulls in with `Read` comes back as a tool result, and a resumed
// session resends every earlier tool result with each request, beside the pictures the daemon sends
// itself (`screens/inline-budget.ts`). The two share one pool of 21 MiB, 28 MiB as base64, which leaves the
// API's 32 MB request limit room for text. The daemon never sees a Read's result before it runs, so it
// counts the Read in the PreToolUse hook and refuses the one that would pass what the inline pictures leave
// of the pool; the PostToolUse hook then replaces the charge with the size the result really had.
// Everything here counts Reads of pictures and of PDFs alike; a name that says "read" means either kind.

export {
  READ_CHARGE_MAX_BYTES,
  READ_RESERVE_BYTES,
  largestReadMeasured,
  readAllowance,
  readBytesSpent,
  readCountedLine,
  readPictureCap,
  unmeasuredRead,
  type ReadKind,
};

/**
 * What Reads may add to a request, in bytes before base64, once the live session carries `inlineSpent` bytes
 * of inline pictures: what they leave of the pool, never less than the reserve a full inline budget leaves.
 */
export const readCeiling = (inlineSpent: number): number =>
  Math.max(READ_RESERVE_BYTES, PICTURE_POOL_BYTES - inlineSpent);

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

/**
 * Whether a Read's result is Claude Code's `file_unchanged` (`SdkFileReadOutput`): the file is the one an
 * earlier tool result already carries, so this Read adds nothing to the request.
 */
export function isFileUnchanged(response: unknown): boolean {
  return (
    typeof response === 'object' &&
    response !== null &&
    (response as Record<string, unknown>)['type'] === 'file_unchanged'
  );
}

/**
 * Whether a Read's result is only text: a bare string, a `text` result (`SdkFileReadOutput`) or content blocks
 * that are all `text`. A Read refused with a reason, such as a PDF over 10 pages with no `pages`, answers this
 * way and carries no picture or document, so it adds nothing to the request however much it was counted for.
 * A `parts` result is not text: its pages are files on disk the session may still Read, so it keeps its charge.
 */
export function isTextOnly(response: unknown): boolean {
  if (typeof response === 'string') return true;
  const isTextBlock = (item: unknown): boolean =>
    typeof item === 'object' &&
    item !== null &&
    (item as Record<string, unknown>)['type'] === 'text';
  return Array.isArray(response)
    ? response.length > 0 && response.every(isTextBlock)
    : isTextBlock(response);
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
export function pagesCharged(pages: string | null): number {
  const range = pages === null ? null : PAGE_RANGE.exec(pages);
  if (range === null) return Number.POSITIVE_INFINITY;
  const first = Number(range[1]);
  const count = Number(range[2] ?? range[1]) - first + 1;
  return first >= 1 && count >= 1 && count <= PDF_PAGES_MAX ? count : Number.POSITIVE_INFINITY;
}

/**
 * What a Read of this path is charged: null for anything but a picture or PDF that exists. `pages` is the
 * Read's own `pages` value, which only a PDF uses. `allowance` is what a page is charged (`readAllowance` of
 * the live session's transcript) and `pictureCap` the most a picture is (`readPictureCap`).
 */
export function readCharge(
  path: string,
  pages: string | null,
  access: Pick<ShapeAccess, 'checkout' | 'home'>,
  allowance: number,
  pictureCap: number,
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
      bytes: kind === 'PDF' ? pagesCharged(pages) * allowance : Math.min(stat.size, pictureCap),
    };
  } catch {
    // Read of a path that isn't there fails, and a failed Read returns text.
    return null;
  }
}

/**
 * The images, among those that went to Claude as a path to Read, that a Read would be refused for: each is
 * charged as a Read charges it (its size, at most `pictureCap`) in order against `room`, the bytes the live
 * session's Reads have left (`readCeiling` less what they spent). An image that doesn't fit is skipped, so a
 * smaller one after it still counts as readable.
 */
export function unreadableImages<F extends { readonly size: number }>(
  files: readonly F[],
  room: number,
  pictureCap: number,
): F[] {
  let left = room;
  return files.filter((file) => {
    const charge = Math.min(file.size, pictureCap);
    if (charge > left) return true;
    left -= charge;
    return false;
  });
}

/**
 * Whether Reading any one of these images first would be let in: each is charged as a Read charges it (its
 * size, at most `pictureCap`) and `room` takes the largest of those alone. An image that doesn't fit even
 * first can only go in a new conversation, so a notice that suggests Reading first must be true for all it
 * names, since the builder picks which.
 */
export function eachFitsAlone(
  files: readonly { readonly size: number }[],
  room: number,
  pictureCap: number,
): boolean {
  return files.every((file) => Math.min(file.size, pictureCap) <= room);
}

/**
 * What a notice calls a dropped image: the name it is kept under, unique in the conversation where the name it
 * was dropped with is not (every pasted screenshot is `pasted-image.png`). Claude is told both, so the builder
 * can use this one to say which picture matters most.
 */
export const noticeName = (file: { readonly storedPath: string }): string =>
  basename(file.storedPath);

/**
 * What the builder is told about images Claude was pointed at but a Read would refuse. It is an estimate, so
 * it says "probably": measured Reads can leave more room or less. The session is what ran out, not the image,
 * so a smaller copy is no remedy: it goes as a path too once the inline budget is full, and is refused.
 * `readFirst` is whether the room left takes any one of the named images (`eachFitsAlone`): only then does
 * Reading the one that matters most first help; otherwise a new conversation, which starts its own pool, is the
 * only remedy offered.
 */
export const unreadableImagesNotice = (names: readonly string[], readFirst: boolean): string =>
  `Claude probably won't be able to Read ${names.join(', ')}: this conversation is out of room for pictures. ` +
  (readFirst
    ? `Tell Claude which picture matters most so it Reads that one first, or send ` +
      `${names.length === 1 ? 'it' : 'them'} in a new conversation.`
    : `Send ${names.length === 1 ? 'it' : 'them'} in a new conversation.`);

/**
 * What the builder is told when a Read of a dropped image was refused and no earlier notice named it: the
 * send-time notice is a prediction that misses images of earlier turns no Read had made room for, room taken
 * after it by `see_screen` or by other Reads, and Reads in an order it did not assume. Unlike that notice it
 * states what happened, so it does not say "probably". The room left was under this image's charge, so
 * Reading it first is no remedy: only a new conversation is offered.
 */
export const refusedImageNotice = (name: string): string =>
  `Claude couldn't Read ${name}: this conversation is out of room for pictures. ` +
  `Send it in a new conversation.`;

/** The line that corrects a Read's counted charge to what its result measured. */
export { readMeasuredLine };

/**
 * Why a Read is refused, or null when it fits within `ceiling` (`readCeiling`) beside the pictures and
 * PDFs already read. A picture charged over `allowance` is one the session has no measurement for, so the
 * reason says that a measurement can let it in.
 */
export function readRefusal(
  path: string,
  charge: number,
  spent: number,
  ceiling: number,
  kind: ReadKind = 'picture',
  allowance: number = READ_CHARGE_MAX_BYTES,
): string | null {
  if (spent + charge <= ceiling) return null;
  if (kind === 'PDF') {
    const room = Math.min(PDF_PAGES_MAX, Math.floor((ceiling - spent) / allowance));
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
    `under the API's 32 MB request limit. ` +
    (charge > allowance
      ? `Until a picture over 1 MiB has come back, each counts at its full file size: wait for the ones ` +
        `already asked for, or Read a smaller one first, then try again.`
      : `Work from the pictures already read, or ask the builder for a smaller one.`)
  );
}
