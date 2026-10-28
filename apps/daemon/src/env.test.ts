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
    ['the highest port', 'http://localhost:65535'],
  ])('accepts a dev UI origin on %s', (_name, origin) => {
    expect(loadEnv({ TENDB_DEV_UI_ORIGIN: origin }).TENDB_DEV_UI_ORIGIN).toBe(origin);
  });

  it.each([
    ['a remote host', 'http://example.com:1420'],
    ['https', 'https://localhost:1420'],
    ['a path', 'http://localhost:1420/app'],
    ['no port', 'http://localhost'],
    ['port 0', 'http://localhost:0'],
    ['a port above 65535', 'http://localhost:99999'],
  ])('rejects a dev UI origin with %s', (_name, origin) => {
    expect(() => loadEnv({ TENDB_DEV_UI_ORIGIN: origin })).toThrow('TENDB_DEV_UI_ORIGIN');
  });

  it.each([
    ['a short dev token', { TENDB_DEV_UI_TOKEN: 'short-secret-value' }, 'TENDB_DEV_UI_TOKEN'],
    ['a relative claude path', { TENDB_CLAUDE_PATH: 'bin/claude' }, 'TENDB_CLAUDE_PATH'],
    ['a relative worktree root', { TENDB_WORKTREE_ROOT: 'worktrees' }, 'TENDB_WORKTREE_ROOT'],
    [
      'a worktree root with a home shorthand',
      { TENDB_WORKTREE_ROOT: '~/wt' },
      'TENDB_WORKTREE_ROOT',
    ],
  ])('rejects %s without echoing it', (_name, source, variable) => {
    expect(() => loadEnv(source)).toThrow(variable);
    expect(() => loadEnv(source)).not.toThrow(String(Object.values(source)[0]));
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
