import { createServer, request, type Server } from 'node:http';
import { createServer as createNetServer, type Server as NetServer } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { waitForAsync } from '../../test/fixtures';
import { startAppProxy, type AppProxy } from './app-proxy';

/** A loopback server that answers every request with its own name and counts what reached it. */
async function countingServer(
  name: string,
): Promise<{ server: Server; port: number; hits: string[] }> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(`${req.method ?? ''} ${req.url ?? ''}`);
    res.setHeader('content-type', 'text/plain');
    res.end(`${name} ${req.url ?? ''}`);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return { server, port: address.port, hits };
}

/** An app that answers every request with `answer`, written raw, and then does what `after` says. */
async function rawApp(
  answer: string,
  after: 'close' | 'hold' = 'close',
): Promise<{ server: NetServer; url: string }> {
  const server = createNetServer((socket) => {
    socket.once('data', () => {
      socket.write(answer);
      if (after === 'close') socket.end();
    });
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return { server, url: `http://127.0.0.1:${String(address.port)}` };
}

/** Sends `GET <target>` to the proxy in absolute form, as Chromium does. */
function viaProxy(proxyPort: number, target: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port: proxyPort, method: 'GET', path: target, agent: false },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** An app that streams events and never ends its answer; `closed` counts the streams it saw end. */
async function streamingApp(): Promise<{ server: Server; url: string; closed: () => number }> {
  let closed = 0;
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: first\n\n');
    res.on('close', () => {
      closed += 1;
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return { server, url: `http://127.0.0.1:${String(address.port)}`, closed: () => closed };
}

/** Opens `target` through the proxy and resolves once the first bytes arrive, with a way to drop it. */
function firstBytes(proxyPort: number, target: string): Promise<{ drop(): void }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port: proxyPort, method: 'GET', path: target, agent: false },
      (res) => {
        res.once('data', () => {
          resolve({
            drop: () => {
              req.destroy();
            },
          });
        });
        res.on('error', () => undefined);
      },
    );
    req.on('error', (error) => {
      reject(error);
    });
    req.end();
  });
}

/** How a request through the proxy ends: answered in full, cut off, or still open after 5 s. */
function settles(proxyPort: number, target: string): Promise<'ended' | 'cut' | 'hung'> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      req.destroy();
      resolve('hung');
    }, 5_000);
    const done = (how: 'ended' | 'cut'): void => {
      clearTimeout(timer);
      resolve(how);
    };
    const req = request(
      { host: '127.0.0.1', port: proxyPort, method: 'GET', path: target, agent: false },
      (res) => {
        res.resume();
        res.on('end', () => {
          done(res.complete ? 'ended' : 'cut');
        });
        res.on('error', () => {
          done('cut');
        });
        res.on('aborted', () => {
          done('cut');
        });
      },
    );
    req.on('error', () => {
      done('cut');
    });
    req.end();
  });
}

/** Asks the proxy for a tunnel; answers its status and, when it opened, what an HTTP request through it got. */
function tunnel(proxyPort: number, authority: string): Promise<{ status: number; reply: string }> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'CONNECT',
      path: authority,
      agent: false,
    });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        resolve({ status: res.statusCode ?? 0, reply: '' });
        return;
      }
      let reply = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        reply += chunk;
        if (reply.includes('\r\n\r\n') && reply.endsWith('/tunnelled')) {
          socket.destroy();
          resolve({ status: 200, reply });
        }
      });
      socket.write(`GET /tunnelled HTTP/1.1\r\nHost: ${authority}\r\nConnection: close\r\n\r\n`);
    });
    req.on('error', reject);
    req.end();
  });
}

