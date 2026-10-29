import { mintId, type ModelProfileDto } from '@10db/contracts';
import { SEED_PROFILES } from './catalogue';

const NOW = '2026-10-17T12:00:00.000Z';

/** An invented frontier: three model sizes at two efforts, scored and priced to make the tables readable. */
const ROWS = [
  ['small', 'low', 20, 18, 15, 0.05, 200],
  ['small', 'high', 30, 28, 25, 0.1, 180],
  ['mid', 'low', 38, 36, 30, 0.4, 90],
  ['mid', 'high', 46, 44, 40, 1, 70],
  ['big', 'high', 50, 50, 45, 2, 50],
  ['big', 'max', 56, 54, 50, 6, 30],
] as const;

export function testCatalogue(
  overrides: Readonly<Record<string, Partial<ModelProfileDto>>> = {},
): ModelProfileDto[] {
  return ROWS.map(([model, effort, intelligence, coding, agentic, cost, tps]) => ({
    id: mintId('ModelProfile'),
    provider: 'claude',
    model,
    effort,
    aaSlug: `test-${model}-${effort}`,
    scores: { intelligence, coding, agentic },
    costPerTaskUsd: cost,
    outputTokensPerSecond: tps,
    source: 'aa',
    indexVersion: 'test',
    measuredAt: NOW,
    enabled: true,
    stepsRun: 0,
    firstPassSteps: 0,
    escalations: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides[`${model}@${effort}`],
  }));
}

export const label = (p: Pick<ModelProfileDto, 'model' | 'effort'>) => `${p.model}@${p.effort}`;

/** The seeded Claude Code profiles with nothing measured: what an account sees before an AA sync. */
export function seedCatalogue(
  overrides: Readonly<Record<string, Partial<ModelProfileDto>>> = {},
): ModelProfileDto[] {
  return SEED_PROFILES.map((seed) => ({
    id: mintId('ModelProfile'),
    ...seed,
    scores: { intelligence: null, coding: null, agentic: null },
    costPerTaskUsd: null,
    outputTokensPerSecond: null,
    source: 'aa',
    indexVersion: null,
    measuredAt: null,
    stepsRun: 0,
    firstPassSteps: 0,
    escalations: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides[`${seed.model}@${seed.effort}`],
  }));
}
