import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { factoryConnectionRoute } from './factory-connection-route';
import { FACTORY_CONNECTION_PATH } from './factory-vite';

let dataDir: string;
let server: Server;
let url: string;

const announce = (port: number, token: string): void => {
  writeFileSync(join(dataDir, 'daemon.json'), JSON.stringify({ port }));
  writeFileSync(join(dataDir, 'ui-token'), token);
};

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'factory-route-'));
  const route = factoryConnectionRoute(dataDir);
  server = createServer((req, res) => {
    route(req, res, () => {
      res.statusCode = 404;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('the test server has no port');
  url = `http://127.0.0.1:${String(address.port)}${FACTORY_CONNECTION_PATH}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) =>
    server.close(() => {
      resolve();
    }),
  );
  rmSync(dataDir, { recursive: true, force: true });
});

it('answers the daemon that runs now, after 10db restarts with a new port and token', async () => {
  announce(51001, 'token-before-the-restart');
  expect(await (await fetch(url)).json()).toEqual({
    url: 'http://127.0.0.1:51001',
    token: 'token-before-the-restart',
  });
  announce(51002, 'token-after-the-restart');
  expect(await (await fetch(url)).json()).toEqual({
    url: 'http://127.0.0.1:51002',
    token: 'token-after-the-restart',
  });
  // Another origin's page never reads it.
  expect((await fetch(url, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status).toBe(403);
});
