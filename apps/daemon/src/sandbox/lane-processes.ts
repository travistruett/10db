import { randomBytes } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import type { CwdReader, ProcessRow, ProcessTable } from './process-table';
import { isEqualOrUnder } from './protected-reads';
import { SandboxTempDirError } from './temp-dir';

/**
 * Stops what a lane's commands start when its session ends, however it ends, and after a daemon
 * that died without stopping them.
 *
 * Claude Code runs a lane's commands as its own children, and a command can leave processes
 * running (`(while :; do :; done) &`). When the session ends, those lose their parent and go to
 * launchd, so a walk down from the session's pid finds nothing. So the watch samples the tree while
 * the session runs and remembers every process it saw, by pid and start time. It also remembers
 * their process groups: a group outlives its leader, so a process forked after the last sample into
 * a group the watch knows is found too. A command that returns at once (`pnpm dev > log 2>&1 &`)
 * hands its job to launchd before any sample sees its shell, so a child of launchd started since the
 * session began whose working directory is in the session's checkout or temp dir is the session's
 * too: its working directory is read (`lsof -d cwd`) once. The memory is a ledger file in the temp
 * root, which neither a lane's commands nor its file tools may write, so a daemon that restarts finds
 * and stops what the last one left. The process environment is never read, and nothing is signalled
 * unless its pid and start time still match.
 */

/** What the watch remembers about one process. */
export interface ProcessMember {
  readonly pid: number;
  /** `ps`'s start time: a recycled pid has another one, and is left alone. */
  readonly startedAt: string;
  /** The process group when last seen; 0 when not yet known. */
  readonly pgid: number;
}

type Signaller = (target: number, signal: NodeJS.Signals) => boolean;

export interface LaneProcessDeps {
  /** A fresh reading of the machine's processes. */
  readonly table: ProcessTable;
  /** The reading the periodic samples use; may be shared among sessions. Defaults to `table`. */
  readonly sampleTable?: ProcessTable;
  /** Sends a signal; negative targets are process groups. False when nothing was there to signal. */
  readonly signal?: Signaller;
  readonly sleep?: (ms: number) => Promise<void>;
  /** The daemon's own pid, which is never signalled, nor is its process group. */
  readonly ownPid?: number;
  /** How long a process gets to exit after SIGTERM before SIGKILL. */
  readonly graceMs?: number;
  readonly pollMs?: number;
}

export interface LaneProcessWatchDeps extends LaneProcessDeps {
  /** Where the watch writes what it has seen; null keeps it in memory only. */
  readonly ledger: string | null;
  /** Reads processes' working directories; without it, launchd's children are never named. */
  readonly cwds?: CwdReader;
  /**
   * The session's checkout and temp dir, each spelled as `lsof` reports it (links resolved): a
   * child of launchd started since the session began that works in one is the session's.
   */
  readonly places?: readonly string[];
  /** How often the tree is sampled while the session runs. */
  readonly intervalMs?: number;
  readonly timers?: {
    setTimeout(fn: () => void, ms: number): { cancel(): void };
  };
  readonly onError?: (error: unknown) => void;
}

/** How a session's processes are read, sampled and signalled: the watch's deps without its ledger. */
export type LaneProcessSetup = Omit<LaneProcessWatchDeps, 'ledger' | 'onError' | 'places'>;

export interface LaneProcessWatch {
  /** Starts watching under the session's own process, sampling now and then on an interval. */
  track(root: { readonly pid: number; readonly startedAt: string }): Promise<void>;
  /**
   * Stops sampling and stops every process the session started that still runs. Rejects when the
   * machine's processes cannot be read, having stopped nothing it could not identify.
   */
  end(): Promise<void>;
  /** True while it remembers processes it has not stopped: tracked, and not ended successfully. */
  pending(): boolean;
}

const DEFAULT_INTERVAL_MS = 1_000;
const DEFAULT_GRACE_MS = 1_500;
const DEFAULT_POLL_MS = 100;
/** How many times the tree is read and signalled again: a stopped process can have forked just before. */
const MAX_ROUNDS = 4;

