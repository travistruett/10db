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
