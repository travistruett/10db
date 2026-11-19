import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir, type TempDir } from '../../test/fixtures';
import { writeRuntimeFiles } from '../runtime-files';
import { createBuilderBridge } from './index';

const NOT_RUNNING = '10db is not running: open the 10db app and try again';

let dir: TempDir;
let client: Client;
let stub: Server | null = null;
let seen: { authorization: string | undefined; body: string }[] = [];
beforeEach(() => {
  dir = tempDir('builder-bridge');
  seen = [];
});
afterEach(async () => {
  await client.close();
  await closeStub();
  stub = null;
  dir.cleanup();
});

function closeStub(): Promise<void> {
  const server = stub;
  if (server === null) return Promise.resolve();
  server.closeAllConnections();
  return new Promise((done) => {
    server.close(() => {
      done();
    });
  });
}

async function connect(timeoutMs = 2000): Promise<void> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createBuilderBridge({ dataDir: dir.path, timeoutMs }).connect(serverSide);
  client = new Client({ name: 'test', version: '0' });
  await client.connect(clientSide);
}

/** An HTTP server standing in for the daemon, with `pid` recorded as the daemon's. */
async function daemonAnswering(
  reply: { status: number; body: string },
  pid: number,
): Promise<void> {
  stub = createServer((req: IncomingMessage, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
    });
    req.on('end', () => {
      seen.push({ authorization: req.headers.authorization, body });
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(reply.body);
    });
  });
  const server = stub;
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as AddressInfo).port;
  writeRuntimeFiles(
    dir.path,
    { pid, port, protocolVersion: 1, startedAt: '2026-10-29T10:00:00.000Z' },
    'the-ui-token',
  );
}

const callCreate = () =>
  client.callTool({ name: 'list_kinds', arguments: {} }).then(
    () => null,
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );

describe('the builder bridge with no daemon', () => {
  it('does not send a request or a token to a pid that has exited', async () => {
    const child = spawnSync(process.execPath, ['-e', '0']);
    await daemonAnswering({ status: 200, body: '{}' }, child.pid);
    await connect();
    expect(await callCreate()).toContain(NOT_RUNNING);
    expect(seen).toEqual([]);
  });
});
