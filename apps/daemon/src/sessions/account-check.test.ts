import { mintId, type AccountProblem, type SupportedAccountKind } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import type { AccountExpectation } from '../environment';
import {
  checkAccount,
  checkInitCredentials,
  credentialProblem,
  missingAccountRefusal,
  modelMatches,
  type SeenAccount,
} from './account-check';

const NONE: SeenAccount = {
  email: undefined,
  organization: undefined,
  subscriptionType: undefined,
  tokenSource: undefined,
  apiKeySource: undefined,
  apiProvider: undefined,
};
const expect_ = (
  kind: SupportedAccountKind,
  identity: string | null = null,
): AccountExpectation => ({
  accountId: mintId('Account'),
  label: 'Company A',
  kind,
  identity,
});
const SUB: Partial<SeenAccount> = {
  email: 'a@example.com',
  subscriptionType: 'Claude Max',
  apiProvider: 'firstParty',
  apiKeySource: 'none',
};

describe('checkAccount', () => {
  it.each<{
    name: string;
    expected: AccountExpectation;
    seen: Partial<SeenAccount>;
    problem: AccountProblem | null;
    seenIdentity?: string | null;
  }>([
    {
      name: 'the confirmed subscription',
      expected: expect_('claude_subscription', 'a@example.com'),
      seen: SUB,
      problem: null,
    },
    {
      name: 'the same email in another case',
      expected: expect_('claude_subscription', 'A@Example.com'),
      seen: SUB,
      problem: null,
    },
    {
      name: 'a subscription with no identity yet',
      expected: expect_('claude_subscription'),
      seen: SUB,
      problem: null,
    },
    {
      name: 'another subscription in the Keychain',
      expected: expect_('claude_subscription', 'a@example.com'),
      seen: { ...SUB, email: 'b@example.com' },
      problem: 'identity_mismatch',
      seenIdentity: 'b@example.com',
    },
    {
      name: 'a signed-out config directory',
      expected: expect_('claude_subscription', 'a@example.com'),
      seen: { apiProvider: 'firstParty' },
      problem: 'signed_out',
    },
    {
      name: 'an API key where the subscription should be',
      expected: expect_('claude_subscription', 'a@example.com'),
      seen: { ...SUB, apiKeySource: 'ANTHROPIC_API_KEY' },
      problem: 'wrong_credentials',
    },
    {
      name: 'a gateway token where the subscription should be',
      expected: expect_('claude_subscription', 'a@example.com'),
      seen: { ...SUB, tokenSource: 'ANTHROPIC_AUTH_TOKEN' },
      problem: 'wrong_credentials',
    },
    {
      name: 'Bedrock where the subscription should be',
      expected: expect_('claude_subscription', 'a@example.com'),
      seen: { apiProvider: 'bedrock' },
      problem: 'wrong_credentials',
    },
    {
      name: 'Bedrock with a plan and an email where the subscription should be',
      expected: expect_('claude_subscription', 'a@example.com'),
      seen: { ...SUB, apiProvider: 'bedrock' },
      problem: 'wrong_credentials',
    },
    {
      name: 'a gateway token alone where the subscription should be',
      expected: expect_('claude_subscription', 'a@example.com'),
      seen: { tokenSource: 'ANTHROPIC_AUTH_TOKEN' },
      problem: 'wrong_credentials',
    },
    {
      name: 'an API key',
      expected: expect_('anthropic_api_key'),
      seen: { apiKeySource: 'ANTHROPIC_API_KEY', apiProvider: 'firstParty' },
      problem: null,
    },
    {
      name: 'an API key from a key helper',
      expected: expect_('anthropic_api_key'),
      seen: { apiKeySource: 'apiKeyHelper', apiProvider: 'firstParty' },
      problem: 'wrong_credentials',
    },
    {
      name: 'an API key in the expected organization',
      expected: expect_('anthropic_api_key', 'org-1'),
      seen: { apiKeySource: 'ANTHROPIC_API_KEY', apiProvider: 'firstParty', organization: 'org-1' },
      problem: null,
    },
    {
      name: 'an API key reporting no organization when one is expected',
      expected: expect_('anthropic_api_key', 'org-1'),
      seen: { apiKeySource: 'ANTHROPIC_API_KEY', apiProvider: 'firstParty' },
      problem: 'identity_mismatch',
      seenIdentity: null,
    },
    {
      name: 'Bedrock',
      expected: expect_('bedrock'),
      seen: { apiProvider: 'bedrock' },
      problem: null,
    },
    {
      name: 'Bedrock that fell back to the first-party login',
      expected: expect_('bedrock'),
      seen: SUB,
      problem: 'wrong_credentials',
    },
    {
      name: 'a gateway as spike 12 saw it',
      expected: expect_('gateway'),
      seen: {
        apiProvider: 'firstParty',
        apiKeySource: 'none',
        tokenSource: 'ANTHROPIC_AUTH_TOKEN',
      },
      problem: null,
    },
    {
      name: 'a gateway that fell back to the saved login',
      expected: expect_('gateway'),
      seen: SUB,
      problem: 'wrong_credentials',
    },
    {
      name: 'a gateway reporting a provider spike 12 never saw',
      expected: expect_('gateway'),
      seen: { apiProvider: 'gateway', apiKeySource: 'none', tokenSource: 'ANTHROPIC_AUTH_TOKEN' },
      problem: 'wrong_credentials',
    },
  ])('$name', ({ expected, seen, problem, seenIdentity }) => {
    const refusal = checkAccount(expected, { ...NONE, ...seen });
    expect(refusal?.problem ?? null).toBe(problem);
    if (seenIdentity !== undefined) expect(refusal?.seenIdentity ?? null).toBe(seenIdentity);
    // A refusal's message is logged, so it never carries an email or organization.
    expect(refusal?.message ?? '').not.toMatch(/@|org-1/);
    if (refusal) expect(refusal.message).toContain('Company A');
  });

  it('re-checks the key source at init with the provider the preflight saw', () => {
    const expected = expect_('anthropic_api_key');
    const preflight: SeenAccount = {
      ...NONE,
      apiKeySource: 'ANTHROPIC_API_KEY',
      apiProvider: 'firstParty',
    };
    expect(checkInitCredentials(expected, 'ANTHROPIC_API_KEY', preflight)).toBeNull();
    expect(checkInitCredentials(expected, 'none', preflight)?.problem).toBe('wrong_credentials');
  });
});

