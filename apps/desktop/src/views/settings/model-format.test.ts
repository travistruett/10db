import { describe, expect, it } from 'vitest';
import { accountDto } from '../../test/account-fixtures';
import { accountModelDto } from '../../test/model-fixtures';
import { costNote } from './model-format';

const plan = accountDto({ kind: 'claude_subscription' });
const bedrock = accountDto({ kind: 'bedrock' });
const offer = (accountId: typeof plan.id, outputPrice: number | null) =>
  accountModelDto({ accountId, model: 'm', outputPrice });

describe('costNote', () => {
  it.each([
    { name: 'no account', account: null, offers: [], want: "At the maker's API list price" },
    {
      name: 'a plan',
      account: plan,
      offers: [offer(plan.id, null)],
      want: "At the maker's API list price; this account has no per-token price",
    },
    {
      name: 'a metered account whose list has no prices',
      account: bedrock,
      offers: [offer(bedrock.id, null)],
      want: "At the maker's API list price; this account has no per-token price",
    },
    {
      name: 'a metered account with prices',
      account: bedrock,
      offers: [offer(bedrock.id, 5)],
      want: "At the maker's API list price, scaled to this account's own output price",
    },
    {
      name: 'a metered account whose list is not read yet',
      account: bedrock,
      offers: [],
      want: "At the maker's API list price; this account's own price is unknown until its list is read",
    },
    {
      name: 'a plan with no list yet',
      account: plan,
      offers: [],
      want: "At the maker's API list price; this account has no per-token price",
    },
  ])('$name', ({ account, offers, want }) => {
    expect(costNote(account, offers)).toBe(want);
  });
});
