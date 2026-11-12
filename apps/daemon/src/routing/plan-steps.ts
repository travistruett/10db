import {
  ROLE_LABEL,
  StepRole,
  ToolAccess,
  type AccountModelDto,
  type FlowDto,
  type FlowStepDef,
  type ModelProfileDto,
  type ModelTier,
  type PatternDto,
  type PersonaDto,
  type ProjectDto,
  type RoleSettingDto,
  type StepPlanDto,
  type TeamBinding,
  type WorkstreamStep,
} from '@10db/contracts';
import { DEFAULT_PERSONA_FOR } from './catalogue';
import { chooseModel, type ChooseTask } from './choose-model';
import { skipReason } from './skip-rules';

export interface PlanInput {
  readonly flow: FlowDto;
  readonly task: ChooseTask;
  readonly project: Pick<ProjectDto, 'id' | 'budgetCeiling'>;
  /** Personas that may play a role: archived ones are left out by the caller. */
  readonly personas: readonly PersonaDto[];
  readonly bindings: readonly TeamBinding[];
  /** What the project's account offers, already narrowed by `offeredProfiles`. */
  readonly profiles: readonly ModelProfileDto[];
  readonly roleSettings: readonly RoleSettingDto[];
  readonly patterns: readonly PatternDto[];
  readonly tierOverrides: Readonly<Partial<Record<ModelTier, string>>>;
  /** The account's own list, which decides whether an override is offered. */
  readonly accountModels?: readonly AccountModelDto[];
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

function routedStep(
  def: FlowStepDef,
  persona: PersonaDto | undefined,
  input: PlanInput,
): WorkstreamStep {
  const choice = chooseModel({
    def,
    persona,
    task: input.task,
    project: input.project,
    profiles: input.profiles,
    roleSettings: input.roleSettings,
    patterns: input.patterns,
    tierOverrides: input.tierOverrides,
    ...(input.accountModels === undefined ? {} : { accountModels: input.accountModels }),
    stakes: { retry: false },
  });
  return {
    role: def.role,
    personaId: persona?.id ?? null,
    personaName: persona?.name ?? ROLE_LABEL[def.role],
    tools: def.role === StepRole.Implement ? ToolAccess.Edit : ToolAccess.ReadOnly,
    need: def.need,
    status: 'pending',
    attempts: 0,
    startedAt: null,
    sessionFloor: 0,
    result: null,
    earlier: [],
    sentBack: 0,
    setting: choice.setting,
    // With nothing to run on, the step names the tier and has no profile; the launcher never starts a tier name.
    profileId: choice.profile?.id ?? null,
    model: choice.model,
    effort: choice.effort,
    reason: choice.reason,
    overBudget: choice.overBudget,
    pinned: choice.pinned,
  };
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
