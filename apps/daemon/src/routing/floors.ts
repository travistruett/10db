import { RiskTag, StepRole } from '@10db/contracts';

export interface Floor {
  readonly minimum: number;
  readonly why: string | null;
}

interface FloorRule {
  readonly roles: readonly StepRole[];
  readonly tags: readonly RiskTag[];
  readonly minimum: number;
  readonly why: string;
}

/** Rule floors (spec §5.2.3), in the role's index points: a matching role and risk tag needs at least this. */
const FLOOR_RULES: readonly FloorRule[] = [
  {
    roles: [StepRole.Review, StepRole.PlanReview],
    tags: [RiskTag.Security, RiskTag.Auth],
    minimum: 52,
    why: 'security-sensitive review',
  },
  { roles: [StepRole.Implement], tags: [RiskTag.Migration], minimum: 45, why: 'migration' },
];

export function stepFloor(role: StepRole, riskTags: readonly RiskTag[]): Floor {
  let floor: Floor = { minimum: 0, why: null };
  for (const rule of FLOOR_RULES) {
    if (!rule.roles.includes(role) || !rule.tags.some((t) => riskTags.includes(t))) continue;
    if (rule.minimum > floor.minimum) floor = { minimum: rule.minimum, why: rule.why };
  }
  return floor;
}

/** The higher of two floors; a persona's minimum score is one. */
export function higherFloor(a: Floor, b: Floor): Floor {
  return b.minimum > a.minimum ? b : a;
}
