import { execFile, execFileSync } from 'node:child_process';
import { lstatSync, opendirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  isLaneTempDirName,
  isSystemTempDirName,
  removeLaneTempDir,
  removeLaneTempDirAsync,
} from './temp-dir';

/**
 * What 10db seals: the lane env file, a gate's settings, and an MCP server's settings, env file,
 * refusal preload and refusal log.
 */
const SEALED_FILE = /^10db-(?:env|gate|mcp)-[0-9a-f]{12}\.(?:json|sh|cjs|log)$/;
/** What `createProcessLedger` makes, and the next content a ledger is given beside it. */
const LEDGER_FILE = /^10db-proc-[1-9][0-9]*-[0-9a-f]{12}\.json(?:\.[0-9a-f]{12}\.tmp)?$/;
/** A session's setup dir (`createSetupDir`), in the files root. */
const SETUP_DIR = /^10db-setup-[0-9a-f]{12}$/;
/** A running daemon's mark in a sandbox root, named by its pid. */
const DAEMON_MARK = /^10db-daemon-([1-9][0-9]*)$/;
/** A 10db daemon's entry on its command line: a bundle's `daemon.mjs`, or `src/main.ts` from source. */
const DAEMON_ENTRY = /(?:^|[\s/])(?:daemon\.mjs|src\/main\.ts)(?:\s|$)/;

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

/** Each name in `root`, read a few at a time; none past a listing that fails. */
function* namesIn(root: string): Generator<string> {
  let dir;
  try {
    dir = opendirSync(root);
  } catch {
    return;
  }
  try {
    for (let entry = dir.readSync(); entry !== null; entry = dir.readSync()) yield entry.name;
  } catch {
    // A listing that fails part way ends there.
  } finally {
    dir.closeSync();
  }
}