function defaultSignal(target: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(target, signal);
    return true;
  } catch {
    return false;
  }
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const defaultTimers: NonNullable<LaneProcessWatchDeps['timers']> = {
  setTimeout(fn, ms) {
    const handle = setTimeout(fn, ms);
    handle.unref();
    return {
      cancel: () => {
        clearTimeout(handle);
      },
    };
  },
};

/** Which processes may never be signalled: launchd, the daemon and the group it leads or is in. */
function protection(rows: readonly ProcessRow[], ownPid: number) {
  const own = rows.find((r) => r.pid === ownPid);
  return {
    pid: (pid: number): boolean => pid <= 1 || pid === ownPid,
    group: (pgid: number): boolean => pgid <= 1 || pgid === ownPid || pgid === own?.pgid,
  };
}

/**
 * The processes in `rows` that belong to the session: the known ones that still run (same pid and
 * start time), everything below them, and everything in the groups they are in.
 */
function findMembers(
  rows: readonly ProcessRow[],
  known: readonly ProcessMember[],
  ownPid: number,
): ProcessMember[] {
  const guard = protection(rows, ownPid);
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const children = new Map<number, ProcessRow[]>();
  const groups = new Map<number, ProcessRow[]>();
  for (const row of rows) {
    children.set(row.ppid, [...(children.get(row.ppid) ?? []), row]);
    groups.set(row.pgid, [...(groups.get(row.pgid) ?? []), row]);
  }
  const found = new Map<number, ProcessRow>();
  const queue: ProcessRow[] = [];
  const take = (row: ProcessRow): void => {
    if (guard.pid(row.pid) || found.has(row.pid)) return;
    found.set(row.pid, row);
    queue.push(row);
  };
  for (const member of known) {
    const row = byPid.get(member.pid);
    if (row?.startedAt === member.startedAt) take(row);
  }
  const seenGroups = new Set<number>();
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const child of children.get(next.pid) ?? []) take(child);
    if (!guard.group(next.pgid) && !seenGroups.has(next.pgid)) {
      seenGroups.add(next.pgid);
      for (const mate of groups.get(next.pgid) ?? []) take(mate);
    }
  }
  return [...found.values()].map((r) => ({ pid: r.pid, startedAt: r.startedAt, pgid: r.pgid }));
}

/** Signals the group of each member (never a protected one) and each member, SIGTERM or SIGKILL. */
function signalAll(
  members: readonly ProcessMember[],
  signal: NodeJS.Signals,
  send: Signaller,
  rows: readonly ProcessRow[],
  ownPid: number,
): void {
  const guard = protection(rows, ownPid);
  for (const pgid of new Set(members.map((m) => m.pgid))) {
    if (!guard.group(pgid)) send(-pgid, signal);
  }
  for (const member of members) {
    if (!guard.pid(member.pid)) send(member.pid, signal);
  }
}

/**
 * Stops every process in `known` that still runs, and what it started, SIGTERM first and SIGKILL to
 * what is left after the grace. Returns how many distinct processes it signalled. Throws when the
 * process table cannot be read.
 */
async function terminateMembers(
  known: readonly ProcessMember[],
  deps: LaneProcessDeps,
): Promise<number> {
  const send = deps.signal ?? defaultSignal;
  const sleep = deps.sleep ?? defaultSleep;
  const ownPid = deps.ownPid ?? process.pid;
  const grace = deps.graceMs ?? DEFAULT_GRACE_MS;
  const poll = deps.pollMs ?? DEFAULT_POLL_MS;
  const stopped = new Set<number>();
  let remembered = [...known];
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const rows = await deps.table();
    const alive = findMembers(rows, remembered, ownPid);
    if (alive.length === 0) break;
    remembered = alive;
    for (const member of alive) stopped.add(member.pid);
    signalAll(alive, 'SIGTERM', send, rows, ownPid);
    let waited = 0;
    let left = alive;
    while (waited < grace) {
      await sleep(poll);
      waited += poll;
      left = findMembers(await deps.table(), alive, ownPid);
      if (left.length === 0) break;
    }
    if (left.length > 0) {
      const latest = await deps.table();
      for (const member of left) stopped.add(member.pid);
      signalAll(left, 'SIGKILL', send, latest, ownPid);
      remembered = left;
    }
  }
  return stopped.size;
}

