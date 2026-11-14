import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A session's folder for the secrets a person allowed it to Read, in the files root: the kernel
 * closes the files root to lane commands, the file-access judge refuses it to the file tools, and no
 * deny rule of Claude Code's names it, so only the Read 10db points at a copy opens it.
 */
export function createSecretReadsDir(filesRoot: string): string {
  const dir = join(filesRoot, `10db-read-${randomBytes(6).toString('hex')}`);
  mkdirSync(dir, { mode: 0o700 });
  return dir;
}

/** Writes one allowed Read's text as a new file of its own in `dir`, and returns its path. */
export function writeSecretRead(dir: string, text: string): string {
  const path = join(dir, randomBytes(6).toString('hex'));
  // `wx`: a new file, never one already there or a link in its place.
  writeFileSync(path, text, { flag: 'wx', mode: 0o600 });
  return path;
}

export function removeSecretReadsDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}
