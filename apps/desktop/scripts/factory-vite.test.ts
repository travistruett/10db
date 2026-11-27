import { describe, expect, it } from 'vitest';
import { factoryViteCommand, viteStartFailure } from './factory-vite';

describe('factoryViteCommand', () => {
  it('runs Vite with CORS off, so no other localhost page can read the daemon token it serves', () => {
    expect(factoryViteCommand('/data')).toEqual({
      file: 'pnpm',
      args: ['exec', 'vite', '--no-cors'],
      env: { TENDB_FACTORY_DATA_DIR: '/data', VITE_DAEMON_FACTORY: '1' },
    });
  });
});

describe('viteStartFailure', () => {
  it.each([
    {
      name: 'pnpm missing from PATH',
      error: Object.assign(new Error('spawn pnpm ENOENT'), { code: 'ENOENT' }),
      says: /pnpm isn't on your PATH.*mise/s,
    },
    {
      name: 'any other spawn error',
      error: Object.assign(new Error('spawn pnpm EACCES'), { code: 'EACCES' }),
      says: /Could not start Vite through pnpm: spawn pnpm EACCES/,
    },
  ])('explains $name in one message', ({ error, says }) => {
    expect(viteStartFailure(error)).toMatch(says);
  });
});
