import { isAbsolute, resolve } from 'node:path';
import { isEqualOrUnder } from './protected-reads';
import { realOrSelf } from './real-or-self';

/** What kind of ground a lane-writable root is, as a refusal names it. */
export const LaneWritableKind = {
  Project: "a project's folder",
  Worktrees: 'the worktree folder',
  Temp: 'a temp folder',
} as const;
export type LaneWritableKind = (typeof LaneWritableKind)[keyof typeof LaneWritableKind];

/** One root a lane can write, as written or as its real path. */
export interface LaneWritableRoot {
  readonly path: string;
  readonly kind: LaneWritableKind;
}

/** The system temp dirs as programs name them, beside their real paths. */
const TEMP_ALIASES = ['/tmp', '/var/tmp'] as const;

/**
 * Every root a lane can write, each beside its real path: every checkout, the whole worktree base (so a
 * worktree made after a session starts is under it), every lane temp root, and the system temp dirs. The
 * one list for what must never run outside the sandbox.
 */
export function laneWritableRoots(roots: {
  readonly checkouts: readonly string[];
  readonly worktreeBase: string;
  readonly sandboxTempRoots: readonly string[];
  readonly systemTempRoots: readonly string[];
}): LaneWritableRoot[] {
  const listed: LaneWritableRoot[] = [
    ...roots.checkouts.map((path) => ({ path, kind: LaneWritableKind.Project })),
    { path: roots.worktreeBase, kind: LaneWritableKind.Worktrees },
    ...[...roots.sandboxTempRoots, ...roots.systemTempRoots, ...TEMP_ALIASES].map((path) => ({
      path,
      kind: LaneWritableKind.Temp,
    })),
  ];
  const seen = new Set<string>();
  const all: LaneWritableRoot[] = [];
  for (const root of listed) {
    for (const path of [root.path, realOrSelf(root.path)]) {
      if (seen.has(path)) continue;
      seen.add(path);
      all.push({ path, kind: root.kind });
    }
  }
  return all;
}

/**
 * The kind of lane-writable root `path` lies in, or null. It is judged as written (relative to `base`)
 * and as its real path, the nearest existing ancestor resolved, so a path that doesn't exist yet is
 * judged by where it would be.
 */
export function underLaneWritable(
  path: string,
  roots: readonly LaneWritableRoot[],
  base: string,
): LaneWritableKind | null {
  const written = isAbsolute(path) ? resolve(path) : resolve(base, path);
  const real = realOrSelf(written);
  const root = roots.find((r) => isEqualOrUnder(written, r.path) || isEqualOrUnder(real, r.path));
  return root?.kind ?? null;
}
