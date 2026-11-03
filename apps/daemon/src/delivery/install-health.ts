import { existsSync, readFileSync, rmSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import { parse } from 'yaml';

/** The lockfile that says a project's packages are pnpm's. */
export const PNPM_LOCKFILE = 'pnpm-lock.yaml';

/** What a copy's installed packages look like against its pnpm lockfile. */
export type InstallHealth =
  /** The project has no pnpm lockfile: there is nothing to check. */
  | { readonly kind: 'not_pnpm' }
  /** Every dependency the lockfile names for each workspace package resolves from that package. */
  | { readonly kind: 'whole' }
  | {
      readonly kind: 'broken';
      /** `<workspace package>: <dependency>` for each that does not resolve; capped at `MAX_NAMED`. */
      readonly missing: readonly string[];
      /** How many dependencies the lockfile names in all. */
      readonly total: number;
      /** How many of them do not resolve. */
      readonly unresolved: number;
    };

/** How many unresolved dependencies a report names before it counts the rest. */
const MAX_NAMED = 10;

/** Not `optionalDependencies`: pnpm leaves out the ones this platform cannot use, and the lockfile still names them. */
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies'] as const;

/** A path inside the copy, relative, with no `..` that leaves it. */
function insideCopy(importer: string): boolean {
  if (isAbsolute(importer)) return false;
  const clean = normalize(importer);
  return clean !== '..' && !clean.startsWith('../');
}

function brokenLockfile(): InstallHealth {
  return { kind: 'broken', missing: ['pnpm-lock.yaml (unreadable)'], total: 0, unresolved: 1 };
}

/**
 * Whether the copy's packages are installed: for every workspace package the lockfile names, each
 * direct dependency must resolve from that package's `node_modules` (`existsSync` follows the link,
 * so one that points into a pruned `.pnpm` fails). This is what the gate's tools need to start: the
 * run of 2026-11-03 left `.pnpm` with a fifth of its packages and `tsx` could not be found. It reads
 * the lockfile and the file system only; no program from the repository runs. An importer path
 * that leaves the copy is not looked at, since a lockfile is something a lane can write.
 */
export function checkInstall(path: string): InstallHealth {
  const lockfile = join(path, PNPM_LOCKFILE);
  if (!existsSync(lockfile)) return { kind: 'not_pnpm' };
  let importers: Record<string, unknown>;
  try {
    const parsed: unknown = parse(readFileSync(lockfile, 'utf8'));
    const found =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as { importers?: unknown }).importers
        : undefined;
    // A single-package project's lockfile keeps its dependencies at the top, with no importers.
    importers =
      typeof found === 'object' && found !== null
        ? (found as Record<string, unknown>)
        : { '.': parsed };
  } catch {
    return brokenLockfile();
  }
  let total = 0;
  const missing: string[] = [];
  for (const [importer, entry] of Object.entries(importers)) {
    if (!insideCopy(importer) || typeof entry !== 'object' || entry === null) continue;
    for (const field of DEPENDENCY_FIELDS) {
      const names = (entry as Record<string, unknown>)[field];
      if (typeof names !== 'object' || names === null) continue;
      for (const name of Object.keys(names)) {
        total += 1;
        if (!existsSync(join(path, importer, 'node_modules', name)))
          missing.push(`${importer}: ${name}`);
      }
    }
  }
  if (missing.length === 0) return { kind: 'whole' };
  return {
    kind: 'broken',
    missing: missing.slice(0, MAX_NAMED),
    total,
    unresolved: missing.length,
  };
}

/** Says what a broken install is in a sentence, for a note or a card. */
export function describeBroken(
  health: Extract<InstallHealth, { readonly kind: 'broken' }>,
): string {
  const more = health.unresolved - health.missing.length;
  const named = health.missing.join(', ') + (more > 0 ? ` and ${String(more)} more` : '');
  return `${String(health.unresolved)} of ${String(health.total)} dependencies the lockfile names do not resolve in the copy's node_modules (${named})`;
}

/**
 * Removes the copy's root `node_modules`, so the install that follows starts as the first one of a
 * copy did, which worked. A link is removed, never followed. The workspace packages' own
 * `node_modules` hold only links into the root one, which the install makes again.
 */
export function removeBrokenInstall(path: string): void {
  rmSync(join(path, 'node_modules'), { recursive: true, force: true });
}
