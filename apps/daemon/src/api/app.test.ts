import {
  ConflictError,
  HealthResponse,
  mintId,
  NotFoundError,
  PROTOCOL_VERSION,
  type DaemonEvent,
} from '@10db/contracts';
import { defineWebSocketHelper } from 'hono/ws';
import { describe, expect, it } from 'vitest';
import { createApp } from './app';
import type { ApiServices } from './services';

const TOKEN = 'ui-token-for-tests';
const startedAt = new Date('2026-10-13T12:00:00.000Z');

function stubServices(overrides: Partial<ApiServices> = {}): ApiServices {
  const none = (): never => {
    throw new Error('not stubbed');
  };
  return {
    listProjects: () => [],
    createProject: none,
    listTasks: () => [],
    createTask: none,
    startTask: none,
    listFlows: () => [],
    listWorkstreams: () => [],
    cancelWorkstream: none,
    retryWorkstream: none,
    listInbox: () => [],
    answerInbox: none,
    eventsAfter: () => [] as DaemonEvent[],
    subscribe: () => () => undefined,
    systemCheck: none,
    keepAwake: () => ({ mode: 'while_running', active: false }),
    setKeepAwake: none,
    eventsHead: () => 0,
    reviewProjectMcp: none,
    ...overrides,
  };
}

// A helper that never upgrades: it answers 426 so a test can tell the route was reached.
const noUpgrade = defineWebSocketHelper(() => new Response(null, { status: 426 }));

function app(
  services = stubServices(),
  onUnexpectedError: (error: unknown) => void = () => undefined,
) {
  return createApp({
    onUnexpectedError,
    startedAt,
    allowedOrigins: ['http://localhost:1420'],
    token: TOKEN,
    services,
    upgradeWebSocket: noUpgrade,
    mcp: () => Promise.resolve(new Response('mcp')),
  });
}
const auth = { headers: { Authorization: `Bearer ${TOKEN}` } };
const json = { headers: { ...auth.headers, 'content-type': 'application/json' } };

