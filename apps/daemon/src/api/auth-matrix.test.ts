import { describe, expect, it } from 'vitest';
import { AuthVerdict, Credential, RouteClass, authorize, routeClassOf } from './auth-matrix';
import { Listener } from '../listeners';

const P = AuthVerdict.Pass;
const U = AuthVerdict.Unauthorized;
const N = AuthVerdict.NotFound;

// Column order: none, ui, dev_ui, render, device, ticket, unknown.
const CREDENTIALS = [
  Credential.None,
  Credential.Ui,
  Credential.DevUi,
  Credential.Render,
  Credential.Device,
  Credential.Ticket,
  Credential.Unknown,
] as const;

const EXPECTED: Record<Listener, Record<RouteClass, readonly AuthVerdict[]>> = {
  main: {
    health: [P, P, P, P, P, P, P],
    mcp: [P, U, U, U, U, U, P],
    builder_mcp: [U, P, U, U, U, U, U],
    screens_claim: [U, P, P, P, U, U, U],
    stream: [U, U, U, U, U, P, U],
    ticket: [U, P, P, U, U, U, U],
    pair: [N, N, N, N, N, N, N],
    app_static: [N, N, N, N, N, N, N],
    api: [U, P, P, P, U, U, U],
  },
  share: {
    health: [P, P, P, P, P, P, P],
    mcp: [N, N, N, N, N, N, N],
    builder_mcp: [N, N, N, N, N, N, N],
    screens_claim: [N, N, N, N, N, N, N],
    stream: [U, U, U, U, U, P, U],
    ticket: [U, U, U, U, P, U, U],
    pair: [P, U, U, U, U, U, U],
    app_static: [P, U, U, U, U, U, U],
    api: [U, U, U, U, P, U, U],
  },
};

describe('authorize', () => {
  it('gives each credential only its cells on each listener', () => {
    const actual: Record<string, Record<string, AuthVerdict[]>> = {};
    for (const listener of Object.values(Listener)) {
      actual[listener] = {};
      for (const route of Object.values(RouteClass)) {
        actual[listener][route] = CREDENTIALS.map((c) => authorize(listener, route, c));
      }
    }
    expect(actual).toEqual(EXPECTED);
  });
});

describe('routeClassOf', () => {
  it.each([
    ['GET', '/health', 'health'],
    ['GET', '/health/', 'health'],
    ['POST', '/mcp', 'mcp'],
    ['POST', '/builder/mcp', 'builder_mcp'],
    ['POST', '/screens/claim', 'screens_claim'],
    ['GET', '/screens/claim', 'api'],
    ['GET', '/events/stream', 'stream'],
    ['POST', '/events/ticket', 'ticket'],
    ['GET', '/events/ticket', 'api'],
    ['POST', '/devices/pair', 'pair'],
    ['GET', '/devices/pair', 'api'],
    ['GET', '/app', 'app_static'],
    ['HEAD', '/app/', 'app_static'],
    ['GET', '/app/x/y.js', 'app_static'],
    ['POST', '/app/x', 'api'],
    ['GET', '/apps', 'api'],
    ['GET', '/appx/y', 'api'],
    ['GET', '/healthz', 'api'],
    ['GET', '/mcp/extra', 'api'],
    ['GET', '/tasks', 'api'],
    ['GET', '/', 'api'],
  ])('%s %s is %s', (method, path, expected) => {
    expect(routeClassOf(method, path)).toBe(expected);
  });
});
