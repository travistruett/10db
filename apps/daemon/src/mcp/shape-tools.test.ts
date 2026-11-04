import type { AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InvalidError } from '@10db/contracts';
import {
  createTestStore,
  insertSession,
  insertShape,
  insertTask,
  insertWorkstream,
  seedProject,
  type Store,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { createGit } from '../git';
import { protectedPaths } from '../guard';
import { createInboxService } from '../inbox';
import { silentLogger } from '../log';
import { createMcpHandler, mintSessionToken, ToolImages } from './index';
import type { ShapeToolsFor } from './shape-tools';

const PICTURE = { mediaType: 'image/png', data: 'iVBORw0KGgo=' } as const;

// Shape spec §5.5: the endpoint builds a session's tool set from its row.

let state: StateStore;
let base: Store;
let close: () => void;
let server: ReturnType<typeof serve>;
let url: string;
let shapeTools: ShapeToolsFor | undefined;
const calls: { tool: string; input: unknown; shapeId: string }[] = [];

beforeEach(async () => {
  calls.length = 0;
  shapeTools = (session) => ({
    note_heard: (input) => {
      calls.push({ tool: 'note_heard', input, shapeId: session.shapeId });
      return Promise.resolve({ heard: input.items.length });
    },
    propose_plan: () => Promise.reject(new InvalidError('Loose task 1, areas: no such area')),
  });
  const test = createTestStore();
  close = test.close;
  base = test.store;
  state = createStateStore(test.store, createEventBus());
  const handler = createMcpHandler({
    protectedPaths: protectedPaths({
      dataDir: join(tmpdir(), 'mcp-shape-data'),
      home: homedir(),
      loginConfigDir: null,
    }),
    state,
    inbox: createInboxService({ state, onParkedAnswer: () => undefined }),
    git: createGit(),
    log: silentLogger,
    waitObserverFor: () => undefined,
    sessionSignal: () => undefined,
    shapeTools: (s) => (shapeTools ? shapeTools(s) : {}),
  });
  server = serve({ fetch: handler, hostname: '127.0.0.1', port: 0 });
  await new Promise((r) => server.once('listening', r));
  url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/mcp`;
});
afterEach(() => {
  server.close();
  close();
});

function shapeToken(): { token: string; shapeId: string } {
  const project = seedProject(base, { repoPath: tmpdir() });
  const shape = state.write((ctx) =>
    insertShape(ctx, project.id, { title: 'Density', origin: 'app' }),
  );
  const { token, hash } = mintSessionToken();
  state.write((ctx) =>
    insertSession(ctx, {
      shapeId: shape.id,
      provider: 'claude',
      model: 'opus',
      effort: 'high',
      mode: 'managed',
      mcpTokenHash: hash,
    }),
  );
  return { token, shapeId: shape.id };
}

function laneToken(): string {
  const project = seedProject(base, { repoPath: tmpdir() });
  const task = state.write((ctx) =>
    insertTask(ctx, project.id, { title: 'A', acceptanceCriteria: ['x'], areas: ['api'] }),
  );
  const workstream = state.write((ctx) => insertWorkstream(ctx, task.id));
  const { token, hash } = mintSessionToken();
  state.write((ctx) =>
    insertSession(ctx, {
      workstreamId: workstream.id,
      provider: 'claude',
      model: 'sonnet',
      effort: 'medium',
      mode: 'managed',
      mcpTokenHash: hash,
    }),
  );
  return token;
}

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

describe('a Shape session’s tool set', () => {
  it('offers the Shape tools it has handlers for, and no lane tool', async () => {
    const client = await connect(shapeToken().token);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['note_heard', 'propose_plan']);
  });

  it('runs a tool with its parsed input, for its own conversation', async () => {
    const { token, shapeId } = shapeToken();
    const client = await connect(token);
    const result = await client.callTool({ name: 'note_heard', arguments: { items: ['a', 'b'] } });
    expect(JSON.stringify(result.content)).toContain('"heard\\":2');
    expect(calls).toEqual([{ tool: 'note_heard', input: { items: ['a', 'b'] }, shapeId }]);
  });

  it('answers a refusal as the tool’s error, with its words', async () => {
    const client = await connect(shapeToken().token);
    const result = await client.callTool({ name: 'propose_plan', arguments: { draft: {} } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('Loose task 1, areas: no such area');
  });

  it('refuses input that does not fit the tool, before any handler runs', async () => {
    const client = await connect(shapeToken().token);
    const result = await client.callTool({
      name: 'note_heard',
      arguments: { items: ['x'.repeat(81)] },
    });
    expect(result.isError).toBe(true);
    expect(calls).toEqual([]);
  });

  it('answers a tool whose result is pictures with an image block the session receives, beside its text', async () => {
    shapeTools = () => ({
      see_screen: () => Promise.resolve(new ToolImages('The Board at 1200×900.', [PICTURE])),
    });
    const client = await connect(shapeToken().token);
    const result = await client.callTool({
      name: 'see_screen',
      arguments: { screen: 'board' },
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([
      { type: 'text', text: 'The Board at 1200×900.' },
      { type: 'image', data: PICTURE.data, mimeType: 'image/png' },
    ]);
  });

  it('parses see_screen’s input with its defaults, and refuses a click, a key or a url in it', async () => {
    const seen: unknown[] = [];
    shapeTools = () => ({
      see_screen: (input) => {
        seen.push(input);
        return Promise.resolve(new ToolImages('ok', []));
      },
    });
    const client = await connect(shapeToken().token);
    await client.callTool({ name: 'see_screen', arguments: { screen: 'factory' } });
    expect(seen).toEqual([{ screen: 'factory', width: 1200, height: 900 }]);
    const { tools } = await client.listTools();
    const schema = tools.find((t) => t.name === 'see_screen')?.inputSchema;
    expect(Object.keys(schema?.properties ?? {}).sort()).toEqual([
      'height',
      'screen',
      'taskId',
      'width',
    ]);
  });

  it('gives a lane session the lane tools, never the Shape tools', async () => {
    const client = await connect(laneToken());
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('commit');
    expect(names).not.toContain('propose_plan');
    expect(names).not.toContain('note_heard');
    expect(names).not.toContain('see_screen');
  });
});

describe('a Shape session with no tool set to give it', () => {
  it('is refused, as an unknown token is', async () => {
    shapeTools = undefined;
    const handler = createMcpHandler({
      protectedPaths: protectedPaths({
        dataDir: join(tmpdir(), 'mcp-shape-data'),
        home: homedir(),
        loginConfigDir: null,
      }),
      state,
      inbox: createInboxService({ state, onParkedAnswer: () => undefined }),
      git: createGit(),
      log: silentLogger,
      waitObserverFor: () => undefined,
      sessionSignal: () => undefined,
    });
    const { token } = shapeToken();
    const res = await handler(
      new Request('http://127.0.0.1/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    expect(res.status).toBe(401);
  });
});
