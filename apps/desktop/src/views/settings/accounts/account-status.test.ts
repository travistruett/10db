import { describe, expect, it } from 'vitest';
import { accountDto, DEFAULT_ACCOUNT } from '../../../test/account-fixtures';
import { AccountStatus, accountStatus } from './account-status';

const CASES: { name: string; account: ReturnType<typeof accountDto>; status: AccountStatus }[] = [
  {
    name: 'a subscription with no confirmed identity',
    account: accountDto({ expectedIdentity: null }),
    status: AccountStatus.NeedsSignIn,
  },
  {
    name: 'a subscription with a confirmed identity',
    account: accountDto({ expectedIdentity: 'a@example.com' }),
    status: AccountStatus.Ready,
  },
  { name: 'the default account', account: DEFAULT_ACCOUNT, status: AccountStatus.Ready },
  {
    name: 'an API key with no secret',
    account: accountDto({ kind: 'anthropic_api_key', settings: {}, secretSet: false }),
    status: AccountStatus.NeedsSecret,
  },
  {
    name: 'an API key with a secret',
    account: accountDto({ kind: 'anthropic_api_key', settings: {}, secretSet: true }),
    status: AccountStatus.Ready,
  },
  {
    name: 'Bedrock on a profile',
    account: accountDto({
      kind: 'bedrock',
      settings: { region: 'us-west-2', awsProfile: 'client-c' },
    }),
    status: AccountStatus.Ready,
  },
  {
    name: 'Bedrock on a bearer token without a secret',
    account: accountDto({
      kind: 'bedrock',
      settings: { region: 'us-west-2', awsProfile: null },
    }),
    status: AccountStatus.NeedsSecret,
  },
  {
    name: 'a gateway with a secret',
    account: accountDto({
      kind: 'gateway',
      settings: { baseUrl: 'https://gateway.example.com' },
      secretSet: true,
    }),
    status: AccountStatus.Ready,
  },
  {
    name: 'an archived account that would otherwise need a secret',
    account: accountDto({ kind: 'anthropic_api_key', settings: {}, archived: true }),
    status: AccountStatus.Archived,
  },
  {
    name: 'an archived unconfirmed subscription',
    account: accountDto({ archived: true }),
    status: AccountStatus.Archived,
  },
];

describe('accountStatus', () => {
  it.each(CASES)('$name', ({ account, status }) => {
    expect(accountStatus(account)).toBe(status);
  });
});
