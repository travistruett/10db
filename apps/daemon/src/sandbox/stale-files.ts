import { lstatSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { removeLaneTempDir, removeLaneTempDirAsync } from './temp-dir';

/** What `createLaneTempDir` makes: `mkdtemp`'s six characters after the prefix. */
const TEMP_DIR = /^10db-[A-Za-z0-9]{6}$/;
/** What `createSealedFile` makes for the lane env file, a gate's settings and an MCP server's. */
const SEALED_FILE = /^10db-(?:env|gate|mcp)-[0-9a-f]{12}\.(?:json|sh)$/;
/** What `createProcessLedger` makes, and the next content a ledger is given beside it. */
const LEDGER_FILE = /^10db-proc-[1-9][0-9]*-[0-9a-f]{12}\.json(?:\.[0-9a-f]{12}\.tmp)?$/;
/** A running daemon's mark in a sandbox root, named by its pid. */
const DAEMON_MARK = /^10db-daemon-([1-9][0-9]*)$/;

/** What a sweep did. */
export interface SweepReport {
  /** Stale entries removed. */
  readonly removed: number;
  /** Stale ones that could not be removed. */
  readonly failed: number;
  /** A live daemon whose mark kept the sweep from running, or null. */
  readonly sharedWith: number | null;
}

export interface TempRootClaim extends SweepReport {
  /** Removes this daemon's mark. Run it once every session and gate has ended. */
  release(): void;
}

/** The name of the mark a running daemon keeps in a sandbox root. */
export const daemonMarkName = (pid: number): string => `10db-daemon-${String(pid)}`;

/** Whether `pid` names a running process, this user's or another's. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

function listing(root: string): string[] {
  try {
    return readdirSync(root);
  } catch {
    return [];
  }
}

/** The entry's kind when this user owns it, never following a link; null otherwise. */
function ownedKind(path: string, uid: number): 'dir' | 'file' | 'other' | null {
  try {
    const stat = lstatSync(path);
    if (stat.uid !== uid) return null;
    if (stat.isDirectory()) return 'dir';
    return stat.isFile() ? 'file' : 'other';
  } catch {
    return null;
  }
}

/** A stale entry of 10db's in a root, by its own kind. */
interface StaleEntry {
  readonly path: string;
  readonly kind: 'dir' | 'file';
}

/**
 * The temp dirs and sealed files a crashed daemon left in `root`, its process ledgers too when
 * `ledgers` is set; the marks of daemons that are not running are removed. Every such entry is stale,
 * unless another live daemon (one with another data dir) has marked the root: its sessions may be
 * running, so nothing is named. Only this user's entries with 10db's exact names are named, by their
 * own kind: a link never is.
 */
function staleIn(
  root: string,
  pid: number,
  ledgers: boolean,
): { readonly stale: StaleEntry[]; readonly sharedWith: number | null } {
  const uid = process.getuid?.();
  const names = listing(root);
  let sharedWith: number | null = null;
  for (const name of names) {
    const marked = Number(DAEMON_MARK.exec(name)?.[1]);
    if (!Number.isInteger(marked) || uid === undefined) continue;
    if (ownedKind(join(root, name), uid) !== 'file') continue;
    if (marked !== pid && processAlive(marked)) sharedWith = marked;
    else rmSync(join(root, name), { force: true });
  }
  if (sharedWith !== null || uid === undefined) return { stale: [], sharedWith };
  const stale = names.flatMap((name): StaleEntry[] => {
    const path = join(root, name);
    const kind = ownedKind(path, uid);
    if (kind === 'dir' && TEMP_DIR.test(name)) return [{ path, kind }];
    const file = SEALED_FILE.test(name) || (ledgers && LEDGER_FILE.test(name));
    return kind === 'file' && file ? [{ path, kind }] : [];
  });
  return { stale, sharedWith };
}

/**
 * Takes a sandbox root for a starting daemon, before any session or gate starts: removes the temp
 * dirs and sealed files a crashed daemon left there (see `staleIn`), then marks the root as in use by
 * `pid`. Its process ledgers stay for `reapLaneProcessLedgers`, which stops what they name.
 */
export function claimSandboxTempRoot(root: string, pid: number = process.pid): TempRootClaim {
  const { stale, sharedWith } = staleIn(root, pid, false);
  let removed = 0;
  let failed = 0;
  for (const entry of stale) {
    try {
      if (entry.kind === 'dir') removeLaneTempDir(entry.path, root);
      else rmSync(entry.path, { force: true });
      removed += 1;
    } catch {
      failed += 1;
    }
  }
  const mark = join(root, daemonMarkName(pid));
  let marked = false;
  try {
    writeFileSync(mark, '', { flag: 'wx', mode: 0o400 });
    marked = true;
  } catch {
    // An unwritable root: the sessions will fail to make their temp dirs there and say why.
  }
  return {
    removed,
    failed,
    sharedWith,
    release() {
      if (marked) rmSync(mark, { force: true });
    },
  };
}

/** Claims each of `roots` (see `claimSandboxTempRoot`); `release` removes every mark. */
export function claimSandboxRoots(
  roots: readonly string[],
  pid: number = process.pid,
): TempRootClaim {
  const claims = roots.map((root) => claimSandboxTempRoot(root, pid));
  return {
    removed: claims.reduce((sum, claim) => sum + claim.removed, 0),
    failed: claims.reduce((sum, claim) => sum + claim.failed, 0),
    sharedWith: claims.find((claim) => claim.sharedWith !== null)?.sharedWith ?? null,
    release() {
      for (const claim of claims) claim.release();
    },
  };
}

/**
 * Removes 10db's entries from the system temp dirs (`SYSTEM_TEMP_ROOTS`) by the claim's rules, their
 * process ledgers too, never read, and marks nothing: every ChatGPT lane can read and write there, so
 * a sealed file there would stay readable to one, and a ledger there could be one a lane wrote. 10db
 * makes nothing there. The tools run as child processes the event loop doesn't wait on, so a lane
 * that leaves many entries there delays no start.
 */
export async function sweepSystemTempRoots(
  roots: readonly string[],
  pid: number = process.pid,
): Promise<SweepReport> {
  let removed = 0;
  let failed = 0;
  let sharedWith: number | null = null;
  for (const root of roots) {
    const found = staleIn(root, pid, true);
    sharedWith ??= found.sharedWith;
    for (const entry of found.stale) {
      try {
        if (entry.kind === 'dir') await removeLaneTempDirAsync(entry.path, root);
        else await rm(entry.path, { force: true });
        removed += 1;
      } catch {
        failed += 1;
      }
    }
  }
  return { removed, failed, sharedWith };
}
