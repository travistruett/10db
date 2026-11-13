import { ModelStatus, ModelTier } from '@10db/contracts';

/** How each tier reads in the UI. */
export const TIER_LABEL: Readonly<Record<ModelTier, string>> = {
  [ModelTier.Efficient]: 'Efficient',
  [ModelTier.Balanced]: 'Balanced',
  [ModelTier.Capable]: 'Capable',
  [ModelTier.Frontier]: 'Frontier',
};

/** How each status reads in a badge; a current model needs none on the list, the drawer says it. */
export const STATUS_LABEL: Readonly<Record<ModelStatus, string>> = {
  [ModelStatus.Current]: 'Current',
  [ModelStatus.Superseded]: 'Superseded',
  [ModelStatus.Retired]: 'Retired',
  [ModelStatus.Unknown]: 'Unknown',
  [ModelStatus.NotRunnable]: 'Not runnable',
};
