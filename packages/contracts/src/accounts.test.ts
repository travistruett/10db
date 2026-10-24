import { describe, expect, it } from 'vitest';
import {
  AccountCardDetail,
  accountDisplayName,
  AccountInput,
  AccountKind,
  AccountPatch,
  AccountSecretInput,
  AccountUsageDto,
  DEFAULT_ACCOUNT_LANE_CAP,
  isMetered,
  mintId,
  Month,
  needsSecret,
  parseAccountSettings,
} from './index';

describe('AccountInput', () => {
  it.each<{ name: string; input: unknown }>([
    { name: 'a subscription', input: { kind: 'claude_subscription', label: 'Company A' } },
    {
      name: 'an API key with a cap and an organization',
      input: {
        kind: 'anthropic_api_key',
        label: 'Client key',
        payer: 'Client B',
        monthlyCapUsd: 500,
        expectedIdentity: 'org-123',
      },
    },
    {
      name: 'Bedrock on a profile',
      input: {
        kind: 'bedrock',
        label: 'Client C',
        settings: { region: 'us-west-2', awsProfile: 'client-c' },
      },
    },
    {
      name: 'Bedrock on a bearer token, with a model map',
      input: {
        kind: 'bedrock',
        label: 'Client D',
        settings: {
          region: 'eu-central-1',
          awsProfile: null,
          modelMap: { sonnet: 'eu.anthropic.claude-sonnet-5-5-v1:0' },
        },
      },
    },
    {
      name: 'a gateway offering two aliases',
      input: {
        kind: 'gateway',
        label: 'OpenRouter',
        settings: { baseUrl: 'https://openrouter.ai/api', aliases: ['haiku', 'sonnet'] },
      },
    },
  ])('accepts $name', ({ input }) => {
    expect(AccountInput.safeParse(input).success).toBe(true);
  });

  it.each<{ name: string; input: unknown; message: RegExp }>([
    {
      name: 'a reserved OpenAI kind',
      input: { kind: 'openai_api_key', label: 'x' },
      message: /reserved until the Codex adapter exists/,
    },
    {
      name: 'a reserved Codex kind',
      input: { kind: 'codex_signin', label: 'x' },
      message: /reserved until the Codex adapter exists/,
    },
    {
      name: 'a monthly cap on a subscription',
      input: { kind: 'claude_subscription', label: 'x', monthlyCapUsd: 10 },
      message: /monthlyCapUsd/,
    },
    {
      name: 'an expected identity on a gateway',
      input: {
        kind: 'gateway',
        label: 'x',
        expectedIdentity: 'org',
        settings: { baseUrl: 'https://g.example' },
      },
      message: /expectedIdentity/,
    },
    {
      name: 'a gateway over plain http',
      input: { kind: 'gateway', label: 'x', settings: { baseUrl: 'http://g.example' } },
      message: /baseUrl/,
    },
    {
      name: 'a gateway URL with credentials in it',
      input: { kind: 'gateway', label: 'x', settings: { baseUrl: 'https://u:p@g.example' } },
      message: /no credentials/,
    },
    {
      name: 'Bedrock without a region',
      input: { kind: 'bedrock', label: 'x', settings: { awsProfile: null } },
      message: /region/,
    },
    {
      name: 'a blank label',
      input: { kind: 'claude_subscription', label: '   ' },
      message: /label/,
    },
    {
      name: 'a lane cap of zero',
      input: { kind: 'claude_subscription', label: 'x', laneCap: 0 },
      message: /laneCap/,
    },
    {
      name: 'an unknown settings key',
      input: { kind: 'claude_subscription', label: 'x', settings: { region: 'us-west-2' } },
      message: /region/,
    },
    {
      name: 'a model map keyed by a model ID instead of an alias',
      input: {
        kind: 'claude_subscription',
        label: 'x',
        settings: { modelMap: { 'claude-sonnet-5-5': 'claude-sonnet-5-5' } },
      },
      message: /model alias/,
    },
  ])('refuses $name', ({ input, message }) => {
    const parsed = AccountInput.safeParse(input);
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toMatch(message);
  });

  it('fills the defaults', () => {
    expect(AccountInput.parse({ kind: 'claude_subscription', label: ' A ' })).toEqual({
      kind: 'claude_subscription',
      label: 'A',
      payer: '',
      laneCap: DEFAULT_ACCOUNT_LANE_CAP,
      settings: {},
    });
    expect(AccountInput.parse({ kind: 'anthropic_api_key', label: 'K' })).toMatchObject({
      monthlyCapUsd: null,
      expectedIdentity: null,
    });
  });
});

