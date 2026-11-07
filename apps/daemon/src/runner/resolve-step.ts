import {
  isModelTier,
  isPickableModel,
  type AccountModelDto,
  type ModelProfileDto,
  type ModelTier,
  type WorkstreamStep,
} from '@10db/contracts';
import type { AccountRow } from '@10db/db';
import { chooseModel, NoProfileError, type ChooseInput } from '../routing';

/** What choosing again needs besides what the account offers: the step's task, project and the builder's settings. */
export interface StepContext extends Pick<
  ChooseInput,
  'persona' | 'task' | 'project' | 'roleSettings' | 'patterns' | 'tierOverrides'
> {
  /**
   * The tier the planned model is in, for a step whose model the account refused: the step starts over in
   * that tier whatever its setting, and keeps the setting.
   */
  readonly plannedTier?: ModelTier | undefined;
}

/** Whether the account can run the step's model at the step's effort now. */
function offered(
  step: WorkstreamStep,
  profiles: readonly ModelProfileDto[],
  accountModels: readonly AccountModelDto[],
): boolean {
  if (isModelTier(step.model)) return false;
  const named = profiles.filter((p) => p.model === step.model);
  if (named.length > 0)
    return named.some((p) => p.effort === step.effort && isPickableModel(p.status));
  // A model the account lists that the catalogue has no profile for still launches.
  return accountModels.some((m) => m.model === step.model && !m.unusable);
}

/** Why a step cannot run as planned, for the reason it carries afterwards. */
function whyNot(
  step: WorkstreamStep,
  account: Pick<AccountRow, 'label'>,
  profiles: readonly ModelProfileDto[],
  accountModels: readonly AccountModelDto[],
): string {
  if (isModelTier(step.model)) return 'no model was chosen when this step was planned';
  if (accountModels.some((m) => m.model === step.model && m.unusable))
    return `${step.model} is marked unusable on ${account.label}`;
  if (profiles.some((p) => p.model === step.model))
    return `${step.model} at ${step.effort} effort is not offered by ${account.label}`;
  return `${step.model} is not offered by ${account.label}`;
}

/**
 * The step as it will start on `account`. A planned model the account offers, and has not marked unusable,
 * is kept. Otherwise (the project moved accounts, the account's list changed, the model was refused, or the
 * step was planned with nothing to run) the step's setting is applied again to what the account offers now,
 * and the reason says why. When nothing is on offer the result names the tier and has no profile: there is
 * nothing to launch, and the caller holds the account.
 */
export function resolveStep(
  step: WorkstreamStep,
  account: Pick<AccountRow, 'label'>,
  profiles: readonly ModelProfileDto[],
  accountModels: readonly AccountModelDto[],
  context: StepContext,
): WorkstreamStep {
  if (offered(step, profiles, accountModels)) return step;
  const refused = accountModels.some((m) => m.model === step.model && m.unusable);
  const startOverTier = refused ? context.plannedTier : undefined;
  const choose = (byScore: boolean) =>
    chooseModel({
      ...context,
      def: { role: step.role, need: step.need },
      accountModels,
      profiles,
      stakes: { retry: false },
      byScore,
      plannedSetting: step.setting,
      ...(startOverTier === undefined ? {} : { startOverTier }),
    });
  let choice;
  try {
    choice = choose(true);
  } catch (error) {
    // A step that already started must not be refused for want of a score that clears its need.
    if (!(error instanceof NoProfileError)) throw error;
    choice = choose(false);
  }
  const profileId = choice.profile?.id ?? null;
  if (choice.model === step.model && choice.effort === step.effort && profileId === step.profileId)
    return step;
  return {
    ...step,
    profileId,
    model: choice.model,
    effort: choice.effort,
    // A refusal moves the step to another model of its tier, not to another kind of choice.
    setting: startOverTier === undefined ? choice.setting : step.setting,
    overBudget: choice.overBudget,
    pinned: choice.pinned,
    score: choice.score,
    reason: `${whyNot(step, account, profiles, accountModels)}, so the step was resolved again: ${choice.reason}`,
  };
}
