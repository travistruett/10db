import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer as createHttpsServer } from 'node:https';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir, type TempDir } from '../../test/fixtures';
import { answers } from './probe';

// A dev server that answers anything is running, an https one with a certificate of its own included:
// 10db must not start a second preview beside it.

let dir: TempDir | null = null;
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) =>
          s.close(() => {
            resolve();
          }),
        ),
    ),
  );
  dir?.cleanup();
  dir = null;
});

async function listening(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return address.port;
}

describe('answers', () => {
  it('counts an error page as answering, and a closed port as not', async () => {
    const port = await listening(
      createServer((_q, s) => {
        s.statusCode = 500;
        s.end('boom');
      }),
    );
    expect(await answers(`http://127.0.0.1:${String(port)}`)).toBe(true);
    const free = await listening(createServer());
    await new Promise<void>((resolve) =>
      servers.pop()?.close(() => {
        resolve();
      }),
    );
    expect(await answers(`http://127.0.0.1:${String(free)}`)).toBe(false);
  });

  it('counts an https dev server with a self-signed certificate as answering', async () => {
    dir = tempDir('probe-tls');
    const key = join(dir.path, 'key.pem');
    const cert = join(dir.path, 'cert.pem');
    execFileSync(
      '/usr/bin/openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-subj',
        '/CN=localhost',
        '-days',
        '1',
        '-keyout',
        key,
        '-out',
        cert,
      ],
      { stdio: 'ignore' },
    );
    const port = await listening(
      createHttpsServer({ key: readFileSync(key), cert: readFileSync(cert) }, (_q, s) =>
        s.end('ok'),
      ),
    );
    expect(await answers(`https://127.0.0.1:${String(port)}`)).toBe(true);
  });
});
