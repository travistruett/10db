import { ProjectDto, TaskDto, WorkstreamDto, isModelTier } from '@10db/contracts';
import { listModelProfiles } from '@10db/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunningDaemon } from '../src/daemon';
import { startDaemon } from '../src/daemon';
import { FakeAdapter } from '../src/sessions';
import { apiClient, quickFlowId } from './api-client';
import { createTempRepo, tempDir, waitForAsync, type TempDir } from './fixtures';

const SNAPSHOT = new URL('fixtures/catalogue.json', import.meta.url).pathname;

// The daemon an e2e run or the live acceptance starts: no fetch from models.dev, the snapshot file given, and
// no profiles written by hand. It is the one place a started daemon is the cheapest rung that can fail: the
// profiles are built in `startDaemon`, and only a started daemon plans and launches a task from them.
describe('a daemon started with the catalogue fetch off and a snapshot', () => {
  const adapter = new FakeAdapter({
    Alpha: [
      [
        {
          do: 'tool',
          toolName: 'Write',
          input: { file_path: 'src/a/one.txt', content: 'one\n' },
        },
        {
          do: 'mcp',
          tool: 'commit',
          args: { opId: 'op-snap-0001', paths: ['src/a/one.txt'], message: 'Add one' },
        },
        { do: 'turn_complete' },
      ],
    ],
  });
  const launched: string[] = [];
  let daemon: RunningDaemon;
  let repo: TempDir;
  let data: TempDir;

  beforeAll(async () => {
    adapter.seen = (spec) => {
      launched.push(spec.model);
      return {};
    };
    repo = createTempRepo();
    data = tempDir('catalogue snapshot start');
    daemon = await startDaemon({
      sandbox: null,
      dataDir: data.path,
      port: 0,
      adapter,
      logLevel: 'warn',
      caffeinate: () => null,
      watch: false,
      catalogueSnapshot: SNAPSHOT,
    });
  });
  afterAll(async () => {
    await daemon.stop();
    repo.cleanup();
    data.cleanup();
  });

  it('has model profiles at start, and runs a task on a real model with none seeded', async () => {
    expect(listModelProfiles(daemon.state.db).length).toBeGreaterThan(0);
    const api = apiClient(daemon.url, daemon.token);
    const project = await api.post('/projects', ProjectDto, {
      name: 'snapshot',
      repoPath: repo.path,
      gateCommand: 'test -d src',
      flowId: await quickFlowId(api),
      areas: [{ name: 'a', globs: ['src/a/**'] }],
    });
    const task = await api.post(`/projects/${project.id}/tasks`, TaskDto, {
      title: 'Alpha',
      acceptanceCriteria: ['the file exists'],
      areas: ['a'],
    });
    await api.post(`/tasks/${task.id}/start`, WorkstreamDto);

    const done = await waitForAsync(async () => {
      const all = await api.get('/workstreams?active=false', WorkstreamDto.array());
      return all.find((w) => w.taskId === task.id && w.state === 'DONE');
    }, 30_000);

    expect(done.state).toBe('DONE');
    const profiled = new Set(listModelProfiles(daemon.state.db).map((p) => p.model));
    expect(launched.length).toBeGreaterThan(0);
    for (const model of launched) {
      expect(isModelTier(model)).toBe(false);
      expect(profiled.has(model)).toBe(true);
    }
  }, 60_000);
});
