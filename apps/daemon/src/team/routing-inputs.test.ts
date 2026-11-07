import { ModelTier, type ModelSetting } from '@10db/contracts';
import {
  createTestStore,
  defaultAccountId,
  markAccountModelUnusable,
  patchAccount,
  replaceAccountModels,
  seedDefaultAccount,
  type NewAccountModel,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedProfiles } from '../../test/seed-profiles';
import { createEventBus, createStateStore } from '../events';
import { chooseModel } from '../routing';
import { routingInputs } from './routing-inputs';

let close: () => void = () => undefined;
let store: ReturnType<typeof createTestStore>['store'];
beforeEach(() => {
  const test = createTestStore();
  close = test.close;
  store = test.store;
  store.write((ctx) => seedDefaultAccount(ctx, { expectedIdentity: 'me@example.com' }));
  seedProfiles(createStateStore(store, createEventBus()));
});
afterEach(() => {
  close();
});

const offer = (model: string): NewAccountModel => ({
  model,
  family: null,
  launchId: model,
  efforts: ['low', 'medium', 'high'],
  inputPrice: null,
  outputPrice: null,
});

/** The model a step asking for the Fast tier runs on, with the account's overrides and list as stored. */
function fastModel(): string {
  const accountId = defaultAccountId(store.db);
  if (accountId === null) throw new Error('no default account');
  const inputs = routingInputs(store.db, { accountId, provider: 'claude' });
  const setting: ModelSetting = { kind: 'tier', tier: ModelTier.Fast };
  return chooseModel({
    ...inputs,
    def: { role: 'implement', need: 0 },
    persona: undefined,
    task: { riskTags: [], acceptanceCriteria: [], areas: [], modelSetting: setting },
    project: { id: null, budgetCeiling: null },
    stakes: { retry: false },
    byScore: false,
  }).model;
}

describe('routingInputs: the account’s tier overrides', () => {
  const OVERRIDE = 'claude-opus-5-5';
  const LIST = ['claude-haiku-5-5', 'claude-sonnet-5-5', OVERRIDE];

  it.each<{
    name: string;
    overrides: Partial<Record<ModelTier, string>>;
    unusable?: string;
    expected: string;
  }>([
    { name: 'no override: the tier’s own model', overrides: {}, expected: 'claude-haiku-5-5' },
    {
      name: 'an override for the tier: that model wins over Automatic',
      overrides: { fast: OVERRIDE },
      expected: OVERRIDE,
    },
    {
      name: 'an override for another tier: the Fast tier is unaffected',
      overrides: { strongest: OVERRIDE },
      expected: 'claude-haiku-5-5',
    },
    {
      name: 'an override the account does not list: skipped',
      overrides: { fast: 'claude-nonesuch-1' },
      expected: 'claude-haiku-5-5',
    },
    {
      name: 'an override the account marked unusable: skipped',
      overrides: { fast: OVERRIDE },
      unusable: OVERRIDE,
      expected: 'claude-haiku-5-5',
    },
  ])('$name', ({ overrides, unusable, expected }) => {
    const accountId = defaultAccountId(store.db);
    if (accountId === null) throw new Error('no default account');
    store.write((ctx) => {
      replaceAccountModels(ctx, accountId, LIST.map(offer));
      if (unusable !== undefined) markAccountModelUnusable(ctx, accountId, unusable);
      patchAccount(ctx, accountId, { settings: { tierOverrides: overrides } });
    });
    expect(fastModel()).toBe(expected);
  });
});
