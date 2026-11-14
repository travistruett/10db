import { describe, expect, it } from 'vitest';
import { addressForLog, loadFailure } from './load-failure';

const MARKER = 'MARKER-IN-QUERY';

describe('addressForLog', () => {
  it.each<[string, string, string]>([
    [
      'a page keeps its origin and path',
      `http://localhost:3000/api/dev-login/x?token=${MARKER}#a`,
      'http://localhost:3000/api/dev-login/x',
    ],
    ['a request made as to a server', `/people?token=${MARKER}`, '/people'],
    ['a CONNECT target', 'localhost:7433', 'localhost:7433'],
    ['a data URL', 'data:image/png;base64,AAAA', 'data:'],
    ['a WebSocket', `ws://localhost:7433/events?token=${MARKER}`, 'ws://localhost:7433/events'],
    ['nonsense', 'not an address', '(not an address)'],
  ])('%s', (_name, raw, logged) => {
    expect(addressForLog(raw)).toBe(logged);
  });
});

describe('loadFailure', () => {
  const at = `http://localhost:3000/api/dev-login/x?token=${MARKER}`;
  it.each<[string, string, string]>([
    [
      'a network error, by its code',
      `page.goto: net::ERR_CONNECTION_REFUSED at ${at}\nCall log:\n  - navigating to "${at}", waiting until "load"`,
      'net::ERR_CONNECTION_REFUSED',
    ],
    [
      'a timeout',
      `page.goto: Timeout 30000ms exceeded.\nCall log:\n  - navigating to "${at}", waiting until "load"`,
      'the page took longer than 30 s to load',
    ],
    ['anything else', `page.goto: Navigation to "${at}" is interrupted`, 'the page did not load'],
  ])('%s, never with the address', (_name, raw, reason) => {
    const failure = loadFailure(new Error(raw));
    expect(failure).toBe(reason);
    expect(failure).not.toContain(MARKER);
  });
});
