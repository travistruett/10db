import {
  createServer,
  request as httpRequest,
  type ClientRequest,
  type OutgoingHttpHeaders,
} from 'node:http';
import { connect, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { addressForLog } from './load-failure';
import { proxyAllows } from './origin-guard';

/**
 * The HTTP proxy Chromium sends every request through, loopback included (`launchOptions`), so the
 * origin guard holds below Playwright: a redirect's next hop, which Playwright's routing never sees,
 * reaches it too. It forwards only what `proxyAllows` lets through for the one app being shot, and
 * answers anything else 403 without forwarding it. It grants nothing new: it reaches only the app,
 * which a process that can reach its own loopback port can reach directly.
 */
export interface AppProxy {
  readonly port: number;
  /** The app whose origin passes until the next call; null lets nothing pass. */
  allow(appUrl: string | null): void;
  close(): Promise<void>;
}

export interface AppProxyOptions {
  /** Told each request it refused, as `<method> <address>`: origin and path, never the query. */
  readonly onRefused?: (target: string) => void;
  /** Told each tunnel it opened to the app, as `host:port`. */
  readonly onTunnel?: (target: string) => void;
}

const HOP_BY_HOP = ['proxy-connection', 'proxy-authorization', 'connection', 'keep-alive'];

/** A URL's hostname as a socket takes it: an IPv6 literal without its brackets. */
function socketHost(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

function refuse(socket: Duplex): void {
  socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
}

/** Starts the proxy on `127.0.0.1` at a port the system picks; it lets nothing pass until `allow`. */
export async function startAppProxy(options: AppProxyOptions = {}): Promise<AppProxy> {
  let allowed: string | null = null;
  const tunnels = new Set<Duplex>();
  /** Requests forwarded to the app whose answer the browser may still be reading. */
  const forwards = new Set<ClientRequest>();
  const refused = (method: string, target: string): void => {
    options.onRefused?.(`${method} ${addressForLog(target)}`);
  };

  const server = createServer((req, res) => {
    const method = req.method ?? 'GET';
    const target = req.url ?? '';
    if (!proxyAllows(allowed, { method, target })) {
      refused(method, target);
      res.writeHead(403, { 'content-length': '0', connection: 'close' });
      res.end();
      return;
    }
    const url = new URL(target);
    const headers: OutgoingHttpHeaders = Object.fromEntries(
      Object.entries(req.headers).filter(([name]) => !HOP_BY_HOP.includes(name)),
    );
    const upstream = httpRequest(
      {
        host: socketHost(url.hostname),
        port: url.port === '' ? 80 : Number(url.port),
        method,
        path: `${url.pathname}${url.search}`,
        headers,
        agent: false,
      },
      (answer) => {
        const status = answer.statusCode ?? 0;
        // The app's own reason phrase is dropped, and a status a response can't carry is no answer:
        // nothing the app sends may throw here, where an uncaught error would stop the daemon.
        if (status < 200 || status > 599) {
          answer.destroy();
          noAnswer();
          return;
        }
        try {
          res.writeHead(status, answer.headers);
        } catch {
          answer.destroy();
          noAnswer();
          return;
        }
        // An answer cut off ends the browser's too, rather than leaving it waiting for the rest.
        answer.on('error', () => res.destroy());
        answer.on('close', () => {
          if (!answer.complete) res.destroy();
        });
        answer.pipe(res);
      },
    );
    const noAnswer = (): void => {
      if (!res.headersSent) {
        try {
          res.writeHead(502, { 'content-length': '0' });
        } catch {
          // Headers already on their way: ending is all that is left.
        }
      }
      res.end();
    };
    // The browser gone, or the answer done: the request to the app is too, a stream's included.
    forwards.add(upstream);
    res.on('close', () => {
      forwards.delete(upstream);
      upstream.destroy();
    });
    upstream.on('error', noAnswer);
    // The browser asked for no upgrade, so a 101 is no answer it can use.
    upstream.on('upgrade', (_answer, socket) => {
      socket.destroy();
      noAnswer();
    });
    req.pipe(upstream);
  });

  server.on('connect', (req, client: Duplex, head: Buffer) => {
    const target = req.url ?? '';
    if (!proxyAllows(allowed, { method: 'CONNECT', target })) {
      refused('CONNECT', target);
      refuse(client);
      return;
    }
    const url = new URL(`http://${target}`);
    // The port as written: a URL drops 80, the default.
    const port = Number(/:(\d+)$/.exec(target)?.[1]);
    const upstream: Socket = connect(port, socketHost(url.hostname), () => {
      options.onTunnel?.(target);
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    tunnels.add(client);
    tunnels.add(upstream);
    const done = (): void => {
      tunnels.delete(client);
      tunnels.delete(upstream);
      client.destroy();
      upstream.destroy();
    };
    upstream.on('error', done);
    upstream.on('close', done);
    client.on('error', done);
    client.on('close', done);
  });

  // A plain request asking to upgrade (a WebSocket sent without CONNECT) is never forwarded.
  server.on('upgrade', (req, socket: Duplex) => {
    refused(req.method ?? 'GET', req.url ?? '');
    refuse(socket);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('the pictures proxy has no port');
  }

  return {
    port: address.port,
    allow(appUrl) {
      allowed = appUrl;
    },
    close: () =>
      new Promise<void>((resolve) => {
        allowed = null;
        for (const socket of tunnels) socket.destroy();
        tunnels.clear();
        for (const forward of forwards) forward.destroy();
        forwards.clear();
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
