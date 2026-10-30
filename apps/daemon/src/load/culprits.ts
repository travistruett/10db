import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Culprit, Owner } from './guard';

const run = promisify(execFile);

/** One line of `ps`. */
export interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  /** 100 is one core. */
  readonly cpu: number;
  readonly command: string;
}

/** The machine's processes, and the files a few of them have open. */
export interface ProcessSnapshot {
  rows(): Promise<readonly ProcessRow[]>;
  /** The paths each process has open, its working directory included. */
  files(pids: readonly number[]): Promise<ReadonlyMap<number, readonly string[]>>;
}

/** What 10db knows about its own processes now. */
export interface KnownProcesses {
  readonly daemonPid: number;
  /** Where lane temp dirs are made; null when lanes aren't sandboxed. */
  readonly tempRoot: string | null;
  /** The process of each lane session that is running. */
  readonly sessions: readonly { pid: number; workstreamId: string; label: string }[];
  /** The leader of each running gate's process group. */
  readonly gates: readonly { pid: number; label: string }[];
  /** The temp dir of each lane session that is running. */
  readonly tempDirs: readonly { dir: string; workstreamId: string; label: string }[];
  /** The worktree of each batch a lane works in. */
  readonly worktrees: readonly { path: string; workstreamId: string; label: string }[];
}

export interface FindOptions {
  /** How many to list. */
  readonly top?: number;
  /** Processes using less than this percentage of one core are left out. */
  readonly minCpu?: number;
}

const DEFAULT_TOP = 5;
const DEFAULT_MIN_CPU = 20;
const MAX_COMMAND = 120;
const TEMP_PREFIX = '10db-';

const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+(?:\.\d+)?)\s+(.+?)\s*$/;

/** Reads `ps -Ao pid=,ppid=,pgid=,pcpu=,command=`; a line it can't read is left out. */
export function parsePs(output: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of output.split('\n')) {
    const match = PS_LINE.exec(line);
    if (!match) continue;
    const [, pid, ppid, pgid, cpu, command] = match;
    if (pid === undefined || ppid === undefined || pgid === undefined) continue;
    rows.push({
      pid: Number(pid),
      ppid: Number(ppid),
      pgid: Number(pgid),
      cpu: Number(cpu),
      command: command ?? '',
    });
  }
  return rows;
}

/** Reads `lsof -Fn`: a `p<pid>` line, then an `n<path>` line for each open file. */
export function parseLsof(output: string): Map<number, string[]> {
  const files = new Map<number, string[]>();
  let current: string[] | null = null;
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) {
      current = [];
      files.set(Number(line.slice(1)), current);
    } else if (line.startsWith('n') && current !== null) {
      current.push(line.slice(1));
    }
  }
  return files;
}

/** `ps` and `lsof`, run for the same user and nothing else; both are read-only. */
export function systemProcessSnapshot(): ProcessSnapshot {
  const env = { LC_ALL: 'C', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
  const maxBuffer = 32 * 1024 * 1024;
  return {
    async rows() {
      const { stdout } = await run('/bin/ps', ['-Ao', 'pid=,ppid=,pgid=,pcpu=,command='], {
        env,
        maxBuffer,
      });
      return parsePs(stdout);
    },
    async files(pids) {
      if (pids.length === 0) return new Map();
      try {
        const { stdout } = await run('/usr/sbin/lsof', ['-p', pids.join(','), '-Fn'], {
          env,
          maxBuffer,
        });
        return parseLsof(stdout);
      } catch (error) {
        // lsof exits 1 when a listed process ended before it looked, and still prints the others.
        const stdout = (error as { stdout?: unknown }).stdout;
        if (typeof stdout === 'string' && stdout.length > 0) return parseLsof(stdout);
        throw error;
      }
    },
  };
}

function isUnder(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}/`);
}

function shortened(command: string): string {
  return command.length <= MAX_COMMAND ? command : `${command.slice(0, MAX_COMMAND - 1)}…`;
}

/** The lane temp dir a path is in, whether or not a lane owns it now; null for any other path. */
function laneTempDirOf(path: string, tempRoot: string): string | null {
  if (!isUnder(path, tempRoot) || path === tempRoot) return null;
  const first = path.slice(tempRoot.length + 1).split('/')[0];
  return first?.startsWith(TEMP_PREFIX) ? `${tempRoot}/${first}` : null;
}

function ownerOf(
  proc: ProcessRow,
  byPid: ReadonlyMap<number, ProcessRow>,
  known: KnownProcesses,
  files: readonly string[],
): Owner {
  const gates = new Map(known.gates.map((g) => [g.pid, g]));
  const sessions = new Map(known.sessions.map((s) => [s.pid, s]));
  // A gate's children keep its process group after the leader exits, and a tool's children keep their
  // session as an ancestor, so each is walked up; a loop in the table ends the walk.
  const chain: ProcessRow[] = [];
  const seen = new Set<number>();
  for (let at: ProcessRow | undefined = proc; at && !seen.has(at.pid); at = byPid.get(at.ppid)) {
    seen.add(at.pid);
    chain.push(at);
  }
  for (const p of chain) {
    const gate = gates.get(p.pid) ?? gates.get(p.pgid);
    if (gate) return { kind: 'gate', label: gate.label };
  }
  for (const p of chain) {
    const session = sessions.get(p.pid);
    if (session) return { kind: 'lane', workstreamId: session.workstreamId, label: session.label };
  }
  for (const path of files) {
    const own = known.tempDirs.find((t) => isUnder(path, t.dir));
    if (own) return { kind: 'lane', workstreamId: own.workstreamId, label: own.label };
    const tree = known.worktrees.find((w) => isUnder(path, w.path));
    if (tree) return { kind: 'lane', workstreamId: tree.workstreamId, label: tree.label };
  }
  if (chain.some((p) => p.pid === known.daemonPid)) return { kind: 'daemon' };
  if (
    known.tempRoot !== null &&
    files.some((path) => laneTempDirOf(path, known.tempRoot ?? '') !== null)
  )
    return { kind: 'ended-lane' };
  return { kind: 'other' };
}

/**
 * The processes using the most CPU, each with what it belongs to. Open files are read only for the
 * few listed, and a failure to read them just leaves those processes unattributed by file.
 */
export async function findCulprits(
  source: ProcessSnapshot,
  known: () => KnownProcesses,
  options: FindOptions = {},
): Promise<Culprit[]> {
  const rows = await source.rows();
  const top = [...rows]
    .filter((r) => r.cpu >= (options.minCpu ?? DEFAULT_MIN_CPU))
    .sort((a, b) => b.cpu - a.cpu)
    .slice(0, options.top ?? DEFAULT_TOP);
  if (top.length === 0) return [];
  const files = await source.files(top.map((r) => r.pid)).catch(() => new Map<number, string[]>());
  const byPid = new Map(rows.map((r) => [r.pid, r] as const));
  const facts = known();
  return top.map((proc) => ({
    pid: proc.pid,
    cpu: proc.cpu,
    command: shortened(proc.command),
    owner: ownerOf(proc, byPid, facts, files.get(proc.pid) ?? []),
  }));
}
