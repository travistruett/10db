import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProjectDto, TaskDto, WorkstreamDto } from '@10db/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { RunningDaemon } from '../src/daemon';
import { FakeAdapter, type FakeScriptBook } from '../src/sessions';
import { runAcceptanceChecks } from '../scripts/acceptance-checks';
import { apiClient } from './api-client';
import { createTempRepo, handoffArgs, tempDir, waitForAsync } from './fixtures';
import { startDaemonWithProfiles } from './daemon-with-profiles';

const write = (path: string) => ({
  do: 'tool' as const,
  toolName: 'Write',
  input: { file_path: path, content: `${path}\n` },
});
const commit = (opId: string, path: string) => ({
  do: 'mcp' as const,
  tool: 'commit',
  args: { opId, paths: [path], message: `Add ${path}` },
});
const turn = { do: 'turn_complete' as const };

const BOOK: FakeScriptBook = {
  Alpha: [
    [
      write('src/a/one.txt'),
      commit('op-a-0001', 'src/a/one.txt'),
      { do: 'context', percentage: 72 },
      { do: 'await_message', contains: 'write_handoff' },
      { do: 'mcp', tool: 'write_handoff', args: handoffArgs('op-a-hand1', 'Add src/a/two.txt') },
      turn,
    ],
    [write('src/a/two.txt'), commit('op-a-0002', 'src/a/two.txt'), turn],
  ],
  Beta: [
    [
      {
        do: 'tool',
        toolName: 'AskUserQuestion',
        input: {
          questions: [
            {
              question: 'Which greeting?',
              header: 'Greeting',
              options: [
                { label: 'Hello', description: '' },
                { label: 'Howdy', description: '' },
              ],
              multiSelect: false,
            },
          ],
        },
      },
      {
        do: 'tool',
        toolName: 'mcp__mantine__search_mantine_docs',
        input: { query: 'Button' },
      },
      write('src/b/one.txt'),
      commit('op-b-0001', 'src/b/one.txt'),
      turn,
    ],
  ],
};

let repo: { path: string; cleanup(): void };
let data: { path: string; cleanup(): void };
let daemon: RunningDaemon;

beforeAll(async () => {
  repo = createTempRepo();
  data = tempDir('acceptance-checks');
  daemon = await startDaemonWithProfiles({
    sandbox: null,
    dataDir: data.path,
    port: 0,
    adapter: new FakeAdapter(BOOK),
    logLevel: 'info',
    caffeinate: () => null,
    watch: false,
  });
  // Every call names the zod schema its response is parsed with, so a changed response fails here.
  const api = apiClient(daemon.url, daemon.token);
  const project = await api.post('/projects', ProjectDto, {
    name: 'checks',
    repoPath: repo.path,
    gateCommand: 'test -d src',
    defaultRigor: 'light',
    maxLanes: 2,
    areas: [
      { name: 'a', globs: ['src/a/**'] },
      { name: 'b', globs: ['src/b/**'] },
    ],
  });
  for (const [title, area] of [
    ['Alpha', 'a'],
    ['Beta', 'b'],
  ] as const) {
    const task = await api.post(`/projects/${project.id}/tasks`, TaskDto, {
      title,
      acceptanceCriteria: ['file exists'],
      areas: [area],
    });
    await api.post(`/tasks/${task.id}/start`, WorkstreamDto);
  }
  // Beta asks a question and then calls a repo MCP tool. Nobody watches a Board task, so the
  // question is answered at once and the tool call skipped, both kept (T4).
  await waitForAsync(async () => {
    const all = await api.get('/workstreams?active=false', z.array(WorkstreamDto));
    return all.length === 2 && all.every((w) => w.state === 'DONE') ? all : undefined;
  });
  await daemon.stop();
}, 60_000);

afterAll(() => {
  repo.cleanup();
  data.cleanup();
});

/** The files the fake run commits. */
const FAKE_OUTPUTS = ['src/a/one.txt', 'src/a/two.txt', 'src/b/one.txt'];

const byName = async (
  overrides: {
    logText?: string;
    minTasks?: number;
    envKeys?: readonly string[] | null;
    server?: string;
    outputs?: readonly string[];
  } = {},
) => {
  const checks = await runAcceptanceChecks({
    dbPath: join(data.path, '10db.sqlite'),
    repoPath: repo.path,
    logText: overrides.logText ?? readFileSync(join(data.path, 'logs', 'daemon.log'), 'utf8'),
    minTasks: overrides.minTasks ?? 2,
    mcpServer: overrides.server ?? 'mantine',
    mcpServerEnvKeys: overrides.envKeys ?? null,
    outputs: overrides.outputs ?? FAKE_OUTPUTS,
  });
  return new Map(checks.map((c) => [c.name, c]));
};

describe('runAcceptanceChecks', () => {
  it('passes every engine check on a clean fake-adapter run', async () => {
    const checks = await byName();
    for (const name of [
      'tasks done',
      'task outputs',
      'gate evidence',
      'handoff crossed',
      'question answered',
      'no duplicate commits',
      'no duplicate tool ops',
      'events replay without gaps',
    ]) {
      expect(checks.get(name), name).toMatchObject({ ok: true });
    }
  });

  describe('task outputs', () => {
    // A task's gate checks only what holds at every step, so this check is what proves each task wrote its file.
    it.each([
      { name: 'every expected file committed', outputs: FAKE_OUTPUTS, ok: true },
      {
        name: 'one expected file never committed',
        outputs: [...FAKE_OUTPUTS, 'src/b/two.txt'],
        ok: false,
      },
    ])('$name', async ({ outputs, ok }) => {
      expect((await byName({ outputs })).get('task outputs')).toMatchObject({ ok });
    });
  });
});
