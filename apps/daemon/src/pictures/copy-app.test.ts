import { describe, expect, it } from 'vitest';
import { copyAppAddress } from './copy-app';

// Value: protects=a copy's pictures are taken only at a loopback origin its command printed last;
// fails_when=an earlier line, a path, another host or the daemon's own port is taken as the copy's app;
// why_new=a parser of child-process output (core: parsers);
// no_claim=the address answers, or belongs to this copy rather than another.

const DAEMON_PORT = 7420;

describe('copyAppAddress', () => {
  it.each([
    [
      'the last line',
      'starting backend\nhttp://localhost:9100\nhttp://localhost:9101\n',
      'http://localhost:9101',
    ],
    [
      'a line with spaces round it',
      'ready\n  http://127.0.0.1:9100  \n\n',
      'http://127.0.0.1:9100',
    ],
    ['an address that is not last', 'http://localhost:9100\nready', null],
    ["the daemon's own port", `http://localhost:${String(DAEMON_PORT)}`, null],
    ['a path', '/people', null],
    ['another host', 'http://elsewhere.example:9100', null],
    ['an address with a path', 'http://localhost:9100/people', null],
    ['nothing', '\n\n', null],
  ])('reads %s', (_case, output, expected) => {
    expect(copyAppAddress(output, DAEMON_PORT)).toBe(expected);
  });
});
