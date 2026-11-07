import {
  AccountKind,
  Effort,
  ModelStatus,
  ModelTier,
  Provider,
  type AccountId,
  type AccountInput,
  type SupportedAccountKind,
} from '@10db/contracts';
import {
  applyAaMeasurement,
  archiveAccount,
  createTestStore,
  findModelProfile,
  insertModelProfile,
  listEventsAfter,
  listModelProfiles,
  listAccountModels,
  recordProfileOutcome,
  replaceAccountModels,
  seedAccount,
  type Store,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readModelsDevFixture } from '../../test/models-dev-fixture';
import type { SeenModel } from '../sessions';
import { offerFromList } from './account-offer';
import { reconcileProfiles } from './profiles';
import { parseCatalogue } from './source';

const catalogue = parseCatalogue(readModelsDevFixture());
const EFFORTS = Object.values(Effort);
const SORTED_EFFORTS = [...EFFORTS].sort();

let store: Store;
let close: () => void;
beforeEach(() => {
  ({ store, close } = createTestStore());
});
afterEach(() => {
  close();
});

const inputFor = (kind: SupportedAccountKind, label: string): AccountInput => {
  switch (kind) {
    case AccountKind.Bedrock:
      return { kind, label, settings: { region: 'us-east-1', awsProfile: null } };
    case AccountKind.Gateway:
      return { kind, label, settings: { baseUrl: 'https://gateway.example.com' } };
    case AccountKind.ClaudeSubscription:
    case AccountKind.AnthropicApiKey:
    case AccountKind.CodexSignin:
      return { kind, label };
  }
};

const account = (kind: SupportedAccountKind, label: string): AccountId =>
  seedAccount(store, inputFor(kind, label)).id;

const seen = (id: string, resolvedId: string | null, efforts: Effort[] = EFFORTS): SeenModel => ({
  id,
  resolvedId,
  efforts,
});

/** The account's list as a successful read stored it. */
function list(id: AccountId, kind: SupportedAccountKind, models: SeenModel[]): void {
  store.write((ctx) => {
    replaceAccountModels(ctx, id, offerFromList(kind, models, catalogue));
  });
}

const reconcile = () => {
  store.write((ctx) => {
    reconcileProfiles(ctx, catalogue);
  });
};
const profiles = (provider: Provider) =>
  listModelProfiles(store.db).filter((p) => p.provider === provider);
const byModel = (provider: Provider) => {
  const found = new Map<string, string[]>();
  for (const p of profiles(provider)) found.set(p.model, [...(found.get(p.model) ?? []), p.effort]);
  return new Map([...found].map(([model, efforts]) => [model, efforts.sort()]));
};

