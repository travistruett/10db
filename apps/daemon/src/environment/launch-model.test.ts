import { mintId, ModelTier, type AccountModelDto } from '@10db/contracts';
import type { AccountRow } from '@10db/db';
import { describe, expect, it } from 'vitest';
import { createMemoryKeychain } from '../../test/fixtures';
import { createLauncher, ModelNotLaunchableError } from './index';

const BASE = { PATH: '/usr/bin', HOME: '/h/b', ANTHROPIC_DEFAULT_SONNET_MODEL: 'from-the-shell' };

function account(overrides: Partial<AccountRow>): AccountRow {
  return {
    id: mintId('Account'),
    kind: 'claude_subscription',
    label: 'Company A',
    payer: '',
    expectedIdentity: 'a@example.com',
    configDir: '/data/accounts/a/claude',
    secretRef: null,
    secretFingerprint: null,
    settings: {},
    laneCap: 4,
    monthlyCapUsd: null,
    archived: false,
    createdAt: '2026-10-22T12:00:00.000Z',
    updatedAt: '2026-10-22T12:00:00.000Z',
    ...overrides,
  };
}

function row(model: string, launchId: string, accountId = mintId('Account')): AccountModelDto {
  return {
    accountId,
    model,
    family: null,
    launchId,
    efforts: [],
    unusable: false,
    wordingMarkEndsAt: null,
    inputPrice: null,
    outputPrice: null,
    lastSeenAt: '2026-11-07T00:00:00.000Z',
  };
}

const launcher = () =>
  createLauncher({ base: BASE, clientApp: '10db/0.1.0', keychain: createMemoryKeychain({}) });

const bedrock = account({
  kind: 'bedrock',
  expectedIdentity: null,
  settings: { region: 'us-east-1', awsProfile: 'dev' },
});
const chatgpt = account({
  kind: 'codex_signin',
  label: 'ChatGPT Pro',
  configDir: '/d/acc/codex',
});

describe('the model a session launches', () => {
  it.each<{
    name: string;
    account: AccountRow;
    model: string;
    rows: AccountModelDto[];
    launches: string;
  }>([
    {
      name: 'a Bedrock account launches its own prefixed ID',
      account: bedrock,
      model: 'claude-opus-5-5',
      rows: [row('claude-opus-5-5', 'us.anthropic.claude-opus-5-5')],
      launches: 'us.anthropic.claude-opus-5-5',
    },
    {
      name: 'a subscription launches its own ID, keeping a [1m] suffix its row carries',
      account: account({}),
      model: 'claude-fable-5-1',
      rows: [row('claude-fable-5-1', 'claude-fable-5-1[1m]')],
      launches: 'claude-fable-5-1[1m]',
    },
    ...['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol'].map((model) => ({
      name: `a ChatGPT account launches ${model}, the model of one of its tiers, with no map`,
      account: chatgpt,
      model,
      rows: [row(model, `${model}-launch`)],
      launches: `${model}-launch`,
    })),
    {
      name: 'an account with no row launches the canonical ID',
      account: account({}),
      model: 'claude-sonnet-5-5',
      rows: [],
      launches: 'claude-sonnet-5-5',
    },
    {
      name: 'a row for another model does not change the canonical ID',
      account: account({}),
      model: 'claude-sonnet-5-5',
      rows: [row('claude-opus-5-5', 'something-else')],
      launches: 'claude-sonnet-5-5',
    },
  ])('$name', ({ account: acct, model, rows, launches }) => {
    expect(launcher().session(acct, model, rows).model).toBe(launches);
  });

  it.each(Object.values(ModelTier))(
    'refuses the tier name %s, which names no model to launch',
    (tier) => {
      expect(() => launcher().session(account({}), tier, [])).toThrow(ModelNotLaunchableError);
    },
  );

  it.each([
    { name: 'a subscription', row: account({}) },
    { name: 'Bedrock', row: bedrock },
    { name: 'a ChatGPT account', row: chatgpt },
  ])('sets no variable that names a model for $name, and drops the shell’s', ({ row: acct }) => {
    const names = [
      ...Object.keys(launcher().session(acct, 'claude-opus-5-5', []).env),
      ...Object.keys(launcher().probe(acct).env),
    ];
    expect(names.filter((name) => name.startsWith('ANTHROPIC_DEFAULT_'))).toEqual([]);
  });
});
