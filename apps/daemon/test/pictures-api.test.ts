import {
  APP_URL_IS_DAEMON,
  EventType,
  PassOpenedDto,
  PicturesStatusDto,
  ProjectDto,
  TaskDto,
  TaskScreensDto,
  WorkstreamDto,
  mintId,
} from '@10db/contracts';
import { insertGoal, insertTaskScreen, latestEventSeq } from '@10db/db';
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
  daemon = await startDaemon();
});
/** The daemon on the test's data dir, with the fake browser; called again for a restart. */
function startDaemon(): Promise<RunningDaemon> {
  return startDaemonWithProfiles({
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
}

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

describe("a goal's pictures", () => {
  it("leads a goal task's screens with the newest after, else before, of each other task on its route", async () => {
    const p = await project();
    const made = daemon.state.write((ctx) =>
      insertGoal(ctx, p.id, {
        brief: {
          title: 'Rework people',
          objective: 'Rework the people screens.',
          tasks: ['done', 'started', 'elsewhere', 'next'].map((key) => ({
            key,
            title: `People ${key}`,
            areas: key === 'elsewhere' ? ['src'] : ['people'],
          })),
        },
      }),
    );
    const id = (key: string) => {
      const taskId = made.taskIds.get(key);
      if (taskId === undefined) throw new Error(`no ${key}`);
      return taskId;
    };
    const shot = (key: string, kind: 'before' | 'after', route = '/people') =>
      daemon.state.write((ctx) =>
        insertTaskScreen(ctx, {
          taskId: id(key),
          turnId: null,
          kind,
          route,
          viewport: { width: 1440, height: 900 },
          theme: 'default',
          sha256: `${key}${kind}`.padEnd(64, '0').replace(/[^0-9a-f]/g, 'a'),
          size: 1,
          width: 1440,
          height: 900,
          storedPath: `${data.path}/screens/x.png`,
          keptSha: null,
        }),
      );
    shot('done', 'before');
    const after = shot('done', 'after');
    const before = shot('started', 'before');
    shot('elsewhere', 'after', '/org');
    shot('next', 'before');
    const screens = await api().get(`/tasks/${id('next')}/screens`, TaskScreensDto);
    expect(screens.fromGoal.map((s) => s.id)).toEqual([after?.id, before?.id]);
    expect(screens.screens.map((s) => s.kind)).toEqual(['before']);
  });
});

describe('pruning', () => {
  it('prunes a turn picture of a task done 15 days ago when the daemon starts', async () => {
    const p = await project();
    const task = await api().post(`/projects/${p.id}/tasks`, TaskDto, {
      title: 'People: old',
      acceptanceCriteria: ['x'],
      areas: ['people'],
    });
    const screenId = mintId('TaskScreen');
    const db = daemon.state.db.$client;
    db.prepare(
      `INSERT INTO task_screens (id, task_id, kind, route, viewport, theme, sha256, size, width, height,
        stored_path, created_at) VALUES (?, ?, 'turn', '/people', '{"width":1440,"height":900}',
        'default', ?, 1, 1440, 900, ?, ?)`,
    ).run(screenId, task.id, 'f'.repeat(64), `${data.path}/screens/ff/x.png`, daemon.state.now());
    const longAgo = new Date(Date.now() - 15 * 24 * 60 * 60_000).toISOString();
    db.prepare(`UPDATE tasks SET status = 'done', updated_at = ? WHERE id = ?`).run(
      longAgo,
      task.id,
    );
    await daemon.stop();
    daemon = await startDaemon();
    const row = z
      .object({ pruned_at: z.string().nullable() })
      .parse(
        daemon.state.db.$client
          .prepare('SELECT pruned_at FROM task_screens WHERE id = ?')
          .get(screenId),
      );
    expect(row.pruned_at).not.toBeNull();
  });
});

describe("the daemon's own address", () => {
  it('is refused as an app address', async () => {
    const made = await api().post('/projects', ProjectDto, {
      name: 'demo',
      repoPath: repo.path,
      gateCommand: null,
      areas: [PEOPLE],
    });
    const port = new URL(daemon.url).port;
    const res = await fetch(`${daemon.url}/projects/${made.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${daemon.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ appUrl: `http://localhost:${port}` }),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain(APP_URL_IS_DAEMON);
    expect((await api().get('/projects', ProjectDto.array()))[0]?.appUrl).toBeNull();
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
