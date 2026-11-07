import type { WorkstreamStep } from '@10db/contracts';
import { chooseModel, type ChooseInput } from './choose-model';
import { escalateStep, NoProfileError, type EscalateInput } from './router';

/**
 * The step a retry runs. A pattern that applies only to a retry moves the step to the model it names; with
 * none, or once the step already runs there, the step climbs one rung (`escalateStep`). A pinned step stays.
 */
export function retryStep(
  step: WorkstreamStep,
  input: { readonly choose: Omit<ChooseInput, 'stakes'>; readonly escalate: EscalateInput },
): { readonly step: WorkstreamStep; readonly escalated: boolean } {
  if (!step.pinned) {
    try {
      const first = chooseModel({ ...input.choose, stakes: { retry: false } });
      const retry = chooseModel({ ...input.choose, stakes: { retry: true } });
      if (
        retry.profile &&
        retry.profile.id !== first.profile?.id &&
        retry.profile.id !== step.profileId
      )
        return {
          escalated: true,
          step: {
            ...step,
            profileId: retry.profile.id,
            model: retry.profile.model,
            effort: retry.profile.effort,
            setting: retry.setting,
            overBudget: retry.overBudget,
            reason: `escalated from ${step.model}@${step.effort} after ${input.escalate.why}: ${retry.reason}`,
          },
        };
    } catch (error) {
      // A retry must not refuse: when no profile reaches the step's need, it climbs a rung instead.
      if (!(error instanceof NoProfileError)) throw error;
    }
  }
  return escalateStep(step, input.escalate);
}
