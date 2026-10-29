import { Effort, StepRole, type FlowInput, type Provider } from '@10db/contracts';

export interface SeedProfile {
  readonly provider: Provider;
  readonly model: string;
  readonly effort: Effort;
  readonly aaSlug: string;
  readonly enabled: boolean;
}

/** How strong a model is, for routing a step no score can route. */
export const ModelTier = { Fast: 'fast', Balanced: 'balanced', Strongest: 'strongest' } as const;
export type ModelTier = (typeof ModelTier)[keyof typeof ModelTier];

/**
 * Claude Code's model aliases, weakest first, with each one's tier and the AA family it maps to; the
 * slugs only, never AA's data.
 */
const FAMILIES = [
  { model: 'haiku', tier: ModelTier.Fast, aaFamily: 'claude-haiku-5-5', enabled: true },
  { model: 'sonnet', tier: ModelTier.Balanced, aaFamily: 'claude-sonnet-5-5', enabled: true },
  { model: 'opus', tier: ModelTier.Strongest, aaFamily: 'claude-opus-5-5', enabled: true },
  // Off until Claude Code accepts the alias.
  { model: 'fable', tier: ModelTier.Strongest, aaFamily: 'claude-fable-5-1', enabled: false },
] as const;

/** Claude Code's models, weakest first, with each one's tier. */
export const MODEL_TIERS: readonly { readonly model: string; readonly tier: ModelTier }[] =
  FAMILIES.map(({ model, tier }) => ({ model, tier }));

/** AA lists `max` under the family slug and every other effort as `<family>-<effort>`. */
export const SEED_PROFILES: readonly SeedProfile[] = FAMILIES.flatMap((family) =>
  Object.values(Effort).map((effort) => ({
    provider: 'claude' as const,
    model: family.model,
    effort,
    aaSlug: effort === Effort.Max ? family.aaFamily : `${family.aaFamily}-${effort}`,
    enabled: family.enabled,
  })),
);

/** Starting needs, in the role's index points (spec §15): heuristics to tune, not AA data. */
const NEED = { plan: 45, planReview: 48, implement: 40, review: 48, qa: 35 } as const;

export const DEFAULT_FLOWS: readonly FlowInput[] = [
  { name: 'quick', steps: [{ role: StepRole.Implement, need: NEED.implement }] },
  {
    name: 'standard',
    steps: [
      { role: StepRole.Implement, need: NEED.implement },
      { role: StepRole.Review, need: NEED.review },
    ],
  },
  {
    name: 'full',
    steps: [
      { role: StepRole.Plan, need: NEED.plan, skip: [{ kind: 'unless_criteria_over', count: 3 }] },
      {
        role: StepRole.PlanReview,
        need: NEED.planReview,
        skip: [{ kind: 'unless_risk', tags: ['security', 'auth', 'migration'] }],
      },
      { role: StepRole.Implement, need: NEED.implement },
      { role: StepRole.Review, need: NEED.review },
      { role: StepRole.Qa, need: NEED.qa, skip: [{ kind: 'unless_criteria_over', count: 3 }] },
    ],
  },
];

/** A project with no flow of its own runs this one. */
export const DEFAULT_PROJECT_FLOW = 'standard';

/** The seeded persona each role falls back to when neither the step nor the team names one. */
export const DEFAULT_PERSONA_FOR: Readonly<Record<StepRole, string>> = {
  plan: 'planner',
  plan_review: 'plan-reviewer',
  implement: 'implementer',
  review: 'reviewer',
  qa: 'qa',
};
