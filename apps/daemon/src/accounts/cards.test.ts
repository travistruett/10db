import { AccountCardChoice, AccountProblem } from '@10db/contracts';
import { createTestStore, getAccountRow, seedAccount } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CAP_RAISE_DETAIL,
  capCard,
  credentialsCard,
  recordedCard,
  refusedCard,
  secretCard,
  signInCard,
} from './cards';
import { monthOf } from './month';

let close: (() => void) | null = null;
afterEach(() => {
  close?.();
  close = null;
});

describe('the sessions-refused card', () => {
  it('tells the builder Later leaves the account paused and where to resume it', () => {
    const test = createTestStore();
    close = test.close;
    const account = getAccountRow(
      test.store.db,
      seedAccount(test.store, { kind: 'anthropic_api_key', label: 'Client key' }).id,
    );
    const card = refusedCard(account, {
      problem: AccountProblem.KeychainUnavailable,
      message: 'The Keychain is locked',
      seenIdentity: null,
    });
    const later = card.options?.find((o) => o.label === AccountCardChoice.Later);
    expect(later?.description).toContain('Settings');
    expect(later?.description).toMatch(/resume/i);
  });
});

describe('the cards that used to hold nothing', () => {
  type Made = ReturnType<typeof accounts>;
  function accounts() {
    const test = createTestStore();
    close = test.close;
    const sub = getAccountRow(
      test.store.db,
      seedAccount(test.store, { kind: 'claude_subscription', label: 'Company A' }).id,
    );
    const key = getAccountRow(
      test.store.db,
      seedAccount(test.store, { kind: 'anthropic_api_key', label: 'Client key' }).id,
    );
    return { sub, key };
  }
  const labels = (card: { options?: readonly { label: string }[] }) =>
    (card.options ?? []).map((o) => o.label);

  it.each([
    ['sign-in', (a: Made) => signInCard(a.sub)],
    [
      'credentials',
      (a: Made) =>
        credentialsCard(a.sub, {
          problem: AccountProblem.WrongCredentials,
          message: 'It reports an API key',
          seenIdentity: null,
        }),
    ],
    ['secret', (a: Made) => secretCard(a.key)],
  ])('offers Check again on the %s card', (_name, make) => {
    expect(labels(make(accounts()))).toEqual([AccountCardChoice.CheckAgain]);
  });

  it('offers Record again on the card that names the default login', () => {
    const { sub } = accounts();
    expect(labels(recordedCard(sub, 'me@example.com'))).toEqual([AccountCardChoice.RecordAgain]);
  });

  it('offers to raise the cap to a figure above what is spent, and the card says so', () => {
    const { key } = accounts();
    const window = monthOf(new Date(2026, 9, 20));
    const card = capCard(key, { spentUsd: 57.5, capUsd: 50, window });
    expect(labels(card)).toEqual(['Raise cap to $70']);
    expect(card.detail[CAP_RAISE_DETAIL]).toEqual({
      accountId: key.id,
      choice: 'Raise cap to $70',
      toUsd: 70,
    });
    expect(card.body).toContain('Raise cap to $70');
  });
});
