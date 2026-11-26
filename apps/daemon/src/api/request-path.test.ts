import {
  PROTOCOL_VERSION,
  SharingState,
  TicketScope,
  mintId,
  type DeviceId,
} from '@10db/contracts';
import { createTestStore } from '@10db/db';
import { upgradeWebSocket } from '@hono/node-server';
import { defineWebSocketHelper } from 'hono/ws';
import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stubServices } from '../../test/api-stub';
import { ManualClock } from '../clock';
import {
  createDeviceService,
  createPairingCodes,
  createSocketRegistry,
  type SocketRegistry,
  createTickets,
  mintDeviceToken,
  type DeviceService,
  type Tickets,
} from '../devices';
import { createEventBus, createStateStore } from '../events';
import { silentLogger } from '../log';
import { createSharingService, startShareListener } from '../sharing';
import { createApp } from './app';
import { Listener } from './listener';
import type { ListenerAllowlists } from './request-guards';

const UI = 'ui-token-for-tests';
const DEV_UI = 'dev-ui-token-for-tests';
const RENDER = 'render-token-for-tests';
const MCP_SESSION = 'mcp-session-token-for-tests';
const FQDN = 'mac.tail1234.ts.net';
const SHARE_PORT = 4319;
const MAIN_PORT = 4317;
const PHONE = `https://${FQDN}:${String(SHARE_PORT)}`;
const HOST_LOGIN = 'me@example.com';

const noUpgrade = defineWebSocketHelper(() => new Response(null, { status: 426 }));
const mainHost = { Host: `127.0.0.1:${String(MAIN_PORT)}` };
const shareHost = { Host: `${FQDN}:${String(SHARE_PORT)}` };
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const SHORT_HEALTH = { status: 'ok', protocolVersion: PROTOCOL_VERSION };

let close: () => void;
let lists: ListenerAllowlists | null;
let devices: DeviceService;
let tickets: Tickets;
let sockets: SocketRegistry;
let pair: () => { deviceId: DeviceId; token: string };
let app: ReturnType<typeof createApp>;
let makeApp: (upgrade: typeof noUpgrade) => ReturnType<typeof createApp>;

const call = (listener: Listener, path: string, init?: RequestInit) =>
  app.request(path, init, listener === Listener.Share ? { listener } : undefined);

beforeEach(() => {
  const clock = new ManualClock();
  const made = createTestStore();
  close = made.close;
  const state = createStateStore(made.store, createEventBus());
  const codes = createPairingCodes({ clock });
  sockets = createSocketRegistry();
  devices = createDeviceService({
    state,
    clock,
    codes,
    sockets,
    sharing: () => ({
      state: SharingState.Ready,
      enabled: true,
      port: SHARE_PORT,
      fqdn: FQDN,
      login: HOST_LOGIN,
      certificateRequested: true,
      certificateExists: true,
      url: PHONE,
      portHolder: null,
      steps: [],
    }),
  });
  tickets = createTickets({ clock });
  lists = { hosts: [shareHost.Host], origins: [PHONE, 'tauri://localhost'] };
  pair = () => {
    const paired = devices.pair({
      code: codes.open().code,
      label: 'Pixel',
      platform: 'android',
    });
    return { deviceId: paired.deviceId, token: paired.token };
  };
  makeApp = (upgrade) =>
    createApp({
      startedAt: new Date('2026-10-13T12:00:00.000Z'),
      allowedOrigins: ['http://localhost:1420'],
      token: UI,
      devUi: { token: DEV_UI, mayRead: () => false },
      screens: {
        claim: () => Promise.resolve(null),
        deliver: () => false,
        refuse: () => false,
        tokenValid: (token) => token === RENDER,
        mayRead: () => false,
        image: () => null,
      },
      services: stubServices(),
      upgradeWebSocket: upgrade,
      mcp: () => Promise.resolve(new Response('mcp')),
      builderMcp: () => Promise.resolve(new Response('builder')),
      onUnexpectedError: () => undefined,
      listenPort: () => MAIN_PORT,
      share: { allowlists: () => lists, hostLogin: () => HOST_LOGIN },
      devices,
      tickets,
      sockets,
      remote: {
        devices,
        sharing: createSharingService({
          state,
          clock,
          log: silentLogger,
          cli: () => null,
          run: () => () => Promise.reject(new Error('no tailscale')),
          listen: () => Promise.resolve({ ok: false, holder: null }),
          sockets,
          mainPort: () => MAIN_PORT,
        }),
      },
    });
  app = makeApp(noUpgrade);
});
afterEach(() => {
  close();
});

interface Row {
  readonly row: string;
  readonly status: number;
  readonly body?: unknown;
  readonly run: () => Response | Promise<Response>;
}

