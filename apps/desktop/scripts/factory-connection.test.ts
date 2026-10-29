// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkFactoryAcceptsOrigin,
  FactoryConnectionError,
  readFactoryConnection,
  VITE_ORIGIN,
} from './factory-connection';

const TOKEN = 'factory-token-0123456789abcdefghijklmnopqrstu';

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), '10db-factory-'));
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

const runtimeInfo = (port: number): string =>
  JSON.stringify({ pid: 4242, port, protocolVersion: 1, startedAt: '2026-10-29T10:00:00.000Z' });

describe('readFactoryConnection', () => {
  it('reads the port the running daemon announced and its UI token', () => {
    writeFileSync(join(dataDir, 'daemon.json'), runtimeInfo(53117));
    writeFileSync(join(dataDir, 'ui-token'), `${TOKEN}\n`);
    expect(readFactoryConnection(dataDir)).toEqual({
      url: 'http://127.0.0.1:53117',
      token: TOKEN,
    });
  });

  it.each([
    { name: 'no daemon.json', info: null, token: TOKEN, problem: /isn't running/ },
    {
      name: 'a daemon.json that is not JSON',
      info: '{ nope',
      token: TOKEN,
      problem: /daemon\.json/,
    },
    {
      name: 'a daemon.json with no port',
      info: JSON.stringify({ pid: 1 }),
      token: TOKEN,
      problem: /daemon\.json/,
    },
    {
      name: 'a port out of range',
      info: runtimeInfo(70000),
      token: TOKEN,
      problem: /daemon\.json/,
    },
    { name: 'no ui-token', info: runtimeInfo(53117), token: null, problem: /ui-token/ },
    { name: 'an empty ui-token', info: runtimeInfo(53117), token: ' \n', problem: /ui-token/ },
  ])('refuses $name with a FactoryConnectionError', ({ info, token, problem }) => {
    if (info !== null) writeFileSync(join(dataDir, 'daemon.json'), info);
    if (token !== null) writeFileSync(join(dataDir, 'ui-token'), token);
    expect(() => readFactoryConnection(dataDir)).toThrow(FactoryConnectionError);
    expect(() => readFactoryConnection(dataDir)).toThrow(problem);
    expect(() => readFactoryConnection(dataDir)).not.toThrow(TOKEN);
  });
});

describe('checkFactoryAcceptsOrigin', () => {
  let server: Server | null;
  beforeEach(() => {
    server = null;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (server)
        server.close(() => {
          resolve();
        });
      else resolve();
    });
  });

  /** A loopback server that answers /health, naming `allowed` in its CORS header when given. */
  const listen = (allowed: string | null): Promise<string> =>
    new Promise((resolve) => {
      const http = createServer((req, res) => {
        const origin = req.headers.origin;
        if (req.url === '/health' && allowed !== null && origin === allowed)
          res.setHeader('access-control-allow-origin', origin);
        res.setHeader('content-type', 'application/json');
        res.end('{"status":"ok"}');
      });
      server = http;
      http.listen(0, '127.0.0.1', () => {
        const address = http.address();
        if (address === null || typeof address === 'string') throw new Error('no TCP address');
        resolve(`http://127.0.0.1:${String(address.port)}`);
      });
    });

  it('passes when the daemon names the Vite origin in its CORS answer', async () => {
    const url = await listen(VITE_ORIGIN);
    await expect(checkFactoryAcceptsOrigin(url, VITE_ORIGIN)).resolves.toBeUndefined();
  });

  it.each([
    { name: 'no origin opted in', allowed: null },
    { name: 'another origin opted in', allowed: 'http://localhost:5173' },
  ])('refuses when the daemon has $name, giving the two steps to opt in', async ({ allowed }) => {
    const url = await listen(allowed);
    const check = checkFactoryAcceptsOrigin(url, VITE_ORIGIN);
    await expect(check).rejects.toThrow(FactoryConnectionError);
    await expect(checkFactoryAcceptsOrigin(url, VITE_ORIGIN)).rejects.toThrow(
      /1\. pnpm dev:factory:enable\n.*2\. Quit 10db \(⌘Q\) and open it again\./,
    );
  });

  it('refuses a daemon that is not answering', async () => {
    const url = await listen(VITE_ORIGIN);
    await new Promise<void>((resolve) => {
      server?.close(() => {
        resolve();
      });
    });
    server = null;
    await expect(checkFactoryAcceptsOrigin(url, VITE_ORIGIN)).rejects.toThrow(/isn't answering/);
  });
});
