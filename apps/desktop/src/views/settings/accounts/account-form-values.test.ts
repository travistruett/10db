import type { AccountDto } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { accountDto } from '../../../test/account-fixtures';
import {
  emptyAccountForm,
  formValuesOf,
  toAccountInput,
  toAccountPatch,
  type AccountFormValues,
} from './account-form-values';

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

const subscription = accountDto({ label: 'Company A', payer: 'Acme' });
const apiKey = accountDto({ kind: 'anthropic_api_key', label: 'Key', monthlyCapUsd: 500 });
const bedrockProfile = accountDto({
  kind: 'bedrock',
  label: 'Cloud',
  settings: { region: 'us-west-2', awsProfile: 'client-b' },
});
const bedrockBearer = accountDto({
  kind: 'bedrock',
  label: 'Cloud',
  secretSet: true,
  settings: { region: 'us-west-2', awsProfile: null },
});
const gateway = accountDto({
  kind: 'gateway',
  label: 'Router',
  settings: {
    baseUrl: 'https://gw.example.com/v1',
    modelMap: { sonnet: 'anthropic/claude-sonnet' },
    aliases: ['sonnet'],
  },
});

describe('formValuesOf', () => {
  it.each<{ name: string; account: AccountDto; values: Partial<AccountFormValues> }>([
    {
      name: 'a subscription',
      account: subscription,
      values: { label: 'Company A', payer: 'Acme' },
    },
    { name: 'an API key with a cap', account: apiKey, values: { monthlyCapUsd: '500' } },
    {
      name: 'Bedrock on a profile',
      account: bedrockProfile,
      values: { region: 'us-west-2', bedrockAuth: 'profile', awsProfile: 'client-b' },
    },
    {
      name: 'Bedrock on a bearer token',
      account: bedrockBearer,
      values: { region: 'us-west-2', bedrockAuth: 'bearer', awsProfile: '' },
    },
    {
      name: 'a gateway with a model map and aliases',
      account: gateway,
      values: {
        baseUrl: 'https://gw.example.com/v1',
        modelMap: [{ alias: 'sonnet', modelId: 'anthropic/claude-sonnet' }],
        aliases: ['sonnet'],
      },
    },
  ])('reads $name', ({ account, values }) => {
    expect(formValuesOf(account)).toMatchObject({
      kind: account.kind,
      laneCap: '4',
      ...values,
    });
  });
});

describe('toAccountPatch', () => {
  it.each<{
    name: string;
    account: AccountDto;
    changes: Partial<AccountFormValues>;
    patch: unknown;
  }>([
    { name: 'nothing changed', account: subscription, changes: {}, patch: null },
    { name: 'nothing changed on a gateway', account: gateway, changes: {}, patch: null },
    { name: 'nothing changed on a capped API key', account: apiKey, changes: {}, patch: null },
    {
      name: 'nothing changed on a Bedrock profile account',
      account: bedrockProfile,
      changes: {},
      patch: null,
    },
    {
      name: 'nothing changed on a Bedrock bearer account',
      account: bedrockBearer,
      changes: {},
      patch: null,
    },
    {
      name: 'the label only',
      account: subscription,
      changes: { label: 'Renamed' },
      patch: { label: 'Renamed' },
    },
    {
      name: 'the lane cap',
      account: subscription,
      changes: { laneCap: '6' },
      patch: { laneCap: 6 },
    },
    {
      name: 'the payer cleared',
      account: subscription,
      changes: { payer: '' },
      patch: { payer: '' },
    },
    {
      name: 'the monthly cap cleared sends null, not 0',
      account: apiKey,
      changes: { monthlyCapUsd: '' },
      patch: { monthlyCapUsd: null },
    },
    {
      name: 'a monthly cap set on an API key',
      account: accountDto({ kind: 'anthropic_api_key', label: 'Key' }),
      changes: { monthlyCapUsd: '250' },
      patch: { monthlyCapUsd: 250 },
    },
    {
      name: 'a cap typed on a subscription is never sent',
      account: subscription,
      changes: { monthlyCapUsd: '10' },
      patch: null,
    },
    {
      name: 'Bedrock from a profile to a bearer token sends the whole settings with a null profile',
      account: bedrockProfile,
      changes: { bedrockAuth: 'bearer' },
      patch: { settings: { region: 'us-west-2', awsProfile: null } },
    },
    {
      name: 'Bedrock from a bearer token to a profile sends the whole settings with the profile',
      account: bedrockBearer,
      changes: { bedrockAuth: 'profile', awsProfile: 'client-b' },
      patch: { settings: { region: 'us-west-2', awsProfile: 'client-b' } },
    },
    {
      name: 'a model map row added sends the whole settings',
      account: gateway,
      changes: {
        modelMap: [
          { alias: 'sonnet', modelId: 'anthropic/claude-sonnet' },
          { alias: 'haiku', modelId: 'anthropic/claude-haiku' },
        ],
      },
      patch: {
        settings: {
          baseUrl: 'https://gw.example.com/v1',
          modelMap: { sonnet: 'anthropic/claude-sonnet', haiku: 'anthropic/claude-haiku' },
          aliases: ['sonnet'],
        },
      },
    },
    {
      name: 'a label and a setting together',
      account: subscription,
      changes: { label: 'Renamed', modelMap: [{ alias: 'sonnet', modelId: 'x' }] },
      patch: { label: 'Renamed', settings: { modelMap: { sonnet: 'x' } } },
    },
  ])('sends $name', ({ account, changes, patch }) => {
    expect(toAccountPatch(account, { ...formValuesOf(account), ...changes })).toEqual({
      ok: true,
      patch,
    });
  });

  it.each<{
    name: string;
    account: AccountDto;
    changes: Partial<AccountFormValues>;
    errors: Record<string, string>;
  }>([
    {
      name: 'an empty label',
      account: subscription,
      changes: { label: '  ' },
      errors: { label: 'Enter a label' },
    },
    {
      name: 'a monthly cap over the limit',
      account: apiKey,
      changes: { monthlyCapUsd: '2000000' },
      errors: {
        monthlyCapUsd: 'Enter a dollar amount above zero and up to $1,000,000, or leave it empty',
      },
    },
    {
      name: 'a bad region',
      account: bedrockProfile,
      changes: { region: 'nowhere' },
      errors: { region: 'Enter an AWS region such as us-west-2' },
    },
  ])('refuses $name', ({ account, changes, errors }) => {
    const result = toAccountPatch(account, { ...formValuesOf(account), ...changes });
    expect(result).toEqual({ ok: false, errors });
  });
});
