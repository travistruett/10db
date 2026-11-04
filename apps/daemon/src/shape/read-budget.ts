import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { ShapeMessageKind, type ShapeMessageDto } from '@10db/contracts';
import { expandHome } from '../sandbox';
import type { ShapeAccess } from './confinement';

// Shape spec §5.4. A picture Claude pulls in with `Read` comes back as a tool result, and a resumed
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
 * A PDF Claude Code's `Read` returns as a document block (the whole file, base64) or, for a page range, as
 * pages rendered to pictures. UNMEASURED like the picture allowance above (no live session has run), so a PDF
 * is charged its whole file size with no cap: a document block can't be larger than the file, and a smaller
 * charge for pages would be a guess. A PDF past the total is refused, so a big PDF can't be Read at all.
 */
const PDF_NAME = /\.pdf$/i;

export type ReadKind = 'picture' | 'PDF';

/** What a Read of this path is charged: null for anything but a picture or PDF that exists. */
export function readCharge(
  path: string,
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
      bytes: kind === 'PDF' ? stat.size : Math.min(stat.size, READ_PICTURE_CHARGE_MAX_BYTES),
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
  if (kind === 'PDF')
    return (
      `Too much read in this conversation: the PDF ${path} would pass the total of pictures and PDFs a ` +
      `resumed session can carry under the API's 32 MB request limit. Work from what is already read, or ` +
      `ask the builder for a smaller PDF or its text.`
    );
  return (
    `Too many pictures read in this conversation: ${path} would pass the total a resumed session can carry ` +
    `under the API's 32 MB request limit. Work from the pictures already read, or ask the builder for a ` +
    `smaller one.`
  );
}
