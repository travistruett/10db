import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  createLaneProcessWatch,
  createProcessLedger,
  LaneProcessFailure,
  removeProcessLedger,
  type LaneProcessSetup,
  type LedgerSweep,
  type ProcessRow,
} from '../sandbox';

const run = promisify(execFile);

/** Reads each pid's executable path, as it was run. A pid it cannot read is left out. */
export type CommandReader = (pids: readonly number[]) => Promise<ReadonlyMap<number, string>>;

/** `ps -o pid=,comm=`: with `comm` last, macOS prints the whole path the process was started from. */
export const systemCommands: CommandReader = async (pids) => {
  if (pids.length === 0) return new Map();
  let stdout: string;
  try {
    ({ stdout } = await run('/bin/ps', ['-ww', '-o', 'pid=,comm=', '-p', pids.join(',')], {
      env: { LC_ALL: 'C' },
      maxBuffer: 4 * 1024 * 1024,
    }));
  } catch (error) {
    // ps exits 1 when a pid is gone; what it did list still counts.
    if (error instanceof Error && 'stdout' in error && typeof error.stdout === 'string') {
      stdout = error.stdout;
    } else throw error;
  }
  const commands = new Map<number, string>();
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s(.+)$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      commands.set(Number(match[1]), match[2].trim());
    }
  }
  return commands;
};

/** The browser's own process in a reading of the machine: the daemon's child running `exe`. */
export function browserRoot(
  rows: readonly ProcessRow[],
  commands: ReadonlyMap<number, string>,
  exe: string,
  ownPid: number,
): ProcessRow | null {
  return rows.find((row) => row.ppid === ownPid && commands.get(row.pid) === exe) ?? null;
}

/** The browser's process could not be found, so it is not kept running. */
export class BrowserLedgerError extends Error {
  override readonly name = 'BrowserLedgerError';
}

export interface BrowserLedgerDeps {
  /** The files root the lane ledgers live in, which no lane command reads or writes. */
  readonly root: string;
  readonly sweep: LedgerSweep;
  readonly processes: LaneProcessSetup;
  readonly commands?: CommandReader;
  readonly onError?: (failure: LaneProcessFailure, error: unknown) => void;
}

/**
 * Remembers the running browser's processes in a ledger, as a lane session's are: the sweep spares it
 * while the browser runs, and a daemon that dies leaves it for the next start to reap.
 */
export interface BrowserLedger {
  /** Finds the browser started from `exe` and watches it and what it starts. */
  track(exe: string): Promise<void>;
  /** Stops whatever of the browser still runs and lets the ledger go. */
  end(): Promise<void>;
}

/** Creates the ledger file and holds it in the sweep at once, before the browser starts. */
export function openBrowserLedger(deps: BrowserLedgerDeps): BrowserLedger {
  const ownPid = deps.processes.ownPid ?? process.pid;
  const file = createProcessLedger(deps.root, ownPid);
  deps.sweep.hold(file);
  const watch = createLaneProcessWatch({
    ...deps.processes,
    ledger: file,
    ...(deps.onError === undefined ? {} : { onError: deps.onError }),
  });
  const commands = deps.commands ?? systemCommands;
  let ended = false;
  return {
    async track(exe) {
      const rows = await deps.processes.table();
      const children = rows.filter((row) => row.ppid === ownPid);
      const root = browserRoot(rows, await commands(children.map((row) => row.pid)), exe, ownPid);
      if (root === null) {
        throw new BrowserLedgerError(
          `no process of ${exe} was found among the daemon's children, so the browser was not kept running`,
        );
      }
      await watch.track({ pid: root.pid, startedAt: root.startedAt });
    },
    async end() {
      if (ended) return;
      ended = true;
      try {
        await watch.end();
      } catch (error) {
        deps.onError?.(LaneProcessFailure.Table, error);
      }
      // What could not be stopped stays named: the sweep tries again, and the next start if it never can.
      const kept = watch.pending();
      deps.sweep.release(file);
      if (kept) deps.sweep.later();
      else removeProcessLedger(file, deps.root);
    },
  };
}
