import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import type { Clock } from '../clock';
import { findDocker } from '../environment';
import { dockerEnvNames, type ProcessTable } from '../sandbox';
import {
  fixedPortRefusal,
  PORT_CACHE_MS,
  PORT_CHECKS_PER_MINUTE,
  portVerdict,
  type PortReadings,
  type PortSocket,
  type PortSession,
  type PortVerdict,
} from './lane-reach';
import type { LaneBrowserSession } from './session';

const run = promisify(execFile);
const READ_DEADLINE_MS = 5_000;
const LSOF = '/usr/sbin/lsof';
const NETSTAT = '/usr/sbin/netstat';

export interface PortReaders {
  /** `lsof -nP -a -iTCP:<port> -sTCP:LISTEN`, each listener's pid and address; rejects on failure. */
  listeners(port: number): Promise<readonly { readonly pid: number; readonly address: string }[]>;
  /** `netstat -anv -p tcp` for the port: every user's listeners, with family, address and pid; rejects on failure. */
  sockets(port: number): Promise<readonly PortSocket[]>;
  /** The process table, for each listener's chain and start times. */
  readonly table: ProcessTable;
  /** `docker ps` for the port's publications: compose working dir and host address; null when no docker is found. */
  readonly compose:
    | ((
        port: number,
      ) => Promise<readonly { readonly workingDir: string | null; readonly hostIp: string }[]>)
    | null;
}

/** Parses `lsof -F pn`: a `p` line starts a process, each `n` line is one of its sockets. */
function parseListeners(output: string): { pid: number; address: string }[] {
  const found: { pid: number; address: string }[] = [];
  let pid: number | null = null;
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid !== null && Number.isInteger(pid)) {
      const name = line.slice(1);
      const colon = name.lastIndexOf(':');
      if (colon > 0) found.push({ pid, address: name.slice(0, colon) });
    }
  }
  return found;
}

/**
 * Parses `netstat -anv -p tcp` for the listeners on `port`. A listening line of the port that does not
 * parse throws, so a view that may be incomplete is never taken for a whole one.
 */
function parseSockets(output: string, port: number): PortSocket[] {
  if (!output.includes('Proto')) throw new Error('netstat printed no table');
  const found: PortSocket[] = [];
  for (const line of output.split('\n')) {
    if (!line.includes('LISTEN')) continue;
    const cols = line.trim().split(/\s+/);
    const local = cols[3];
    if (local === undefined) throw new Error('netstat line without an address');
    const dot = local.lastIndexOf('.');
    if (local.slice(dot + 1) !== String(port)) continue;
    const family = cols[0];
    // The pid is the end of the `process:pid` column, whose name may hold spaces; an older netstat
    // printed the pid alone after the two window sizes.
    const named = /LISTEN\s+\d+\s+\d+\s+\d+\s+\d+\s+.*:(\d+)\s+\S+\s+\S+\s/.exec(line)?.[1];
    const pid = Number(named ?? cols[8]);
    if ((family !== 'tcp4' && family !== 'tcp6' && family !== 'tcp46') || !Number.isInteger(pid)) {
      throw new Error('netstat line not understood');
    }
    found.push({ family, address: local.slice(0, dot), pid });
  }
  return found;
}

/**
 * The sockets as `lsof` alone shows them, for a daemon whose process tree netstat's socket table does not
 * answer (see `TENDB_LANE_NETSTAT`): the same listeners without other users' sockets.
 */
function socketsFromListeners(
  listeners: readonly { readonly pid: number; readonly address: string }[],
): PortSocket[] {
  return listeners.map(({ pid, address }) => ({
    pid,
    address,
    family: address === '*' ? 'tcp46' : address.includes(':') ? 'tcp6' : 'tcp4',
  }));
}

/** The mappings of a `docker ps` `.Ports` column that publish exactly `port`: each one's host address. */
function publishedOn(ports: string, port: number): string[] {
  const ips: string[] = [];
  for (const mapping of ports.split(',')) {
    const match = /^\s*(.*):(\d+)->/.exec(mapping);
    if (match?.[2] !== String(port) || match[1] === undefined) continue;
    const ip = match[1];
    ips.push(ip.startsWith('[') && ip.endsWith(']') ? ip.slice(1, -1) : ip);
  }
  return ips;
}

