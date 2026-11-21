import { ShapeFileKind } from '@10db/contracts';
import { unzipSync } from 'fflate';
import { signedKind } from './file-check';

// What a dropped file is, from its bytes alone: the extension and the declared type are the builder's
// word, the bytes are the file's.

export const DroppedKind = {
  Image: 'image',
  Pdf: 'pdf',
  Docx: 'docx',
  Pptx: 'pptx',
  Text: 'text',
} as const;
export type DroppedKind = (typeof DroppedKind)[keyof typeof DroppedKind];

export interface ClassifiedBytes {
  readonly kind: DroppedKind;
  /** The image or PDF type; `text/plain` for text, which a name ending `.md` may refine. */
  readonly mediaType: ShapeFileKind;
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });

/** Whether the bytes are UTF-8 text: a BOM is allowed, a NUL or an invalid sequence is not. */
function isText(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    UTF8.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** The names inside a ZIP, read from its directory without inflating anything. */
function zipNames(bytes: Uint8Array): readonly string[] {
  const names: string[] = [];
  try {
    unzipSync(bytes, {
      filter: (entry) => {
        names.push(entry.name);
        return false;
      },
    });
  } catch {
    return [];
  }
  return names;
}

/** Why a refused file is an Office format 10db can't read yet, with what to drop instead; null otherwise. */
export function unsupportedOffice(bytes: Uint8Array): string | null {
  // The Compound File header every pre-2007 Office document begins with.
  if ([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every((byte, i) => bytes[i] === byte))
    return "10db can't read older Office files (.doc, .xls, .ppt) yet; save it as .docx, .pptx or CSV and drop that";
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4)
    return zipNames(bytes).includes('xl/workbook.xml')
      ? "10db can't read Excel workbooks yet; save the sheet as CSV and drop that"
      : null;
  return null;
}

/** The kind of a dropped file by its bytes, or null for anything 10db won't hand a session. */
export function classifyBytes(bytes: Uint8Array): ClassifiedBytes | null {
  const signed = signedKind(bytes);
  if (signed === ShapeFileKind.Pdf) return { kind: DroppedKind.Pdf, mediaType: signed };
  if (signed !== null) return { kind: DroppedKind.Image, mediaType: signed };
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4) {
    const names = zipNames(bytes);
    if (names.includes('word/document.xml'))
      return { kind: DroppedKind.Docx, mediaType: ShapeFileKind.Markdown };
    if (names.some((name) => name.startsWith('ppt/slides/')))
      return { kind: DroppedKind.Pptx, mediaType: ShapeFileKind.Markdown };
    return null;
  }
  return isText(bytes) ? { kind: DroppedKind.Text, mediaType: ShapeFileKind.Text } : null;
}
