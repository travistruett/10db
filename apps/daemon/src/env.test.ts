import { describe, expect, it } from 'vitest';
import { EnvError, loadEnv } from './env';

describe('loadEnv', () => {
  it('applies defaults', () => {
    expect(loadEnv({})).toEqual({
      TENDB_PORT: 4317,
      TENDB_LOG_LEVEL: 'info',
    });
  });

  it('reads the fake script path', () => {
    expect(loadEnv({ TENDB_FAKE_SCRIPTS: '/tmp/book.json' }).TENDB_FAKE_SCRIPTS).toBe(
      '/tmp/book.json',
    );
  });

  it('coerces the port', () => {
    expect(loadEnv({ TENDB_PORT: '0' }).TENDB_PORT).toBe(0);
  });

  it('treats empty values as unset, as an exported .env.example leaves them', () => {
    expect(loadEnv({ TENDB_DATA_DIR: '', TENDB_PORT: '', TENDB_LOG_LEVEL: '' })).toEqual({
      TENDB_PORT: 4317,
      TENDB_LOG_LEVEL: 'info',
    });
  });

  it.each([
    ['port out of range', { TENDB_PORT: '70000' }, 'TENDB_PORT'],
    ['unknown log level', { TENDB_LOG_LEVEL: 'loud' }, 'TENDB_LOG_LEVEL'],
  ])('rejects %s, naming the variable', (_name, source, variable) => {
    expect(() => loadEnv(source)).toThrow(EnvError);
    expect(() => loadEnv(source)).toThrow(variable);
  });

  it('accepts a long dev UI token and an absolute claude path', () => {
    const token = 'a'.repeat(43);
    expect(
      loadEnv({ TENDB_DEV_UI_TOKEN: token, TENDB_CLAUDE_PATH: '/usr/local/bin/claude' }),
    ).toMatchObject({ TENDB_DEV_UI_TOKEN: token, TENDB_CLAUDE_PATH: '/usr/local/bin/claude' });
  });

  it.each([
    ['localhost', 'http://localhost:51234'],
    ['the IPv4 loopback', 'http://127.0.0.1:51234'],
    ['the IPv6 loopback', 'http://[::1]:51234'],
    ['the Vite port', 'http://localhost:1420'],
    ['the lowest port', 'http://localhost:1'],
    ['the highest port', 'http://localhost:65535'],
  ])('accepts a dev UI origin on %s', (_name, origin) => {
    expect(loadEnv({ TENDB_DEV_UI_ORIGIN: origin }).TENDB_DEV_UI_ORIGIN).toBe(origin);
  });

  it.each([
    ['a remote host', 'http://example.com:1420'],
    ['a host that starts with localhost', 'http://localhost.example.com:1420'],
    ['another IPv4 loopback address', 'http://127.0.0.2:1420'],
    ['the unspecified address', 'http://0.0.0.0:1420'],
    ['another IPv6 address', 'http://[::2]:1420'],
    ['an unbracketed IPv6 address', 'http://::1:1420'],
    ['an upper-case host', 'http://LOCALHOST:1420'],
    ['https', 'https://localhost:1420'],
    ['a scheme other than http', 'tauri://localhost'],
    ['a path', 'http://localhost:1420/app'],
    ['a trailing slash', 'http://localhost:1420/'],
    ['a query', 'http://localhost:1420?x=1'],
    ['a fragment', 'http://localhost:1420#x'],
    ['credentials', 'http://user@localhost:1420'],
    ['two origins', 'http://localhost:1420,http://localhost:1421'],
    ['surrounding space', ' http://localhost:1420'],
    ['no port', 'http://localhost'],
    ['port 0', 'http://localhost:0'],
    ['a port with a leading zero', 'http://localhost:01420'],
    ['a port above 65535', 'http://localhost:99999'],
  ])('rejects a dev UI origin with %s, naming the variable but not the value', (_name, origin) => {
    expect(() => loadEnv({ TENDB_DEV_UI_ORIGIN: origin })).toThrow(EnvError);
    expect(() => loadEnv({ TENDB_DEV_UI_ORIGIN: origin })).toThrow('TENDB_DEV_UI_ORIGIN');
    expect(() => loadEnv({ TENDB_DEV_UI_ORIGIN: origin })).not.toThrow(origin);
  });

  it.each([
    ['a short dev token', { TENDB_DEV_UI_TOKEN: 'short-secret-value' }, 'TENDB_DEV_UI_TOKEN'],
    ['a relative claude path', { TENDB_CLAUDE_PATH: 'bin/claude' }, 'TENDB_CLAUDE_PATH'],
    ['a relative worktree root', { TENDB_WORKTREE_ROOT: 'worktrees' }, 'TENDB_WORKTREE_ROOT'],
    ['zero gate slots', { TENDB_GATE_SLOTS: '0' }, 'TENDB_GATE_SLOTS'],
    ['a fractional gate slot count', { TENDB_GATE_SLOTS: '1.5' }, 'TENDB_GATE_SLOTS'],
    ['a text gate slot count', { TENDB_GATE_SLOTS: 'two' }, 'TENDB_GATE_SLOTS'],
    [
      'a worktree root with a home shorthand',
      { TENDB_WORKTREE_ROOT: '~/wt' },
      'TENDB_WORKTREE_ROOT',
    ],
  ])('rejects %s without echoing it', (_name, source, variable) => {
    expect(() => loadEnv(source)).toThrow(variable);
    expect(() => loadEnv(source)).not.toThrow(String(Object.values(source)[0]));
  });

  it.each([
    ['on', 'on'],
    ['off', 'off'],
    ['absent', undefined],
    ['empty, which means unset', undefined],
  ])('reads TENDB_BENCHMARKS when it is %s', (name, expected) => {
    const source =
      name === 'absent' ? {} : { TENDB_BENCHMARKS: name.startsWith('empty') ? '' : name };
    expect(loadEnv(source).TENDB_BENCHMARKS).toBe(expected);
  });

  it.each([
    ['uppercase', 'OFF'],
    ['a boolean word', 'false'],
    ['a number', '0'],
  ])('rejects TENDB_BENCHMARKS as %s, naming the variable and not the value', (_name, value) => {
    expect(() => loadEnv({ TENDB_BENCHMARKS: value })).toThrow(EnvError);
    expect(() => loadEnv({ TENDB_BENCHMARKS: value })).toThrow('TENDB_BENCHMARKS');
    expect(() => loadEnv({ TENDB_BENCHMARKS: value })).not.toThrow(`: ${value}`);
  });

  it('never puts a value in the error message', () => {
    const secretLooking = 'sk-ant-api03-DO-NOT-LEAK';
    try {
      loadEnv({ TENDB_PORT: secretLooking });
      expect.unreachable('loadEnv should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvError);
      expect(String(error)).not.toContain(secretLooking);
      expect(JSON.stringify((error as EnvError).issues)).not.toContain(secretLooking);
    }
  });
});
