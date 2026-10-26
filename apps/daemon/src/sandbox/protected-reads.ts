import { isAbsolute, join, resolve } from 'node:path';

/** True when `path` is `root` or lies under it. */
export function isEqualOrUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`);
}

/** The protected reads that live under the home directory, whatever the data and config dirs are. */
export function homeProtectedReads(home: string): string[] {
  return [
    join(home, '.claude'),
    join(home, '.claude.json'),
    join(home, 'Library', 'Keychains'),
    '/usr/bin/security',
  ];
}

/**
 * Paths a lane's commands can never read: 10db's data, the builder's config dirs, Claude Code's
 * state and credentials, the Keychain and the `security` tool. Absolute and deduplicated.
 */
export function protectedReads(input: {
  home: string;
  dataDir: string;
  configDirs: readonly string[];
}): string[] {
  const all = [input.dataDir, ...input.configDirs, ...homeProtectedReads(input.home)]
    .filter((path) => isAbsolute(path))
    .map((path) => resolve(path));
  return [...new Set(all)];
}
