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
  type PortSession,
  type PortVerdict,
} from './lane-reach';
import type { LaneBrowserSession } from './session';

const run = promisify(execFile);
const READ_DEADLINE_MS = 5_000;
const LSOF = '/usr/sbin/lsof';

export interface PortReaders {
  /** `lsof -nP -a -iTCP:<port> -sTCP:LISTEN`, each listener's pid and address; rejects on failure. */
  listeners(port: number): Promise<readonly { readonly pid: number; readonly address: string }[]>;
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
  return {
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
      const sockets = await deps.readers.listeners(port);
      const rows = new Map((await deps.readers.table()).map((row) => [row.pid, row]));
      listeners = sockets.map(({ pid, address }) => {
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
    const first = judge({ listeners, compose: null });
    const compose = deps.readers.compose;
    if (
      first.kind === 'owned' ||
      !session.docker ||
      compose === null ||
      listeners === 'unread' ||
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
    return judge({ listeners, compose: publications });
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
