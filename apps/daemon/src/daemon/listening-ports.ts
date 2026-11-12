import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Listener } from '../folders';

/** Reads the TCP ports processes of this Mac listen on, each with its process's working directory. */
export type ListenerReader = (signal?: AbortSignal) => Promise<readonly Listener[]>;

const run = promisify(execFile);
const LSOF = '/usr/sbin/lsof';
/** How long one lsof call may take before it is stopped. */
const LSOF_MS = 3_000;

interface Listening {
  readonly pid: number;
  readonly command: string;
  readonly host: string;
  readonly port: number;
}

/** `lsof -F` records: a `p<pid>` line opens a process, then its fields, `c` and `n` among them. */
function records(output: string): { pid: number; command: string; names: string[] }[] {
  const found: { pid: number; command: string; names: string[] }[] = [];
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) {
      const pid = Number(line.slice(1));
      if (Number.isInteger(pid) && pid > 0) found.push({ pid, command: '', names: [] });
      continue;
    }
    const current = found.at(-1);
    if (current === undefined) continue;
    if (line.startsWith('c')) current.command = line.slice(1);
    else if (line.startsWith('n')) current.names.push(line.slice(1));
  }
  return found;
}

/**
 * The listeners in `lsof -nP -iTCP -sTCP:LISTEN -Fpcn` output, each given the working directory
 * `lsof -a -d cwd -Fn` printed for its process (`cwds`), or null when none was. Pure.
 */
export function listenersFrom(listening: string, cwds: string): Listener[] {
  const dirs = new Map(records(cwds).map((r) => [r.pid, r.names[0] ?? null]));
  const found: Listening[] = [];
  for (const r of records(listening)) {
    for (const name of r.names) {
      const colon = name.lastIndexOf(':');
      const port = Number(name.slice(colon + 1));
      if (colon <= 0 || !Number.isInteger(port) || port <= 0 || port > 65535) continue;
      found.push({ pid: r.pid, command: r.command, host: name.slice(0, colon), port });
    }
  }
  return found.map((l) => ({
    port: l.port,
    host: l.host,
    cwd: dirs.get(l.pid) ?? null,
    command: l.command,
  }));
}

/**
 * What a failed `lsof` printed when it ran to an exit status (1 when some of what it was asked for was
 * not there): its output then still counts. Null when it did not run, was stopped, or `error` is not
 * a child process's failure.
 */
export function outputOfExit(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const code: unknown = Reflect.get(error, 'code');
  const stdout: unknown = Reflect.get(error, 'stdout');
  return typeof code === 'number' && typeof stdout === 'string' ? stdout : null;
}

async function lsof(args: readonly string[], signal: AbortSignal | undefined): Promise<string> {
  try {
    const { stdout } = await run(LSOF, [...args], {
      env: { LC_ALL: 'C' },
      maxBuffer: 16 * 1024 * 1024,
      timeout: LSOF_MS,
      ...(signal === undefined ? {} : { signal }),
    });
    return stdout;
  } catch (error) {
    const output = outputOfExit(error);
    if (output === null) throw error;
    return output;
  }
}

/**
 * Every TCP listener of this Mac, read with `lsof` (read-only, the daemon's own user): one call for
 * the listening sockets, one for their processes' working directories, each stopped after a few seconds
 * or when `signal` is aborted. Throws when lsof cannot run or is stopped.
 */
export const systemListeners: ListenerReader = async (signal) => {
  const listening = await lsof(['-w', '-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn'], signal);
  const pids = [...new Set(records(listening).map((r) => r.pid))];
  if (pids.length === 0) return [];
  const cwds = await lsof(['-w', '-a', '-d', 'cwd', '-p', pids.join(','), '-Fn'], signal);
  return listenersFrom(listening, cwds);
};
