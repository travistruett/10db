import {
  isShapeImage,
  shapeFileKind,
  TASK_MESSAGE_PICTURES_MAX,
  TASK_MESSAGE_PICTURES_MAX_BYTES,
  TASK_PICTURE_MAX_BYTES,
} from '@10db/contracts';
import { nameImage } from '../shape/dropped-files';

// Workbench spec §4.3: the composer takes pasted, dropped or picked PNG, JPEG and WebP pictures. It
// checks each before it holds it, so the reason shows at once; the daemon checks the bytes again when
// the message is sent, and its words are shown when it still refuses.

/** What Add Picture offers; a paste or a drop skips it, so the checks below still run. */
export const PICTURE_PICKER_ACCEPT = '.png,.jpg,.jpeg,.webp';

const MIB = 1024 * 1024;

function refusal(file: File, held: readonly File[]): string | null {
  const kind = shapeFileKind(file.name);
  if (kind === null || !isShapeImage(kind))
    return `${file.name} can’t be added: paste a PNG, JPEG or WebP picture`;
  if (file.size === 0) return `${file.name} is empty`;
  if (file.size > TASK_PICTURE_MAX_BYTES)
    return `${file.name} is ${String(Math.ceil(file.size / MIB))} MB; the limit is ${String(TASK_PICTURE_MAX_BYTES / MIB)} MB`;
  if (held.length >= TASK_MESSAGE_PICTURES_MAX)
    return `${file.name} can’t be added: a message carries at most ${String(TASK_MESSAGE_PICTURES_MAX)} pictures`;
  const total = held.reduce((sum, p) => sum + p.size, file.size);
  if (total > TASK_MESSAGE_PICTURES_MAX_BYTES)
    return `${file.name} can’t be added: a message’s pictures are at most ${String(TASK_MESSAGE_PICTURES_MAX_BYTES / MIB)} MB together`;
  return null;
}

/** The pictures `held` with `added` taken one after another, and a reason for each one refused. */
export function withPictures(
  held: readonly File[],
  added: readonly File[],
): { readonly pictures: readonly File[]; readonly refused: readonly string[] } {
  const pictures = [...held];
  const refused: string[] = [];
  for (const file of added.map(nameImage)) {
    const reason = refusal(file, pictures);
    if (reason === null) pictures.push(file);
    else refused.push(reason);
  }
  return { pictures, refused };
}
