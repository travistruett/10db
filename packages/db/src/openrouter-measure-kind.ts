/** What a row of `openrouter_measures` holds: Artificial Analysis's scores as OpenRouter relays them, OpenRouter's own, or a provider's speed. */
export const OpenRouterMeasureKind = {
  ScoreAa: 'score_aa',
  ScoreOpenRouter: 'score_openrouter',
  Speed: 'speed',
} as const;
export type OpenRouterMeasureKind =
  (typeof OpenRouterMeasureKind)[keyof typeof OpenRouterMeasureKind];