const rows = (): Row[] => [
  {
    row: '1 main: the UI token from a loopback Host and the webview origin',
    status: 200,
    run: () =>
      call(Listener.Main, '/projects', {
        headers: { ...mainHost, ...bearer(UI), Origin: 'http://localhost:1420' },
      }),
  },
  {
    row: '2 main: a device token',
    status: 401,
    run: () =>
      call(Listener.Main, '/projects', { headers: { ...mainHost, ...bearer(pair().token) } }),
  },
  {
    row: '3 main: another Host is refused before the credential',
    status: 421,
    run: () =>
      call(Listener.Main, '/projects', {
        headers: { Host: `evil.example:${String(MAIN_PORT)}`, ...bearer(UI) },
      }),
  },
  {
    row: '3 main: another Host with no credential is 421, not 401',
    status: 421,
    run: () =>
      call(Listener.Main, '/projects', { headers: { Host: `evil.example:${String(MAIN_PORT)}` } }),
  },
  {
    row: '4 main: a foreign Origin on a GET',
    status: 403,
    run: () =>
      call(Listener.Main, '/projects', {
        headers: { ...mainHost, ...bearer(UI), Origin: 'https://evil.example' },
      }),
  },
  {
    row: '5 main: X-Forwarded-For marks the request remote, so even the UI token is refused',
    status: 401,
    run: () =>
      call(Listener.Main, '/projects', {
        headers: { ...mainHost, ...bearer(UI), 'X-Forwarded-For': '100.64.0.9' },
      }),
  },
  {
    row: '5 main: Tailscale-Headers-Info marks it remote too',
    status: 401,
    run: () =>
      call(Listener.Main, '/projects', {
        headers: { ...mainHost, ...bearer(UI), 'Tailscale-Headers-Info': 'x' },
      }),
  },
  {
    row: '6 share: a device token from the tailnet Host and the phone origin',
    status: 200,
    run: () =>
      call(Listener.Share, '/projects', {
        headers: { ...shareHost, ...bearer(pair().token), Origin: PHONE },
      }),
  },
  ...[
    ['the UI token', UI],
    ['the dev-UI token', DEV_UI],
    ['a render token', RENDER],
    ['an MCP session token', MCP_SESSION],
  ].map(([name, token]): Row => ({
    row: `7 share: ${String(name)}`,
    status: 401,
    run: () =>
      call(Listener.Share, '/projects', { headers: { ...shareHost, ...bearer(String(token)) } }),
  })),
  {
    row: '8 share: /health with no credential answers the short shape',
    status: 200,
    body: SHORT_HEALTH,
    run: () => call(Listener.Share, '/health', { headers: shareHost }),
  },
  ...['/builder/mcp', '/mcp'].map((path): Row => ({
    row: `11 share: ${path} is not routed`,
    status: 404,
    run: () =>
      call(Listener.Share, path, {
        method: 'POST',
        headers: { ...shareHost, ...bearer(pair().token) },
      }),
  })),
  {
    row: '11 share: /screens/claim is not routed',
    status: 404,
    run: () =>
      call(Listener.Share, '/screens/claim', {
        method: 'POST',
        headers: { ...shareHost, ...bearer(pair().token) },
      }),
  },
  {
    row: "12 share: a Tailscale-User-Login that isn't the host's",
    status: 403,
    run: () =>
      call(Listener.Share, '/projects', {
        headers: {
          ...shareHost,
          ...bearer(pair().token),
          'Tailscale-User-Login': 'other@example.com',
        },
      }),
  },
  {
    row: "12 share: the host's own login, in other case, passes",
    status: 200,
    run: () =>
      call(Listener.Share, '/projects', {
        headers: {
          ...shareHost,
          ...bearer(pair().token),
          'Tailscale-User-Login': 'ME@example.com',
        },
      }),
  },
  {
    row: '13 share: /app/* with no credential is a 404 for now',
    status: 404,
    run: () => call(Listener.Share, '/app/anything', { headers: shareHost }),
  },
  {
    row: '14 share: a ticket the main listener issued',
    status: 401,
    run: () => {
      const { ticket } = tickets.issue({
        scope: TicketScope.Full,
        deviceId: null,
        listener: Listener.Main,
      });
      return call(Listener.Share, `/events/stream?ticket=${ticket}`, { headers: shareHost });
    },
  },
  {
    row: '14 share: a live device ticket reaches the socket',
    status: 426,
    run: () => {
      const { ticket } = tickets.issue({
        scope: TicketScope.Full,
        deviceId: pair().deviceId,
        listener: Listener.Share,
      });
      return call(Listener.Share, `/events/stream?ticket=${ticket}`, { headers: shareHost });
    },
  },
  {
    row: '19 share: no name yet, everything but /health is 503',
    status: 503,
    body: { error: 'not_shared' },
    run: () => {
      lists = null;
      return call(Listener.Share, '/projects', {
        headers: { ...shareHost, ...bearer(pair().token) },
      });
    },
  },
  {
    row: '19 share: no name yet, /health still answers',
    status: 200,
    body: SHORT_HEALTH,
    run: () => {
      lists = null;
      return call(Listener.Share, '/health');
    },
  },
  {
    row: '21 main: an MCP session token reaches /mcp',
    status: 200,
    run: () => call(Listener.Main, '/mcp', { headers: { ...mainHost, ...bearer(MCP_SESSION) } }),
  },
  {
    row: '21 main: a stale bearer on /health answers the short shape',
    status: 200,
    body: SHORT_HEALTH,
    run: () => call(Listener.Main, '/health', { headers: { ...mainHost, ...bearer('stale') } }),
  },
  {
    row: '22 main: X-Forwarded-For with a device token',
    status: 401,
    run: () =>
      call(Listener.Main, '/projects', {
        headers: { ...mainHost, ...bearer(pair().token), 'X-Forwarded-For': '100.64.0.9' },
      }),
  },
  {
    row: '22 main: pairing is not routed',
    status: 404,
    run: () =>
      call(Listener.Main, '/devices/pair', {
        method: 'POST',
        headers: { ...mainHost, 'X-Forwarded-For': '100.64.0.9' },
      }),
  },
  {
    row: '23 share: a UI token on /health is never compared, so the shape is short',
    status: 200,
    body: SHORT_HEALTH,
    run: () => call(Listener.Share, '/health', { headers: { ...shareHost, ...bearer(UI) } }),
  },
  {
    row: '24 share: a ticket whose device was revoked after it was issued',
    status: 401,
    run: () => {
      const device = pair();
      const { ticket } = tickets.issue({
        scope: TicketScope.Full,
        deviceId: device.deviceId,
        listener: Listener.Share,
      });
      devices.revoke(device.deviceId);
      return call(Listener.Share, `/events/stream?ticket=${ticket}`, { headers: shareHost });
    },
  },
];

