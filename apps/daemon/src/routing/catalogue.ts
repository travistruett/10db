import { Effort, StepRole, type FlowInput, type Provider } from '@10db/contracts';

export interface SeedProfile {
  readonly provider: Provider;
  readonly model: string;
  readonly effort: Effort;
  readonly aaSlug: string;
  readonly enabled: boolean;
}

/** Claude Code's model aliases and the AA family each maps to; the slugs only, never AA's data. */
const FAMILIES = [
  { model: 'haiku', aaFamily: 'claude-haiku-5-5', enabled: true },
  { model: 'sonnet', aaFamily: 'claude-sonnet-5-5', enabled: true },
  { model: 'opus', aaFamily: 'claude-opus-5-5', enabled: true },
  // Off until Claude Code accepts the alias.
  { model: 'fable', aaFamily: 'claude-fable-5-1', enabled: false },
] as const;

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
