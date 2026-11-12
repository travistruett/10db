import { describe, expect, it } from 'vitest';
import { proxyAllows, requestAllowed } from './origin-guard';

describe('proxyAllows', () => {
  it.each<[string, string | null, string, string, boolean]>([
    ['a page of the app', 'http://localhost:3000', 'GET', 'http://localhost:3000/people', true],
    ['the app with a query', 'http://localhost:3000', 'GET', 'http://localhost:3000/?a=1', true],
    ['a post to the app', 'http://localhost:3000', 'POST', 'http://localhost:3000/api/x', true],
    [
      'another port of the same host',
      'http://localhost:3000',
      'GET',
      'http://localhost:7433/tasks',
      false,
    ],
    [
      '127.0.0.1 for a localhost app',
      'http://localhost:3000',
      'GET',
      'http://127.0.0.1:3000/',
      false,
    ],
    ['[::1] for a localhost app', 'http://localhost:3000', 'GET', 'http://[::1]:3000/', false],
    [
      'the app over https when it is http',
      'http://localhost:3000',
      'GET',
      'https://localhost:3000/',
      false,
    ],
    ['another host', 'http://localhost:3000', 'GET', 'http://example.com/', false],
    ['a CONNECT to the app', 'http://localhost:3000', 'CONNECT', 'localhost:3000', true],
    ['a CONNECT to another port', 'http://localhost:3000', 'CONNECT', 'localhost:7433', false],
    [
      'a CONNECT to 127.0.0.1 for a localhost app',
      'http://localhost:3000',
      'CONNECT',
      '127.0.0.1:3000',
      false,
    ],
    ['a CONNECT with no port', 'http://localhost:3000', 'CONNECT', 'localhost', false],
    [
      'a CONNECT to an https app on its default port',
      'https://app.localhost',
      'CONNECT',
      'app.localhost:443',
      true,
    ],
    [
      'a CONNECT to an http app on its default port',
      'http://localhost',
      'CONNECT',
      'localhost:80',
      true,
    ],
    [
      'a CONNECT to 443 for an http app on 80',
      'http://localhost',
      'CONNECT',
      'localhost:443',
      false,
    ],
    [
      'a CONNECT to 80 for an https app on 443',
      'https://app.localhost',
      'CONNECT',
      'app.localhost:80',
      false,
    ],
    ['a CONNECT to an IPv6 app', 'http://[::1]:5173', 'CONNECT', '[::1]:5173', true],
    ['a CONNECT to IPv6 on another port', 'http://[::1]:5173', 'CONNECT', '[::1]:7433', false],
    ['an origin-form request, as to a server', 'http://localhost:3000', 'GET', '/people', false],
    ['an app address with a default port', 'http://localhost', 'GET', 'http://localhost/x', true],
    ['the default port spelled out', 'http://localhost', 'GET', 'http://localhost:80/x', true],
    ['no shot running', null, 'GET', 'http://localhost:3000/', false],
    ['no shot running, CONNECT', null, 'CONNECT', 'localhost:3000', false],
    ['nonsense', 'http://localhost:3000', 'GET', 'http://', false],
    ['a userinfo trick', 'http://localhost:3000', 'GET', 'http://localhost:3000@evil.test/', false],
  ])('%s', (_name, appUrl, method, target, allowed) => {
    const reach = appUrl === null ? null : { app: appUrl, daemon: null };
    expect(proxyAllows(reach, { method, target })).toBe(allowed);
  });
});

describe('proxyAllows while 10db shoots its own dev UI, which reads the daemon', () => {
  const reach = { app: 'http://localhost:1420', daemon: 'http://127.0.0.1:7433' };
  it.each<[string, string, string, boolean]>([
    ['a read of the daemon', 'GET', 'http://127.0.0.1:7433/projects', true],
    ['a read with a query', 'GET', 'http://127.0.0.1:7433/events?after=4', true],
    ['a HEAD of the daemon', 'HEAD', 'http://127.0.0.1:7433/projects', true],
    ['the CORS preflight of a read', 'OPTIONS', 'http://127.0.0.1:7433/projects', true],
    ['a POST to the daemon', 'POST', 'http://127.0.0.1:7433/passes', false],
    ['a DELETE on the daemon', 'DELETE', 'http://127.0.0.1:7433/tasks/x', false],
    ['a PATCH on the daemon', 'PATCH', 'http://127.0.0.1:7433/projects/x', false],
    ['a CONNECT to the daemon', 'CONNECT', '127.0.0.1:7433', false],
    ['the daemon spelled localhost', 'GET', 'http://localhost:7433/projects', false],
    ['the daemon over https', 'GET', 'https://127.0.0.1:7433/projects', false],
    ['the next port', 'GET', 'http://127.0.0.1:7434/projects', false],
    ['a userinfo trick', 'GET', 'http://127.0.0.1:7433@evil.test/', false],
    ['the app, still', 'POST', 'http://localhost:1420/api/x', true],
    ['the app’s WebSocket, still', 'CONNECT', 'localhost:1420', true],
  ])('%s', (_name, method, target, allowed) => {
    expect(proxyAllows(reach, { method, target })).toBe(allowed);
  });
});

describe('requestAllowed', () => {
  it.each<[string, string, boolean]>([
    ['the app', 'http://localhost:3000/people', true],
    ['the app’s scripts', 'http://localhost:3000/_next/static/chunks/main.js', true],
    ['another port', 'http://localhost:7433/tasks', false],
    ['127.0.0.1 for a localhost app', 'http://127.0.0.1:3000/', false],
    ['a font from a CDN', 'https://fonts.gstatic.com/s/inter.woff2', false],
    ['the dev server’s WebSocket', 'ws://localhost:3000/_next/webpack-hmr', true],
    ['a secure WebSocket on the app’s port', 'wss://localhost:3000/hmr', true],
    ['a WebSocket to another port', 'ws://localhost:7433/events', false],
    ['a WebSocket to 127.0.0.1', 'ws://127.0.0.1:3000/hmr', false],
    ['a data URL', 'data:image/png;base64,AAAA', true],
    ['a blob URL', 'blob:http://localhost:3000/5f1c', true],
    ['about:blank', 'about:blank', true],
    ['another about page', 'about:version', false],
    ['a file URL', 'file:///etc/passwd', false],
    ['nonsense', 'not a url', false],
  ])('%s', (_name, url, allowed) => {
    expect(requestAllowed({ app: 'http://localhost:3000', daemon: null }, url)).toBe(allowed);
  });

  it.each<[string, string, boolean]>([
    ['a read of the daemon', 'http://127.0.0.1:7433/projects', true],
    ['the daemon spelled localhost', 'http://localhost:7433/projects', false],
    ['a WebSocket to the daemon', 'ws://127.0.0.1:7433/events', false],
    ['the app', 'http://localhost:1420/settings', true],
  ])('while 10db shoots its own dev UI: %s', (_name, url, allowed) => {
    expect(
      requestAllowed({ app: 'http://localhost:1420', daemon: 'http://127.0.0.1:7433' }, url),
    ).toBe(allowed);
  });
});