describe('reconcileProfiles', () => {
  it('writes one profile per model and effort, disabled, from the catalogue', () => {
    const sub = account(AccountKind.ClaudeSubscription, 'sub');
    list(sub, AccountKind.ClaudeSubscription, [
      seen('opus', 'claude-opus-5-5', ['low', 'max']),
      seen('haiku', 'claude-haiku-5-5', []),
    ]);
    reconcile();
    expect(byModel(Provider.Claude)).toEqual(
      new Map([
        ['claude-haiku-5-5', SORTED_EFFORTS],
        ['claude-opus-5-5', ['low', 'max']],
      ]),
    );
    expect(findModelProfile(store.db, Provider.Claude, 'claude-opus-5-5', 'max')).toMatchObject({
      enabled: false,
      aaSlug: null,
      maker: 'anthropic',
      family: 'claude-opus',
      releaseDate: '2026-09-22',
      inputPrice: 4,
      outputPrice: 20,
      tier: ModelTier.Strongest,
      status: ModelStatus.Current,
    });
  });

  it('gives Bedrock and a subscription offering one model a single profile and two account rows', () => {
    const sub = account(AccountKind.ClaudeSubscription, 'sub');
    const aws = account(AccountKind.Bedrock, 'aws');
    list(sub, AccountKind.ClaudeSubscription, [seen('opus', 'claude-opus-5-5')]);
    list(aws, AccountKind.Bedrock, [
      seen('us.anthropic.claude-opus-5-5', 'us.anthropic.claude-opus-5-5'),
    ]);
    reconcile();
    expect([...byModel(Provider.Claude).keys()]).toEqual(['claude-opus-5-5']);
    expect(listAccountModels(store.db).map((m) => [m.accountId === sub, m.launchId])).toEqual(
      expect.arrayContaining([
        [true, 'claude-opus-5-5'],
        [false, 'us.anthropic.claude-opus-5-5'],
      ]),
    );
    // The profile carries the maker's price, not Bedrock's copy.
    expect(findModelProfile(store.db, Provider.Claude, 'claude-opus-5-5', 'low')).toMatchObject({
      inputPrice: 4,
      outputPrice: 20,
    });
  });

  it('ranks across accounts: an older model another account supersedes is Superseded, with no tier', () => {
    const sub = account(AccountKind.ClaudeSubscription, 'sub');
    const aws = account(AccountKind.Bedrock, 'aws');
    list(sub, AccountKind.ClaudeSubscription, [
      seen('claude-fable-5-1', 'claude-fable-5-1'),
      seen('haiku', 'claude-haiku-5-5'),
    ]);
    list(aws, AccountKind.Bedrock, [seen('haiku', 'us.anthropic.claude-haiku-4-5-20251001-v1:0')]);
    reconcile();
    const status = (model: string) =>
      findModelProfile(store.db, Provider.Claude, model, 'low') ?? null;
    expect(status('claude-haiku-4-5-20251001')).toMatchObject({
      tier: null,
      status: ModelStatus.Superseded,
    });
    expect(status('claude-haiku-5-5')).toMatchObject({
      tier: ModelTier.Fast,
      status: ModelStatus.Current,
    });
  });

  it('keeps what is already there: enabled, scores, step counts and seeded alias rows', () => {
    const sub = account(AccountKind.ClaudeSubscription, 'sub');
    list(sub, AccountKind.ClaudeSubscription, [seen('opus', 'claude-opus-5-5', ['low'])]);
    const { seed, existing } = store.write((ctx) => {
      const seeded = insertModelProfile(ctx, {
        provider: Provider.Claude,
        model: 'sonnet',
        effort: 'low',
        aaSlug: 'claude-sonnet',
        enabled: true,
      });
      const made = insertModelProfile(ctx, {
        provider: Provider.Claude,
        model: 'claude-opus-5-5',
        effort: 'low',
        aaSlug: 'slug',
        enabled: true,
      });
      applyAaMeasurement(ctx, made.id, {
        scores: { intelligence: 40, coding: 41, agentic: 42 },
        costPerTaskUsd: 1,
        outputTokensPerSecond: 50,
        indexVersion: 'v',
        measuredAt: ctx.now,
      });
      recordProfileOutcome(ctx, made.id, { firstPass: true, escalated: false });
      return { seed: seeded, existing: made };
    }).value;
    reconcile();
    expect(findModelProfile(store.db, Provider.Claude, 'sonnet', 'low')).toMatchObject({
      id: seed.id,
      enabled: true,
      maker: null,
    });
    expect(findModelProfile(store.db, Provider.Claude, 'claude-opus-5-5', 'low')).toMatchObject({
      id: existing.id,
      enabled: true,
      aaSlug: 'slug',
      scores: { intelligence: 40, coding: 41, agentic: 42 },
      stepsRun: 1,
      maker: 'anthropic',
      tier: ModelTier.Strongest,
    });
  });

  it('is a no-op the second time: nothing is written and no event is appended', () => {
    const sub = account(AccountKind.ClaudeSubscription, 'sub');
    list(sub, AccountKind.ClaudeSubscription, [seen('opus', 'claude-opus-5-5')]);
    reconcile();
    const before = listEventsAfter(store.db, 0, 1000).length;
    const rows = listModelProfiles(store.db);
    reconcile();
    expect(listEventsAfter(store.db, 0, 1000)).toHaveLength(before);
    expect(listModelProfiles(store.db)).toEqual(rows);
  });

  it('writes a ChatGPT account profile per effort it reports', () => {
    const chat = account(AccountKind.CodexSignin, 'chatgpt');
    list(chat, AccountKind.CodexSignin, [
      seen('gpt-6-astra', null, ['low', 'max']),
      seen('gpt-6-luna', null, []),
    ]);
    reconcile();
    expect(byModel(Provider.Codex)).toEqual(
      new Map([
        ['gpt-6-astra', ['low', 'max']],
        ['gpt-6-luna', SORTED_EFFORTS],
      ]),
    );
  });

  it('lists a model of another maker on a Bedrock account without a profile', () => {
    const aws = account(AccountKind.Bedrock, 'aws');
    list(aws, AccountKind.Bedrock, [
      seen('us.anthropic.claude-opus-5-5', 'us.anthropic.claude-opus-5-5'),
      seen('openai.gpt-6.1-sol', 'openai.gpt-6.1-sol'),
    ]);
    reconcile();
    expect(listAccountModels(store.db, aws).map((m) => m.model)).toContain('openai.gpt-6.1-sol');
    expect(listModelProfiles(store.db).map((p) => p.model)).not.toContain('openai.gpt-6.1-sol');
    expect([...byModel(Provider.Claude).keys()]).toContain('claude-opus-5-5');
  });

  it('writes a model the catalogue lacks as Unknown, with no tier and no price', () => {
    const gateway = account(AccountKind.Gateway, 'gateway');
    list(gateway, AccountKind.Gateway, [seen('house-model', null)]);
    reconcile();
    expect(findModelProfile(store.db, Provider.Claude, 'house-model', 'high')).toMatchObject({
      enabled: false,
      maker: null,
      family: null,
      tier: null,
      status: ModelStatus.Unknown,
      inputPrice: null,
      outputPrice: null,
    });
  });

  it('uses the maker models of the catalogue for an account with no list yet, retired ones left out', () => {
    account(AccountKind.CodexSignin, 'chatgpt');
    account(AccountKind.ClaudeSubscription, 'sub');
    reconcile();
    expect([...byModel(Provider.Codex).keys()].sort()).toEqual([
      'gpt-6-astra',
      'gpt-6-luna',
      'gpt-6.1-sol',
      'gpt-6.1-terra',
    ]);
    expect([...byModel(Provider.Claude).keys()]).toContain('claude-opus-5-5');
    expect(listAccountModels(store.db)).toEqual([]);
  });

  it('leaves an archived account out', () => {
    const sub = account(AccountKind.ClaudeSubscription, 'sub');
    list(sub, AccountKind.ClaudeSubscription, [seen('opus', 'claude-opus-5-5')]);
    store.write((ctx) => {
      archiveAccount(ctx, sub);
    });
    reconcile();
    expect(listModelProfiles(store.db)).toEqual([]);
  });
});