describe('API', () => {
  it('serves the event head, keep-awake and the system check behind the token', async () => {
    const check = {
      loginEnv: { source: 'login_shell' as const, warning: null },
      tools: [
        {
          name: 'git' as const,
          path: '/usr/bin/git',
          version: 'git version 2.50.1',
          required: true,
        },
      ],
    };
    const modes: string[] = [];
    const services = stubServices({
      eventsHead: () => 41,
      systemCheck: () => Promise.resolve(check),
      setKeepAwake: (mode) => {
        modes.push(mode);
        return { mode, active: mode === 'always' };
      },
    });
    expect((await app(services).request('/events/head')).status).toBe(401);
    expect(await (await app(services).request('/events/head', auth)).json()).toEqual({ seq: 41 });
    expect(await (await app(services).request('/settings/keep-awake', auth)).json()).toEqual({
      mode: 'while_running',
      active: false,
    });
    expect(await (await app(services).request('/system', auth)).json()).toEqual(check);

    const put = (body: unknown) =>
      app(services).request('/settings/keep-awake', {
        method: 'PUT',
        headers: { ...auth.headers, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect(await (await put({ mode: 'always' })).json()).toEqual({ mode: 'always', active: true });
    expect((await put({ mode: 'sometimes' })).status).toBe(400);
    expect(modes).toEqual(['always']);
  });

  it("reviews a project's repo MCP servers behind the token", async () => {
    const projectId = mintId('Project');
    const seen: string[] = [];
    const services = stubServices({
      reviewProjectMcp: (id) => {
        seen.push(id);
        return [];
      },
    });
    const review = (headers: Record<string, string> = {}) =>
      app(services).request(`/projects/${projectId}/mcp-servers/review`, {
        method: 'POST',
        headers,
      });
    expect((await review()).status).toBe(401);
    expect(await (await review(auth.headers)).json()).toEqual([]);
    expect(seen).toEqual([projectId]);
  });

  it('serves /health without a token', async () => {
    const res = await app().request('/health');
    expect(HealthResponse.parse(await res.json())).toEqual({
      status: 'ok',
      protocolVersion: PROTOCOL_VERSION,
      startedAt: startedAt.toISOString(),
    });
  });

  it('requires the UI token everywhere else', async () => {
    expect((await app().request('/projects')).status).toBe(401);
    expect(
      (await app().request('/projects', { headers: { Authorization: 'Bearer wrong' } })).status,
    ).toBe(401);
    expect((await app().request('/projects', auth)).status).toBe(200);
  });

  it('takes the token from the query string on the event stream only', async () => {
    expect((await app().request('/events/stream')).status).toBe(401);
    expect((await app().request('/events/stream', auth)).status).toBe(401);
    expect((await app().request('/events/stream?token=wrong')).status).toBe(401);
    expect((await app().request(`/events/stream?token=${TOKEN}`)).status).toBe(426);
    expect((await app().request(`/projects?token=${TOKEN}`)).status).toBe(401);
  });

  it('passes /mcp through without the UI token', async () => {
    expect(await (await app().request('/mcp', { method: 'POST' })).text()).toBe('mcp');
  });

  it('answers 400 with issue paths for an invalid body', async () => {
    const res = await app().request('/projects', {
      method: 'POST',
      ...json,
      body: JSON.stringify({ name: '' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { issues: { path: string }[] };
    expect(body.issues.map((i) => i.path)).toContain('repoPath');
  });

  it('answers 400 for a body that is not JSON', async () => {
    const res = await app().request('/projects', { method: 'POST', ...json, body: '{nope' });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toMatchObject({ error: 'invalid' });
  });

  it('refuses an event-stream upgrade from a foreign origin', async () => {
    const upgrade = { Upgrade: 'websocket', Connection: 'Upgrade' };
    const foreign = await app().request(`/events/stream?token=${TOKEN}`, {
      headers: { ...upgrade, Origin: 'https://evil.example' },
    });
    expect(foreign.status).toBe(403);
    // The stubbed upgrader answers 426, so reaching it proves the allowed origin got through.
    const allowed = await app().request(`/events/stream?token=${TOKEN}`, {
      headers: { ...upgrade, Origin: 'http://localhost:1420' },
    });
    expect(allowed.status).toBe(426);
  });

  it('answers 400 with the API error shape for a JSON body sent without a content type', async () => {
    const res = await app().request('/projects', {
      method: 'POST',
      ...auth,
      body: JSON.stringify({ name: 'x' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid' });
  });

  it('answers 400, not 500, when an inbox answer fails the contract schema', async () => {
    const services = stubServices({
      answerInbox: () => {
        throw new Error('the service must not be reached');
      },
    });
    const res = await app(services).request(`/inbox/${mintId('InboxItem')}/answer`, {
      method: 'POST',
      ...json,
      body: JSON.stringify({ kind: 'nope' }),
    });
    expect(res.status).toBe(400);
  });

  it('maps domain errors to 404 and 409', async () => {
    const services = stubServices({
      startTask: () => {
        throw new NotFoundError('task', 'tsk_x');
      },
      retryWorkstream: () => {
        throw new ConflictError('not failed');
      },
    });
    expect(
      (await app(services).request(`/tasks/${mintId('Task')}/start`, { method: 'POST', ...auth }))
        .status,
    ).toBe(404);
    expect(
      (
        await app(services).request(`/workstreams/${mintId('Workstream')}/retry`, {
          method: 'POST',
          ...auth,
        })
      ).status,
    ).toBe(409);
  });

  it('answers 500 for an unexpected error and reports that error to the hook', async () => {
    const boom = new Error('boom');
    const seen: unknown[] = [];
    const services = stubServices({
      listProjects: () => {
        throw boom;
      },
    });
    const res = await app(services, (error) => seen.push(error)).request('/projects', auth);
    expect(res.status).toBe(500);
    expect(seen).toEqual([boom]);
    expect(seen[0]).toBe(boom);
  });

  it('answers 400 for a malformed ID', async () => {
    expect(
      (await app().request('/tasks/not-an-id/start', { method: 'POST', ...auth })).status,
    ).toBe(400);
  });

  it('filters the inbox by a comma-separated state list, and rejects an unknown state', async () => {
    const seen: (readonly string[] | null)[] = [];
    const services = stubServices({
      listInbox: ({ states }) => {
        seen.push(states);
        return [];
      },
    });
    expect((await app(services).request('/inbox?state=OPEN,ANSWERED', auth)).status).toBe(200);
    expect((await app(services).request('/inbox', auth)).status).toBe(200);
    expect(seen).toEqual([['OPEN', 'ANSWERED'], null]);
    expect((await app(services).request('/inbox?state=NOPE', auth)).status).toBe(400);
  });

  it('keeps the CORS allow-list', async () => {
    const ok = await app().request('/health', { headers: { Origin: 'http://localhost:1420' } });
    expect(ok.headers.get('access-control-allow-origin')).toBe('http://localhost:1420');
    const no = await app().request('/health', { headers: { Origin: 'https://evil.example' } });
    expect(no.headers.get('access-control-allow-origin')).toBeNull();
  });
});
