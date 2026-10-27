import { join, resolve } from 'node:path';
import { foldPathCase } from '../guard';

/** True when two paths name the same place, comparing spellings the way the file system does. */
export function pathsEqual(a: string, b: string): boolean {
  return foldPathCase(a) === foldPathCase(b);
}

/** True when `path` is `root` or lies under it, comparing spellings the way the file system does. */
export function isEqualOrUnder(path: string, root: string): boolean {
  const p = foldPathCase(path);
  const r = foldPathCase(root);
  return p === r || p.startsWith(r.endsWith('/') ? r : `${r}/`);
}

/** The protected reads that live under the home directory, whatever the data and config dirs are. */
export function homeProtectedReads(home: string): string[] {
  return [
    join(home, '.claude'),
    join(home, '.claude.json'),
    join(home, 'Library', 'Keychains'),
    // Denying the tool doesn't stop it running under srt (the gate); the denied Keychains dir is the
    // barrier, and this deny only refuses reading the binary where the engine honours it.
    '/usr/bin/security',
  ];
}

/**
 * Paths a lane's commands can never read: 10db's data, the builder's config dirs, Claude Code's
 * state and credentials, and the Keychain files, with the `security` tool's binary. Absolute (a
 * relative entry is resolved) and deduplicated.
 */
export function protectedReads(input: {
  home: string;
  dataDir: string;
  configDirs: readonly string[];
}): string[] {
  const all = [input.dataDir, ...input.configDirs, ...homeProtectedReads(input.home)].map((path) =>
    resolve(path),
  );
  return [...new Set(all)];
}
