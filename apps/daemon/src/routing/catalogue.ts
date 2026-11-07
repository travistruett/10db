import { StepRole, type FlowInput } from '@10db/contracts';

/** Starting needs, in the role's index points (spec §15): heuristics to tune, not AA data. */
const NEED = { plan: 45, planReview: 48, implement: 40, review: 48, qa: 35 } as const;

/** The need a Plan conversation's model is chosen for: the plan step's. */
export const PLAN_NEED = NEED.plan;

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
