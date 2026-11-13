import { mintId, ModelTier, type ModelSetting } from '@10db/contracts';
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
import { chooseModel, planSteps } from '../routing';
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

/** The model a step asking for the Efficient tier runs on, with the account's overrides and list as stored. */
function efficientModel(): string {
  const accountId = defaultAccountId(store.db);
  if (accountId === null) throw new Error('no default account');
  const inputs = routingInputs(store.db, { accountId, provider: 'claude' });
  const setting: ModelSetting = { kind: 'tier', tier: ModelTier.Efficient };
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
      overrides: { efficient: OVERRIDE },
      expected: OVERRIDE,
    },
    {
      name: 'an override for another tier: the Efficient tier is unaffected',
      overrides: { capable: OVERRIDE },
      expected: 'claude-haiku-5-5',
    },
    {
      name: 'an override the account does not list: skipped',
      overrides: { efficient: 'claude-nonesuch-1' },
      expected: 'claude-haiku-5-5',
    },
    {
      name: 'an override the account marked unusable: skipped',
      overrides: { efficient: OVERRIDE },
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
    expect(efficientModel()).toBe(expected);
  });
});

describe('planning a step with the account’s overrides', () => {
  it('skips an override the account marked unusable, as choosing does', () => {
    const accountId = defaultAccountId(store.db);
    if (accountId === null) throw new Error('no default account');
    store.write((ctx) => {
      replaceAccountModels(
        ctx,
        accountId,
        ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'].map(offer),
      );
      markAccountModelUnusable(ctx, accountId, 'claude-opus-5-5');
      patchAccount(ctx, accountId, {
        settings: { tierOverrides: { efficient: 'claude-opus-5-5' } },
      });
    });
    const plan = planSteps({
      flow: {
        id: mintId('Flow'),
        name: 'one-step',
        steps: [{ role: 'implement', need: 0, skip: [], persona: null }],
        createdAt: '2026-11-07T00:00:00.000Z',
        updatedAt: '2026-11-07T00:00:00.000Z',
      },
      task: {
        riskTags: [],
        acceptanceCriteria: [],
        areas: [],
        modelSetting: { kind: 'tier', tier: ModelTier.Efficient },
      },
      project: { id: mintId('Project'), budgetCeiling: null },
      personas: [],
      bindings: [],
      ...routingInputs(store.db, { accountId, provider: 'claude' }),
    });
    expect(plan.steps.length).toBeGreaterThan(0);
    expect(plan.steps.map((s) => s.model)).not.toContain('claude-opus-5-5');
  });
});
