import { describe, expect, it } from 'vitest';
import { factoryViteCommand, viteStartFailure } from './factory-vite';

const CONNECTION = {
  url: 'http://127.0.0.1:53117',
  token: 'factory-token-0123456789abcdefghijklmn',
};

describe('factoryViteCommand', () => {
  it('runs Vite with CORS off, so no other localhost page can read the module that holds the token', () => {
    expect(factoryViteCommand(CONNECTION)).toEqual({
      file: 'pnpm',
      args: ['exec', 'vite', '--no-cors'],
      env: { VITE_DAEMON_URL: CONNECTION.url, VITE_DAEMON_TOKEN: CONNECTION.token },
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
