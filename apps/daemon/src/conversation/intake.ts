import { rmSync } from 'node:fs';
import { InvalidError } from '@10db/contracts';
import type { StoredPicture } from '@10db/db';
import { checkPicture, keepPicture, type KeptPicture } from './pictures';

// Workbench spec §4.3, §11, §12; sessions spec §6.1. The builder-message intake every conversation
// shares: what a message may carry, and the order its parts are kept in: every picture on disk first,
// then the rows in one write, and the pictures that write never named removed if it fails.

const MIB = 1024 * 1024;

/** A file as the builder pasted it: the name and bytes the request carried. */
export interface PastedFile {
  readonly name: string;
  readonly bytes: Uint8Array;
}

/** What one builder message may carry. */
export interface MessageLimits {
  readonly maxChars: number;
  readonly maxPictures: number;
  readonly maxPicturesBytes: number;
}

/**
 * Validates the message, keeps its pictures under `filesDir`, then runs `write` with its trimmed text
 * and the kept pictures; removes what it wrote if `write` throws. Throws InvalidError, naming what is
 * refused, before anything is kept.
 */
export function keepBuilderMessage<M>(
  input: { readonly text: string; readonly pictures: readonly PastedFile[] },
  opts: {
    readonly limits: MessageLimits;
    readonly filesDir: string;
    readonly write: (body: string, files: readonly StoredPicture[]) => M;
  },
): M {
  const { limits } = opts;
  const body = input.text.trim();
  if (body === '' && input.pictures.length === 0)
    throw new InvalidError('A message needs words or a picture');
  if (body.length > limits.maxChars)
    throw new InvalidError(`A message is at most ${String(limits.maxChars)} characters`);
  if (input.pictures.length > limits.maxPictures)
    throw new InvalidError(`A message carries at most ${String(limits.maxPictures)} pictures`);
  if (input.pictures.reduce((sum, p) => sum + p.bytes.length, 0) > limits.maxPicturesBytes)
    throw new InvalidError(
      `A message's pictures are at most ${String(limits.maxPicturesBytes / MIB)} MB together`,
    );
  const pictures = input.pictures.map(checkPicture);
  const kept: KeptPicture[] = [];
  try {
    const files: StoredPicture[] = [];
    for (const picture of pictures) {
      const at = keepPicture(opts.filesDir, picture);
      kept.push(at);
      files.push({
        name: picture.name,
        mediaType: picture.mediaType,
        size: picture.bytes.length,
        sha256: at.sha256,
        storedPath: at.storedPath,
      });
    }
    return opts.write(body, files);
  } catch (error) {
    // No row names what this call wrote; a picture kept before stays.
    removeKeptFiles(kept.filter((p) => p.written).map((p) => p.storedPath));
    throw error;
  }
}

/** Removes the files a message took back no longer needs. */
export function removeKeptFiles(paths: readonly string[]): void {
  for (const path of paths) rmSync(path, { force: true });
}
