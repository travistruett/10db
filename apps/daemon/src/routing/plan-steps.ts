import {
  ROLE_LABEL,
  StepRole,
  ToolAccess,
  type AccountModelDto,
  type KindDto,
  type ModelProfileDto,
  type ModelTier,
  type PersonaDto,
  type ProjectDto,
  type Rigor,
  type StepPlanDto,
  type TaskKind,
  type WorkstreamStep,
} from '@10db/contracts';
import { DEFAULT_PERSONA_FOR } from './catalogue';
import { chooseModel, type ChooseTask } from './choose-model';
import { resolveSteps, type PlaybookScopes, type ResolvedStep } from './playbook';

export interface PlanInput {
  /** The rigor the task runs at (`effectiveRigor`). */
  readonly rigor: Rigor;
  readonly task: ChooseTask;
  readonly taskKinds: readonly TaskKind[];
  readonly kinds: readonly KindDto[];
  readonly playbook: PlaybookScopes;
  readonly project: Pick<ProjectDto, 'budgetCeiling'>;
  /** Personas that may play a role: archived ones are left out by the caller. */
  readonly personas: readonly PersonaDto[];
  /** What the project's account offers, already narrowed by `offeredProfiles`. */
  readonly profiles: readonly ModelProfileDto[];
  readonly tierOverrides: Readonly<Partial<Record<ModelTier, string>>>;
  /** The account's own list, which decides whether an override is offered. */
  readonly accountModels?: readonly AccountModelDto[];
}

/**
 * The persona the playbook names for a step when it is live and plays the role, else the seeded default
 * for the role, else any persona of the role. A persona that no longer exists is ignored.
 */
function personaFor(step: ResolvedStep, personas: readonly PersonaDto[]): PersonaDto | undefined {
  const named =
    step.personaId === null
      ? undefined
      : personas.find((p) => p.id === step.personaId && p.role === step.role);
  return (
    named ??
    personas.find((p) => p.key === DEFAULT_PERSONA_FOR[step.role]) ??
    personas.find((p) => p.role === step.role)
  );
}

function routedStep(step: ResolvedStep, input: PlanInput): WorkstreamStep {
  const persona = personaFor(step, input.personas);
  const choice = chooseModel({
    def: { role: step.role, need: step.need },
    requirements: step.requirements,
    effort: step.effort,
    fallback: step.fallback,
    pinned: step.pinned,
    task: input.task,
    project: input.project,
    profiles: input.profiles,
    tierOverrides: input.tierOverrides,
    ...(input.accountModels === undefined ? {} : { accountModels: input.accountModels }),
  });
  return {
    role: step.role,
    personaId: persona?.id ?? null,
    personaName: persona?.name ?? ROLE_LABEL[step.role],
    tools: step.role === StepRole.Implement ? ToolAccess.Edit : ToolAccess.ReadOnly,
    need: step.need,
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

/** Resolves a task's rigor, kinds and the playbook into the steps a workstream runs. */
export function planSteps(input: PlanInput): StepPlanDto {
  const steps = resolveSteps({
    rigor: input.rigor,
    taskKinds: input.taskKinds,
    kinds: input.kinds,
    playbook: input.playbook,
  }).map((step) => routedStep(step, input));
  return {
    rigor: input.rigor,
    steps,
    overBudget: steps.flatMap((s, i) => (s.overBudget ? [i] : [])),
  };
}
