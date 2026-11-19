import {
  ModelEffortDto,
  ModelMeasuresDto,
  ModelRowDto,
  RolePickDto,
  RolePicksDto,
  mintId,
  type AccountId,
  type StepRole,
} from '@10db/contracts';

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
    costPerTaskUsd: null,
    outputTokensPerSecond: null,
    efforts: [],
    stepsRun: 0,
    firstSeenAt: AT,
    ...over,
  });
}

/** One effort of a model row, unmeasured unless a test says otherwise. */
export function modelEffortDto(over: Partial<ModelEffortDto> = {}): ModelEffortDto {
  return ModelEffortDto.parse({
    profileId: mintId('ModelProfile'),
    effort: 'high',
    intelligence: null,
    costPerTaskUsd: null,
    outputTokensPerSecond: null,
    stepsRun: 0,
    firstPassSteps: 0,
    ...over,
  });
}

/** One role's pick; a pick of nothing unless a test gives it a model. */
export function rolePickDto(over: Partial<RolePickDto> & { role: StepRole }): RolePickDto {
  return RolePickDto.parse({
    need: 40,
    profileId: null,
    model: null,
    effort: null,
    intelligence: null,
    costPerTaskUsd: null,
    reason: 'by score: cheapest profile at or above 40 intelligence',
    ...over,
  });
}

export const rolePicksDto = (accountId: AccountId, picks: RolePickDto[]): RolePicksDto =>
  RolePicksDto.parse({ accountId, picks });

/** What the daemon answers for a model with nothing stored; a test names what it is about. */
export function modelMeasuresDto(over: Partial<ModelMeasuresDto> = {}): ModelMeasuresDto {
  return ModelMeasuresDto.parse({
    openRouterIds: [],
    accountProvider: null,
    evals: [],
    speeds: [],
    evalsMissing: 'Not read from OpenRouter yet.',
    speedsMissing: 'Not read from OpenRouter yet.',
    ...over,
  });
}