describe('the request path through both listeners', () => {
  it.each(rows().map((r) => [r.row, r] as const))('%s', async (_name, row) => {
    const res = await row.run();
    expect(res.status).toBe(row.status);
    if (row.body !== undefined) expect(await res.json()).toEqual(row.body);
  });

  it('answers the same 401 for an unknown device, a revoked one and a wrong secret', async () => {
    const live = pair();
    const revoked = pair();
    devices.revoke(revoked.deviceId);
    const last = live.token.slice(-1);
    const wrongSecret = `${live.token.slice(0, -1)}${last === 'A' ? 'B' : 'A'}`;
    const tokens = [mintDeviceToken(mintId('Device')).token, revoked.token, wrongSecret];
    const answers = await Promise.all(
      tokens.map(async (token) => {
        const res = await call(Listener.Share, '/projects', {
          headers: { ...shareHost, ...bearer(token) },
        });
        return { status: res.status, body: await res.text() };
      }),
    );
    expect(answers).toEqual(
      Array.from({ length: 3 }, () => ({ status: 401, body: '{"error":"unauthorized"}' })),
    );
  });

  it('closes a real share-listener socket with 4401 when its device is revoked', async () => {
    const realApp = makeApp(upgradeWebSocket);
    const started = await startShareListener({
      fetch: (req, env) => realApp.fetch(req, env),
      port: 0,
      sockets,
      holderOf: () => Promise.resolve(null),
    });
    if (!started.ok) throw new Error('the share listener did not start');
    try {
      const host = `127.0.0.1:${String(started.listener.port)}`;
      lists = { hosts: [host], origins: [] };
      const device = pair();
      const { ticket } = tickets.issue({
        scope: TicketScope.Full,
        deviceId: device.deviceId,
        listener: Listener.Share,
      });
      const socket = new WebSocket(`ws://${host}/events/stream?ticket=${ticket}`);
      await new Promise<void>((resolve, reject) => {
        socket.once('open', () => {
          resolve();
        });
        socket.once('error', reject);
      });
      const closed = new Promise<number>((resolve) => {
        socket.once('close', (code) => {
          resolve(code);
        });
      });
      const revoked = await app.request(`/devices/${device.deviceId}`, {
        method: 'DELETE',
        headers: { ...mainHost, ...bearer(UI) },
      });
      expect(revoked.status).toBe(204);
      expect(await closed).toBe(4401);
    } finally {
      await started.listener.close();
    }
  }, 10_000);
});
