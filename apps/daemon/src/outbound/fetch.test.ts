import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:tls';
import { afterEach, expect, it } from 'vitest';
import { outboundFetch } from './fetch';

let dir: string | undefined;
let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (server === undefined) resolve();
    else
      server.close(() => {
        resolve();
      });
  });
  server = undefined;
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

it('offers only http/1.1 in the TLS handshake', async () => {
  // The key is made here, never committed: it lives for this test only.
  dir = mkdtempSync(join(tmpdir(), 'tendb-outbound-'));
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-subj',
      '/CN=localhost',
      '-days',
      '1',
    ],
    { stdio: 'ignore' },
  );
  const offers: string[][] = [];
  const listening = createServer({
    key: readFileSync(keyPath),
    cert: readFileSync(certPath),
    // Choosing no protocol ends the handshake with an alert, once the offer is recorded.
    ALPNCallback: ({ protocols }) => {
      offers.push(protocols);
      return undefined;
    },
  });
  server = listening;
  listening.on('tlsClientError', () => undefined);
  await new Promise<void>((resolve) => {
    listening.listen(0, '127.0.0.1', resolve);
  });
  const { port } = listening.address() as AddressInfo; // a listening TCP server's address is an AddressInfo

  await expect(outboundFetch(`https://localhost:${String(port)}/`)).rejects.toThrow();

  expect(offers).toEqual([['http/1.1']]);
});
