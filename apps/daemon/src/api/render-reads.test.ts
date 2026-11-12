import { defineWebSocketHelper } from 'hono/ws';
import { describe, expect, it } from 'vitest';
import {
  DEV_UI_READS,
  DEV_UI_REFUSED_READS,
  devUiMayRead,
  RENDER_READS,
  RENDER_REFUSED_READS,
} from '../screens';
import { createApp } from './app';
import type { ApiServices } from './services';

// Shape spec §5.5: a screen's token reads only what a screen shows. Every GET the daemon serves is
// named in screens/render-access.ts, allowed or refused, so a new GET (one that moves a mark, runs a
// command) can't be reached by a screen until someone has decided about it.

describe('every GET the daemon serves is classified for a screen', () => {
  const app = createApp({
    startedAt: new Date(),
    allowedOrigins: [],
    token: 'ui',
    services: {} as ApiServices,
    upgradeWebSocket: defineWebSocketHelper(() => undefined as never) as never,
    mcp: () => Promise.resolve(new Response()),
    onUnexpectedError: () => undefined,
  });
  const gets = [...new Set(app.routes.filter((r) => r.method === 'GET').map((r) => r.path))].sort();

  it('is allowed or refused by name, so a new GET fails here until someone decides', () => {
    const classified = [...RENDER_READS.map((r) => r.route), ...Object.keys(RENDER_REFUSED_READS)];
    expect(gets.filter((path) => !classified.includes(path))).toEqual([]);
    // And nothing is classified that the daemon no longer serves.
    expect(classified.filter((path) => !gets.includes(path))).toEqual([]);
  });

  it('gives each refused read a reason', () => {
    for (const reason of Object.values(RENDER_REFUSED_READS))
      expect(reason.length).toBeGreaterThan(8);
  });

  it('allows a route and refuses it at once never', () => {
    const allowed = RENDER_READS.map((r) => r.route);
    expect(allowed.filter((route) => route in RENDER_REFUSED_READS)).toEqual([]);
  });
});

// Decision 2026-11-11-10db-runs-the-preview-while-a-pass-is-open: the dev UI's token is deny by
// default too, so a new GET is refused to it until someone names it a read.
describe('every GET the daemon serves is classified for the dev UI', () => {
  const app = createApp({
    startedAt: new Date(),
    allowedOrigins: [],
    token: 'ui',
    services: {} as ApiServices,
    upgradeWebSocket: defineWebSocketHelper(() => undefined as never) as never,
    mcp: () => Promise.resolve(new Response()),
    onUnexpectedError: () => undefined,
  });
  const gets = [...new Set(app.routes.filter((r) => r.method === 'GET').map((r) => r.path))].sort();

  it('is allowed or refused by name, never both, and nothing stale is named', () => {
    const refused = Object.keys(DEV_UI_REFUSED_READS);
    const classified = [...DEV_UI_READS, ...refused];
    expect(gets.filter((path) => !classified.includes(path))).toEqual([]);
    expect(classified.filter((path) => !gets.includes(path))).toEqual([]);
    expect(DEV_UI_READS.filter((route) => refused.includes(route))).toEqual([]);
  });

  it('refuses every route it does not name, and every method but GET', () => {
    expect(devUiMayRead('GET', '/projects')).toBe(true);
    expect(devUiMayRead('GET', '/a-route-nobody-named')).toBe(false);
    expect(devUiMayRead('POST', '/projects')).toBe(false);
  });
});
