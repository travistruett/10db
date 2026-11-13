import { Rigor } from '@10db/contracts';

/** A rigor in plain words, as the task's picker and card show it. */
export const RIGOR_LABEL: Readonly<Record<Rigor, string>> = {
  [Rigor.Light]: 'Light',
  [Rigor.Standard]: 'Standard',
  [Rigor.Careful]: 'Careful',
  [Rigor.Critical]: 'Critical',
};