async function realOrNull(path: string): Promise<string | null> {
  if (path === '') return null;
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

/** `execFile` readers for lsof and docker: an argument list, a 5 s deadline and a fixed env, never a shell. */
export function systemPortReaders(
  home: string,
  env: Readonly<Record<string, string | undefined>>,
  table: ProcessTable,
): PortReaders {
  const docker = findDocker(home);
  const dockerEnv: Record<string, string> = {};
  const defined = Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  for (const name of dockerEnvNames(defined)) {
    const value = defined[name];
    if (value !== undefined) dockerEnv[name] = value;
  }
  const readers: PortReaders = {
    async listeners(port) {
      try {
        const { stdout } = await run(
          LSOF,
          ['-nP', '-a', `-iTCP:${String(port)}`, '-sTCP:LISTEN', '-F', 'pn'],
          { env: { LC_ALL: 'C' }, timeout: READ_DEADLINE_MS, killSignal: 'SIGKILL' },
        );
        return parseListeners(stdout);
      } catch (error) {
        // lsof exits 1 when nothing matches, which is an empty list, not a failure.
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 1 &&
          'stdout' in error &&
          error.stdout === ''
        ) {
          return [];
        }
        throw error;
      }
    },
    async sockets(port) {
      if (defined['TENDB_LANE_NETSTAT'] === 'off')
        return socketsFromListeners(await readers.listeners(port));
      const { stdout } = await run(NETSTAT, ['-anv', '-p', 'tcp'], {
        env: { LC_ALL: 'C' },
        timeout: READ_DEADLINE_MS,
        killSignal: 'SIGKILL',
        maxBuffer: 64 * 1024 * 1024,
      });
      return parseSockets(stdout, port);
    },
    table,
    compose:
      docker === null
        ? null
        : async (port) => {
            const { stdout } = await run(
              docker,
              [
                'ps',
                '--filter',
                `publish=${String(port)}`,
                '--format',
                '{{.Label "com.docker.compose.project.working_dir"}}\t{{.Ports}}',
              ],
              {
                env: {
                  HOME: home,
                  PATH: `${dirname(docker)}:/usr/bin:/bin`,
                  ...dockerEnv,
                },
                timeout: READ_DEADLINE_MS,
                killSignal: 'SIGKILL',
              },
            );
            const entries: { workingDir: string | null; hostIp: string }[] = [];
            for (const line of stdout.split('\n')) {
              const tab = line.indexOf('\t');
              if (tab === -1) continue;
              const workingDir = await realOrNull(line.slice(0, tab).trim());
              for (const hostIp of publishedOn(line.slice(tab + 1), port)) {
                entries.push({ workingDir, hostIp });
              }
            }
            return entries;
          },
  };
  return readers;
}

export interface PortOwner {
  /**
   * The verdict for a connection now: cached `PORT_CACHE_MS`, read again after, at most
   * `PORT_CHECKS_PER_MINUTE` fresh reads a minute (past it, refused).
   */
  check(port: number): Promise<PortVerdict>;
}

const MINUTE_MS = 60_000;

export function createPortOwner(
  deps: {
    readonly clock: Clock;
    readonly readers: PortReaders;
    readonly daemonPort: () => number | null;
    readonly proxyPorts: () => ReadonlySet<number>;
    readonly browserPids: () => ReadonlySet<number>;
  },
  session: LaneBrowserSession,
): PortOwner {
  const cache = new Map<number, { verdict: PortVerdict; until: number }>();
  const inFlight = new Map<number, Promise<PortVerdict>>();
  let fresh: number[] = [];

  const read = async (port: number): Promise<PortVerdict> => {
    const portSession: PortSession = {
      members: new Set(session.members().map((m) => `${String(m.pid)}:${m.startedAt}`)),
      browserPids: deps.browserPids(),
      copy: session.copy,
      tempDir: session.tempDir,
      registeredCheckouts: session.registeredCheckouts,
      loopback: session.loopback,
    };
    const judge = (readings: PortReadings): PortVerdict =>
      portVerdict({
        port,
        daemonPort: deps.daemonPort(),
        proxyPorts: deps.proxyPorts(),
        session: portSession,
        readings,
      });

    let listeners: PortReadings['listeners'];
    try {
      const found = await deps.readers.listeners(port);
      const rows = new Map((await deps.readers.table()).map((row) => [row.pid, row]));
      listeners = found.map(({ pid, address }) => {
        const chain: { pid: number; startedAt: string }[] = [];
        const seen = new Set<number>();
        for (
          let at = rows.get(pid);
          at !== undefined && !seen.has(at.pid);
          at = rows.get(at.ppid)
        ) {
          seen.add(at.pid);
          chain.push({ pid: at.pid, startedAt: at.startedAt });
          if (at.pid === 1) break;
        }
        return { address, chain };
      });
    } catch {
      listeners = 'unread';
    }
    let sockets: PortReadings['sockets'];
    try {
      sockets = await deps.readers.sockets(port);
    } catch {
      sockets = 'unread';
    }
    const first = judge({ listeners, sockets, compose: null });
    const compose = deps.readers.compose;
    if (
      first.kind === 'owned' ||
      !session.docker ||
      compose === null ||
      listeners === 'unread' ||
      sockets === 'unread' ||
      listeners.length === 0
    ) {
      return first;
    }
    let publications: PortReadings['compose'];
    try {
      publications = await compose(port);
    } catch {
      publications = 'unanswered';
    }
    return judge({ listeners, sockets, compose: publications });
  };

  return {
    async check(port) {
      const fixed = fixedPortRefusal(port, deps.daemonPort(), deps.proxyPorts());
      if (fixed !== null) return { kind: 'refused', why: fixed };
      const now = deps.clock.now().getTime();
      const cached = cache.get(port);
      if (cached !== undefined && now < cached.until) return cached.verdict;
      const pending = inFlight.get(port);
      if (pending !== undefined) return pending;
      fresh = fresh.filter((at) => now - at < MINUTE_MS);
      if (fresh.length >= PORT_CHECKS_PER_MINUTE) {
        return {
          kind: 'refused',
          why: `this lane checked ${String(PORT_CHECKS_PER_MINUTE)} ports in a minute; wait before trying another`,
        };
      }
      fresh.push(now);
      const reading = read(port).then((verdict) => {
        cache.set(port, { verdict, until: now + PORT_CACHE_MS });
        return verdict;
      });
      inFlight.set(port, reading);
      try {
        return await reading;
      } finally {
        inFlight.delete(port);
      }
    },
  };
}
