import { mintId, ModelStatus, type AccountModelDto } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { offeredModels, offeredProfiles } from './offered';
import { testCatalogue, unscoredCatalogue } from './test-catalogue';

const NOW = '2026-10-17T12:00:00.000Z';
const account = mintId('Account');
const offer = (model: string, over: Partial<AccountModelDto> = {}): AccountModelDto => ({
  accountId: account,
  model,
  family: null,
  launchId: model,
  efforts: [],
  unusable: false,
  wordingMarkEndsAt: null,
  inputPrice: null,
  outputPrice: null,
  lastSeenAt: NOW,
  ...over,
});
const names = (profiles: readonly { model: string; effort: string }[]) =>
  profiles.map((p) => `${p.model}@${p.effort}`).sort();

describe('offeredProfiles', () => {
  const all = testCatalogue();
  it.each([
    {
      name: 'only the models the account lists',
      offers: [offer('mid')],
      want: ['mid@high', 'mid@low'],
    },
    {
      name: 'every effort when the list reports none for a model',
      offers: [offer('big', { efforts: [] })],
      want: ['big@high', 'big@max'],
    },
    {
      name: 'only the efforts the list reports',
      offers: [offer('big', { efforts: ['max'] })],
      want: ['big@max'],
    },
    {
      name: 'nothing from a model marked unusable',
      offers: [offer('mid', { unusable: true }), offer('small')],
      want: ['small@high', 'small@low'],
    },
    { name: 'nothing when the list names no profile', offers: [offer('ghost')], want: [] },
  ])('keeps $name', ({ offers, want }) => {
    expect(names(offeredProfiles(all, offers, 'claude'))).toEqual(want);
  });

  it('assumes an account with no list offers every profile of its provider', () => {
    const codex = testCatalogue().map((p) => ({ ...p, provider: 'codex' as const }));
    expect(offeredProfiles([...all, ...codex], [], 'codex')).toEqual(codex);
    expect(offeredProfiles(all, [], 'claude')).toEqual(all);
  });

  it('keeps only the account’s provider, even where a list names another provider’s model', () => {
    const codex = testCatalogue().map((p) => ({ ...p, provider: 'codex' as const }));
    expect(offeredProfiles([...all, ...codex], [offer('mid')], 'codex')).toEqual(
      codex.filter((p) => p.model === 'mid'),
    );
  });
});

describe('offeredModels', () => {
  it('lists each model once with its tier, the weakest tier first and the cheapest first within it', () => {
    const profiles = unscoredCatalogue({}, ['big', 'peak', 'small', 'mid']);
    expect(offeredModels(profiles)).toEqual([
      { model: 'small', tier: 'efficient' },
      { model: 'mid', tier: 'balanced' },
      { model: 'big', tier: 'capable' },
      { model: 'peak', tier: 'capable' },
    ]);
  });

  it('keeps a replaced model in its tier, puts an unranked one last, and leaves a retired one out', () => {
    const profiles = [
      ...unscoredCatalogue({}, ['small', 'mid']).map((p) =>
        p.model === 'small' ? { ...p, status: ModelStatus.Superseded } : p,
      ),
      ...unscoredCatalogue({}, ['big']).map((p) => ({ ...p, status: ModelStatus.Retired })),
      ...unscoredCatalogue({}, ['peak']).map((p) => ({
        ...p,
        model: 'house',
        tier: null,
        status: ModelStatus.Unknown,
        outputPrice: null,
      })),
    ];
    expect(offeredModels(profiles)).toEqual([
      { model: 'small', tier: 'efficient' },
      { model: 'mid', tier: 'balanced' },
      { model: 'house', tier: null },
    ]);
  });
});
