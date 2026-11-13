import {
  AccountCreatedDto,
  InboxItemDto,
  Provider,
  ProjectDto,
  TaskDto,
  WorkstreamDto,
} from '@10db/contracts';
import { listModelProfiles, setAppSetting } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseCatalogue } from '../src/catalogue';
import { startDaemon, type RunningDaemon } from '../src/daemon';
import { FakeAdapter } from '../src/sessions';
import { apiClient } from './api-client';
import { createTempRepo, tempDir, waitForAsync, type TempDir } from './fixtures';
import { readModelsDevFixture } from './models-dev-fixture';

// A daemon that fetches nothing. The profiles come from the catalogue it holds, so it has none until one is stored
// or a snapshot is given, and a lane that finds none waits instead of retrying every tick.

let daemon: RunningDaemon;
let repo: TempDir;
let data: TempDir;
beforeEach(() => {
  repo = createTempRepo();
  data = tempDir('model list wait');
});
afterEach(async () => {
  await daemon.stop();
  repo.cleanup();
  data.cleanup();
});

const start = async (catalogueSnapshot?: string) => {
  daemon = await startDaemon({
    sandbox: null,
    dataDir: data.path,
    port: 0,
    adapter: new FakeAdapter({
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
            args: { opId: 'op-wait-0001', paths: ['src/a/one.txt'], message: 'Add one' },
          },
          { do: 'turn_complete' },
        ],
      ],
    }),
    logLevel: 'warn',
    caffeinate: () => null,
    watch: false,
    tickMs: 50,
    ...(catalogueSnapshot ? { catalogueSnapshot } : {}),
  });
  return apiClient(daemon.url, daemon.token);
};

describe('a daemon with no catalogue to build profiles from', () => {
  it('holds a lane with one card, then runs it on a real scheduler tick once an account is added and profiles are built', async () => {
    const api = await start();
    const project = await api.post('/projects', ProjectDto, {
      name: 'wait',
      repoPath: repo.path,
      gateCommand: 'test -d src',
      defaultRigor: 'light',
      areas: [{ name: 'a', globs: ['src/a/**'] }],
    });
    const task = await api.post(`/projects/${project.id}/tasks`, TaskDto, {
      title: 'Alpha',
      acceptanceCriteria: ['the file exists'],
      areas: ['a'],
    });
    await api.post(`/tasks/${task.id}/start`, WorkstreamDto);

    const cards = () => api.get('/inbox?state=OPEN', z.array(InboxItemDto));
    const card = await waitForAsync(async () =>
      (await cards()).find((c) => c.title.endsWith('is waiting for its model list')),
    );
    expect(card.projectId).toBe(project.id);
    // The catalogue arrives (a fetch would store it); adding an account rebuilds the profiles from it.
    const catalogue = parseCatalogue(readModelsDevFixture());
    daemon.state.write((ctx) => {
      setAppSetting(ctx, 'catalogue.document', {
        fetchedAt: new Date().toISOString(),
        catalogue,
      });
    });
    await api.post('/accounts', AccountCreatedDto, {
      kind: 'claude_subscription',
      label: 'Second plan',
    });

    const done = await waitForAsync(async () => {
      const all = await api.get('/workstreams?active=false', z.array(WorkstreamDto));
      return all.find((w) => w.taskId === task.id && w.state === 'DONE');
    }, 30_000);
    expect(done.state).toBe('DONE');
    expect(
      (await cards()).filter((c) => c.title.endsWith('is waiting for its model list')),
    ).toEqual([]);
  }, 60_000);

  it('builds the profiles of an account added after start from the snapshot, with the fetch off', async () => {
    const api = await start(new URL('fixtures/catalogue.json', import.meta.url).pathname);
    const codex = () =>
      listModelProfiles(daemon.state.db).filter((p) => p.provider === Provider.Codex);
    expect(codex()).toEqual([]);
    await api.post('/accounts', AccountCreatedDto, { kind: 'codex_signin', label: 'ChatGPT' });
    expect(codex().length).toBeGreaterThan(0);
  });
});
