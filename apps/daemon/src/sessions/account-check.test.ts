import { mintId, type AccountProblem, type SupportedAccountKind } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import type { AccountExpectation } from '../environment';
import {
  checkAccount,
  codexIdentity,
  checkInitCredentials,
  credentialProblem,
  missingAccountRefusal,
  modelMatches,
  noAccountWhy,
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
const CHATGPT: Partial<SeenAccount> = {
  email: 'a@b.c',
  organization: 'w1',
  subscriptionType: 'pro',
  apiProvider: 'chatgpt',
};
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

  it.each<{
    name: string;
    seen: Partial<SeenAccount>;
    problem: AccountProblem | null;
    seenIdentity?: string | null;
  }>([
    { name: 'the confirmed ChatGPT sign-in', seen: CHATGPT, problem: null },
    {
      name: 'the same email in another workspace',
      seen: { ...CHATGPT, organization: 'w2' },
      problem: 'identity_mismatch',
      seenIdentity: 'a@b.c · w2',
    },
    {
      name: 'another email in the same workspace',
      seen: { ...CHATGPT, email: 'other@b.c' },
      problem: 'identity_mismatch',
      seenIdentity: 'other@b.c · w1',
    },
    {
      name: 'a sign-in reporting no workspace',
      seen: { ...CHATGPT, organization: undefined },
      problem: 'identity_mismatch',
      seenIdentity: 'a@b.c',
    },
    {
      name: 'an API key where the sign-in should be',
      seen: { apiKeySource: 'OPENAI_API_KEY', apiProvider: 'apikey' },
      problem: 'wrong_credentials',
    },
    { name: 'nothing reported', seen: {}, problem: 'signed_out' },
  ])('a ChatGPT sign-in expecting a@b.c · w1 meets $name', ({ seen, problem, seenIdentity }) => {
    const refusal = checkAccount(expect_('codex_signin', 'a@b.c · w1'), { ...NONE, ...seen });
    expect(refusal?.problem ?? null).toBe(problem);
    if (seenIdentity !== undefined) expect(refusal?.seenIdentity ?? null).toBe(seenIdentity);
    if (refusal) {
      expect(refusal.message).toContain('Company A');
      expect(refusal.message).not.toMatch(/Claude|claude/);
    }
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
  it.each<[string, string, string, boolean]>([
    ['the launch ID reported back', 'claude-opus-5-5', 'claude-opus-5-5', true],
    [
      'a [1m] launch ID a subscription reports without it',
      'claude-opus-5-5[1m]',
      'claude-opus-5-5',
      true,
    ],
    [
      'a [1m] launch ID Bedrock reports with it',
      'us.anthropic.claude-sonnet-4-6[1m]',
      'us.anthropic.claude-sonnet-4-6[1m]',
      true,
    ],
    ['a prefixed Bedrock ID', 'us.anthropic.claude-opus-5-5', 'us.anthropic.claude-opus-5-5', true],
    ['a Codex model', 'gpt-5.6-sol', 'gpt-5.6-sol', true],
    ['another model than the one launched', 'claude-opus-5-5', 'claude-sonnet-5-5', false],
    ['an alias, which 10db no longer launches', 'haiku', 'claude-haiku-5-5', false],
    [
      'a canonical ID against a prefixed one',
      'claude-opus-5-5',
      'us.anthropic.claude-opus-5-5',
      false,
    ],
  ])('%s', (_name, launched, reported, ok) => {
    expect(modelMatches(launched, reported)).toBe(ok);
  });
});

describe('missingAccountRefusal', () => {
  it.each<[SupportedAccountKind, AccountProblem | null]>([
    ['claude_subscription', 'signed_out'],
    ['codex_signin', 'signed_out'],
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

describe('noAccountWhy', () => {
  it('names one start by the wait alone, and says nothing was printed', () => {
    expect(noAccountWhy(30_000, [''], 'claude_subscription')).toEqual({
      why: 'Claude Code reported no account within 30 s',
      printed: 'Claude Code printed nothing',
    });
  });

  it('counts the starts and quotes what each printed, once for the same text', () => {
    expect(
      noAccountWhy(
        30_000,
        ['warming up\n  plugin cache locked', '', 'warming up plugin cache locked'],
        'claude_subscription',
      ),
    ).toEqual({
      why: 'Claude Code reported no account within 30 s on each of 3 starts',
      printed: 'Claude Code printed: "warming up plugin cache locked"',
    });
    expect(noAccountWhy(30_000, ['one', 'two'], 'claude_subscription').printed).toBe(
      'Claude Code printed: "one"; "two"',
    );
  });

  it('keeps the end of a long print on one line, without control characters or a final full stop', () => {
    const { printed } = noAccountWhy(
      30_000,
      [`${'x'.repeat(1_000)}\u001b[31m\nfailed.\r\n`],
      'claude_subscription',
    );
    expect(printed).toMatch(/^Claude Code printed: "…x+ failed"$/);
    expect(printed).not.toContain('\u001b');
    expect(printed.length).toBeLessThan(400);
  });
});

describe('missingAccountRefusal with what Claude Code printed', () => {
  it('puts it after the signed-out reading, so the card can show both', () => {
    const refusal = missingAccountRefusal(
      expect_('claude_subscription'),
      'Claude Code reported no account within 30 s on each of 2 starts',
      'Claude Code printed nothing',
    );
    expect(refusal?.message).toBe(
      'Claude Code reported no account within 30 s on each of 2 starts for account "Company A", which looks signed out. Claude Code printed nothing',
    );
  });
});

describe('missingAccountRefusal with what claude auth status said', () => {
  const why = 'Claude Code reported no account within 30 s on each of 2 starts';
  it('says the account looked signed out when claude auth status says it is', () => {
    const refusal = missingAccountRefusal(
      expect_('claude_subscription'),
      why,
      'Claude Code printed nothing',
      'signed_out',
    );
    expect(refusal).toEqual({
      problem: 'signed_out',
      message: `${why} for account "Company A", and claude auth status says it is not signed in, so it looks signed out. Claude Code printed nothing`,
      seenIdentity: null,
    });
  });

  it.each([
    ['signed_in', 'claude auth status says it is signed in'],
    ['unknown', 'claude auth status gave no answer'],
  ] as const)(
    'says the starts kept timing out, not a sign-out, when the check says %s',
    (state, said) => {
      const refusal = missingAccountRefusal(
        expect_('claude_subscription'),
        why,
        'Claude Code printed nothing',
        state,
      );
      expect(refusal).toEqual({
        problem: 'start_timeout',
        message: `${why} for account "Company A", but ${said}, so its starts kept timing out. Claude Code printed nothing`,
        seenIdentity: null,
      });
    },
  );

  it('leaves a keyed account to fail its workstream whatever the check says', () => {
    expect(missingAccountRefusal(expect_('anthropic_api_key'), why, '', 'signed_out')).toBeNull();
  });
});

describe('noAccountWhy with a wait that grows', () => {
  it('names each start by its wait when the waits differ', () => {
    expect(noAccountWhy([30_000, 60_000, 120_000], ['', '', ''], 'claude_subscription').why).toBe(
      'Claude Code reported no account on each of 3 starts (waiting 30 s, 60 s and 120 s)',
    );
  });

  it('keeps the short wording when every start waited the same', () => {
    expect(noAccountWhy([30_000, 30_000], ['', ''], 'claude_subscription').why).toBe(
      'Claude Code reported no account within 30 s on each of 2 starts',
    );
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

describe('codexIdentity', () => {
  it('joins the email and the workspace', () => {
    expect(codexIdentity('a@b.c', 'w1')).toBe('a@b.c · w1');
  });
});

describe('missingAccountRefusal for a ChatGPT sign-in', () => {
  it('names Codex and codex login status, never Claude Code', () => {
    const refusal = missingAccountRefusal(
      expect_('codex_signin'),
      'Codex reported no account within 30 s',
      'Codex printed nothing',
      'signed_in',
    );
    expect(refusal?.problem).toBe('start_timeout');
    expect(refusal?.message).toContain('codex login status');
    expect(refusal?.message).not.toMatch(/Claude|claude/);
  });
});

describe('noAccountWhy for a ChatGPT sign-in', () => {
  it('names Codex in both parts, never Claude', () => {
    const { why, printed } = noAccountWhy(30_000, ['', 'rollout locked'], 'codex_signin');
    expect(why).toBe('Codex reported no account within 30 s on each of 2 starts');
    expect(printed).toBe('Codex printed: "rollout locked"');
    expect(noAccountWhy(30_000, [''], 'codex_signin').printed).toBe('Codex printed nothing');
    expect(`${why} ${printed}`).not.toMatch(/Claude/);
  });
});
