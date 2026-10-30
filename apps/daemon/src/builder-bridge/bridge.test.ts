import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { BUILDER_INSTRUCTIONS, builderToolList } from '@10db/contracts';
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

/** An HTTP server standing in for the daemon: answers every request with `reply`, or never. */
async function daemonAnswering(
  reply: { status: number; body: string; type?: string } | 'hang',
  pid = process.pid,
): Promise<void> {
  stub = createServer((req: IncomingMessage, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
    });
    req.on('end', () => {
      seen.push({ authorization: req.headers.authorization, body });
      if (reply === 'hang') return;
      res.writeHead(reply.status, { 'content-type': reply.type ?? 'application/json' });
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
  client.callTool({ name: 'list_flows', arguments: {} }).then(
    () => null,
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );

describe('the builder bridge with no daemon', () => {
  it('answers initialize and the tool list on its own', async () => {
    await connect();
    expect(client.getInstructions()).toBe(BUILDER_INSTRUCTIONS);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(builderToolList().map((t) => t.name));
  });

  it('answers a call with the not-running error', async () => {
    await connect();
    expect(await callCreate()).toContain(NOT_RUNNING);
  });

  it('does not send a request or a token to a pid that has exited', async () => {
    const child = spawnSync(process.execPath, ['-e', '0']);
    await daemonAnswering({ status: 200, body: '{}' }, child.pid);
    await connect();
    expect(await callCreate()).toContain(NOT_RUNNING);
    expect(seen).toEqual([]);
  });

  it('answers not running after the daemon.json is removed', async () => {
    await daemonAnswering({ status: 200, body: '{}' });
    rmSync(join(dir.path, 'daemon.json'));
    await connect();
    expect(await callCreate()).toContain(NOT_RUNNING);
  });
});

describe('the builder bridge with a daemon', () => {
  const ok = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    result: { content: [{ type: 'text', text: '[]' }] },
  });

  it('forwards a call with the UI token and returns the result', async () => {
    await daemonAnswering({ status: 200, body: ok });
    await connect();
    const result = await client.callTool({ name: 'list_flows', arguments: {} });
    expect(result.content).toEqual([{ type: 'text', text: '[]' }]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.authorization).toBe('Bearer the-ui-token');
    expect(JSON.parse(seen[0]?.body ?? '')).toMatchObject({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'list_flows', arguments: {} },
    });
  });

  it('rereads the runtime files on every call', async () => {
    await daemonAnswering({ status: 200, body: ok });
    await connect();
    await client.callTool({ name: 'list_flows', arguments: {} });
    rmSync(join(dir.path, 'daemon.json'));
    expect(await callCreate()).toContain(NOT_RUNNING);
  });

  it('passes a JSON-RPC error on', async () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32602, message: 'Unknown tool' },
    });
    await daemonAnswering({ status: 200, body });
    await connect();
    expect(await callCreate()).toContain('Unknown tool');
  });

  it.each([
    { name: '401', reply: { status: 401, body: '{"error":"unauthorized"}' }, text: 'refused' },
    {
      name: '400 with a null id',
      reply: {
        status: 400,
        body: '{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}}',
      },
      text: 'Parse error',
    },
    { name: '400 without a body', reply: { status: 400, body: '' }, text: 'HTTP 400' },
    {
      name: '406',
      reply: { status: 406, body: 'Not Acceptable', type: 'text/plain' },
      text: 'HTTP 406',
    },
    { name: '500', reply: { status: 500, body: '{"error":"internal"}' }, text: 'HTTP 500' },
    {
      name: 'non-JSON',
      reply: { status: 200, body: 'hello', type: 'text/plain' },
      text: 'could not be read',
    },
    {
      name: 'JSON of the wrong shape',
      reply: { status: 200, body: '{"a":1}' },
      text: 'could not be read',
    },
  ])('says what went wrong on $name', async ({ reply, text }) => {
    await daemonAnswering(reply);
    await connect();
    expect(await callCreate()).toContain(text);
  });

  it('times out on a daemon that does not answer', async () => {
    await daemonAnswering('hang');
    await connect(150);
    expect(await callCreate()).toContain('did not answer');
  });

  it('says 10db is not running when the port refuses the connection', async () => {
    await daemonAnswering({ status: 200, body: ok });
    await closeStub();
    await connect();
    expect(await callCreate()).toContain(NOT_RUNNING);
  });
});
