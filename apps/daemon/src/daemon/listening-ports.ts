import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Listener } from '../folders';

/** Reads the TCP ports processes of this Mac listen on, each with its process's working directory. */
export type ListenerReader = () => Promise<readonly Listener[]>;

const run = promisify(execFile);
const LSOF = '/usr/sbin/lsof';

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

/** `lsof`'s output; exit status 1 with output means some of what it was asked for was not there. */
async function lsof(args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await run(LSOF, [...args], {
      env: { LC_ALL: 'C' },
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    // A failure to run lsof at all (no exit code) is thrown; an exit status with output is read.
    const failed = error as { code?: unknown; stdout?: unknown };
    if (typeof failed.code === 'number' && typeof failed.stdout === 'string') return failed.stdout;
    throw error;
  }
}

/**
 * Every TCP listener of this Mac, read with `lsof` (read-only, the daemon's own user): one call for
 * the listening sockets, one for their processes' working directories. Throws when lsof cannot run.
 */
export const systemListeners: ListenerReader = async () => {
  const listening = await lsof(['-w', '-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn']);
  const pids = [...new Set(records(listening).map((r) => r.pid))];
  if (pids.length === 0) return [];
  const cwds = await lsof(['-w', '-a', '-d', 'cwd', '-p', pids.join(','), '-Fn']);
  return listenersFrom(listening, cwds);
};
