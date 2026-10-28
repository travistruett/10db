import { Effort, StepRole, type ModelProfileDto, type Provider } from '@10db/contracts';
import { MODEL_TIERS, ModelTier } from './catalogue';

/** The tier and effort each role runs on when no score can route it. */
const ROLE_DEFAULT: Readonly<Record<StepRole, { tier: ModelTier; effort: Effort }>> = {
  [StepRole.Plan]: { tier: ModelTier.Strongest, effort: Effort.High },
  [StepRole.PlanReview]: { tier: ModelTier.Strongest, effort: Effort.High },
  [StepRole.Implement]: { tier: ModelTier.Balanced, effort: Effort.High },
  [StepRole.Review]: { tier: ModelTier.Strongest, effort: Effort.High },
  [StepRole.Qa]: { tier: ModelTier.Fast, effort: Effort.Medium },
};

const TIERS: readonly ModelTier[] = [ModelTier.Fast, ModelTier.Balanced, ModelTier.Strongest];
const EFFORTS: readonly Effort[] = Object.values(Effort);

const strength = (model: string): number => MODEL_TIERS.findIndex((m) => m.model === model);
const tierLevel = (model: string): number =>
  TIERS.indexOf(MODEL_TIERS.find((m) => m.model === model)?.tier ?? ModelTier.Fast);
const effortLevel = (effort: Effort): number => EFFORTS.indexOf(effort);

/** The profiles a role default may run: enabled, of the provider, on one of Claude Code's models. */
function usable(profiles: readonly ModelProfileDto[], provider: Provider): ModelProfileDto[] {
  return profiles.filter(
    (p) =>
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Provider has one member today; the comparison is what keeps routing correct when another is added.
      p.enabled && p.provider === provider && strength(p.model) >= 0,
  );
}

/** The strongest model offered in the tier, else in the nearest tier, the stronger on a tie. */
function modelFor(tier: ModelTier, offered: readonly ModelProfileDto[]): string | undefined {
  const target = TIERS.indexOf(tier);
  const distance = (model: string) => Math.abs(tierLevel(model) - target);
  return [...new Set(offered.map((p) => p.model))].sort(
    (a, b) => distance(a) - distance(b) || strength(b) - strength(a),
  )[0];
}

/** The model's profile at the effort, else at the nearest effort offered, the higher on a tie. */
function atEffort(
  model: string,
  effort: Effort,
  offered: readonly ModelProfileDto[],
): ModelProfileDto | undefined {
  const target = effortLevel(effort);
  const distance = (p: ModelProfileDto) => Math.abs(effortLevel(p.effort) - target);
  return offered
    .filter((p) => p.model === model)
    .sort((a, b) => distance(a) - distance(b) || effortLevel(b.effort) - effortLevel(a.effort))[0];
}

export interface RoleDefaultInput {
  readonly provider: Provider;
  readonly role: StepRole;
  /** Why the step needs more than its need, when a risk rule or a persona's minimum raises it. */
  readonly floor: string | null;
  readonly profiles: readonly ModelProfileDto[];
}

export interface RoleDefaultChoice {
  readonly profile: ModelProfileDto;
  readonly reason: string;
}

/**
 * The profile a role runs on when no score can route it: the strongest model offered for plan, plan review
 * and review, a balanced one for implement, a fast one for QA. A floor moves the step to the strongest model,
 * one effort up. Undefined when the account offers none of Claude Code's models.
 */
export function roleDefault(input: RoleDefaultInput): RoleDefaultChoice | undefined {
  const offered = usable(input.profiles, input.provider);
  const own = ROLE_DEFAULT[input.role];
  const tier = input.floor === null ? own.tier : ModelTier.Strongest;
  const effort =
    input.floor === null
      ? own.effort
      : (EFFORTS[Math.min(effortLevel(own.effort) + 1, EFFORTS.length - 1)] ?? own.effort);
  const model = modelFor(tier, offered);
  const profile = model === undefined ? undefined : atEffort(model, effort, offered);
  if (!profile) return undefined;
  const raised = input.floor === null ? '' : `, one effort up (floor: ${input.floor})`;
  return { profile, reason: `by role default: the ${tier} model offered${raised}` };
}

/**
 * One rung up the role defaults' ladder from a profile: the next stronger model offered at the nearest
 * effort, then, on the strongest, the next effort up. Undefined at the top.
 */
export function strongerDefault(
  provider: Provider,
  from: Pick<ModelProfileDto, 'model' | 'effort'>,
  profiles: readonly ModelProfileDto[],
): ModelProfileDto | undefined {
  const here = strength(from.model);
  if (here < 0) return undefined;
  const offered = usable(profiles, provider);
  const next = offered
    .map((p) => p.model)
    .filter((m) => strength(m) > here)
    .sort((a, b) => strength(a) - strength(b))[0];
  if (next !== undefined) return atEffort(next, from.effort, offered);
  return offered
    .filter((p) => p.model === from.model && effortLevel(p.effort) > effortLevel(from.effort))
    .sort((a, b) => effortLevel(a.effort) - effortLevel(b.effort))[0];
}