describe('modelMatches', () => {
  it.each<[string, string, boolean]>([
    ['haiku', 'claude-haiku-5-5', true],
    ['sonnet', 'claude-sonnet-5-5[1m]', true],
    ['sonnet', 'us.anthropic.claude-sonnet-5-5-v1:0', true],
    ['haiku', '~anthropic/claude-haiku-latest', true],
    ['opus', 'claude-sonnet-5-5', false],
    ['~anthropic/claude-haiku-latest', '~anthropic/claude-haiku-latest', true],
    ['us.anthropic.claude-sonnet-5-5-v1:0', 'claude-sonnet-5-5', false],
  ])('%s against %s: %s', (requested, reported, ok) => {
    expect(modelMatches(requested, reported)).toBe(ok);
  });
});

describe('missingAccountRefusal', () => {
  it.each<[SupportedAccountKind, AccountProblem | null]>([
    ['claude_subscription', 'signed_out'],
    ['anthropic_api_key', null],
    ['bedrock', null],
    ['gateway', null],
  ])('a %s whose accountInfo() gave nothing: %s', (kind, problem) => {
    const refusal = missingAccountRefusal(
      expect_(kind),
      'Claude Code reported no account within 15 s',
    );
    expect(refusal?.problem ?? null).toBe(problem);
    if (refusal) expect(refusal.message).toContain('Company A');
  });
});

describe('credentialProblem', () => {
  it.each<[string | undefined, AccountProblem | null]>([
    ['authentication_failed', 'signed_out'],
    ['oauth_org_not_allowed', 'signed_out'],
    ['cloud_credential_error', 'signed_out'],
    ['billing_error', 'cannot_bill'],
    ['account_on_hold', 'cannot_bill'],
    ['rate_limit', null],
    ['server_error', null],
    [undefined, null],
  ])('%s → %s', (error, problem) => {
    expect(credentialProblem(error)).toBe(problem);
  });
});
