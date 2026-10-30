import {
  ROLE_LABEL,
  ROLE_SCORE,
  ScoreKind,
  StepRole,
  ToolAccess,
  type FlowDto,
  type FlowStepDef,
  type ModelProfileDto,
  type PersonaDto,
  type ProjectDto,
  type StepPlanDto,
  type TeamBinding,
  type WorkstreamStep,
} from '@10db/contracts';
import { DEFAULT_PERSONA_FOR } from './catalogue';
import { higherFloor, stepFloor } from './floors';
import { roleDefault } from './role-defaults';
import { NoProfileError, route, UnmeasuredError } from './router';
import { skipReason, type TaskShape } from './skip-rules';

export interface PlanInput {
  readonly flow: FlowDto;
  readonly task: TaskShape;
  readonly project: Pick<ProjectDto, 'provider' | 'budgetCeiling'>;
  /** Personas that may play a role: archived ones are left out by the caller. */
  readonly personas: readonly PersonaDto[];
  readonly bindings: readonly TeamBinding[];
  readonly profiles: readonly ModelProfileDto[];
}

/**
 * A step's own persona, then the team's binding for its role, then the seeded default, then any of the role.
 * The caller passes live personas only, so a step naming an archived one runs the role's default.
 */
function personaFor(def: FlowStepDef, input: PlanInput): PersonaDto | undefined {
  const own =
    def.persona === null
      ? undefined
      : input.personas.find((p) => p.key === def.persona && p.role === def.role);
  const bound = input.bindings.find((b) => b.role === def.role);
  return (
    own ??
    (bound ? input.personas.find((p) => p.id === bound.personaId) : undefined) ??
    input.personas.find((p) => p.key === DEFAULT_PERSONA_FOR[def.role]) ??
    input.personas.find((p) => p.role === def.role)
  );
}

/** The indefinite article for a score kind's name. */
const article = (kind: ScoreKind): string => (kind === ScoreKind.Coding ? 'a' : 'an');

function routedStep(
  def: FlowStepDef,
  persona: PersonaDto | undefined,
  input: PlanInput,
): WorkstreamStep {
  const kind = ROLE_SCORE[def.role];
  const base = {
    role: def.role,
    personaId: persona?.id ?? null,
    personaName: persona?.name ?? ROLE_LABEL[def.role],
    tools: def.role === StepRole.Implement ? ToolAccess.Edit : ToolAccess.ReadOnly,
    score: kind,
    need: def.need,
    status: 'pending',
    attempts: 0,
    startedAt: null,
    sessionFloor: 0,
    result: null,
  } as const;
  const pin = persona?.modelPin ?? null;
  if (pin && persona) {
    const pinned = input.profiles.find(
      (p) =>
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Provider has one member today; the comparison is what keeps routing correct when another is added.
        p.provider === input.project.provider && p.model === pin.model && p.effort === pin.effort,
    );
    return {
      ...base,
      earlier: [],
      sentBack: 0,
      profileId: pinned?.id ?? null,
      model: pin.model,
      effort: pin.effort,
      reason: `pinned by ${persona.key}`,
      overBudget: false,
      pinned: true,
    };
  }
  const personaFloor =
    persona && persona.minimumScore !== null
      ? { minimum: persona.minimumScore, why: `${persona.key} minimum` }
      : { minimum: 0, why: null };
  const floor = higherFloor(stepFloor(def.role, input.task.riskTags), personaFloor);
  try {
    const choice = route({
      provider: input.project.provider,
      role: def.role,
      need: def.need,
      floor,
      budgetCeiling: input.project.budgetCeiling,
      profiles: input.profiles,
    });
    return {
      ...base,
      earlier: [],
      sentBack: 0,
      score: choice.score,
      profileId: choice.profile.id,
      model: choice.profile.model,
      effort: choice.profile.effort,
      reason: choice.reason,
      overBudget: choice.overBudget,
      pinned: false,
    };
  } catch (error) {
    if (!(error instanceof UnmeasuredError)) throw error;
    const fallback = roleDefault({
      provider: input.project.provider,
      role: def.role,
      floor: floor.minimum > def.need ? floor.why : null,
      profiles: input.profiles,
    });
    if (!fallback)
      throw new NoProfileError(
        `No enabled ${input.project.provider} profile the account offers is one of Claude Code's models`,
      );
    return {
      ...base,
      earlier: [],
      sentBack: 0,
      profileId: fallback.profile.id,
      model: fallback.profile.model,
      effort: fallback.profile.effort,
      reason: `${fallback.reason}; no profile has ${article(error.kind)} ${error.kind} score to compare on yet (sync Artificial Analysis to route by score)`,
      overBudget: false,
      pinned: false,
    };
  }
}

/** Resolves a flow into the steps a workstream runs. Skipped steps are left out. */
export function planSteps(input: PlanInput): StepPlanDto {
  const steps: WorkstreamStep[] = [];
  for (const def of input.flow.steps) {
    if (skipReason(def, input.task) !== null) continue;
    // A plan review with no plan before it has nothing to judge and nowhere to send a rejection.
    if (def.role === StepRole.PlanReview && !steps.some((s) => s.role === StepRole.Plan)) continue;
    steps.push(routedStep(def, personaFor(def, input), input));
  }
  return {
    flowName: input.flow.name,
    steps,
    overBudget: steps.flatMap((s, i) => (s.overBudget ? [i] : [])),
  };
}
