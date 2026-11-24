/**
 * What a lane's browser may reach: only loopback servers the session itself started. Pure rules; the
 * readings they judge come from `port-owner.ts`, and `lane-proxy.ts` enforces the verdicts on every
 * connection the browser makes.
 */

/** A browser's request target, read before any reading: a loopback port, or why not. */
export type LaneTarget =
  | { readonly kind: 'port'; readonly port: number }
  | { readonly kind: 'refused'; readonly why: string };

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);
const NAMED_SCHEMES = ['file', 'view-source', 'chrome', 'filesystem', 'javascript', 'data', 'blob'];
const AUTHORITY = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i;

function refused(why: string): LaneTarget {
  return { kind: 'refused', why };
}

/**
 * The host exactly as written. A `URL` rewrites `2130706433` and `0x7f.1` to `127.0.0.1`, so the
 * spelling is read from the text, where only the three loopback names pass.
 */
function writtenHost(raw: string): string | null {
  const authority = AUTHORITY.exec(raw)?.[1];
  if (authority === undefined) return null;
  const at = authority.lastIndexOf('@');
  const hostPort = at === -1 ? authority : authority.slice(at + 1);
  if (hostPort.startsWith('[')) {
    const close = hostPort.indexOf(']');
    return close === -1 ? null : hostPort.slice(0, close + 1).toLowerCase();
  }
  const colon = hostPort.lastIndexOf(':');
  return (colon === -1 ? hostPort : hostPort.slice(0, colon)).toLowerCase();
}

/** A URL a tool loads or a navigation goes to: http or https, host exactly localhost, 127.0.0.1 or [::1]. */
export function laneUrlTarget(raw: string): LaneTarget {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return refused('that is not an address the browser can open');
  }
  const scheme = url.protocol.slice(0, -1);
  if (NAMED_SCHEMES.includes(scheme)) return refused(`${scheme}: addresses are not reachable`);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return refused(`${scheme}: addresses are not reachable; use http or https`);
  }
  if (url.username !== '' || url.password !== '') {
    return refused('an address with a user name or password is not reachable');
  }
  const host = writtenHost(raw);
  if (host === null || !LOOPBACK_HOSTS.has(host) || host !== url.hostname) {
    return refused(
      `${host ?? url.hostname} is not reachable; only localhost, 127.0.0.1 and [::1] are`,
    );
  }
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  if (port < 1) return refused('port 0 is not reachable');
  return { kind: 'port', port };
}

const AUTHORITY_FORM = /^(\[[0-9a-f:.]+\]|[^\s:/@[\]]+):(\d{1,5})$/i;

/** What the proxy is asked: absolute-form `http://` only, or `CONNECT host:port`; userinfo and origin-form refused. */
export function laneProxyTarget(request: {
  readonly method: string;
  readonly target: string;
}): LaneTarget {
  if (request.method.toUpperCase() === 'CONNECT') {
    const match = AUTHORITY_FORM.exec(request.target);
    if (match === null) return refused('a tunnel must name host:port');
    // The port as written, so 80 and 443 are not defaults here.
    return laneUrlTarget(`http://${match[1] ?? ''}:${match[2] ?? ''}/`);
  }
  if (/^http:\/\//i.test(request.target)) return laneUrlTarget(request.target);
  if (/^https:\/\//i.test(request.target)) {
    return refused('https goes through a tunnel, not a plain request');
  }
  return refused('the proxy takes an absolute http:// address or a tunnel only');
}

/** One listening socket as `netstat` shows it. */
export interface PortSocket {
  readonly family: 'tcp4' | 'tcp6' | 'tcp46';
  readonly address: string;
  readonly pid: number;
}

export interface PortReadings {
  /** `lsof`'s listeners on the port: each one's address and its process chain, itself first, up to launchd. */
  readonly listeners:
    | readonly {
        readonly address: string;
        readonly chain: readonly { readonly pid: number; readonly startedAt: string }[];
      }[]
    | 'unread';
  /**
   * Every listener on the port from `netstat`, whoever's: its family and bound address (`*` for all
   * addresses) and the pid that holds it. `lsof` run as the builder cannot see another user's socket,
   * so this is the view that shows a root-owned `127.0.0.1:P` beside a lane's wildcard one. 'unread'
   * when `netstat` failed or passed its deadline.
   */
  readonly sockets: readonly PortSocket[] | 'unread';
  /**
   * Each publication of the port by a running container: its compose working dir (null without the label)
   * and the host address Docker bound (`127.0.0.1`, `0.0.0.0`, `::`, or another); null when Docker is off for
   * the project, 'unanswered' when `docker ps` failed or passed 5 s.
   */
  readonly compose:
    | readonly { readonly workingDir: string | null; readonly hostIp: string }[]
    | null
    | 'unanswered';
}

export interface PortSession {
  /** `${pid}:${startedAt}` of every process the session's ledger holds. */
  readonly members: ReadonlySet<string>;
  /**
   * Every lane browser's pids (`BrowserLedger.pids`): never an owner. Pictures' browser and every proxy run
   * as the daemon or its children, whose chains reach no session's member.
   */
  readonly browserPids: ReadonlySet<number>;
  /** Real paths. */
  readonly copy: string;
  readonly tempDir: string;
  readonly registeredCheckouts: readonly string[];
  /** The project lets lane commands bind localhost (`sandboxLoopback`). */
  readonly loopback: boolean;
}

export type PortVerdict =
  | { readonly kind: 'owned'; readonly connectTo: '127.0.0.1' | '::1' }
  | { readonly kind: 'refused'; readonly why: string };

/** How long a port's verdict is kept, and how many fresh checks a session gets a minute. */
export const PORT_CACHE_MS = 5_000;
export const PORT_CHECKS_PER_MINUTE = 20;

/** The ports no lane may reach, answered before anything is read. */
export function fixedPortRefusal(
  port: number,
  daemonPort: number | null,
  proxyPorts: ReadonlySet<number>,
): string | null {
  if (port === daemonPort) return `${String(port)} is 10db's own port`;
  if (proxyPorts.has(port)) return `${String(port)} is a lane browser's proxy`;
  return null;
}

function bare(address: string): string {
  return address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address;
}

function isEqualOrUnder(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir.endsWith('/') ? dir : `${dir}/`);
}

