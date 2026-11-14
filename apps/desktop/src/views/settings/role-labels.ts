import { StepRole } from '@10db/contracts';

/** The roles a step plays, in the order a task meets them, with what each does. */
export const ROLES: readonly {
  readonly role: StepRole;
  readonly label: string;
  readonly about: string;
}[] = [
  { role: StepRole.Plan, label: 'Plan', about: 'Plans the task before any code is written.' },
  {
    role: StepRole.PlanReview,
    label: 'Plan Review',
    about: 'Reads the plan before work starts.',
  },
  { role: StepRole.Implement, label: 'Build', about: 'Writes the code.' },
  { role: StepRole.Review, label: 'Review', about: 'Reads the finished work.' },
  { role: StepRole.Qa, label: 'QA', about: 'Checks the work against what the task promised.' },
];
