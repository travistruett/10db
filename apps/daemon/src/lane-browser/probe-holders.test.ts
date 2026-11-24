import { describe, expect, it } from 'vitest';
import { parseAcceptors } from './probe-holders';

const probe = { server: '127.0.0.1', port: 3000, client: '127.0.0.1', clientPort: 55555 };

describe('parseAcceptors', () => {
  it.each<[string, string, number[]]>([
    ['the server end', 'p200\nn127.0.0.1:3000->127.0.0.1:55555\n', [200]],
    [
      'the same end spelled v4-mapped',
      'p200\nn[::ffff:127.0.0.1]:3000->[::ffff:127.0.0.1]:55555\n',
      [200],
    ],
    ['the daemon client end, by its direction', 'p9\nn127.0.0.1:55555->127.0.0.1:3000\n', []],
    [
      'an unrelated socket that mentions the probe port',
      'p300\nn10.0.0.5:44444->93.184.216.34:55555\n',
      [],
    ],
    [
      'an unrelated socket with the probe port as its local port',
      'p300\nn10.0.0.5:55555->93.184.216.34:443\n',
      [],
    ],
    ['the right ports on another address', 'p300\nn127.0.0.1:3000->10.0.0.5:55555\n', []],
    ['a listener', 'p300\nn*:3000\n', []],
  ])('%s', (_name, output, expected) => {
    expect(parseAcceptors(output, probe)).toEqual(expected);
  });
});