/** Watches one lane session's processes; see the module comment. */
export function createLaneProcessWatch(deps: LaneProcessWatchDeps): LaneProcessWatch {
  const timers = deps.timers ?? defaultTimers;
  const interval = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  const ownPid = deps.ownPid ?? process.pid;
  const sampleTable = deps.sampleTable ?? deps.table;
  let known: ProcessMember[] = [];
  let saved = '';
  /** Whether the session is being watched; `end` clears it while a sample may be in flight. */
  const watching = { on: false };
  const isWatching = (): boolean => watching.on;
  let timer: { cancel(): void } | null = null;

  function persist(): void {
    if (deps.ledger === null) return;
    const text = JSON.stringify({ version: 1, members: known });
    if (text === saved) return;
    try {
      writeFileSync(deps.ledger, text, { mode: 0o600 });
      saved = text;
    } catch (error) {
      deps.onError?.(error);
    }
  }

  const places = deps.places ?? [];
  /** The session's own process's start, in ms; NaN when unknown, and then the time doesn't narrow. */
  let since = Number.NaN;
  /** Children of launchd whose working dir was read and found not to be the session's. */
  let judged = new Set<string>();
  const rowKey = (row: ProcessRow): string => `${String(row.pid)}@${row.startedAt}`;

  /**
   * Children of launchd that started since the session began, with their working dir in its
   * checkout or temp dir: jobs a command left when it returned before any sample saw its shell.
   * Each is read once; one found not to be the session's is not read again.
   */
  async function orphansIn(
    rows: readonly ProcessRow[],
    members: readonly ProcessMember[],
  ): Promise<ProcessMember[]> {
    if (deps.cwds === undefined || places.length === 0) return [];
    const guard = protection(rows, ownPid);
    const mine = new Set(members.map((m) => m.pid));
    const present = new Set(rows.map(rowKey));
    // Forget what is gone, so the set stays the size of the machine.
    judged = new Set([...judged].filter((key) => present.has(key)));
    const candidates = rows.filter((row) => {
      if (row.ppid !== 1 || guard.pid(row.pid) || mine.has(row.pid)) return false;
      if (judged.has(rowKey(row))) return false;
      const started = Date.parse(row.startedAt);
      return Number.isNaN(since) || Number.isNaN(started) || started >= since;
    });
    if (candidates.length === 0) return [];
    const dirs = await deps.cwds(candidates.map((row) => row.pid));
    const found: ProcessMember[] = [];
    for (const row of candidates) {
      const dir = dirs.get(row.pid);
      if (dir !== undefined && places.some((place) => isEqualOrUnder(dir, place))) {
        found.push({ pid: row.pid, startedAt: row.startedAt, pgid: row.pgid });
      } else {
        judged.add(rowKey(row));
      }
    }
    return found;
  }

  /** Who the session's processes are in `rows`: the known ones and theirs, and launchd's orphans. */
  async function membersIn(rows: readonly ProcessRow[]): Promise<ProcessMember[]> {
    const members = findMembers(rows, known, ownPid);
    const orphans = await orphansIn(rows, members);
    return orphans.length === 0 ? members : findMembers(rows, [...members, ...orphans], ownPid);
  }

  async function sample(table: ProcessTable): Promise<void> {
    try {
      const rows = await table();
      if (!watching.on) return;
      // What is gone is forgotten; what is new is remembered.
      const members = await membersIn(rows);
      // `end` may have run while the working dirs were read.
      if (!isWatching()) return;
      known = members;
      persist();
    } catch (error) {
      deps.onError?.(error);
    }
  }

  /** Arms the next sample, unless the session is no longer watched. */
  function schedule(): void {
    if (!watching.on) return;
    timer?.cancel();
    timer = timers.setTimeout(() => {
      if (!watching.on) return;
      void sample(sampleTable).then(() => {
        schedule();
      });
    }, interval);
  }

  return {
    async track(root) {
      watching.on = true;
      since = Date.parse(root.startedAt);
      known = [{ pid: root.pid, startedAt: root.startedAt, pgid: 0 }];
      // A fresh reading: a shared one may predate the session's process, and would forget it.
      await sample(deps.table);
      schedule();
    },
    async end() {
      watching.on = false;
      timer?.cancel();
      timer = null;
      if (known.length === 0) return;
      // What a command left since the last sample. A table that can't be read is told of below.
      try {
        const rows = await deps.table();
        const orphans = await orphansIn(rows, findMembers(rows, known, ownPid));
        if (orphans.length > 0) {
          known = [...known, ...orphans];
          persist();
        }
      } catch (error) {
        deps.onError?.(error);
      }
      await terminateMembers(known, deps);
      known = [];
      persist();
    },
    pending: () => known.length > 0,
  };
}

