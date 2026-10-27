import { describe, expect, it } from 'vitest';
import { emptyAccountForm, toAccountInput, type AccountFormValues } from './account-form-values';

function form(
  kind: AccountFormValues['kind'],
  changes: Partial<AccountFormValues>,
): AccountFormValues {
  return { ...emptyAccountForm(kind), ...changes };
}

describe('toAccountInput', () => {
  it.each<{ name: string; values: AccountFormValues; input: unknown }>([
    {
      name: 'a minimal subscription',
      values: form('claude_subscription', { label: 'Company A' }),
      input: {
        kind: 'claude_subscription',
        label: 'Company A',
        payer: '',
        laneCap: 4,
        settings: {},
      },
    },
    {
      name: 'an API key with a $500 cap and an organization',
      values: form('anthropic_api_key', {
        label: 'Client key',
        monthlyCapUsd: '500',
        organization: 'org-123',
      }),
      input: {
        kind: 'anthropic_api_key',
        label: 'Client key',
        payer: '',
        laneCap: 4,
        monthlyCapUsd: 500,
        expectedIdentity: 'org-123',
        settings: {},
      },
    },
    {
      name: 'an API key with an empty cap omits it',
      values: form('anthropic_api_key', { label: 'K' }),
      input: {
        kind: 'anthropic_api_key',
        label: 'K',
        payer: '',
        laneCap: 4,
        monthlyCapUsd: null,
        expectedIdentity: null,
        settings: {},
      },
    },
    {
      name: 'Bedrock on a profile',
      values: form('bedrock', { label: 'B', region: 'us-west-2', awsProfile: 'client-b' }),
      input: {
        kind: 'bedrock',
        label: 'B',
        payer: '',
        laneCap: 4,
        monthlyCapUsd: null,
        expectedIdentity: null,
        settings: { region: 'us-west-2', awsProfile: 'client-b' },
      },
    },
    {
      name: 'Bedrock on a bearer token sends a null profile',
      values: form('bedrock', {
        label: 'B',
        region: 'us-west-2',
        bedrockAuth: 'bearer',
        awsProfile: 'left-over',
      }),
      input: {
        kind: 'bedrock',
        label: 'B',
        payer: '',
        laneCap: 4,
        monthlyCapUsd: null,
        expectedIdentity: null,
        settings: { region: 'us-west-2', awsProfile: null },
      },
    },
    {
      name: 'a gateway with a base URL and a model map',
      values: form('gateway', {
        label: 'G',
        baseUrl: 'https://gw.example.com/v1',
        modelMap: [{ alias: 'sonnet', modelId: 'anthropic/claude-sonnet' }],
        aliases: ['sonnet'],
        organization: 'ignored',
      }),
      input: {
        kind: 'gateway',
        label: 'G',
        payer: '',
        laneCap: 4,
        monthlyCapUsd: null,
        settings: {
          baseUrl: 'https://gw.example.com/v1',
          modelMap: { sonnet: 'anthropic/claude-sonnet' },
          aliases: ['sonnet'],
        },
      },
    },
    {
      name: 'a subscription never carries a cap or an identity',
      values: form('claude_subscription', {
        label: 'S',
        monthlyCapUsd: '10',
        organization: 'org',
      }),
      input: { kind: 'claude_subscription', label: 'S', payer: '', laneCap: 4, settings: {} },
    },
  ])('builds $name', ({ values, input }) => {
    expect(toAccountInput(values)).toEqual({ ok: true, input });
  });

  it.each<{ name: string; values: AccountFormValues; errors: Record<string, RegExp> }>([
    {
      name: 'a gateway URL with credentials, onto baseUrl',
      values: form('gateway', { label: 'G', baseUrl: 'https://u:p@gw.example.com' }),
      errors: { baseUrl: /no credentials/ },
    },
    {
      name: 'a bad region, onto region',
      values: form('bedrock', { label: 'B', region: 'nowhere', awsProfile: 'p' }),
      errors: { region: /AWS region/ },
    },
    {
      name: 'a capitalised alias, onto modelMap',
      values: form('claude_subscription', {
        label: 'S',
        modelMap: [{ alias: 'Sonnet', modelId: 'x' }],
      }),
      errors: { modelMap: /model alias/ },
    },
    {
      name: 'an empty label, onto label',
      values: form('claude_subscription', {}),
      errors: { label: /.+/ },
    },
    {
      name: 'a lane cap of zero, onto laneCap',
      values: form('claude_subscription', { label: 'S', laneCap: '0' }),
      errors: { laneCap: /.+/ },
    },
  ])('refuses $name', ({ values, errors }) => {
    const result = toAccountInput(values);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    for (const [field, message] of Object.entries(errors))
      expect(result.errors[field]).toMatch(message);
  });
});
