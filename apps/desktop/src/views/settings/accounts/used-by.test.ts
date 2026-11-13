import { mintId, type AccountId } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { accountUsedBy, usedByText } from './used-by';

const ME = mintId('Account');
const OTHER = mintId('Account');
const project = (
  name: string,
  accountId: AccountId,
  fallbackAccountId: AccountId | null = null,
) => ({
  name,
  accountId,
  fallbackAccountId,
});
const judge = (accountId: AccountId | null) => ({ config: { accountId } });

describe('accountUsedBy', () => {
  it.each([
    { name: 'nothing', projects: [project('Renewals', OTHER)], judge: judge(null), want: [] },
    {
      name: "a project's account",
      projects: [project('Renewals', ME)],
      judge: judge(null),
      want: ["Renewals' agents"],
    },
    {
      name: "a project's backup",
      projects: [project('Renewals', OTHER, ME)],
      judge: judge(null),
      want: ["Renewals' backup"],
    },
    {
      name: 'decisions',
      projects: [],
      judge: judge(ME),
      want: ['decisions'],
    },
    {
      name: 'all three, in the order projects then decisions',
      projects: [project('Renewals', ME), project('Billing', OTHER, ME)],
      judge: judge(ME),
      want: ["Renewals' agents", "Billing's backup", 'decisions'],
    },
    { name: 'a judge not read yet', projects: [], judge: undefined, want: [] },
  ])('$name', ({ projects, judge: j, want }) => {
    expect(accountUsedBy({ id: ME }, projects, j)).toEqual(want);
  });
});

describe('usedByText', () => {
  it.each([
    { used: [], want: 'Used by nothing' },
    { used: ["Renewals' agents", 'decisions'], want: "Used by: Renewals' agents, decisions" },
  ])('$want', ({ used, want }) => {
    expect(usedByText(used)).toBe(want);
  });
});
