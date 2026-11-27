import {
  EvalLiveRefusal,
  EvalLiveRefused,
  EvalModelId,
  type EvalLiveModels,
} from '@10db/contracts';

/** At most this many picks reach the environment variable. */
const MAX_PICKS = 10;

/**
 * What one pick is passed as: an `openrouter` suite takes a strict model id as given; a `choices` suite takes a
 * choice's name, whether the pick names the choice or the model it maps to. Anything else is refused.
 */
function passedAs(models: EvalLiveModels, pick: string): string {
  if (models.ids === 'openrouter') {
    const id = EvalModelId.safeParse(pick);
    if (id.success) return id.data;
  } else {
    const choice = models.ids.choices.find((c) => c.name === pick || c.model === pick);
    if (choice !== undefined) return choice.name;
  }
  throw new EvalLiveRefused(
    EvalLiveRefusal.BadModel,
    'A picked model is not one this suite accepts.',
  );
}

/**
 * The one place picks become the value of the suite's model variable: each pick checked against what the suite
 * accepts, joined by commas. Throws `EvalLiveRefused(BadModel)` for a pick it does not accept, for none, or for
 * more than ten; the value is never a free string, so it holds no shell syntax.
 */
export function modelEnvValue(models: EvalLiveModels, picked: readonly string[]): string {
  if (picked.length === 0 || picked.length > MAX_PICKS)
    throw new EvalLiveRefused(EvalLiveRefusal.BadModel, 'Pick between one and ten models.');
  return picked.map((pick) => passedAs(models, pick)).join(',');
}
