import { describe, expect, it } from 'vitest';
import { StorageState } from './storage-state';

// Workbench spec §10: a project's sign-in is Playwright's storage state, read back from the data
// directory through zod.

const COOKIE = {
  name: 'sessionid',
  value: 'abc',
  domain: 'localhost',
  path: '/',
  expires: -1,
  httpOnly: true,
  secure: false,
  sameSite: 'Lax',
};

const STATES = [
  {
    name: 'cookies and local storage',
    state: {
      cookies: [COOKIE],
      origins: [{ origin: 'http://localhost:8800', localStorage: [{ name: 'k', value: 'v' }] }],
    },
    ok: true,
  },
  { name: 'nothing kept', state: { cookies: [], origins: [] }, ok: true },
  {
    name: 'a field a later Playwright writes',
    state: { cookies: [{ ...COOKIE, partitionKey: 'x' }], origins: [] },
    ok: true,
  },
  {
    name: 'a cookie with no name',
    state: { cookies: [{ ...COOKIE, name: '' }], origins: [] },
    ok: false,
  },
  {
    name: 'a cookie with an unknown same-site rule',
    state: { cookies: [{ ...COOKIE, sameSite: 'Sometimes' }], origins: [] },
    ok: false,
  },
  { name: 'no cookies list', state: { origins: [] }, ok: false },
];

describe('StorageState', () => {
  it.each(STATES)('$name', ({ state, ok }) => {
    expect(StorageState.safeParse(state).success).toBe(ok);
  });

  it('keeps a field it does not know, so the browser gets the state as it wrote it', () => {
    const parsed = StorageState.parse({ cookies: [{ ...COOKIE, partitionKey: 'x' }], origins: [] });
    expect(parsed.cookies[0]).toMatchObject({ partitionKey: 'x' });
  });
});
