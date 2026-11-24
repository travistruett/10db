import { execFile } from 'node:child_process';
import { createConnection, type Socket } from 'node:net';
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
  PORT_REFUSAL_CACHE_MS,
  portVerdict,
  type PortJudgement,
  type PortReadings,
  type PortSession,
  type PortVerdict,
} from './lane-reach';
import type { LaneBrowserSession } from './session';

const run = promisify(execFile);
const READ_DEADLINE_MS = 5_000;
const LSOF = '/usr/sbin/lsof';
const ACCEPT_WAIT_MS = 1_000;
const ACCEPT_POLL_MS = 50;

export interface PortReaders {
  /** `lsof -nP -a -iTCP:<port> -sTCP:LISTEN`, each listener's pid and address; rejects on failure. */
  listeners(port: number): Promise<readonly { readonly pid: number; readonly address: string }[]>;
  /**
   * Connects to `address:port` without sending a byte, holds the connection, and names the processes
   * other than the daemon that hold its other end (`lsof -nP -iTCP:<the connection's local port>`): the
   * acceptor exists only once the server calls accept, so it waits up to about a second and answers
   * `'unaccepted'` after. Rejects when the connection fails.
   */
  acceptors(address: '127.0.0.1' | '::1', port: number): Promise<readonly number[] | 'unaccepted'>;
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

/** The pids of an `lsof -F p` listing. */
function parsePids(output: string): number[] {
  const pids: number[] = [];
  for (const line of output.split('\n')) {
    if (!line.startsWith('p')) continue;
    const pid = Number(line.slice(1));
    if (Number.isInteger(pid)) pids.push(pid);
  }
  return pids;
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

/** A connection to `address:port` that sends nothing; rejects when it cannot connect. */
function connect(address: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: address, port });
    socket.once('connect', () => {
      socket.removeAllListeners('error');
      // A server that resets the held connection must not crash the daemon.
      socket.on('error', () => undefined);
      resolve(socket);
    });
    socket.once('error', (error) => {
      socket.destroy();
      reject(error);
    });
  });
}

/** `lsof` for every process holding a TCP socket whose either end is `port`. */
async function lsofHolders(port: number): Promise<string> {
  try {
    const { stdout } = await run(LSOF, ['-nP', `-iTCP:${String(port)}`, '-F', 'pn'], {
      env: { LC_ALL: 'C' },
      timeout: READ_DEADLINE_MS,
      killSignal: 'SIGKILL',
    });
    return stdout;
  } catch (error) {
    // lsof exits 1 when nothing matches: no holder yet. Output beside a failure is a partial view.
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 1 &&
      'stdout' in error &&
      error.stdout === ''
    ) {
      return '';
    }
    throw error;
  }
}

function sleep(clock: Clock, ms: number): Promise<void> {
  return new Promise((resolve) => {
    clock.setTimeout(resolve, ms);
  });
}

