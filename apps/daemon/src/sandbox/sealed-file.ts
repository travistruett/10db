import { randomBytes } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { SandboxTempDirError } from './temp-dir';

/** What a sealed file is called: `<root>/<prefix><random hex><suffix>`, and what errors call it. */
export interface SealedFileKind {
  readonly prefix: string;
  readonly suffix: string;
  /** Names the file in an error, such as "the lane env file". */
  readonly what: string;
}

/**
 * Writes `content` to a new read-only file (mode 0400) beside the sandbox temp dirs and outside
 * every one of them, so no sandboxed command can write, replace or chmod it. Returns its path.
 */
export function createSealedFile(root: string, kind: SealedFileKind, content: string): string {
  const file = join(root, `${kind.prefix}${randomBytes(6).toString('hex')}${kind.suffix}`);
  try {
    // `wx` never follows a link or reuses a file someone else left at the name.
    writeFileSync(file, content, { flag: 'wx', mode: 0o400 });
  } catch {
    throw new SandboxTempDirError(`Could not create ${kind.what}`);
  }
  return file;
}

/** Removes a file made by `createSealedFile` with the same kind; refuses any other path. */
export function removeSealedFile(file: string, root: string, kind: SealedFileKind): void {
  const name = basename(file);
  if (dirname(file) !== root || !name.startsWith(kind.prefix) || !name.endsWith(kind.suffix)) {
    throw new SandboxTempDirError(`Not ${kind.what}`);
  }
  try {
    rmSync(file, { force: true });
  } catch {
    throw new SandboxTempDirError(`Could not remove ${kind.what}`);
  }
}