describe('account kinds', () => {
  it.each<[AccountKind, boolean]>([
    [AccountKind.ClaudeSubscription, false],
    [AccountKind.AnthropicApiKey, true],
    [AccountKind.Bedrock, true],
    [AccountKind.Gateway, true],
  ])('%s is metered: %s', (kind, metered) => {
    expect(isMetered(kind)).toBe(metered);
  });

  it.each<{
    name: string;
    kind: 'claude_subscription' | 'anthropic_api_key' | 'bedrock' | 'gateway';
    settings: unknown;
    secret: boolean;
  }>([
    { name: 'a subscription', kind: 'claude_subscription', settings: {}, secret: false },
    { name: 'an API key', kind: 'anthropic_api_key', settings: {}, secret: true },
    {
      name: 'Bedrock on a profile',
      kind: 'bedrock',
      settings: { region: 'us-west-2', awsProfile: 'p' },
      secret: false,
    },
    {
      name: 'Bedrock on a bearer token',
      kind: 'bedrock',
      settings: { region: 'us-west-2', awsProfile: null },
      secret: true,
    },
    {
      name: 'a gateway',
      kind: 'gateway',
      settings: { baseUrl: 'https://g.example' },
      secret: true,
    },
  ])('$name needs a Keychain secret: $secret', ({ kind, settings, secret }) => {
    expect(needsSecret(kind, parseAccountSettings(kind, settings))).toBe(secret);
  });

  it('refuses settings that belong to another kind', () => {
    expect(() =>
      parseAccountSettings('gateway', { region: 'us-west-2', awsProfile: null }),
    ).toThrow();
  });
});

describe('the other account schemas', () => {
  it('refuses an empty patch, and an expected identity that is blank', () => {
    expect(AccountPatch.safeParse({}).success).toBe(false);
    expect(AccountPatch.safeParse({ expectedIdentity: ' ' }).success).toBe(false);
    expect(AccountPatch.parse({ expectedIdentity: null, monthlyCapUsd: 250 })).toEqual({
      expectedIdentity: null,
      monthlyCapUsd: 250,
    });
  });

  it.each<[string, string, boolean]>([
    ['an Anthropic key', `sk-ant-api03-${'a'.repeat(40)}`, true],
    ['a gateway token with symbols', 'sk-or-v1_abc+/=~!#', true],
    ['a secret with a space', 'abc def ghij', false],
    ['a secret with a double quote', 'abcdefgh"', false],
    ['a secret with a backslash', 'abcdefgh\\', false],
    ['a secret with a newline', 'abcdefgh\nrm', false],
    ['a seven-character secret', 'abcdefg', false],
  ])('secret input: %s', (_name, secret, ok) => {
    expect(AccountSecretInput.safeParse({ secret }).success).toBe(ok);
  });

  it.each<[string, boolean]>([
    ['2026-10', true],
    ['2026-1', false],
    ['2026-13', false],
    ['26-10', false],
  ])('month %s: %s', (month, ok) => {
    expect(Month.safeParse(month).success).toBe(ok);
  });

  it('allows a subscription usage report with no dollars', () => {
    const totals = { tokensIn: 10, tokensOut: 2, tokensCached: 5, costUsd: null };
    expect(
      AccountUsageDto.parse({
        accountId: mintId('Account'),
        month: '2026-10',
        total: totals,
        monthlyCapUsd: null,
        byProject: [{ ...totals, projectId: mintId('Project'), projectName: 'p' }],
      }).total.costUsd,
    ).toBeNull();
  });

  it('parses an account card detail', () => {
    const detail = {
      accountId: mintId('Account'),
      reason: 'refused',
      problem: 'identity_mismatch',
      seenIdentity: 'b@example.com',
    };
    expect(AccountCardDetail.parse(detail)).toEqual(detail);
  });

  it('names an account by its label, with its identity beside it once one is recorded', () => {
    expect(accountDisplayName({ label: 'Claude plan', expectedIdentity: 'you@example.com' })).toBe(
      'Claude plan · you@example.com',
    );
    expect(accountDisplayName({ label: 'OpenRouter', expectedIdentity: null })).toBe('OpenRouter');
  });
});
