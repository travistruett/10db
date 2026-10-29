// @vitest-environment node
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkFactoryConnection,
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

  it.each([
    {
      name: 'a daemon.json that is a directory',
      arrange: () => {
        mkdirSync(join(dataDir, 'daemon.json'));
        writeFileSync(join(dataDir, 'ui-token'), TOKEN);
      },
      problem: /Could not read .*daemon\.json \(EISDIR\)/,
    },
    {
      name: 'a ui-token that is a directory',
      arrange: () => {
        writeFileSync(join(dataDir, 'daemon.json'), runtimeInfo(53117));
        mkdirSync(join(dataDir, 'ui-token'));
      },
      problem: /Could not read .*ui-token \(EISDIR\)/,
    },
    {
      name: 'a ui-token it may not read',
      arrange: () => {
        writeFileSync(join(dataDir, 'daemon.json'), runtimeInfo(53117));
        writeFileSync(join(dataDir, 'ui-token'), TOKEN);
        chmodSync(join(dataDir, 'ui-token'), 0o000);
      },
      problem: /Could not read .*ui-token \(EACCES\)/,
    },
  ])('turns $name into a FactoryConnectionError', ({ arrange, problem }) => {
    arrange();
    expect(() => readFactoryConnection(dataDir)).toThrow(FactoryConnectionError);
    expect(() => readFactoryConnection(dataDir)).toThrow(problem);
  });
});

describe('checkFactoryConnection', () => {
  let server: Server | null;
  beforeEach(() => {
    server = null;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (!server) {
        resolve();
        return;
      }
      server.closeAllConnections();
      server.close(() => {
        resolve();
      });
    });
  });

  interface Daemon {
    /** The origin it names in its CORS answer; null names none. */
    readonly allowed: string | null;
    /** The bearer token `/projects` accepts. */
    readonly token: string;
    /** Never answer, as a daemon stuck at startup. */
    readonly hang?: boolean;
  }

  /** A loopback stand-in for the daemon's `/health` (CORS) and `/projects` (bearer token). */
  const listen = (daemon: Daemon): Promise<string> =>
    new Promise((resolve) => {
      const http = createServer((req, res) => {
        if (daemon.hang) return;
        const origin = req.headers.origin;
        if (daemon.allowed !== null && origin === daemon.allowed)
          res.setHeader('access-control-allow-origin', origin);
        res.setHeader('content-type', 'application/json');
        if (req.url === '/projects' && req.headers.authorization !== `Bearer ${daemon.token}`) {
          res.statusCode = 401;
          res.end('{"error":"unauthorized"}');
          return;
        }
        res.end(req.url === '/projects' ? '[]' : '{"status":"ok"}');
      });
      server = http;
      http.listen(0, '127.0.0.1', () => {
        const address = http.address();
        if (address === null || typeof address === 'string') throw new Error('no TCP address');
        resolve(`http://127.0.0.1:${String(address.port)}`);
      });
    });

  it('passes when the daemon answers the Vite origin and takes the token', async () => {
    const url = await listen({ allowed: VITE_ORIGIN, token: TOKEN });
    await expect(
      checkFactoryConnection({ url, token: TOKEN }, VITE_ORIGIN),
    ).resolves.toBeUndefined();
  });

  it.each([
    {
      name: 'no origin opted in',
      daemon: { allowed: null, token: TOKEN },
      problem: /1\. pnpm dev:factory:enable\n.*2\. Quit 10db \(⌘Q\) and open it again\./,
    },
    {
      name: 'another origin opted in',
      daemon: { allowed: 'http://localhost:5173', token: TOKEN },
      problem: /1\. pnpm dev:factory:enable\n.*2\. Quit 10db \(⌘Q\) and open it again\./,
    },
    {
      name: 'another token',
      daemon: { allowed: VITE_ORIGIN, token: 'a-token-from-a-later-start-0123456789abcdef' },
      problem: /refused the token in ui-token.*run pnpm dev:factory again/s,
    },
    {
      name: 'no answer in time',
      daemon: { allowed: VITE_ORIGIN, token: TOKEN, hang: true },
      problem: /didn't answer within 0\.2 s/,
    },
  ])('refuses a daemon with $name, saying what to do', async ({ daemon, problem }) => {
    const url = await listen(daemon);
    const check = checkFactoryConnection({ url, token: TOKEN }, VITE_ORIGIN, { timeoutMs: 200 });
    await expect(check).rejects.toThrow(FactoryConnectionError);
    await expect(
      checkFactoryConnection({ url, token: TOKEN }, VITE_ORIGIN, { timeoutMs: 200 }),
    ).rejects.toThrow(problem);
  });

  it('refuses a daemon that is not listening', async () => {
    const url = await listen({ allowed: VITE_ORIGIN, token: TOKEN });
    await new Promise<void>((resolve) => {
      server?.close(() => {
        resolve();
      });
    });
    server = null;
    await expect(checkFactoryConnection({ url, token: TOKEN }, VITE_ORIGIN)).rejects.toThrow(
      /isn't answering/,
    );
  });
});
