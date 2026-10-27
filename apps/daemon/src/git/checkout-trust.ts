import { statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { isTrustedKey, type ConfigEntry } from './config-trust';
import { insideAny } from './lane-writable';
import type { RefusedKey } from './trust-error';

/** Scopes whose files sit in the checkout's git dir, where a lane could have written them. */
const CHECKOUT_SCOPES: ReadonlySet<string> = new Set(['local', 'worktree']);

/**
 * Which directories a checkout's git uses, by identity: device and inode, so a `.git` moved aside
 * and replaced at the same path reads as a different checkout.
 */
export function checkoutIdentity(dirs: { gitDir: string; commonDir: string }): string {
  const id = (path: string): string => {
    const st = statSync(path);
    return `${String(st.dev)}:${String(st.ino)}`;
  };
  return `${id(dirs.gitDir)}/${id(dirs.commonDir)}`;
}

/** The file a `--show-origin` field names, absolute; null for the command line and other sources. */
function originFile(origin: string, repo: string): string | null {
  if (!origin.startsWith('file:')) return null;
  const path = origin.slice('file:'.length);
  return isAbsolute(path) ? path : join(repo, path);
}

/**
 * True when a lane could have written `entry`: git read it at local or worktree scope, or from a
 * file in one of `roots` (a global config's include can point there), read as written or through a
 * link.
 */
function laneWritable(
  entry: ConfigEntry,
  repo: string,
  roots: readonly string[],
): { writable: boolean; file: string | null } {
  const file = originFile(entry.origin, repo);
  return {
    writable: CHECKOUT_SCOPES.has(entry.scope) || (file !== null && insideAny(file, roots)),
    file,
  };
}

/** Where a lane can write a config file: `laneRoots` (every checkout and lane temp root) and the git dirs. */
export interface ConfigRoots {
  readonly repo: string;
  readonly dirs: { readonly gitDir: string; readonly commonDir: string };
  readonly laneRoots: readonly string[];
}

function rootsOf({ dirs, laneRoots }: ConfigRoots): string[] {
  return [...laneRoots, dirs.gitDir, dirs.commonDir];
}

/** Keys from a lane-writable file that the daemon's fetch and push do not accept. */
export function refusedCheckoutKeys(
  where: ConfigRoots,
  entries: readonly ConfigEntry[],
): RefusedKey[] {
  const { repo } = where;
  const roots = rootsOf(where);
  const refused: RefusedKey[] = [];
  for (const entry of entries) {
    const { writable, file } = laneWritable(entry, repo, roots);
    if (writable && !isTrustedKey(entry.name))
      refused.push({ key: entry.name, file: file ?? entry.origin });
  }
  return refused;
}

/**
 * The values of `key` (lowercase, as git prints it) from the builder's own config only: system,
 * global and the command line, never a file a lane could have written. In git's order, last wins.
 */
export function trustedValues(
  where: ConfigRoots,
  entries: readonly ConfigEntry[],
  key: string,
): (string | null)[] {
  const { repo } = where;
  const roots = rootsOf(where);
  return entries
    .filter((entry) => entry.name === key && !laneWritable(entry, repo, roots).writable)
    .map((entry) => entry.value);
}
