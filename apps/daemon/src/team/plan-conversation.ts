import { Rigor, StepRole, type Effort, type ProjectDto } from '@10db/contracts';
import type { DbReader } from '@10db/db';
import { atEffort, chooseModel, offeredModels, resolveSteps, ROLE_DEFAULT } from '../routing';
import { playbookInputs, routingInputs } from './routing-inputs';

/**
 * The model a Plan conversation runs on: what the Careful Plan cell chooses (the project's, then the global
 * one, then the default), by its fallback rung and never by score, so a conversation is never refused for
 * want of one. It runs at the plan role's own effort, not Careful's step up, unless the conversation's own
 * effort is given. Undefined when the account offers nothing to run it on.
 */
export function planConversationModel(
  db: DbReader,
  project: ProjectDto,
  effort: Effort | null,
): { model: string; effort: Effort } | undefined {
  const plan = resolveSteps({
    rigor: Rigor.Careful,
    taskKinds: [],
    ...playbookInputs(db, project.id),
  }).find((step) => step.role === StepRole.Plan);
  const choice = chooseModel({
    ...routingInputs(db, project),
    def: { role: StepRole.Plan, need: plan?.need ?? 0 },
    requirements: plan?.requirements ?? [{ kind: 'automatic' }],
    effort: plan?.effort ?? null,
    // The rung is Careful's, one effort up; a conversation keeps the role's own effort unless a cell fixes one.
    fallback: plan?.fallback
      ? { ...plan.fallback, effort: plan.effort ?? ROLE_DEFAULT[StepRole.Plan].effort }
      : null,
    pinned: false,
    task: { modelSetting: null, effortPin: effort },
    project,
    byScore: false,
  });
  return choice.profile === null && choice.model === choice.tier
    ? undefined
    : { model: choice.model, effort: choice.effort };
}

/**
 * What a conversation launches on: the builder's pick while the account still offers it, run at the
 * conversation's effort snapped to the efforts that model has; otherwise the Plan cell's model and effort.
 */
export function conversationRun(
  db: DbReader,
  project: ProjectDto,
  chosen: string | null,
  effort: Effort | null,
): { model: string; effort: Effort } | undefined {
  const planned = planConversationModel(db, project, effort);
  if (planned === undefined) return undefined;
  const { profiles } = routingInputs(db, project);
  if (chosen === null || !offeredModels(profiles).some((o) => o.model === chosen)) return planned;
  const snapped = atEffort(chosen, effort ?? planned.effort, profiles);
  return { model: chosen, effort: snapped?.effort ?? planned.effort };
}
