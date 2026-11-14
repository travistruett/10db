import {
  shapeFileKind,
  ShapeFileKind,
  TASK_MESSAGE_PICTURES_MAX,
  TASK_MESSAGE_PICTURES_MAX_BYTES,
  TASK_PICTURE_MAX_BYTES,
  type ImageFormat,
} from '@10db/contracts';
import { nameImage } from './dropped-files';

// Sessions UI spec §7.9: the composer takes pasted, dropped or picked pictures in the formats the
// agent's capabilities list. It checks each before it holds it, so the reason shows at once; the daemon
// checks the bytes again when the message is sent.

const FORMAT_OF_KIND: Readonly<Partial<Record<ShapeFileKind, ImageFormat>>> = {
  [ShapeFileKind.Png]: 'png',
  [ShapeFileKind.Jpeg]: 'jpeg',
  [ShapeFileKind.Webp]: 'webp',
};

const EXTENSIONS: Readonly<Record<ImageFormat, string>> = {
  png: '.png',
  jpeg: '.jpg,.jpeg',
  webp: '.webp',
};

const WORDS: Readonly<Record<ImageFormat, string>> = { png: 'PNG', jpeg: 'JPEG', webp: 'WebP' };

const MIB = 1024 * 1024;

/** What Attach offers for these formats; a paste or a drop skips it, so the checks below still run. */
export function pickerAccept(images: readonly ImageFormat[]): string {
  return images.map((format) => EXTENSIONS[format]).join(',');
}

/** "PNG, JPEG or WebP". */
function formatsInWords(images: readonly ImageFormat[]): string {
  const names = images.map((format) => WORDS[format]);
  const last = names.pop();
  return names.length === 0 ? (last ?? '') : `${names.join(', ')} or ${last ?? ''}`;
}

function refusal(file: File, held: readonly File[], images: readonly ImageFormat[]): string | null {
  const kind = shapeFileKind(file.name);
  const format = kind === null ? undefined : FORMAT_OF_KIND[kind];
  if (format === undefined || !images.includes(format))
    return `${file.name} can’t be added: paste a ${formatsInWords(images)} picture`;
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
  images: readonly ImageFormat[],
): { readonly pictures: readonly File[]; readonly refused: readonly string[] } {
  const pictures = [...held];
  const refused: string[] = [];
  for (const file of added.map(nameImage)) {
    const reason = refusal(file, pictures, images);
    if (reason === null) pictures.push(file);
    else refused.push(reason);
  }
  return { pictures, refused };
}