/** `execFile` readers for lsof and docker: an argument list, a 5 s deadline and a fixed env, never a shell. */
export function systemPortReaders(
  home: string,
  env: Readonly<Record<string, string | undefined>>,
  table: ProcessTable,
  clock: Clock,
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
    async acceptors(address, port) {
      const probe = await connect(address, port);
      try {
        const local = probe.localPort;
        if (local === undefined) throw new Error('the probe has no local port');
        const until = clock.now().getTime() + ACCEPT_WAIT_MS;
        for (;;) {
          const holders = parsePids(await lsofHolders(local)).filter((pid) => pid !== process.pid);
          if (holders.length > 0) return holders;
          if (clock.now().getTime() >= until) return 'unaccepted';
          await sleep(clock, ACCEPT_POLL_MS);
        }
      } finally {
        probe.destroy();
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
  return readers;
}

export interface PortOwner {
  /**
   * The verdict for a connection now: an owned one cached `PORT_CACHE_MS`, a refusal `PORT_REFUSAL_CACHE_MS`,
   * read again after. A port with no owned verdict in the last minute counts as a fresh check, at most
   * `PORT_CHECKS_PER_MINUTE` a minute (past it, refused).
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
  const ownedAt = new Map<number, number>();
  let fresh: { port: number; at: number }[] = [];

  const read = async (port: number): Promise<PortVerdict> => {
    const portSession: PortSession = {
      members: new Set(session.members().map((m) => `${String(m.pid)}:${m.startedAt}`)),
      browserPids: deps.browserPids(),
      copy: session.copy,
      tempDir: session.tempDir,
      registeredCheckouts: session.registeredCheckouts,
      loopback: session.loopback,
    };
    const judge = (readings: PortReadings): PortJudgement =>
      portVerdict({
        port,
        daemonPort: deps.daemonPort(),
        proxyPorts: deps.proxyPorts(),
        session: portSession,
        readings,
      });
    let rows: ReadonlyMap<number, { pid: number; ppid: number; startedAt: string }> | null = null;
    const chainOf = async (pid: number): Promise<{ pid: number; startedAt: string }[]> => {
      rows ??= new Map((await deps.readers.table()).map((row) => [row.pid, row]));
      const chain: { pid: number; startedAt: string }[] = [];
      const seen = new Set<number>();
      for (let at = rows.get(pid); at !== undefined && !seen.has(at.pid); at = rows.get(at.ppid)) {
        seen.add(at.pid);
        chain.push({ pid: at.pid, startedAt: at.startedAt });
        if (at.pid === 1) break;
      }
      return chain;
    };

    let listeners: PortReadings['listeners'];
    try {
      const found = await deps.readers.listeners(port);
      listeners = await Promise.all(
        found.map(async ({ pid, address }) => ({ address, chain: await chainOf(pid) })),
      );
    } catch {
      listeners = 'unread';
    }
    // Reads who accepts a connection to the address the judgement named, then judges again.
    const probed = async (
      judgement: PortJudgement,
      readings: PortReadings,
    ): Promise<PortVerdict> => {
      if (judgement.kind !== 'probe') return judgement;
      let acceptors: PortReadings['acceptors'];
      // The acceptor may have started after the first reading.
      rows = null;
      try {
        const pids = await deps.readers.acceptors(judgement.connectTo, port);
        acceptors =
          pids === 'unaccepted'
            ? pids
            : await Promise.all(pids.map(async (pid) => ({ chain: await chainOf(pid) })));
      } catch {
        acceptors = 'unread';
      }
      const final = judge({ ...readings, acceptors });
      // A probe answer is final: asking for it again would loop.
      return final.kind === 'probe'
        ? { kind: 'refused', why: 'the probe was not answered' }
        : final;
    };

    const base: PortReadings = { listeners, acceptors: 'pending', compose: null };
    const first = judge(base);
    const compose = deps.readers.compose;
    if (
      first.kind !== 'refused' ||
      !session.docker ||
      compose === null ||
      listeners === 'unread' ||
      listeners.length === 0
    ) {
      return probed(first, base);
    }
    let publications: PortReadings['compose'];
    try {
      publications = await compose(port);
    } catch {
      publications = 'unanswered';
    }
    const withCompose: PortReadings = { ...base, compose: publications };
    return probed(judge(withCompose), withCompose);
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
      fresh = fresh.filter((entry) => now - entry.at < MINUTE_MS);
      // A port this lane owned in the last minute is its own server read again: it costs nothing.
      const lastOwned = ownedAt.get(port);
      const free = lastOwned !== undefined && now - lastOwned < MINUTE_MS;
      if (!free && fresh.length >= PORT_CHECKS_PER_MINUTE) {
        return {
          kind: 'refused',
          why: `this lane checked ${String(PORT_CHECKS_PER_MINUTE)} ports in a minute; wait before trying another`,
        };
      }
      const entry = { port, at: now };
      if (!free) fresh.push(entry);
      const reading = read(port).then((verdict) => {
        const done = deps.clock.now().getTime();
        if (verdict.kind === 'owned') {
          ownedAt.set(port, done);
          fresh = fresh.filter((e) => e !== entry);
        }
        cache.set(port, {
          verdict,
          until: done + (verdict.kind === 'owned' ? PORT_CACHE_MS : PORT_REFUSAL_CACHE_MS),
        });
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
