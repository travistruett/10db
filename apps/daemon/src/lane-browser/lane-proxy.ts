import {
  createServer,
  request as httpRequest,
  type ClientRequest,
  type OutgoingHttpHeaders,
} from 'node:http';
import { connect, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import type { Logger } from '../log';
import { laneProxyTarget } from './lane-reach';
import type { PortOwner } from './port-owner';

/**
 * The HTTP proxy a lane's Chromium sends every request through, loopback included. It is what holds
 * the reach rule: a request is forwarded only to a port `owner` answers owned, at the address the
 * listener reported, and it never resolves a name. Playwright's own routing is a first check; a
 * redirect's next hop and a subresource reach this proxy too.
 */
export interface LaneProxy {
  readonly port: number;
  /** The refusals since the last call, worded for the answer; empties the list. */
  takeRefused(): string[];
  close(): Promise<void>;
}

const HOP_BY_HOP = ['proxy-connection', 'proxy-authorization', 'connection', 'keep-alive'];

function refuseSocket(socket: Duplex): void {
  socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
}

/** The target as a log and an answer name it: origin and path, never the query or a body. */
function describe(target: string): string {
  if (/^[^/?#@\s]+:\d+$/.test(target)) return target;
  try {
    const url = new URL(target);
    return `${url.origin}${url.pathname}`;
  } catch {
    return '(not an address)';
  }
}

/** Starts the proxy on `127.0.0.1` at a port the system picks. */
export async function startLaneProxy(owner: PortOwner, logger: Logger): Promise<LaneProxy> {
  const tunnels = new Set<Duplex>();
  const forwards = new Set<ClientRequest>();
  let refusals: string[] = [];
  const refused = (method: string, target: string, why: string): void => {
    const line = `${method} ${describe(target)}: ${why}`;
    refusals.push(line);
    logger.info({ refused: line }, 'lane browser proxy refused a request');
  };

  /** The owned port's connection address, or null after recording why not. */
  const decide = async (
    method: string,
    target: string,
  ): Promise<{ port: number; connectTo: '127.0.0.1' | '::1' } | null> => {
    const parsed = laneProxyTarget({ method, target });
    if (parsed.kind === 'refused') {
      refused(method, target, parsed.why);
      return null;
    }
    const verdict = await owner.check(parsed.port);
    if (verdict.kind === 'refused') {
      refused(method, target, verdict.why);
      return null;
    }
    return { port: parsed.port, connectTo: verdict.connectTo };
  };

  const server = createServer((req, res) => {
    const method = req.method ?? 'GET';
    const target = req.url ?? '';
    const deny = (): void => {
      res.writeHead(403, { 'content-length': '0', connection: 'close' });
      res.end();
    };
    void decide(method, target).then(
      (verdict) => {
        if (verdict === null) {
          deny();
          return;
        }
        const url = new URL(target);
        const headers: OutgoingHttpHeaders = Object.fromEntries(
          Object.entries(req.headers).filter(([name]) => !HOP_BY_HOP.includes(name)),
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
        const upstream = httpRequest(
          {
            host: verdict.connectTo,
            port: verdict.port,
            method,
            path: `${url.pathname}${url.search}`,
            headers,
            agent: false,
          },
          (answer) => {
            const status = answer.statusCode ?? 0;
            // A status a response can't carry is no answer: nothing the server sends may throw here.
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
            answer.on('error', () => res.destroy());
            answer.on('close', () => {
              if (!answer.complete) res.destroy();
            });
            answer.pipe(res);
          },
        );
        forwards.add(upstream);
        res.on('close', () => {
          forwards.delete(upstream);
          upstream.destroy();
        });
        upstream.on('error', noAnswer);
        upstream.on('upgrade', (_answer, socket) => {
          socket.destroy();
          noAnswer();
        });
        req.pipe(upstream);
      },
      () => {
        deny();
      },
    );
  });

  server.on('connect', (req, client: Duplex, head: Buffer) => {
    const target = req.url ?? '';
    // Nothing a browser's socket does may throw out of this handler, before or after the check.
    client.on('error', () => client.destroy());
    void decide('CONNECT', target).then(
      (verdict) => {
        if (client.destroyed) return;
        if (verdict === null) {
          refuseSocket(client);
          return;
        }
        const upstream: Socket = connect(verdict.port, verdict.connectTo, () => {
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
        client.on('close', done);
      },
      () => {
        refuseSocket(client);
      },
    );
  });

  // A plain request asking to upgrade (a WebSocket sent without CONNECT) is never forwarded.
  server.on('upgrade', (req, socket: Duplex) => {
    refused(req.method ?? 'GET', req.url ?? '', 'an upgrade must come through a tunnel');
    refuseSocket(socket);
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
    throw new Error('the lane browser proxy has no port');
  }

  return {
    port: address.port,
    takeRefused() {
      const taken = refusals;
      refusals = [];
      return taken;
    },
    close: () =>
      new Promise<void>((resolve) => {
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
