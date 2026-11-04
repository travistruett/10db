import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { ShapeMessageKind, type ShapeMessageDto } from '@10db/contracts';
import { expandHome } from '../sandbox';
import type { ShapeAccess } from './confinement';

// Shape spec §5.4. A picture or PDF Claude pulls in with `Read` comes back as a tool result, and a resumed
// session resends every earlier tool result with each request, beside the pictures the daemon sends
// itself (`screens/inline-budget.ts`: 18 MiB, 24 MiB as base64, which leaves the API's 32 MB request
// about 6.8 MB). The daemon never sees that result, so it counts the Read in the PreToolUse hook, before
// it runs, and refuses the one that would pass the total.

const MIB = 1024 * 1024;

/**
 * The most a conversation's Read pictures add to a request, in bytes before base64: 3 MiB is 4 MiB (4.2 MB)
 * on the wire, which leaves about 2.6 MB of the 32 MB for the conversation's text.
 */
export const READ_PICTURES_MAX_BYTES = 3 * MIB;

/**
 * The most one Read picture is charged. Claude Code resizes a picture it reads to at most about 2000 px
 * a side and re-encodes it, so what it returns is not the file's size; this is the allowance for it, and a
 * smaller file is charged its own size, which resizing does not make larger. UNMEASURED: no live session
 * has run `test/shape-session.live.test.ts` (`TENDB_LIVE_CLAUDE=1`). It ships unmeasured with the
 * orchestrator's acceptance for the builder (inbox card inb_01a1a575); follow-up task
 * tsk_01a1a578-91d9-7591-beb2-36336144c589 runs it. If a Read returns more than this, the total above is not a promise.
 */
export const READ_PICTURE_CHARGE_MAX_BYTES = 1 * MIB;

/** The pictures Claude Code's `Read` turns into an image block. */
const PICTURE_NAME = /\.(png|jpe?g|gif|webp)$/i;

/**
 * The most pages one Read of a PDF returns (`pages`: "Maximum 20 pages per request"). What a Read of a PDF
 * returns is either the whole file as a document block or its pages as pictures, and the SDK's types show
 * pictures can come back with no range too, so its size is not the file's: a 100 kB text PDF renders to
 * pictures far larger than itself. So a Read is charged by the page, each page at the per-picture allowance,
 * and one whose pages aren't known is charged this most, which is past the total: refused, with the reason
 * saying to name them. UNMEASURED like that allowance: it ships with the builder's acceptance (inbox card
 * inb_01a1a613-db5c-74d6-9bc8-f779db7f360d), and follow-up task tsk_01a1a613-b481-766b-b60e-ec76fecb12ca runs
 * the PDF cases of `test/shape-session.live.test.ts`.
 */
const PDF_PAGES_MAX = 20;

const PDF_NAME = /\.pdf$/i;

const PAGE_RANGE = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/;

/** How many pages a Read's `pages` names, up to the most: that most when it names none or can't be read. */
function pagesCharged(pages: string | null): number {
  const range = pages === null ? null : PAGE_RANGE.exec(pages);
  if (range === null) return PDF_PAGES_MAX;
  const first = Number(range[1]);
  const count = Number(range[2] ?? range[1]) - first + 1;
  return first >= 1 && count >= 1 ? Math.min(count, PDF_PAGES_MAX) : PDF_PAGES_MAX;
}

export type ReadKind = 'picture' | 'PDF';

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

/** The dimmed transcript line that records a counted Read; `readPictureBytesSpent` reads it back. */
export const readPictureLine = (path: string, charge: number, kind: ReadKind = 'picture'): string =>
  `Read · ${path} · ${kind} · ${String(charge)} bytes counted`;

const COUNTED = /^Read · .* · (?:picture|PDF) · (\d+) bytes counted$/s;

/**
 * The bytes of Read pictures the live session carries: the counted lines after the latest digest, which
 * marks where the session began (§5.5). A restart resumes the session with all of them, so they come from
 * the transcript, not from memory.
 */
export function readPictureBytesSpent(messages: readonly ShapeMessageDto[]): number {
  const start = messages.findLastIndex((m) => m.kind === ShapeMessageKind.Digest) + 1;
  return messages.slice(start).reduce((sum, message) => {
    if (message.kind !== ShapeMessageKind.Tool) return sum;
    const counted = COUNTED.exec(message.body)?.[1];
    return counted === undefined ? sum : sum + Number(counted);
  }, 0);
}

/** Why a Read is refused, or null when it fits beside the pictures and PDFs already read. */
export function readPictureRefusal(
  path: string,
  charge: number,
  spent: number,
  kind: ReadKind = 'picture',
): string | null {
  if (spent + charge <= READ_PICTURES_MAX_BYTES) return null;
  if (kind === 'PDF') {
    const room = Math.floor((READ_PICTURES_MAX_BYTES - spent) / READ_PICTURE_CHARGE_MAX_BYTES);
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
