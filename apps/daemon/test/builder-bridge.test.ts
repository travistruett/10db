import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BuilderToolName, ProjectDto } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { startDaemon, type RunningDaemon } from '../src/daemon';
import { FakeAdapter } from '../src/sessions';
import { apiClient } from './api-client';
import { createTempRepo, tempDir } from './fixtures';
import { initialize, spawnStdioRpc, type StdioRpc } from './stdio-rpc';

const daemonRoot = resolve(import.meta.dirname, '..');

let data: { path: string; cleanup(): void };
let repo: { path: string; cleanup(): void };
let daemon: RunningDaemon | null = null;
let rpc: StdioRpc;

const startOptions = () => ({
  sandbox: null,
  dataDir: data.path,
  port: 0,
  adapter: new FakeAdapter({}),
  logLevel: 'warn' as const,
  caffeinate: () => null,
  watch: false as const,
  tickMs: 3_600_000,
});

beforeEach(async () => {
  data = tempDir('builder bridge');
  repo = createTempRepo();
  daemon = await startDaemon(startOptions());
  // The bridge as a client starts it: the entry file under tsx, with the client's own
  // environment, which holds a daemon variable that would not parse.
  rpc = spawnStdioRpc(
    process.execPath,
    ['--import', 'tsx', join(daemonRoot, 'src/builder-mcp.ts')],
    {
      cwd: daemonRoot,
      env: {
        PATH: process.env['PATH'] ?? '/usr/bin:/bin',
        HOME: data.path,
        TMPDIR: tmpdir(),
        GIT_CONFIG_GLOBAL: '/dev/null',
        TENDB_DATA_DIR: data.path,
        TENDB_PORT: 'abc',
      },
    },
  );
});
afterEach(async () => {
  await rpc.close();
  await daemon?.stop();
  repo.cleanup();
  data.cleanup();
});

const Text = z.object({ content: z.array(z.object({ type: z.string(), text: z.string() })) });
const callTool = (name: string, args: Record<string, unknown>) =>
  rpc.request('tools/call', { name, arguments: args });

async function seedProject() {
  if (!daemon) throw new Error('no daemon');
  return apiClient(daemon.url, daemon.token).post('/projects', ProjectDto, {
    name: 'demo',
    repoPath: repo.path,
    gateCommand: 'true',
    areas: [{ name: 'src', globs: ['src/**'] }],
  });
}

describe('the builder bridge over stdio, against a real daemon', () => {
  it('initializes, lists the tools and creates a task, each answer carrying its request id', async () => {
    const init = await initialize(rpc);
    expect(init.result).toMatchObject({ serverInfo: { name: '10db-builder' } });

    const list = await rpc.request('tools/list');
    expect(list.message.id).toBe(list.id);
    expect(
      z.object({ tools: z.array(z.object({ name: z.string() })) }).parse(list.message.result).tools,
    ).toHaveLength(Object.values(BuilderToolName).length);

    const project = await seedProject();
    const created = await callTool('create_task', {
      projectId: project.id,
      title: 'From a bridge',
      acceptanceCriteria: ['It exists'],
      areas: ['src'],
    });
    expect(created.message.id).toBe(created.id);
    const text = Text.parse(created.message.result).content[0]?.text ?? '';
    const task = z.object({ id: z.string() }).parse(JSON.parse(text));
    const listed = await callTool('list_tasks', { projectId: project.id });
    expect(listed.message.id).toBe(listed.id);
    expect(Text.parse(listed.message.result).content[0]?.text).toContain(task.id);
    expect(rpc.strayStdout).toEqual([]);
  });

  it('answers an error with the request id once the daemon has stopped', async () => {
    await initialize(rpc);
    await daemon?.stop();
    daemon = null;
    const called = await callTool('list_flows', {});
    expect(called.message.id).toBe(called.id);
    expect(called.message.error?.message).toContain('10db is not running');
    // The tool list still works without a daemon.
    expect((await rpc.request('tools/list')).message.error).toBeUndefined();
  });

  it('works again on the new port after the daemon restarts', async () => {
    await initialize(rpc);
    const first = await callTool('list_flows', {});
    expect(first.message.error).toBeUndefined();
    const oldPort = daemon?.port;
    await daemon?.stop();
    daemon = await startDaemon(startOptions());
    expect(daemon.port).not.toBe(oldPort);
    const again = await callTool('list_flows', {});
    expect(again.message.id).toBe(again.id);
    expect(again.message.error).toBeUndefined();
  });

  it('answers an error with the request id when the token is wrong', async () => {
    await initialize(rpc);
    writeFileSync(join(data.path, 'ui-token'), 'not-the-token');
    const called = await callTool('list_flows', {});
    expect(called.message.id).toBe(called.id);
    expect(called.message.error?.message).toContain('refused');
  });

  it('answers not running when daemon.json is gone', async () => {
    await initialize(rpc);
    rmSync(join(data.path, 'daemon.json'));
    const called = await callTool('list_flows', {});
    expect(called.message.error?.message).toContain('10db is not running');
  });
});
