import { SKILL_VERSION_HEADER, DevUiConnectionDto, mintId } from '@10db/contracts';
import { defineWebSocketHelper } from 'hono/ws';
import { describe, expect, it } from 'vitest';
import { devUiMayRead } from '../screens';
import { createApp, MAX_BODY_BYTES } from './app';

const TOKEN = 'ui-token-for-tests';
const startedAt = new Date('2026-10-13T12:00:00.000Z');

import { noSharing, stubServices } from '../../test/api-stub';

// A helper that never upgrades: it answers 426 so a test can tell the route was reached.
const noUpgrade = defineWebSocketHelper(() => new Response(null, { status: 426 }));

function app(
  services = stubServices(),
  onUnexpectedError: (error: unknown) => void = () => undefined,
  skillVersion: string | null = null,
) {
  return createApp({
    ...noSharing,
    skillVersion,
    onUnexpectedError,
    startedAt,
    allowedOrigins: ['http://localhost:1420'],
    token: TOKEN,
    services,
    upgradeWebSocket: noUpgrade,
    mcp: () => Promise.resolve(new Response('mcp')),
    builderMcp: () => Promise.resolve(new Response('builder')),
  });
}
const auth = { headers: { Authorization: `Bearer ${TOKEN}` } };

describe('the skill version check', () => {
  it('answers 401 before it compares versions', async () => {
    const res = await app(stubServices(), undefined, 'aaaaaaaaaaaa').request('/projects', {
      headers: { [SKILL_VERSION_HEADER]: 'bbbbbbbbbbbb' },
    });
    expect(res.status).toBe(401);
  });
});

describe('API', () => {
  describe("the dev UI's read-only token", () => {
    const DEV_TOKEN = 'dev-ui-token-for-tests';
    const devApp = (devUiToken: string | null) =>
      createApp({
        ...noSharing,
        startedAt,
        allowedOrigins: ['http://localhost:1420'],
        devUiOrigin: devUiToken === null ? null : 'http://localhost:1420',
        devUi: devUiToken === null ? null : { token: devUiToken, mayRead: devUiMayRead },
        token: TOKEN,
        services: stubServices(),
        upgradeWebSocket: noUpgrade,
        onUnexpectedError: () => undefined,
        mcp: () => Promise.resolve(new Response('mcp')),
      });
    const as = (token: string, method = 'GET') => ({
      method,
      headers: { Authorization: `Bearer ${token}` },
    });

    it('is handed to the app over its full token only, and exists only with a dev UI origin', async () => {
      const res = await devApp(DEV_TOKEN).request('/dev-ui/connection', auth);
      expect(DevUiConnectionDto.parse(await res.json())).toEqual({ token: DEV_TOKEN });
      expect((await devApp(null).request('/dev-ui/connection', auth)).status).toBe(404);
      expect((await devApp(null).request('/projects', as(DEV_TOKEN))).status).toBe(401);
    });
  });

  it('requires the UI token everywhere else', async () => {
    expect((await app().request('/projects')).status).toBe(401);
    expect(
      (await app().request('/projects', { headers: { Authorization: 'Bearer wrong' } })).status,
    ).toBe(401);
    expect((await app().request('/projects', auth)).status).toBe(200);
  });

  it('serves /builder/mcp to the UI token only', async () => {
    const post = (headers: Record<string, string>) =>
      app().request('/builder/mcp', { method: 'POST', headers });
    expect((await post({})).status).toBe(401);
    // A managed session's token is not the UI token.
    expect((await post({ Authorization: 'Bearer lane-session-token' })).status).toBe(401);
    const ok = await post(auth.headers);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('builder');
  });

  it('takes the token from the query string on the event stream only', async () => {
    expect((await app().request('/events/stream')).status).toBe(401);
    expect((await app().request('/events/stream', auth)).status).toBe(401);
    expect((await app().request('/events/stream?token=wrong')).status).toBe(401);
    expect((await app().request(`/events/stream?token=${TOKEN}`)).status).toBe(426);
    expect((await app().request(`/projects?token=${TOKEN}`)).status).toBe(401);
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

  it('keeps the CORS allow-list', async () => {
    const ok = await app().request('/health', { headers: { Origin: 'http://localhost:1420' } });
    expect(ok.headers.get('access-control-allow-origin')).toBe('http://localhost:1420');
    const no = await app().request('/health', { headers: { Origin: 'https://evil.example' } });
    expect(no.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('shape routes', () => {
  const projectId = mintId('Project');
  const shapeId = mintId('Shape');

  it('needs the token', async () => {
    for (const [method, path] of [
      ['GET', `/projects/${projectId}/shapes`],
      ['GET', `/shapes/${shapeId}`],
      ['POST', `/shapes/${shapeId}/convert`],
      ['POST', `/shapes/${shapeId}/files`],
      ['PATCH', `/shapes/${shapeId}/proposals/${mintId('ShapeProposal')}`],
    ] as const)
      expect((await app().request(path, { method })).status).toBe(401);
  });
});

describe('knowledge routes', () => {
  const pid = mintId('Project');
  const pri = mintId('Principle');
  const prp = mintId('Proposal');

  it('needs the token', async () => {
    for (const [method, path] of [
      ['GET', `/projects/${pid}/knowledge`],
      ['POST', `/projects/${pid}/decisions`],
      ['GET', `/principles/${pri}/provenance`],
      ['POST', `/proposals/${prp}/accept`],
    ] as const)
      expect((await app().request(path, { method })).status).toBe(401);
  });
});

describe('judge routes', () => {
  describe('body size limit', () => {
    const adoptPath = `/projects/${mintId('Project')}/goals/adopt`;
    const oversize = 'x'.repeat(MAX_BODY_BYTES + 1);

    it('answers 401 before 413 for a request without the token', async () => {
      const res = await app().request(adoptPath, { method: 'POST', body: oversize });
      expect(res.status).toBe(401);
    });
  });
});