/** The ownership rule. The daemon's and every lane proxy's port are refused before any reading. */
export function portVerdict(input: {
  readonly port: number;
  readonly daemonPort: number | null;
  readonly proxyPorts: ReadonlySet<number>;
  readonly session: PortSession;
  readonly readings: PortReadings;
}): PortVerdict {
  const { port, session, readings } = input;
  const fixed = fixedPortRefusal(port, input.daemonPort, input.proxyPorts);
  if (fixed !== null) return { kind: 'refused', why: fixed };
  const { listeners, compose, sockets } = readings;
  if (listeners === 'unread') {
    return { kind: 'refused', why: `the listeners on ${String(port)} could not be read` };
  }
  if (sockets === 'unread') {
    return { kind: 'refused', why: `the sockets on ${String(port)} could not be read` };
  }
  if (listeners.length === 0) return { kind: 'refused', why: `nothing listens on ${String(port)}` };

  const ownedByLedger = (chain: (typeof listeners)[number]['chain']): boolean =>
    chain.some((p) => session.members.has(`${String(p.pid)}:${p.startedAt}`)) &&
    !chain.some((p) => session.browserPids.has(p.pid));
  const ledgerOwners = session.loopback ? listeners.filter((l) => ownedByLedger(l.chain)) : [];
  if (session.loopback && ledgerOwners.length === listeners.length) {
    // Every socket on the port must be one of the lane's own, whoever lsof could see.
    const lanePids = new Set(listeners.map((l) => l.chain[0]?.pid));
    if (sockets.some((socket) => !lanePids.has(socket.pid))) {
      return { kind: 'refused', why: `another process listens on port ${String(port)}` };
    }
    const connectTo = addressCovered(sockets);
    if (connectTo === null) {
      return { kind: 'refused', why: `${String(port)} is not bound to loopback` };
    }
    return { kind: 'owned', connectTo };
  }

  const pubs: NonNullable<Exclude<PortReadings['compose'], 'unanswered'>> =
    compose === null || compose === 'unanswered' ? [] : compose;
  const ipv4Loopback = sockets.some((socket) => bare(socket.address) === '127.0.0.1');
  if (pubs.length > 0) {
    const ips = pubs.map((c) => bare(c.hostIp));
    const known = ips.every((ip) => ip === '127.0.0.1' || ip === '0.0.0.0' || ip === '::');
    const wildcard = ips.some((ip) => ip === '0.0.0.0' || ip === '::');
    const v6Alone = ips.includes('::') && !ips.includes('0.0.0.0') && !ips.includes('127.0.0.1');
    if (pubs.every((c) => isInsideCopy(c.workingDir, session)) && known) {
      if (wildcard && ipv4Loopback) return sharedRefusal(port);
      if (v6Alone) {
        return {
          kind: 'refused',
          why: `${String(port)} is published on :: only; 127.0.0.1:${String(port)} may be another server's`,
        };
      }
      return { kind: 'owned', connectTo: '127.0.0.1' };
    }
  }

  if (compose === 'unanswered') return { kind: 'refused', why: 'Docker did not answer in 5 s' };
  if (pubs.some((c) => c.workingDir === null)) {
    return {
      kind: 'refused',
      why: `${String(port)} is published by a container not started with Compose; start it with \`docker compose\` from your copy`,
    };
  }
  if (pubs.some((c) => !isInsideCopy(c.workingDir, session))) {
    return { kind: 'refused', why: `${String(port)}'s stack was started outside this lane's copy` };
  }
  if (ledgerOwners.length > 0) return sharedRefusal(port);
  {
    const other = pubs.find((c) => {
      const ip = bare(c.hostIp);
      return ip !== '127.0.0.1' && ip !== '0.0.0.0' && ip !== '::';
    });
    if (other !== undefined) {
      return {
        kind: 'refused',
        why: `${String(port)} is published on ${other.hostIp}, not loopback`,
      };
    }
  }
  return { kind: 'refused', why: `${String(port)} is not a server this lane started` };
}

/** The loopback address one of the lane's own sockets answers on, IPv4 first; null when none does. */
function addressCovered(sockets: readonly PortSocket[]): '127.0.0.1' | '::1' | null {
  const v4 = sockets.some(
    (s) => s.family !== 'tcp6' && ['127.0.0.1', '*', '0.0.0.0'].includes(bare(s.address)),
  );
  if (v4) return '127.0.0.1';
  const v6 = sockets.some(
    (s) => s.family !== 'tcp4' && ['::1', '*', '::'].includes(bare(s.address)),
  );
  return v6 ? '::1' : null;
}

function isInsideCopy(dir: string | null, session: PortSession): boolean {
  return (
    dir !== null &&
    (isEqualOrUnder(dir, session.copy) || isEqualOrUnder(dir, session.tempDir)) &&
    !session.registeredCheckouts.some((checkout) => isEqualOrUnder(dir, checkout))
  );
}

function sharedRefusal(port: number): PortVerdict {
  return { kind: 'refused', why: `${String(port)} is shared with a server that isn't this lane's` };
}