/** `namesIn` off the event loop. */
async function* namesInAsync(root: string): AsyncGenerator<string> {
  let dir;
  try {
    dir = await opendir(root);
  } catch {
    return;
  }
  try {
    for await (const entry of dir) yield entry.name;
  } catch {
    // A listing that fails part way ends there.
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

/** Where a sweep looks: a sandbox root it claims, or a system temp dir it only sweeps. */
type SweptRoot = 'sandbox' | 'system';

/**
 * The kind a stale entry called `name` has in a root of `where`, by 10db's exact names there alone;
 * null for any other name. A system temp dir holds no ledger but one a lane wrote, so only its sweep
 * removes them; a sandbox root's are left for the reap that stops what they name.
 */
function staleKind(name: string, where: SweptRoot): 'dir' | 'setup' | 'file' | null {
  switch (where) {
    case 'sandbox':
      if (isLaneTempDirName(name)) return 'dir';
      if (SETUP_DIR.test(name)) return 'setup';
      return SEALED_FILE.test(name) ? 'file' : null;
    case 'system':
      if (isSystemTempDirName(name)) return 'dir';
      return SEALED_FILE.test(name) || LEDGER_FILE.test(name) ? 'file' : null;
  }
}

/**
 * The live daemon whose mark is in `root`, if one `counts`; marks of daemons that are not running,
 * and one naming this daemon's own pid (a dead one's, reused), are removed. Only this user's plain
 * files with the mark's exact name are read, and no other name is looked at.
 */
function markedBy(
  marks: Iterable<string>,
  root: string,
  uid: number,
  counts: (pid: number) => boolean,
  stopped: () => boolean = () => false,
): number | null {
  let sharedWith: number | null = null;
  for (const name of marks) {
    if (stopped()) break;
    const marked = Number(DAEMON_MARK.exec(name)?.[1]);
    if (!Number.isInteger(marked) || ownedKind(join(root, name), uid) !== 'file') continue;
    if (marked !== process.pid && processAlive(marked)) {
      if (counts(marked)) sharedWith = marked;
    } else {
      rmSync(join(root, name), { force: true });
    }
  }
  return sharedWith;
}

/**
 * Takes a sandbox root for a starting daemon, before any session or gate starts: removes the temp
 * dirs and sealed files a crashed daemon left there, then marks the root as in use by `pid`. Every
 * such entry is stale, unless another live daemon (one with another data dir) has marked the root:
 * its sessions may be running, so nothing is removed. Only this user's entries with 10db's exact
 * names are touched, by their own kind: a link is never followed or removed. Its process ledgers
 * stay for `reapLaneProcessLedgers`, which stops what they name.
 */
export function claimSandboxTempRoot(root: string, pid: number = process.pid): TempRootClaim {
  const uid = process.getuid?.();
  let removed = 0;
  let failed = 0;
  let sharedWith: number | null = null;
  if (uid !== undefined) {
    sharedWith = markedBy(namesIn(root), root, uid, (marked) => marked !== pid);
    const stale =
      sharedWith === null
        ? [...namesIn(root)].flatMap((name) => {
            const kind = staleKind(name, 'sandbox');
            const path = join(root, name);
            const owned = ownedKind(path, uid);
            return kind !== null && (owned === kind || (kind === 'setup' && owned === 'dir'))
              ? [{ path, kind }]
              : [];
          })
        : [];
    for (const entry of stale) {
      try {
        if (entry.kind === 'dir') removeLaneTempDir(entry.path, root);
        // No lane writes a setup dir, and removing it never follows the links it holds.
        else if (entry.kind === 'setup') rmSync(entry.path, { recursive: true, force: true });
        else rmSync(entry.path, { force: true });
        removed += 1;
      } catch {
        failed += 1;
      }
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

/** The `ps` that names each process's command, with a fixed PATH. */
const PS = ['/bin/ps', ['-axo', 'pid=,command=']] as const;
/** As `process-table.ts` reads it: a busy machine's table would pass the default 1 MiB buffer. */
const PS_OPTIONS = {
  encoding: 'utf8',
  env: { PATH: '/usr/bin:/bin' },
  maxBuffer: 64 * 1024 * 1024,
} as const;
const execPs = promisify(execFile);

/** The pids whose command line runs a 10db daemon's entry, read from `ps`'s output. */
function daemonPidsIn(table: string): ReadonlySet<number> {
  const pids = new Set<number>();
  for (const line of table.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match?.[2] !== undefined && DAEMON_ENTRY.test(match[2])) pids.add(Number(match[1]));
  }
  return pids;
}

/**
 * Whether a live mark in a system temp dir counts: only while its pid runs a 10db daemon's entry.
 * Every ChatGPT lane can write there, so a mark naming any other running process (one a lane
 * planted) keeps nothing. When `ps` can't be read, every live mark counts.
 */
function daemonCheck(daemons: ReadonlySet<number> | null): (pid: number) => boolean {
  return (pid) => daemons === null || daemons.has(pid);
}

/**
 * Removes 10db's sealed files and process ledgers from the system temp dirs (`SYSTEM_TEMP_ROOTS`),
 * never reading one: every ChatGPT lane can read and write there, so a sealed file there would stay
 * readable to one, and a ledger there could be one a lane wrote. Run it at start, before any lane
 * session or gate: each is one unlink, and only this user's plain files with 10db's exact names are
 * looked at. A running 10db daemon's mark keeps its dir (`daemonCheck`). Marks nothing.
 */
export function sweepSystemTempFiles(roots: readonly string[]): SweepReport {
  const uid = process.getuid?.();
  let removed = 0;
  let failed = 0;
  let sharedWith: number | null = null;
  if (uid === undefined) return { removed, failed, sharedWith };
  let daemons: ReadonlySet<number> | null | undefined;
  const counts = (pid: number): boolean => {
    if (daemons === undefined) {
      try {
        daemons = daemonPidsIn(execFileSync(...PS, PS_OPTIONS));
      } catch {
        daemons = null;
      }
    }
    return daemonCheck(daemons)(pid);
  };
  for (const root of roots) {
    const marked = markedBy(namesIn(root), root, uid, counts);
    sharedWith ??= marked;
    if (marked !== null) continue;
    for (const name of namesIn(root)) {
      if (staleKind(name, 'system') !== 'file') continue;
      const path = join(root, name);
      if (ownedKind(path, uid) !== 'file') continue;
      try {
        unlinkSync(path);
        removed += 1;
      } catch {
        failed += 1;
      }
    }
  }
  return { removed, failed, sharedWith };
}

/**
 * Removes 10db's lane temp dirs from the system temp dirs, by the claim's rules, off the event loop:
 * the listing is read a few names at a time, a name is tested before its entry is looked at, the
 * tools that remove a dir run as child processes, and `signal` (the daemon's stop) ends the sweep
 * between entries. A running 10db daemon's mark keeps its dir (`daemonCheck`). Marks nothing.
 */
export async function sweepSystemTempDirs(
  roots: readonly string[],
  signal: AbortSignal,
): Promise<SweepReport> {
  const uid = process.getuid?.();
  let removed = 0;
  let failed = 0;
  let sharedWith: number | null = null;
  if (uid === undefined) return { removed, failed, sharedWith };
  // Read again after every await: the daemon's stop can come at any of them.
  const stopped = (): boolean => signal.aborted;
  let daemons: ReadonlySet<number> | null | undefined;
  for (const root of roots) {
    if (stopped()) break;
    const marks: string[] = [];
    for await (const name of namesInAsync(root)) {
      if (stopped()) break;
      if (DAEMON_MARK.test(name)) marks.push(name);
    }
    if (stopped()) break;
    if (marks.length > 0 && daemons === undefined) {
      daemons = await execPs(...PS, PS_OPTIONS).then(
        ({ stdout }) => daemonPidsIn(stdout),
        () => null,
      );
    }
    const marked = markedBy(marks, root, uid, daemonCheck(daemons ?? null), stopped);
    sharedWith ??= marked;
    if (stopped()) break;
    if (marked !== null) continue;
    for await (const name of namesInAsync(root)) {
      if (stopped()) break;
      if (staleKind(name, 'system') !== 'dir') continue;
      const path = join(root, name);
      if (ownedKind(path, uid) !== 'dir') continue;
      try {
        await removeLaneTempDirAsync(path, root);
        removed += 1;
      } catch {
        failed += 1;
      }
    }
  }
  return { removed, failed, sharedWith };
}
