import { describe, expect, it } from 'vitest';
import { emptyAccountForm, toAccountInput, type AccountFormValues } from './account-form-values';

function form(
  kind: AccountFormValues['kind'],
  changes: Partial<AccountFormValues>,
): AccountFormValues {
  return { ...emptyAccountForm(kind), ...changes };
}

const MONTHLY_CAP_MESSAGE =
  'Enter a dollar amount above zero and up to $1,000,000, or leave it empty';

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
      name: 'an API key with an empty cap sends no cap (null)',
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

  it.each<{ name: string; values: AccountFormValues; errors: Record<string, string> }>([
    {
      name: 'a gateway URL with credentials, onto baseUrl',
      values: form('gateway', { label: 'G', baseUrl: 'https://u:p@gw.example.com' }),
      errors: { baseUrl: 'Enter an https URL with no credentials, query or fragment' },
    },
    {
      name: 'a bad region, onto region',
      values: form('bedrock', { label: 'B', region: 'nowhere', awsProfile: 'p' }),
      errors: { region: 'Enter an AWS region such as us-west-2' },
    },
    {
      name: 'a bad AWS profile, onto awsProfile',
      values: form('bedrock', { label: 'B', region: 'us-west-2', awsProfile: 'bad profile' }),
      errors: {
        awsProfile: 'Enter an AWS profile name: letters, digits, dots, dashes or underscores',
      },
    },
    {
      name: 'a capitalised alias, onto modelMap',
      values: form('claude_subscription', {
        label: 'S',
        modelMap: [{ alias: 'Sonnet', modelId: 'x' }],
      }),
      errors: { modelMap: 'Enter a lowercase alias such as sonnet and a model ID for each row' },
    },
    {
      name: 'a blank model ID, onto modelMap',
      values: form('claude_subscription', {
        label: 'S',
        modelMap: [{ alias: 'sonnet', modelId: '' }],
      }),
      errors: { modelMap: 'Enter a lowercase alias such as sonnet and a model ID for each row' },
    },
    {
      name: 'a duplicate alias, onto modelMap',
      values: form('claude_subscription', {
        label: 'S',
        modelMap: [
          { alias: 'sonnet', modelId: 'a' },
          { alias: 'sonnet', modelId: 'b' },
        ],
      }),
      errors: { modelMap: 'Each alias can appear once' },
    },
    {
      name: 'a capitalised offered alias, onto aliases',
      values: form('claude_subscription', { label: 'S', aliases: ['Sonnet'] }),
      errors: { aliases: 'Use lowercase aliases such as sonnet' },
    },
    {
      name: 'an empty label, onto label',
      values: form('claude_subscription', {}),
      errors: { label: 'Enter a label' },
    },
    {
      name: 'a lane cap of zero, onto laneCap',
      values: form('claude_subscription', { label: 'S', laneCap: '0' }),
      errors: { laneCap: 'Enter a whole number from 1 to 16' },
    },
    {
      name: 'an empty lane cap, onto laneCap',
      values: form('claude_subscription', { label: 'S', laneCap: '' }),
      errors: { laneCap: 'Enter a whole number from 1 to 16' },
    },
    {
      name: 'a fractional lane cap, onto laneCap',
      values: form('claude_subscription', { label: 'S', laneCap: '2.5' }),
      errors: { laneCap: 'Enter a whole number from 1 to 16' },
    },
    {
      name: 'a non-numeric monthly cap, onto monthlyCapUsd',
      values: form('anthropic_api_key', { label: 'K', monthlyCapUsd: 'lots' }),
      errors: { monthlyCapUsd: MONTHLY_CAP_MESSAGE },
    },
    {
      name: 'a zero monthly cap, onto monthlyCapUsd',
      values: form('anthropic_api_key', { label: 'K', monthlyCapUsd: '0' }),
      errors: { monthlyCapUsd: MONTHLY_CAP_MESSAGE },
    },
    {
      name: 'a monthly cap over $1,000,000, onto monthlyCapUsd',
      values: form('anthropic_api_key', { label: 'K', monthlyCapUsd: '1000001' }),
      errors: { monthlyCapUsd: MONTHLY_CAP_MESSAGE },
    },
    {
      name: 'a model ID over 200 characters, onto modelMap with its own message',
      values: form('claude_subscription', {
        label: 'S',
        modelMap: [{ alias: 'sonnet', modelId: 'x'.repeat(201) }],
      }),
      errors: { modelMap: 'Keep each model ID up to 200 characters' },
    },
    {
      name: 'a payer over 200 characters, onto payer',
      values: form('claude_subscription', { label: 'S', payer: 'x'.repeat(201) }),
      errors: { payer: 'Keep the payer up to 200 characters' },
    },
    {
      name: 'an organization over 200 characters, onto organization',
      values: form('anthropic_api_key', { label: 'K', organization: 'x'.repeat(201) }),
      errors: { organization: 'Enter an organization of up to 200 characters, or leave it empty' },
    },
  ])('refuses $name', ({ values, errors }) => {
    const result = toAccountInput(values);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual(errors);
  });
});
