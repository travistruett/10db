import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/** One running process, as `ps` lists it. */
export interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  /** The process group; a group outlives its leader, so an orphan keeps the group it was started in. */
  readonly pgid: number;
  /** `ps`'s start time, the same text `recovery/processes.ts` stores beside a pid. */
  readonly startedAt: string;
}

/** Reads every process of this machine. */
export type ProcessTable = () => Promise<readonly ProcessRow[]>;

const run = promisify(execFile);

const ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S.*?)\s*$/;

/** Parses `ps -axo pid=,ppid=,pgid=,lstart=`; a line that does not fit is left out. */
export function parseProcessTable(output: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of output.split('\n')) {
    const match = ROW.exec(line);
    if (match === null) continue;
    const [, pid, ppid, pgid, startedAt] = match;
    if (pid === undefined || ppid === undefined || pgid === undefined || startedAt === undefined) {
      continue;
    }
    rows.push({ pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), startedAt });
  }
  return rows;
}

/** The system's process table. Throws when `ps` cannot run, so a caller never mistakes that for an empty machine. */
export const systemProcessTable: ProcessTable = async () => {
  const { stdout } = await run('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,lstart='], {
    env: { LC_ALL: 'C' },
    maxBuffer: 64 * 1024 * 1024,
  });
  return parseProcessTable(stdout);
};

/**
 * Reads the paths each pid has open: its working directory, its program and every file it holds
 * (its stdout among them). A pid it cannot read (gone, another user's) is left out.
 */
export type OpenPathReader = (pids: readonly number[]) => Promise<ReadonlyMap<number, string[]>>;

/** Parses `lsof -Fn` output: a `p<pid>` line, then an `n<path>` line for each file it has open. */
export function parseOpenPaths(output: string): Map<number, string[]> {
  const paths = new Map<number, string[]>();
  let pid: number | null = null;
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) {
      const value = Number(line.slice(1));
      pid = Number.isInteger(value) && value > 0 ? value : null;
    } else if (line.startsWith('n/') && pid !== null) {
      const list = paths.get(pid);
      if (list === undefined) paths.set(pid, [line.slice(1)]);
      else list.push(line.slice(1));
    }
  }
  return paths;
}

/** Open paths by `lsof`. Throws when `lsof` cannot run; a pid it could not list is left out. */
export const systemOpenPaths: OpenPathReader = async (pids) => {
  if (pids.length === 0) return new Map();
  const args = ['-w', '-n', '-P', '-Fn', '-p', pids.join(',')];
  try {
    const { stdout } = await run('/usr/sbin/lsof', args, {
      env: { LC_ALL: 'C' },
      maxBuffer: 16 * 1024 * 1024,
    });
    return parseOpenPaths(stdout);
  } catch (error) {
    // lsof exits 1 when a pid is gone or can't be listed; what it did list still counts. A failure
    // to run it at all (no exit code) is thrown.
    const failed = error as { code?: unknown; stdout?: unknown };
    if (typeof failed.code === 'number' && typeof failed.stdout === 'string') {
      return parseOpenPaths(failed.stdout);
    }
    throw error;
  }
};

/**
 * Shares one reading among callers within `ttlMs`, so many lane sessions sampling together cost one
 * `ps`. A reading in flight is joined, never repeated.
 */
export function cachedProcessTable(
  table: ProcessTable,
  ttlMs: number,
  now: () => number = Date.now,
): ProcessTable {
  let cached: { readonly at: number; readonly rows: Promise<readonly ProcessRow[]> } | null = null;
  return () => {
    if (cached !== null && now() - cached.at < ttlMs) return cached.rows;
    const rows = table();
    const entry = { at: now(), rows };
    cached = entry;
    // A failed reading is not kept: the next caller tries again.
    rows.catch(() => {
      if (cached === entry) cached = null;
    });
    return rows;
  };
}
