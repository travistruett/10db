import {
  EventType,
  PassOpenedDto,
  PicturesStatusDto,
  ProjectDto,
  TaskDto,
  TaskScreensDto,
  WorkstreamDto,
} from '@10db/contracts';
import { latestEventSeq } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { RunningDaemon } from '../src/daemon';
import { FakeAdapter } from '../src/sessions';
import { apiClient, quickFlowId } from './api-client';
import { startDaemonWithProfiles } from './daemon-with-profiles';
import { FakeCamera } from './fake-camera';
import { createTempRepo, tempDir, waitForAsync, type TempDir } from './fixtures';
import { pngOfSize } from './png';

// Workbench spec §10, §11, §13: a daemon with a fake browser takes a task's pictures, serves them to the
// Workbench and the drawer by id, and says how its browser and sign-in stand. A task in Your folder gets
// its before ahead of its first edit and its after once done.

const APP = 'http://localhost:8800';
const PEOPLE = {
  name: 'people',
  globs: ['src/people/**'],
  role: 'page' as const,
  route: '/people',
};

let data: TempDir;
let repo: TempDir;
let daemon: RunningDaemon;
let cam: FakeCamera;
/** The event log's head as each shot was asked. */
let shotAtSeq: number[];

beforeEach(async () => {
  data = tempDir('pictures api');
  repo = createTempRepo();
  cam = new FakeCamera();
  shotAtSeq = [];
  cam.onShoot = () => {
    shotAtSeq.push(latestEventSeq(daemon.state.db));
  };
  daemon = await startDaemonWithProfiles({
    sandbox: null,
    dataDir: data.path,
    port: 0,
    adapter: new FakeAdapter({
      'People: UI work': [[{ do: 'consume' }, { do: 'await_message', contains: 'never sent' }]],
      'People: tidy': [
        [
          {
            do: 'tool',
            toolName: 'Write',
            input: { file_path: 'src/people/page.tsx', content: 'tidy\n' },
          },
          {
            do: 'mcp',
            tool: 'commit',
            args: {
              opId: 'op-pictures-01',
              paths: ['src/people/page.tsx'],
              message: 'Tidy people',
            },
          },
          { do: 'turn_complete' },
        ],
      ],
    }),
    logLevel: 'warn',
    caffeinate: () => null,
    watch: false,
    pictures: { kind: 'given', camera: cam, prepare: () => undefined },
  });
});
afterEach(async () => {
  await daemon.stop();
  repo.cleanup();
  data.cleanup();
});

const api = () => apiClient(daemon.url, daemon.token);
const get = (path: string) =>
  fetch(`${daemon.url}${path}`, { headers: { Authorization: `Bearer ${daemon.token}` } });

async function project(more: Record<string, unknown> = {}): Promise<ProjectDto> {
  const made = await api().post('/projects', ProjectDto, {
    name: 'demo',
    repoPath: repo.path,
    gateCommand: 'test -d src',
    areas: [PEOPLE, { name: 'src', globs: ['src/**'], role: 'shared' }],
    ...more,
  });
  return api().patch(`/projects/${made.id}`, ProjectDto, { appUrl: APP });
}

describe("a task's pictures over HTTP", () => {
  it('lists them, serves one as a private PNG, and answers 404 once it is pruned', async () => {
    const p = await project();
    const task = await api().post(`/projects/${p.id}/tasks`, TaskDto, {
      title: 'People: UI work',
      acceptanceCriteria: ['x'],
      areas: ['people'],
    });
    await api().post(`/projects/${p.id}/passes`, PassOpenedDto, {
      name: 'Polish',
      taskIds: [task.id],
    });
    const listed = await waitForAsync(async () => {
      const screens = await api().get(`/tasks/${task.id}/screens`, TaskScreensDto);
      return screens.screens.length > 0 ? screens : undefined;
    });
    expect(listed).toMatchObject({ taskId: task.id, fromGoal: [] });
    expect(listed.screens.map((s) => [s.kind, s.route, s.width, s.height])).toEqual([
      ['before', '/people', 1440, 900],
    ]);
    const id = listed.screens[0]?.id ?? '';

    const res = await get(`/screens/${id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(pngOfSize(1440, 900, 1));

    daemon.state.db.$client
      .prepare('UPDATE task_screens SET pruned_at = ? WHERE task_id = ?')
      .run(daemon.state.now(), task.id);
    expect((await get(`/screens/${id}`)).status).toBe(404);
    expect((await api().get(`/tasks/${task.id}/screens`, TaskScreensDto)).screens).toEqual([]);
  });

  it("says how the project's browser and sign-in stand", async () => {
    const p = await project();
    expect(await api().get(`/projects/${p.id}/pictures`, PicturesStatusDto)).toEqual({
      browser: { state: 'ready', problem: null },
      signIn: null,
    });
  });
});

describe('a task in Your folder', () => {
  it('has its before taken ahead of its first edit, and its after once done', async () => {
    const p = await project({ flowId: await quickFlowId(api()) });
    const task = await api().post(`/projects/${p.id}/tasks`, TaskDto, {
      title: 'People: tidy',
      acceptanceCriteria: ['the page is tidy'],
      areas: ['people'],
    });
    cam.version = 1;
    await api().post(`/tasks/${task.id}/start`, WorkstreamDto);
    await waitForAsync(async () => {
      const all = await api().get('/workstreams?active=false', WorkstreamDto.array());
      return all.find((w) => w.taskId === task.id && w.state === 'DONE');
    }, 30_000);
    const screens = await waitForAsync(async () => {
      const listed = await api().get(`/tasks/${task.id}/screens`, TaskScreensDto);
      return listed.screens.length === 2 ? listed.screens : undefined;
    });
    expect(screens.map((s) => s.kind)).toEqual(['before', 'after']);
    const firstWrite = z
      .object({ seq: z.number() })
      .parse(
        daemon.state.db.$client
          .prepare(
            "SELECT min(seq) AS seq FROM events WHERE type = ? AND json_extract(data, '$.tool.name') = 'Write'",
          )
          .get(EventType.SessionActivity),
      );
    expect(shotAtSeq[0]).toBeLessThan(firstWrite.seq);
  }, 60_000);
});
