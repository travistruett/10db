import { AccountCardChoice, AccountProblem } from '@10db/contracts';
import { createTestStore, getAccountRow, seedAccount } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { refusedCard } from './cards';

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
