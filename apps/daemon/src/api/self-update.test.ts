import { HealthResponse, SelfUpdateStatusDto } from '@10db/contracts';
import { defineWebSocketHelper } from 'hono/ws';
import { describe, expect, it } from 'vitest';
import { createApp } from './app';
import type { ApiServices, SelfUpdateServices } from './services';

const TOKEN = 'ui-token-for-tests';
const COMMIT = '1'.repeat(40);
const noUpgrade = defineWebSocketHelper(() => new Response(null, { status: 426 }));
const auth = { headers: { Authorization: `Bearer ${TOKEN}` } };
const json = { headers: { ...auth.headers, 'content-type': 'application/json' } };

function app(extra: { commit?: string | null; selfUpdate?: SelfUpdateServices } = {}) {
  return createApp({
    onUnexpectedError: () => undefined,
    startedAt: new Date('2026-10-29T12:00:00.000Z'),
    allowedOrigins: [],
    token: TOKEN,
    // Nothing here reaches the other services.
    services: {} as ApiServices,
    upgradeWebSocket: noUpgrade,
    mcp: () => Promise.resolve(new Response('mcp')),
    ...extra,
  });
}

describe('GET /health', () => {
  it('names the commit the app was built from, with no token, for the header', async () => {
    const response = await app({ commit: COMMIT }).request('/health');
    expect(response.status).toBe(200);
    expect(HealthResponse.parse(await response.json()).commit).toBe(COMMIT);
  });

  it('says null for a run from source', async () => {
    const response = await app({ commit: null }).request('/health');
    expect(HealthResponse.parse(await response.json()).commit).toBeNull();
  });

  it('says null when the daemon was given no commit', async () => {
    const response = await app().request('/health');
    expect(HealthResponse.parse(await response.json()).commit).toBeNull();
  });
});

describe('the self-update setting', () => {
  const asked: (boolean | null)[] = [];
  const waits: (number | null)[] = [];
  let installNowAsked = 0;
  const status = {
    enabled: true,
    isDefault: true,
    runningCommit: COMMIT,
    availableCommit: null,
    waitMinutes: 15,
    waitingSince: null,
    draining: false,
    drainingSince: null,
    midSession: { working: 0, waitingOnCard: 0, shapes: [] },
    blocker: null,
  };
  const services: SelfUpdateServices = {
    selfUpdateStatus: () => status,
    setSelfUpdate: (enabled) => {
      asked.push(enabled);
      return { ...status, enabled: enabled ?? true, isDefault: enabled === null };
    },
    setSelfUpdateWait: (minutes) => {
      waits.push(minutes);
      return { ...status, waitMinutes: minutes ?? 15 };
    },
    installNow: () => {
      installNowAsked += 1;
      return {
        ...status,
        availableCommit: COMMIT,
        draining: true,
        drainingSince: '2026-11-03T12:00:00.000Z',
      };
    },
  };

  it('sets how long an update waits before it drains', async () => {
    waits.length = 0;
    const api = app({ selfUpdate: services });
    const response = await api.request('/settings/self-update/wait', {
      ...json,
      method: 'PUT',
      body: JSON.stringify({ minutes: 30 }),
    });
    expect(response.status).toBe(200);
    expect(SelfUpdateStatusDto.parse(await response.json()).waitMinutes).toBe(30);
    expect(waits).toEqual([30]);
  });

  it('refuses a wait that is negative or not whole minutes', async () => {
    for (const minutes of [-1, 2.5]) {
      const response = await app({ selfUpdate: services }).request('/settings/self-update/wait', {
        ...json,
        method: 'PUT',
        body: JSON.stringify({ minutes }),
      });
      expect(response.status).toBe(400);
    }
  });

  it('starts the drain at Install Now, behind the token', async () => {
    installNowAsked = 0;
    const api = app({ selfUpdate: services });
    expect(
      (await api.request('/settings/self-update/install-now', { method: 'POST' })).status,
    ).toBe(401);
    expect(installNowAsked).toBe(0);
    const response = await api.request('/settings/self-update/install-now', {
      ...auth,
      method: 'POST',
    });
    expect(response.status).toBe(200);
    expect(SelfUpdateStatusDto.parse(await response.json()).draining).toBe(true);
    expect(installNowAsked).toBe(1);
  });

  it('is read once for the whole app, behind the token', async () => {
    const api = app({ selfUpdate: services });
    expect((await api.request('/settings/self-update')).status).toBe(401);
    const response = await api.request('/settings/self-update', auth);
    expect(SelfUpdateStatusDto.parse(await response.json())).toMatchObject({
      enabled: true,
      isDefault: true,
    });
  });

  it.each([{ enabled: false }, { enabled: true }, { enabled: null }])(
    'is set to $enabled',
    async (body) => {
      asked.length = 0;
      const response = await app({ selfUpdate: services }).request('/settings/self-update', {
        ...json,
        method: 'PUT',
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(200);
      expect(asked).toEqual([body.enabled]);
    },
  );

  it('refuses a value that is not a boolean or null', async () => {
    const response = await app({ selfUpdate: services }).request('/settings/self-update', {
      ...json,
      method: 'PUT',
      body: JSON.stringify({ enabled: 'yes' }),
    });
    expect(response.status).toBe(400);
  });

  it('answers 501 where the daemon wires none', async () => {
    const response = await app().request('/settings/self-update', auth);
    expect(response.status).toBe(501);
  });
});
