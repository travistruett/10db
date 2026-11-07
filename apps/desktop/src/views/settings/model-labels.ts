import { ModelTier } from '@10db/contracts';

/** How each tier reads in the UI. */
export const TIER_LABEL: Readonly<Record<ModelTier, string>> = {
  [ModelTier.Fast]: 'Fast',
  [ModelTier.Balanced]: 'Balanced',
  [ModelTier.Strongest]: 'Strongest',
};
