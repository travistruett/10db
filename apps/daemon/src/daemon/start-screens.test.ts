import {
  ProjectDto,
  ShapeDto,
  ShapeMessageDto,
  ShapeViewDto,
  TaskDto,
  ScreenRenderRequest,
  mintId,
} from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { apiClient } from '../../test/api-client';
import { createTempRepo, tempDir, waitForAsync } from '../../test/fixtures';
import { pngImage } from '../../test/png';
import { FakeAdapter, scriptedShapeBehaviour } from '../sessions';
import { RENDER_READS } from '../screens';
import { startDaemon, type RunningDaemon } from './index';

// Shape spec §5.5: see_screen on a started daemon. A session asks, a window (played here over HTTP)
// draws with a token that reads and writes nothing else, and the session gets the picture. The
// database is dumped before and after, so "taking a screenshot changes nothing" is checked there.

let dir: { path: string; cleanup(): void };
let repo: { path: string; cleanup(): void };
let daemon: RunningDaemon | null;
beforeEach(() => {
  dir = tempDir('daemon');
  repo = createTempRepo();
  daemon = null;
});
afterEach(async () => {
  await daemon?.stop();
  repo.cleanup();
  dir.cleanup();
});

interface Sqlite {
  prepare(sql: string): { all(): unknown[]; pluck(): { all(): unknown[] } };
}

/** Every row of every table, as text, by table: any change to any of them shows. */
function dump(running: RunningDaemon): Record<string, string> {
  const raw = (running.state.db as unknown as { $client: Sqlite }).$client;
  const tables = raw
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%fts%'",
    )
    .pluck()
    .all() as string[];
  return Object.fromEntries(
    tables.map((t) => [t, JSON.stringify(raw.prepare(`SELECT * FROM "${t}"`).all())]),
  );
}
const changed = (before: Record<string, string>, after: Record<string, string>): string[] =>
  Object.keys(after).filter((t) => before[t] !== after[t]);

async function startOnTheFake(): Promise<ReturnType<typeof apiClient>> {
  const adapter = new FakeAdapter({});
  adapter.shapeBehaviour = scriptedShapeBehaviour();
  daemon = await startDaemon({
    sandbox: null,
    dataDir: dir.path,
    port: 0,
    adapter,
    logLevel: 'warn',
    caffeinate: () => null,
    watch: false,
  });
  return apiClient(daemon.url, daemon.token);
}

