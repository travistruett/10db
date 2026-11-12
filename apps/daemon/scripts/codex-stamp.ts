import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** The file in the generated folder that records the release it came from and a hash of the rest. */
export const STAMP_FILE = 'STAMP';

/** Where `generate:codex` writes Codex's generated protocol types, schemas and fixtures. */
export const GENERATED_DIR = join(import.meta.dirname, '../src/sessions/codex-generated');

const REGENERATE = 'pnpm --filter @10db/daemon generate:codex';

export class StampError extends Error {
  override readonly name = 'StampError';
}

export interface Stamp {
  readonly version: string;
  readonly sha256: string;
}

/** sha256 hex over the files sorted by path, each as its path, a NUL byte, its bytes and a NUL byte. */
export function hashTree(files: ReadonlyMap<string, Buffer>): string {
  const hash = createHash('sha256');
  const nul = Buffer.from([0]);
  for (const path of [...files.keys()].sort()) {
    hash.update(path);
    hash.update(nul);
    hash.update(files.get(path) ?? Buffer.alloc(0));
    hash.update(nul);
  }
  return hash.digest('hex');
}

export function formatStamp(stamp: Stamp): string {
  return `version=${stamp.version}\nsha256=${stamp.sha256}\n`;
}

const STAMP_TEXT = /^version=([0-9A-Za-z.+-]+)\nsha256=([0-9a-f]{64})\n$/;

export function parseStamp(text: string): Stamp {
  const match = STAMP_TEXT.exec(text);
  const version = match?.[1];
  const sha256 = match?.[2];
  if (version === undefined || sha256 === undefined)
    throw new StampError('STAMP is not a version line and a sha256 line');
  return { version, sha256 };
}

/** Every file under `dir` except its STAMP, keyed by its POSIX path relative to `dir`. */
export function readTree(dir: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/');
    if (path === STAMP_FILE) continue;
    files.set(path, readFileSync(join(dir, path)));
  }
  return files;
}

/**
 * Null when `dir`'s STAMP names `pinned` and hashes what the folder holds; otherwise one line saying
 * what differs and naming the command that regenerates the folder.
 */
export function stampProblem(dir: string, pinned: string): string | null {
  const stampPath = join(dir, STAMP_FILE);
  if (!existsSync(stampPath))
    return `${dir} has no ${STAMP_FILE}: run \`${REGENERATE}\` on a Mac and commit the folder.`;
  let stamp: Stamp;
  try {
    stamp = parseStamp(readFileSync(stampPath, 'utf8'));
  } catch (error) {
    if (!(error instanceof StampError)) throw error;
    return `${stampPath} cannot be read (${error.message}): run \`${REGENERATE}\` on a Mac and commit the folder.`;
  }
  if (stamp.version !== pinned)
    return `${dir} was generated from Codex ${stamp.version} but the pin is ${pinned}: run \`${REGENERATE}\` on a Mac and commit the folder.`;
  if (stamp.sha256 !== hashTree(readTree(dir)))
    return `${dir} differs from what its ${STAMP_FILE} records (a file was edited, added or removed by hand): run \`${REGENERATE}\` on a Mac and commit the folder.`;
  return null;
}
