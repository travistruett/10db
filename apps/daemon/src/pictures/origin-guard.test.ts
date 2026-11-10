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
    expect(proxyAllows(appUrl, { method, target })).toBe(allowed);
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
    expect(requestAllowed('http://localhost:3000', url)).toBe(allowed);
  });
});
