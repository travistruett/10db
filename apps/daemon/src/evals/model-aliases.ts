import type { EvalLiveModels } from '@10db/contracts';

/** The names a result may call a pick: the pick itself and, for a choice, the model it maps to. */
export function aliasesOf(models: EvalLiveModels | undefined, pick: string): string[] {
  if (models === undefined || models.ids === 'openrouter') return [pick];
  const choice = models.ids.choices.find((c) => c.name === pick);
  return choice === undefined ? [pick] : [...new Set([choice.name, choice.model])];
}
