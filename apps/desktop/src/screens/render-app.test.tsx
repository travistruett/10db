import { mintId } from '@10db/contracts';
import { render, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, server, TEST_CONNECTION } from '../test/daemon';
import { projectViewDto, taskDto } from '../test/fixtures';
import { RenderApp } from './render-app';
import type { RenderParams } from './render-params';

// Shape spec §5.5: the frame the window draws a screen in. It is the app, at one route, with the data
// it is given and nothing it could change.

const project = projectViewDto();
const params: RenderParams = {
  token: 'render-token',
  daemon: TEST_CONNECTION.url,
  projectId: project.id,
  screen: 'board',
  path: '/board',
};

interface Heard {
  readonly kind: string;
  readonly reason?: string;
}
let heard: Heard[];
let requests: { method: string; path: string; authorization: string | null }[];
const listen = (event: MessageEvent): void => {
  const data = event.data as Heard & { source?: string };
  if (data.source === 'tendb-screen') heard.push(data);
};
beforeEach(() => {
  heard = [];
  requests = [];
  window.addEventListener('message', listen);
  localStorage.clear();
  server.events.on('request:start', ({ request }) => {
    requests.push({
      method: request.method,
      path: new URL(request.url).pathname,
      authorization: request.headers.get('authorization'),
    });
  });
});
afterEach(() => {
  window.removeEventListener('message', listen);
  server.events.removeAllListeners();
});

const alpha = taskDto({ projectId: project.id, title: 'Alpha', boardStatus: 'ready' });
function serve(...overrides: Parameters<typeof server.use>): void {
  // A test's own handlers first: the first handler that matches answers.
  server.use(
    ...overrides,
    http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
    http.get(daemonUrl('/projects/:projectId/tasks'), () => HttpResponse.json([alpha])),
    http.get(daemonUrl('/projects/:projectId/board-columns'), () => HttpResponse.json([])),
    ...baseHandlers(),
  );
}

describe('a frame the window draws a screen in', () => {
  it('draws the screen with the render token on every request, and writes nothing', async () => {
    serve();
    render(<RenderApp params={params} />);
    expect(await screen.findByRole('button', { name: 'Alpha' })).toBeTruthy();
    await waitFor(() => {
      expect(heard).toEqual([{ source: 'tendb-screen', kind: 'ready' }]);
    });
    const daemon = requests.filter((r) => r.path !== '/events/stream');
    expect(daemon.length).toBeGreaterThan(0);
    for (const r of daemon) expect(r.authorization, r.path).toBe('Bearer render-token');
    expect(requests.filter((r) => r.method !== 'GET')).toEqual([]);
  });

  it('draws the screen alone: none of the shell’s navigation, status or settings', async () => {
    serve();
    render(<RenderApp params={params} />);
    await screen.findByRole('button', { name: 'Alpha' });
    expect(screen.queryByRole('link', { name: 'Settings' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Factory' })).toBeNull();
    expect(screen.queryByRole('navigation')).toBeNull();
    // Nothing of the shell's own reads is made either: no system check, no keep-awake, no stream.
    expect(requests.map((r) => r.path)).not.toContain('/system');
    expect(requests.map((r) => r.path)).not.toContain('/settings/keep-awake');
    expect(requests.map((r) => r.path)).not.toContain('/events/stream');
  });

  it('shows the project it was told to, and leaves the builder’s own selection alone', async () => {
    const other = projectViewDto({ id: mintId('Project'), name: 'other' });
    const asked: string[] = [];
    serve(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([other, project])),
      http.get(daemonUrl('/projects/:projectId/tasks'), ({ params: p }) => {
        asked.push(String(p['projectId']));
        return HttpResponse.json([alpha]);
      }),
    );
    localStorage.setItem('tendb.project', JSON.stringify(other.id));
    render(<RenderApp params={params} />);
    await screen.findByRole('button', { name: 'Alpha' });
    expect(new Set(asked)).toEqual(new Set([project.id]));
    expect(localStorage.getItem('tendb.project')).toBe(JSON.stringify(other.id));
  });

  it('is ready though a read a screen does not need is refused: a 403 is the daemon holding the line', async () => {
    serve(
      http.get(daemonUrl('/workstreams'), () =>
        HttpResponse.json(
          { error: 'forbidden', message: 'A screen is drawn read-only' },
          { status: 403 },
        ),
      ),
    );
    render(<RenderApp params={params} />);
    await screen.findByRole('button', { name: 'Alpha' });
    await waitFor(() => {
      expect(heard.map((h) => h.kind)).toEqual(['ready']);
    });
  });

  it('refuses, saying why, when the daemon will not give the screen its data', async () => {
    serve(
      http.get(daemonUrl('/projects/:projectId/tasks'), () =>
        HttpResponse.json({ error: 'unauthorized' }, { status: 401 }),
      ),
    );
    render(<RenderApp params={params} />);
    await waitFor(() => {
      expect(heard).toHaveLength(1);
    });
    expect(heard[0]).toMatchObject({ kind: 'refused' });
    expect(heard[0]?.reason).toMatch(/^The Board failed to load: /);
  });

  it('refuses when the daemon fails on the screen’s data', async () => {
    serve(
      http.get(daemonUrl('/projects/:projectId/tasks'), () =>
        HttpResponse.json({ error: 'internal' }, { status: 500 }),
      ),
    );
    render(<RenderApp params={params} />);
    await waitFor(() => {
      expect(heard).toHaveLength(1);
    });
    expect(heard[0]).toMatchObject({ kind: 'refused' });
    expect(heard[0]?.reason).toMatch(/^The Board failed to load: /);
  });
});