const ui = (running: RunningDaemon, init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: { Authorization: `Bearer ${running.token}`, 'content-type': 'application/json' },
});
const withToken = (token: string, method = 'GET', body?: unknown): RequestInit => ({
  method,
  headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

describe('see_screen on a started daemon', () => {
  it('draws the Board for the session through a window that reads and changes nothing', async () => {
    const api = await startOnTheFake();
    const running = daemon;
    if (running === null) throw new Error('no daemon');
    const project = await api.post('/projects', ProjectDto, {
      name: 'demo',
      repoPath: repo.path,
      gateCommand: 'true',
      areas: [{ name: 'src', globs: ['src/**'] }],
    });
    const task = await api.post(`/projects/${project.id}/tasks`, TaskDto, {
      title: 'Alpha',
      acceptanceCriteria: ['it works'],
      areas: ['src'],
    });
    const shape = await api.post(`/projects/${project.id}/shapes`, ShapeDto, {});

    // The window waits for work, as the app's does, before the session asks.
    const claim = fetch(`${running.url}/screens/claim`, ui(running, { method: 'POST' }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    await api.post(`/shapes/${shape.id}/messages`, ShapeMessageDto, {
      text: 'Please see the board at 900',
    });
    const request = ScreenRenderRequest.parse(await (await claim).json());
    expect(request).toMatchObject({
      screen: 'board',
      projectId: project.id,
      shapeId: shape.id,
      width: 900,
      height: 900,
    });

    // With the token, the window reads every screen's data and no more, and the database is as it was.
    const before = dump(running);
    for (const { route } of RENDER_READS) {
      const path = route
        .replace(':projectId', project.id)
        .replace(':taskId', task.id)
        .replace(':shapeId', shape.id)
        .replace(':goalId', mintId('Goal'))
        .replace(/:[A-Za-z]+/, mintId('Workstream'));
      const res = await fetch(`${running.url}${path}`, withToken(request.token));
      expect([401, 403], `${path} was refused`).not.toContain(res.status);
    }
    const refused: [string, string, unknown?][] = [
      ['GET', `/goals/${mintId('Goal')}/digest`],
      ['GET', '/system'],
      ['GET', '/system?recheck=1'],
      ['GET', `/accounts/${mintId('Account')}/identity`],
      ['GET', `/workstreams/${mintId('Workstream')}/changes`],
      ['GET', '/events'],
      ['GET', `/events/stream?token=${request.token}`],
      ['POST', `/projects/${project.id}/tasks`, { title: 'x', acceptanceCriteria: ['y'] }],
      ['POST', `/tasks/${task.id}/hold`],
      ['POST', `/tasks/${task.id}/start`],
      ['POST', '/inbox/inb_x/answer', { optionId: 'x' }],
      ['PUT', '/settings/lane-permissions', { autoMode: false }],
      ['PATCH', `/tasks/${task.id}`, { title: 'Renamed' }],
      ['POST', '/screens/claim'],
      ['POST', `/screens/${request.id}/image`, {}],
      ['POST', `/screens/${request.id}/refuse`, { reason: 'x' }],
      ['POST', '/builder/mcp', {}],
    ];
    for (const [method, path, body] of refused) {
      const res = await fetch(`${running.url}${path}`, withToken(request.token, method, body));
      expect(res.status, `${method} ${path}`).toBe(403);
    }
    // The session endpoint finds the token belongs to no session.
    const mcp = await fetch(`${running.url}/mcp`, withToken(request.token, 'POST', {}));
    expect(mcp.status).toBe(401);
    expect(changed(before, dump(running))).toEqual([]);

    // The window answers with the picture, and the session is given it.
    const picture = pngImage(900, 900);
    const delivered = await fetch(
      `${running.url}/screens/${request.id}/image`,
      ui(running, {
        method: 'POST',
        body: JSON.stringify({
          mediaType: 'image/png',
          data: picture.toString('base64'),
          width: 900,
          height: 900,
        }),
      }),
    );
    expect(delivered.status).toBe(204);
    await waitForAsync(async () => {
      const view = await api.get(`/shapes/${shape.id}`, ShapeViewDto);
      return view.messages.some((m) => m.body.startsWith('I saw the board'));
    });
    const view = await api.get(`/shapes/${shape.id}`, ShapeViewDto);
    const bodies = view.messages.map((m) => [m.kind, m.body]);
    expect(bodies).toContainEqual(['tool', 'see_screen · board · 900×900']);
    expect(bodies).toContainEqual(['text', 'I saw the board: 1 picture.']);
    const row = view.messages.find((m) => m.kind === 'screen');
    expect(JSON.parse(row?.body ?? '{}')).toMatchObject({ screen: 'board', name: '0001.png' });

    // The builder sees the same image the session was given.
    const kept = await fetch(`${running.url}/shapes/${shape.id}/screens/0001.png`, ui(running));
    expect(kept.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await kept.arrayBuffer())).toEqual(picture);

    // Its token died with the request.
    expect((await fetch(`${running.url}/projects`, withToken(request.token))).status).toBe(401);

    // Nothing but the conversation's own rows differs from before: no task, batch, card, goal mark or setting.
    const moved = changed(before, dump(running));
    for (const table of [
      'projects',
      'tasks',
      'batches',
      'workstreams',
      'inbox_items',
      'goals',
      'goal_views',
      'app_settings',
      'decisions',
    ])
      expect(moved, table).not.toContain(table);
  });

  it('refuses at once, saying why, when no window is open to draw it', async () => {
    const api = await startOnTheFake();
    const project = await api.post('/projects', ProjectDto, {
      name: 'demo',
      repoPath: repo.path,
      gateCommand: 'true',
      areas: [{ name: 'src', globs: ['src/**'] }],
    });
    const shape = await api.post(`/projects/${project.id}/shapes`, ShapeDto, {});
    await api.post(`/shapes/${shape.id}/messages`, ShapeMessageDto, {
      text: 'Please see the factory',
    });
    await waitForAsync(async () => {
      const view = await api.get(`/shapes/${shape.id}`, ShapeViewDto);
      return view.messages.some((m) => m.body.startsWith('I could not see it'));
    });
    const view = await api.get(`/shapes/${shape.id}`, ShapeViewDto);
    expect(view.messages.find((m) => m.body.startsWith('I could not see it'))?.body).toMatch(
      /window isn't open/,
    );
    expect(view.messages.filter((m) => m.kind === 'screen')).toEqual([]);
    expect(view.messages.map((m) => m.body)).toContainEqual(
      expect.stringMatching(/^see_screen · refused · .*window isn't open/),
    );
  });

  it('is checked by a dump that does see a write: the UI token’s own setting change shows in it', async () => {
    await startOnTheFake();
    const running = daemon;
    if (running === null) throw new Error('no daemon');
    const before = dump(running);
    const res = await fetch(
      `${running.url}/settings/lane-permissions`,
      ui(running, { method: 'PUT', body: JSON.stringify({ autoMode: false }) }),
    );
    expect(res.status).toBe(200);
    expect(changed(before, dump(running))).toContain('app_settings');
  });

  it('answers 404 to a picture nobody is waiting for, and to a kept one that is not there', async () => {
    await startOnTheFake();
    const running = daemon;
    if (running === null) throw new Error('no daemon');
    const stale = await fetch(
      `${running.url}/screens/nope/image`,
      ui(running, {
        method: 'POST',
        body: JSON.stringify({ mediaType: 'image/png', data: 'AAAA', width: 1, height: 1 }),
      }),
    );
    expect(stale.status).toBe(404);
    const missing = await fetch(
      `${running.url}/shapes/${mintId('Shape')}/screens/0001.png`,
      ui(running),
    );
    expect(missing.status).toBe(404);
    expect(z.object({ error: z.string() }).parse(await missing.json()).error).toBe('not_found');
  });
});
