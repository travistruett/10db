import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  agentKind,
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
  OPENROUTER_CANT_RUN_AGENTS,
  parseAccountSettings,
  ProjectPatch,
  providerOf,
  runsAgents,
  signsInWithLogin,
  USAGE_HANDOFF_AT,
  USAGE_HANDOFF_MAX,
  USAGE_HANDOFF_MIN,
  type AgentAccountKind,
  type Provider,
  type SupportedAccountKind,
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
      name: 'Bedrock on a bearer token, with a fast-tier override',
      input: {
        kind: 'bedrock',
        label: 'Client D',
        settings: {
          region: 'eu-central-1',
          awsProfile: null,
          tierOverrides: { efficient: 'eu.anthropic.claude-haiku-5-5-v1:0' },
        },
      },
    },
    {
      name: 'a gateway overriding two tiers',
      input: {
        kind: 'gateway',
        label: 'OpenRouter',
        settings: {
          baseUrl: 'https://openrouter.ai/api',
          tierOverrides: { efficient: 'vendor/small', frontier: 'vendor/large' },
        },
      },
    },
    { name: 'a ChatGPT sign-in', input: { kind: 'codex_signin', label: 'ChatGPT Pro' } },
  ])('accepts $name', ({ input }) => {
    expect(AccountInput.safeParse(input).success).toBe(true);
  });

  it.each<{ name: string; input: unknown; message: RegExp }>([
    {
      name: 'a reserved OpenAI kind',
      input: { kind: 'openai_api_key', label: 'x' },
      message: /openai_api_key is reserved/,
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
      name: 'a gateway URL with no scheme',
      input: { kind: 'gateway', label: 'x', settings: { baseUrl: 'openrouter.ai/api' } },
      message: /baseUrl/,
    },
    {
      name: 'a gateway URL with a fragment',
      input: { kind: 'gateway', label: 'x', settings: { baseUrl: 'https://g.example/#sk-secret' } },
      message: /no credentials/,
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
      name: 'an override for a tier that does not exist',
      input: {
        kind: 'claude_subscription',
        label: 'x',
        settings: { tierOverrides: { huge: 'vendor/large' } },
      },
      message: /huge/,
    },
    {
      name: 'an override that is a tier name, not a model',
      input: {
        kind: 'claude_subscription',
        label: 'x',
        settings: { tierOverrides: { frontier: 'efficient' } },
      },
      message: /tierOverrides/,
    },
    {
      name: 'an override naming no model',
      input: {
        kind: 'claude_subscription',
        label: 'x',
        settings: { tierOverrides: { efficient: '  ' } },
      },
      message: /tierOverrides/,
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

describe('OpenRouter accounts', () => {
  it.each<[SupportedAccountKind, boolean]>([
    ['claude_subscription', true],
    ['anthropic_api_key', true],
    ['bedrock', true],
    ['gateway', true],
    ['codex_signin', true],
    ['openrouter', false],
  ])('%s runs agents: %s', (kind, runs) => {
    expect(runsAgents(kind)).toBe(runs);
  });

  it('holds a key, is not metered, and takes no settings', () => {
    expect(needsSecret('openrouter', parseAccountSettings('openrouter', {}))).toBe(true);
    expect(isMetered(AccountKind.OpenRouter)).toBe(false);
    expect(() => parseAccountSettings('openrouter', { tierOverrides: {} })).toThrow(z.ZodError);
  });

  it('parses a label and payer, and rejects any other field', () => {
    expect(AccountInput.parse({ kind: 'openrouter', label: 'OpenRouter', payer: 'Me' })).toEqual({
      kind: 'openrouter',
      label: 'OpenRouter',
      payer: 'Me',
    });
    for (const extra of [{ laneCap: 2 }, { monthlyCapUsd: 5 }, { settings: {} }]) {
      expect(() => AccountInput.parse({ kind: 'openrouter', label: 'O', ...extra })).toThrow(
        z.ZodError,
      );
    }
  });

  it('names the refusal a project binding gets', () => {
    expect(OPENROUTER_CANT_RUN_AGENTS).toBe("OpenRouter can't run agents yet");
  });
});

describe('agentKind', () => {
  it('answers an agent kind as itself, and refuses OpenRouter', () => {
    expect(agentKind('bedrock')).toBe('bedrock');
    expect(() => agentKind('openrouter')).toThrow(OPENROUTER_CANT_RUN_AGENTS);
  });
});

describe('account kinds', () => {
  it.each<[AgentAccountKind, Provider]>([
    ['claude_subscription', 'claude'],
    ['anthropic_api_key', 'claude'],
    ['bedrock', 'claude'],
    ['gateway', 'claude'],
    ['codex_signin', 'codex'],
  ])('%s runs on %s', (kind, provider) => {
    expect(providerOf(kind)).toBe(provider);
  });

  it.each<[SupportedAccountKind, boolean]>([
    ['claude_subscription', true],
    ['codex_signin', true],
    ['anthropic_api_key', false],
    ['bedrock', false],
    ['gateway', false],
  ])('%s signs in with a login: %s', (kind, login) => {
    expect(signsInWithLogin(kind)).toBe(login);
  });

  it('is not metered for a ChatGPT sign-in, and needs no secret', () => {
    expect(isMetered(AccountKind.CodexSignin)).toBe(false);
    expect(needsSecret('codex_signin', parseAccountSettings('codex_signin', {}))).toBe(false);
  });

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
    ).toThrow(z.ZodError);
  });
});

describe('the other account schemas', () => {
  it('keeps a project usage threshold below the limit itself', () => {
    expect([USAGE_HANDOFF_MIN, USAGE_HANDOFF_AT, USAGE_HANDOFF_MAX]).toEqual([0.5, 0.95, 0.99]);
    expect(ProjectPatch.safeParse({ usageHandoffAt: 0.8 }).success).toBe(true);
    expect(ProjectPatch.safeParse({ usageHandoffAt: 1 }).success).toBe(false);
    expect(ProjectPatch.safeParse({ usageHandoffAt: 0.3 }).success).toBe(false);
    expect(ProjectPatch.parse({ fallbackAccountId: null })).toEqual({ fallbackAccountId: null });
  });

  it('parses a card that offers moves', () => {
    const detail = {
      accountId: mintId('Account'),
      reason: 'usage_limit',
      problem: null,
      seenIdentity: null,
      moves: [{ choice: 'Continue on Second plan', accountId: mintId('Account') }],
    };
    expect(AccountCardDetail.parse(detail)).toEqual(detail);
  });

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
