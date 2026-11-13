import { describe, expect, it } from 'vitest';
import { readAccountSecret, readAccountSecretAsync } from './account-secret';
import { secretFingerprint, type Keychain } from './keychain';

const SECRET = 'sk-or-v1-0123456789abcdef-NEVER-SHOWN';

function keychain(items: Record<string, string>): Keychain {
  return {
    read: (account) => items[account] ?? null,
    readAsync: (account) => Promise.resolve(items[account] ?? null),
    write: () => undefined,
    remove: () => undefined,
  };
}

describe('readAccountSecret', () => {
  it.each<{
    name: string;
    account: { secretRef: string | null; secretFingerprint: string | null };
    items: Record<string, string>;
    expected: { state: 'set'; secret: string } | { state: 'missing' | 'changed' };
  }>([
    {
      name: 'a recorded secret that still matches',
      account: { secretRef: 'account:a', secretFingerprint: secretFingerprint(SECRET) },
      items: { 'account:a': SECRET },
      expected: { state: 'set', secret: SECRET },
    },
    {
      name: 'an account that takes no secret',
      account: { secretRef: null, secretFingerprint: null },
      items: {},
      expected: { state: 'missing' },
    },
    {
      name: 'a secret never recorded through 10db',
      account: { secretRef: 'account:a', secretFingerprint: null },
      items: { 'account:a': SECRET },
      expected: { state: 'missing' },
    },
    {
      name: 'a recorded secret the Keychain no longer holds',
      account: { secretRef: 'account:a', secretFingerprint: secretFingerprint(SECRET) },
      items: {},
      expected: { state: 'missing' },
    },
    {
      name: 'a secret changed outside 10db',
      account: { secretRef: 'account:a', secretFingerprint: secretFingerprint(SECRET) },
      items: { 'account:a': 'sk-or-v1-other-value' },
      expected: { state: 'changed' },
    },
  ])('answers $expected.state for $name, the same on the sync and async read', async (row) => {
    const kc = keychain(row.items);
    expect(readAccountSecret(row.account, kc)).toEqual(row.expected);
    expect(await readAccountSecretAsync(row.account, kc)).toEqual(row.expected);
  });
});
