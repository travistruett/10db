import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { ProjectId } from '@10db/contracts';

/** A file path that would write outside the folder a kept copy lives in. */
export class KeptCopyPathError extends Error {
  override readonly name = 'KeptCopyPathError';
}

/** The folder under the builder's home where 10db keeps a copy of a file before it removes it. */
const KEPT_FOLDER = ['.10db', 'kept'] as const;
const HASH_CHARS = 12;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

/** `YYYYMMDDTHHMMSSZ`, in UTC. */
const utcStamp = (now: Date): string =>
  now
    .toISOString()
    .replace(/\.\d+Z$/, 'Z')
    .replace(/[-:]/g, '');

/**
 * Writes `<home>/.10db/kept/<projectId>/<UTC stamp>-<sha12>/<rel>` (folders 0700, the file 0600) and returns its
 * path. `rel` is the file's path in its checkout, so a kept copy reads as where it was. A `rel` that is absolute
 * or climbs with `..` is refused: nothing is written outside the kept folder.
 */
export function keepCopy(
  home: string,
  projectId: ProjectId,
  rel: string,
  bytes: Uint8Array,
  now: Date,
): string {
  if (rel === '' || isAbsolute(rel) || rel.split(/[\\/]/).some((part) => part === '..'))
    throw new KeptCopyPathError(
      `Cannot keep a copy of ${JSON.stringify(rel)}: not a path inside a checkout`,
    );
  const sha = createHash('sha256').update(bytes).digest('hex').slice(0, HASH_CHARS);
  const file = join(home, ...KEPT_FOLDER, projectId, `${utcStamp(now)}-${sha}`, rel);
  mkdirSync(join(file, '..'), { recursive: true, mode: DIRECTORY_MODE });
  writeFileSync(file, bytes, { mode: FILE_MODE });
  return file;
}
