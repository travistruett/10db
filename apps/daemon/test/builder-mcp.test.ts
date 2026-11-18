import {
  BUILDER_INSTRUCTIONS,
  BuilderToolName,
  builderToolList,
  McpToolName,
} from '@10db/contracts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { startDaemon } from '../src/daemon';
import type { RunningDaemon } from '../src/daemon';
import { FakeAdapter } from '../src/sessions';
import { createTempRepo, tempDir } from './fixtures';
import { startDaemonWithProfiles } from './daemon-with-profiles';

let data: { path: string; cleanup(): void };
let repo: { path: string; cleanup(): void };
let daemon: RunningDaemon;
let client: Client;
/** Starts a daemon and connects the builder client to it; `extra` adds to the daemon's options. */
async function boot(extra: Partial<Parameters<typeof startDaemon>[0]> = {}) {
  daemon = await startDaemonWithProfiles({
    sandbox: null,
    dataDir: data.path,
    port: 0,
    adapter: new FakeAdapter({}),
    logLevel: 'debug',
    caffeinate: () => null,
    watch: false,
    // A tick long enough that a started task stays where the test left it.
    tickMs: 3_600_000,
    // No lane is free, so a started task stays queued and can be held.
    caps: { global: 0 },
    ...extra,
  });
  client = new Client({ name: 'test', version: '0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${daemon.url}/builder/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${daemon.token}` } },
    }),
  );
}
beforeEach(async () => {
  data = tempDir('builder mcp');
  repo = createTempRepo();
  await boot();
});
afterEach(async () => {
  await client.close();
  await daemon.stop();
  repo.cleanup();
  data.cleanup();
});

describe('the builder MCP endpoint', () => {
  it('lists exactly the builder tools, none of them a lane tool', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(builderToolList().map((t) => t.name));
    const lane = new Set<string>(Object.values(McpToolName));
    expect(tools.filter((t) => lane.has(t.name))).toEqual([]);
    expect(tools.map((t) => t.name).sort()).toEqual(Object.values(BuilderToolName).sort());
  });

  it('sends the drafting instructions', () => {
    expect(client.getInstructions()).toBe(BUILDER_INSTRUCTIONS);
  });
});
