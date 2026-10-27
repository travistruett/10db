import { accessSync, constants, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Where the daemon looks for git and gh, in order: Homebrew on Apple silicon, Homebrew on Intel, then
 * the system's. Never the login PATH, which can name a directory a lane writes, such as a checkout's
 * `node_modules/.bin`; no lane can write these.
 */
export const INSTALL_PREFIXES: readonly string[] = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
];

/** The prefixes as a sentence lists them, for messages that say where 10db looked. */
export const INSTALL_PREFIXES_TEXT = `${INSTALL_PREFIXES.slice(0, -1).join(', ')} and ${INSTALL_PREFIXES.slice(-1).join('')}`;

/** True when `path` is an executable file, through a link or not. */
export function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * The first of `candidates` that is an executable file, by the path it was found at, never its link's
 * target: Homebrew's prefix entry is a link into a versioned directory an upgrade deletes. Null when
 * none is.
 */
export function firstExecutable(candidates: readonly string[]): string | null {
  return candidates.find(executable) ?? null;
}

/** Each install prefix's `name`, in order. */
export function installCandidates(name: string): string[] {
  return INSTALL_PREFIXES.map((dir) => join(dir, name));
}
