import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { homeProtectedReads, isEqualOrUnder } from './protected-reads';

const FIXED_UNDER_HOME = [
  ['.local', 'share', 'mise'],
  ['.config', 'mise'],
  ['.local', 'state', 'mise'],
  ['.cache', 'mise'],
  ['Library', 'pnpm'],
  ['Library', 'Caches', 'pnpm'],
  ['Library', 'Preferences', 'pnpm'],
  ['.cargo'],
  ['.rustup'],
] as const;

/**
 * Where a lane's toolchain lives: the fixed version-manager and package-manager dirs, plus each
 * PATH entry under `home`. An entry is listed itself, never its parent, so `~/.docker/bin` does not
 * open `~/.docker`. Never `home` itself, a protected read or anything under one.
 */
export function toolchainReads(home: string, path: string): string[] {
  const protectedUnderHome = homeProtectedReads(home);
  const fromPath = path
    .split(delimiter)
    .filter((entry) => entry !== '' && isAbsolute(entry))
    .map((entry) => resolve(entry))
    .filter((entry) => entry !== home && isEqualOrUnder(entry, home));
  const all = [...FIXED_UNDER_HOME.map((parts) => join(home, ...parts)), ...fromPath];
  return [
    ...new Set(
      all.filter((entry) => !protectedUnderHome.some((root) => isEqualOrUnder(entry, root))),
    ),
  ];
}