describe('the app proxy', () => {
  let app: Awaited<ReturnType<typeof countingServer>>;
  let other: Awaited<ReturnType<typeof countingServer>>;
  let proxy: AppProxy;
  let refused: string[];
  let tunnels: string[];

  beforeEach(async () => {
    app = await countingServer('app');
    other = await countingServer('daemon');
    refused = [];
    tunnels = [];
    proxy = await startAppProxy({
      onRefused: (target) => {
        refused.push(target);
      },
      onTunnel: (target) => {
        tunnels.push(target);
      },
    });
    proxy.allow(`http://127.0.0.1:${String(app.port)}`);
  });
  afterEach(async () => {
    await proxy.close();
    app.server.close();
    other.server.close();
  });

  it('forwards a request on the app’s origin', async () => {
    const got = await viaProxy(proxy.port, `http://127.0.0.1:${String(app.port)}/people?tab=all`);
    expect(got).toEqual({ status: 200, body: 'app /people?tab=all' });
    expect(app.hits).toEqual(['GET /people?tab=all']);
  });

  it('answers 403 for another port, which sees nothing', async () => {
    const got = await viaProxy(proxy.port, `http://127.0.0.1:${String(other.port)}/tasks`);
    expect(got.status).toBe(403);
    expect(other.hits).toEqual([]);
    expect(refused).toEqual([`GET http://127.0.0.1:${String(other.port)}/tasks`]);
  });

  it('refuses a request made to it as a server', async () => {
    const got = await viaProxy(proxy.port, '/people');
    expect(got.status).toBe(403);
    expect(app.hits).toEqual([]);
  });

  it('tunnels a CONNECT to the app, and refuses one to another port', async () => {
    const opened = await tunnel(proxy.port, `127.0.0.1:${String(app.port)}`);
    expect(opened.status).toBe(200);
    expect(opened.reply).toContain('app /tunnelled');
    expect(tunnels).toEqual([`127.0.0.1:${String(app.port)}`]);
    const shut = await tunnel(proxy.port, `127.0.0.1:${String(other.port)}`);
    expect(shut.status).toBe(403);
    expect(other.hits).toEqual([]);
  });

  it('lets nothing through while no app is allowed', async () => {
    proxy.allow(null);
    const got = await viaProxy(proxy.port, `http://127.0.0.1:${String(app.port)}/`);
    expect(got.status).toBe(403);
    expect((await tunnel(proxy.port, `127.0.0.1:${String(app.port)}`)).status).toBe(403);
    expect(app.hits).toEqual([]);
  });

  it.each([
    ['a status below 100', 'HTTP/1.1 099 Odd\r\nContent-Length: 0\r\n\r\n', 502],
    ['a status of 000', 'HTTP/1.1 000 Odd\r\nContent-Length: 0\r\n\r\n', 502],
    // Its own reason phrase is dropped, so the answer passes without it.
    [
      'a control byte in the reason phrase',
      'HTTP/1.1 200 O\u0001K\r\nContent-Length: 2\r\n\r\nok',
      200,
    ],
  ])('never throws on %s, and keeps serving', async (_name, answer, status) => {
    const bad = await rawApp(answer);
    try {
      proxy.allow(bad.url);
      expect((await viaProxy(proxy.port, `${bad.url}/x`)).status).toBe(status);
      proxy.allow(`http://127.0.0.1:${String(app.port)}`);
      expect(
        (await viaProxy(proxy.port, `http://127.0.0.1:${String(app.port)}/after`)).status,
      ).toBe(200);
    } finally {
      bad.server.close();
    }
  });

  it.each([
    [
      'an answer cut off before its length',
      'HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nshort',
      'close',
    ],
    [
      'a 101 to a request that asked for no upgrade',
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: x\r\nConnection: upgrade\r\n\r\n',
      'hold',
    ],
  ] as const)('never leaves the browser waiting on %s', async (_name, answer, after) => {
    const bad = await rawApp(answer, after);
    try {
      proxy.allow(bad.url);
      expect(await settles(proxy.port, `${bad.url}/x`)).not.toBe('hung');
    } finally {
      bad.server.close();
    }
  });

  it('stops the app’s stream when the browser drops it', async () => {
    const stream = await streamingApp();
    try {
      proxy.allow(stream.url);
      const open = await firstBytes(proxy.port, `${stream.url}/events`);
      open.drop();
      await waitForAsync(() => Promise.resolve(stream.closed() === 1 ? true : undefined), 5_000);
    } finally {
      stream.server.closeAllConnections();
      stream.server.close();
    }
  });

  it('stops the app’s streams when it closes', async () => {
    const stream = await streamingApp();
    try {
      proxy.allow(stream.url);
      await firstBytes(proxy.port, `${stream.url}/events`);
      await proxy.close();
      await waitForAsync(() => Promise.resolve(stream.closed() === 1 ? true : undefined), 5_000);
    } finally {
      stream.server.closeAllConnections();
      stream.server.close();
    }
  });
});
