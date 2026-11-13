import { Effort, Rigor } from '@10db/contracts';

/** How each rigor reads, with the line that says what it is for. */
export const RIGOR_LABELS: Readonly<
  Record<Rigor, { readonly label: string; readonly about: string }>
> = {
  [Rigor.Light]: { label: 'Light', about: 'Small, low-risk changes.' },
  [Rigor.Standard]: { label: 'Standard', about: 'Most work: built, then reviewed.' },
  [Rigor.Careful]: { label: 'Careful', about: 'Planned first, then built and reviewed.' },
  [Rigor.Critical]: { label: 'Critical', about: 'Every step runs, with a plan review and QA.' },
};

export const rigorLabel = (rigor: Rigor): string => RIGOR_LABELS[rigor].label;

/** How each effort reads in a list. */
export const EFFORT_LABELS: Readonly<Record<Effort, string>> = {
  [Effort.Low]: 'Low',
  [Effort.Medium]: 'Medium',
  [Effort.High]: 'High',
  [Effort.XHigh]: 'Extra High',
  [Effort.Max]: 'Max',
};
