import { lstatSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { removeLaneTempDir } from './temp-dir';

/** What `createLaneTempDir` makes: `mkdtemp`'s six characters after the prefix. */
const TEMP_DIR = /^10db-[A-Za-z0-9]{6}$/;
/** What `createSealedFile` makes for the lane env file, a gate's settings and an MCP server's. */
const SEALED_FILE = /^10db-(?:env|gate|mcp)-[0-9a-f]{12}\.(?:json|sh)$/;
/** What `createProcessLedger` makes, and the next content a ledger is given beside it. */
const LEDGER_FILE = /^10db-proc-[1-9][0-9]*-[0-9a-f]{12}\.json(?:\.[0-9a-f]{12}\.tmp)?$/;
/** A running daemon's mark in a sandbox root, named by its pid. */
const DAEMON_MARK = /^10db-daemon-([1-9][0-9]*)$/;

/** What a sweep of one root did. */
interface Sweep {
  /** Stale entries removed. */
  readonly removed: number;
  /** Stale ones that could not be removed. */
  readonly failed: number;
  /** A live daemon whose mark kept the sweep from running, or null. */
  readonly sharedWith: number | null;
}

export interface TempRootClaim extends Sweep {
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

/**
 * Removes the temp dirs and sealed files a crashed daemon left in `root`, and its process ledgers
 * too when `ledgers` is set, and the marks of daemons that no longer run. It runs before any session
 * or gate starts, so every such entry is stale, unless another live daemon (one with another data
 * dir) has marked the root: its sessions may be running, so nothing is removed. Only this user's
 * entries with 10db's exact names are touched, by their own kind: a link is never followed or removed.
 */
function sweepRoot(root: string, pid: number, ledgers: boolean): Sweep {
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
  let removed = 0;
  let failed = 0;
  if (sharedWith === null && uid !== undefined) {
    for (const name of names) {
      const path = join(root, name);
      const kind = ownedKind(path, uid);
      const stale =
        (kind === 'dir' && TEMP_DIR.test(name)) ||
        (kind === 'file' && (SEALED_FILE.test(name) || (ledgers && LEDGER_FILE.test(name))));
      if (!stale) continue;
      try {
        if (kind === 'dir') removeLaneTempDir(path, root);
        else rmSync(path, { force: true });
        removed += 1;
      } catch {
        failed += 1;
      }
    }
  }
  return { removed, failed, sharedWith };
}

/**
 * Takes a sandbox root for a starting daemon: sweeps the temp dirs and sealed files a crashed daemon
 * left there (see `sweepRoot`), then marks the root as in use by `pid`. Its process ledgers stay for
 * `reapLaneProcessLedgers`, which stops what they name.
 */
export function claimSandboxTempRoot(root: string, pid: number = process.pid): TempRootClaim {
  const { removed, failed, sharedWith } = sweepRoot(root, pid, false);
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

/**
 * Claims each of `roots` (`claimSandboxTempRoot`), then sweeps `previous`, where an earlier 10db kept
 * every sandbox file (`SYSTEM_TEMP_ROOT`), by the same rules, its process ledgers included: Codex's
 * base policy lets every ChatGPT lane read and write there, so a sealed file left there would stay
 * readable to one, and a ledger there could be one a lane wrote, so it is removed and never read.
 * `previous` is not marked: nothing is made there any more.
 */
export function claimSandboxRoots(
  roots: readonly string[],
  previous: string,
  pid: number = process.pid,
): TempRootClaim {
  const claims = roots.map((root) => claimSandboxTempRoot(root, pid));
  const sweeps: Sweep[] = [...claims, sweepRoot(previous, pid, true)];
  return {
    removed: sweeps.reduce((sum, sweep) => sum + sweep.removed, 0),
    failed: sweeps.reduce((sum, sweep) => sum + sweep.failed, 0),
    sharedWith: sweeps.find((sweep) => sweep.sharedWith !== null)?.sharedWith ?? null,
    release() {
      for (const claim of claims) claim.release();
    },
  };
}
