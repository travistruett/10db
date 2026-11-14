import { resolve } from 'node:path';
import { equalOrUnder } from '../git';
import { realPathOf } from '../guard';

// The places a Plan's record is never read from or written to: 10db's own roots, and what a lane can
// write. Each is read both as named and as the kernel opens it, so a link to one is the same place.

/** A place, and what to call it in a refusal. */
export interface ForbiddenPlace {
  readonly path: string;
  readonly what: string;
}

/** 10db's data dir, its worktree root and the sandbox's roots, named for a refusal. */
export function daemonRoots(roots: {
  readonly dataDir: string;
  readonly worktreeRoot: string;
  readonly sandboxRoots: readonly string[];
}): ForbiddenPlace[] {
  return [
    { path: roots.dataDir, what: "10db's data dir" },
    { path: roots.worktreeRoot, what: "10db's worktree root" },
    ...roots.sandboxRoots.map((path) => ({ path, what: 'a sandbox root' })),
  ];
}

function readingsOf(path: string): string[] {
  const named = resolve(path);
  try {
    return [named, realPathOf(path)];
  } catch {
    return [named];
  }
}

/** The first place any of `paths` lies at or under, or null. */
export function forbiddenPlaceOf(
  paths: readonly string[],
  places: readonly ForbiddenPlace[],
): ForbiddenPlace | null {
  for (const place of places)
    for (const reading of readingsOf(place.path))
      if (paths.some((p) => equalOrUnder(p, reading))) return place;
  return null;
}