/** What a ledger file is called: `10db-proc-<12 hex>.json` in the sandbox temp root. */
const LEDGER_PREFIX = '10db-proc-';
const LEDGER_SUFFIX = '.json';
const LEDGER_NAME = /^10db-proc-[0-9a-f]{12}\.json$/;

const Ledger = z.object({
  version: z.literal(1),
  members: z.array(
    z.object({
      pid: z.number().int().min(2),
      startedAt: z.string().min(1),
      pgid: z.number().int().min(0),
    }),
  ),
});

/** Creates an empty ledger beside the lane temp dirs, outside every one of them, and returns its path. */
export function createProcessLedger(root: string): string {
  const file = join(root, `${LEDGER_PREFIX}${randomBytes(6).toString('hex')}${LEDGER_SUFFIX}`);
  try {
    // `wx` never follows a link or reuses a file someone else left at the name.
    writeFileSync(file, JSON.stringify({ version: 1, members: [] }), { flag: 'wx', mode: 0o600 });
  } catch {
    throw new SandboxTempDirError('Could not create the lane process ledger');
  }
  return file;
}

/** Removes a ledger made by `createProcessLedger`; refuses any other path. */
export function removeProcessLedger(file: string, root: string): void {
  if (dirname(file) !== root || !LEDGER_NAME.test(basename(file))) {
    throw new SandboxTempDirError('Not a lane process ledger');
  }
  try {
    rmSync(file, { force: true });
  } catch {
    throw new SandboxTempDirError('Could not remove the lane process ledger');
  }
}

export interface ReapReport {
  /** Ledgers found, readable or not. */
  readonly ledgers: number;
  /** Processes signalled. */
  readonly stopped: number;
}

function readLedger(file: string): ProcessMember[] | null {
  try {
    const parsed = Ledger.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    return parsed.success ? parsed.data.members : null;
  } catch {
    return null;
  }
}

/**
 * Stops what lane sessions left running when their daemon died, from the ledgers in the temp root,
 * and removes each ledger once its processes are gone. Run it once at start, before any session,
 * and only when no other live daemon uses the root. Reads the process table only when a ledger
 * names a process. A ledger it could not act on (the table was unreadable) stays for the next start,
 * and the error is thrown after the other ledgers were handled.
 */
export async function reapLaneProcessLedgers(
  root: string,
  deps: LaneProcessDeps,
): Promise<ReapReport> {
  const uid = process.getuid?.();
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return { ledgers: 0, stopped: 0 };
  }
  let ledgers = 0;
  let stopped = 0;
  let failure: unknown = null;
  for (const name of names.filter((n) => LEDGER_NAME.test(n))) {
    const file = join(root, name);
    try {
      const stat = lstatSync(file);
      if (!stat.isFile() || (uid !== undefined && stat.uid !== uid)) continue;
    } catch {
      continue;
    }
    ledgers += 1;
    const members = readLedger(file);
    try {
      if (members !== null && members.length > 0) stopped += await terminateMembers(members, deps);
      rmSync(file, { force: true });
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== null) {
    throw failure instanceof Error
      ? failure
      : new Error('could not stop a lane session’s processes');
  }
  return { ledgers, stopped };
}
