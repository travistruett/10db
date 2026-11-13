import { Effort, mintId, ModelStatus, ModelTier, type ModelProfileDto } from '@10db/contracts';

const NOW = '2026-10-17T12:00:00.000Z';

/** The invented models of the tests: a tier and an output price each, never a real model's. */
const MODELS = {
  small: { tier: ModelTier.Efficient, outputPrice: 1 },
  mid: { tier: ModelTier.Balanced, outputPrice: 5 },
  big: { tier: ModelTier.Capable, outputPrice: 25 },
  /** Dearer than `big` in the same tier. */
  peak: { tier: ModelTier.Capable, outputPrice: 50 },
  /** Dearer still, and the maker's top: the Frontier model. */
  apex: { tier: ModelTier.Frontier, outputPrice: 75 },
} as const;
type TestModel = keyof typeof MODELS;

/** What a profile carries once the catalogue has ranked its model. */
const describe = (model: TestModel) => ({
  maker: 'test',
  family: `test-${model}`,
  tier: MODELS[model].tier,
  status: ModelStatus.Current,
  inputPrice: MODELS[model].outputPrice / 5,
  outputPrice: MODELS[model].outputPrice,
  releaseDate: '2026-09-01',
});

const base = {
  provider: 'claude',
  source: 'aa',
  enabled: true,
  stepsRun: 0,
  firstPassSteps: 0,
  escalations: 0,
  createdAt: NOW,
  updatedAt: NOW,
} as const;

/** An invented frontier: three model sizes at two efforts, scored and priced to make the tables readable. */
const ROWS = [
  ['small', 'low', 20, 0.05, 200],
  ['small', 'high', 30, 0.1, 180],
  ['mid', 'low', 38, 0.4, 90],
  ['mid', 'high', 46, 1, 70],
  ['big', 'high', 50, 2, 50],
  ['big', 'max', 56, 6, 30],
] as const;

export function testCatalogue(
  overrides: Readonly<Record<string, Partial<ModelProfileDto>>> = {},
): ModelProfileDto[] {
  return ROWS.map(([model, effort, intelligence, cost, tps]) => ({
    ...base,
    ...describe(model),
    id: mintId('ModelProfile'),
    model,
    effort,
    aaSlug: `test-${model}-${effort}`,
    scores: { intelligence },
    costPerTaskUsd: cost,
    outputTokensPerSecond: tps,
    indexVersion: 'test',
    measuredAt: NOW,
    ...overrides[`${model}@${effort}`],
  }));
}

export const label = (p: Pick<ModelProfileDto, 'model' | 'effort'>) => `${p.model}@${p.effort}`;

/** The models at every effort with nothing measured: what an account sees before an AA sync. */
export function unscoredCatalogue(
  overrides: Readonly<Record<string, Partial<ModelProfileDto>>> = {},
  models: readonly TestModel[] = ['small', 'mid', 'big'],
): ModelProfileDto[] {
  return models.flatMap((model) =>
    Object.values(Effort).map((effort) => ({
      ...base,
      ...describe(model),
      id: mintId('ModelProfile'),
      model,
      effort,
      aaSlug: null,
      scores: { intelligence: null },
      costPerTaskUsd: null,
      outputTokensPerSecond: null,
      indexVersion: null,
      measuredAt: null,
      ...overrides[`${model}@${effort}`],
    })),
  );
}
