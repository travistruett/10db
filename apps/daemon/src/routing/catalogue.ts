import type { StepRole } from '@10db/contracts';

/** Starting needs, in Intelligence Index points (spec §15): heuristics to tune, not AA data. */
export const ROLE_NEED: Readonly<Record<StepRole, number>> = {
  plan: 45,
  plan_review: 48,
  implement: 40,
  review: 48,
  qa: 35,
};

/** The seeded persona each role falls back to when neither the step nor the team names one. */
export const DEFAULT_PERSONA_FOR: Readonly<Record<StepRole, string>> = {
  plan: 'planner',
  plan_review: 'plan-reviewer',
  implement: 'implementer',
  review: 'reviewer',
  qa: 'qa',
};
