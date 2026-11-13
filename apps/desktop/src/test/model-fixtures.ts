import type { ModelSettingsDto, PatternMatch } from '@10db/contracts';
import {
  AccountModelDto,
  CatalogueStatusDto,
  ModelProfileDto,
  ModelRowDto,
  PatternDto,
  mintId,
  type AccountId,
} from '@10db/contracts';
import type { z } from 'zod';

const AT = '2026-10-01T10:00:00.000Z';

/** A row of the model list; every field has a neutral default so a test names only what it is about. */
export function modelRowDto(over: Partial<ModelRowDto> & { model: string }): ModelRowDto {
  return ModelRowDto.parse({
    name: over.model,
    maker: 'lab-a',
    family: 'family-a',
    tier: 'balanced',
    status: 'current',
    availableOn: [] satisfies AccountId[],
    providers: [],
    inputPrice: null,
    outputPrice: null,
    intelligence: null,
    outputTokensPerSecond: null,
    stepsRun: 0,
    firstSeenAt: AT,
    ...over,
  });
}

export function catalogueStatusDto(over: Partial<CatalogueStatusDto> = {}): CatalogueStatusDto {
  return CatalogueStatusDto.parse({
    fetchedAt: '2026-11-06T10:00:00.000Z',
    source: 'fetched',
    models: 40,
    lastAttempt: 'succeeded',
    ...over,
  });
}

export const someAccountId = (): AccountId => mintId('Account');

export function accountModelDto(
  over: Partial<AccountModelDto> & Pick<AccountModelDto, 'accountId' | 'model'>,
) {
  return AccountModelDto.parse({
    family: null,
    launchId: over.model,
    efforts: [],
    unusable: false,
    wordingMarkEndsAt: null,
    inputPrice: null,
    outputPrice: null,
    lastSeenAt: AT,
    ...over,
  });
}

export function modelProfileDto(over: Partial<ModelProfileDto> & Pick<ModelProfileDto, 'model'>) {
  return ModelProfileDto.parse({
    id: mintId('ModelProfile'),
    provider: 'claude',
    effort: 'high',
    aaSlug: null,
    scores: { intelligence: null },
    costPerTaskUsd: null,
    outputTokensPerSecond: null,
    source: 'aa',
    indexVersion: null,
    measuredAt: null,
    enabled: false,
    maker: 'lab-a',
    family: 'family-a',
    tier: 'balanced',
    status: 'current',
    inputPrice: null,
    outputPrice: null,
    releaseDate: null,
    stepsRun: 0,
    firstPassSteps: 0,
    escalations: 0,
    createdAt: AT,
    updatedAt: AT,
    ...over,
  });
}

export function patternDto(
  over: Partial<Omit<PatternDto, 'match'>> & {
    name: string;
    match?: z.input<typeof PatternMatch>;
  },
): PatternDto {
  return PatternDto.parse({
    id: mintId('Pattern'),
    projectId: null,
    match: {},
    setting: { kind: 'automatic' },
    position: 0,
    ...over,
  });
}

export const noModelSettings = (): ModelSettingsDto => ({ roles: [], patterns: [] });
