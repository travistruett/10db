import { z } from 'zod';
import { RIGOR_FIGURES_PERIODS } from './rigor-figures';

/** What the acceptance check read of one criterion. `unread` is a call that gave no answer. */
export const AcceptanceVerdict = {
  Met: 'met',
  NotMet: 'not_met',
  Unclear: 'unclear',
  Unread: 'unread',
} as const;
export type AcceptanceVerdict = (typeof AcceptanceVerdict)[keyof typeof AcceptanceVerdict];

export const AcceptanceCriterionResult = z.object({
  criterion: z.string().min(1),
  verdict: z.enum(['met', 'not_met', 'unclear', 'unread']),
  /** Which call read it, and how sure it was: "read as not met (0.86, second opinion)". */
  note: z.string(),
});
export type AcceptanceCriterionResult = z.infer<typeof AcceptanceCriterionResult>;

export const AcceptanceDetail = z.object({
  criteria: z.array(AcceptanceCriterionResult),
  /** Set when the change likely does something the task didn't ask for. */
  unasked: z.string().nullable(),
  /** True only on the pass that sent the run back: the one row that is fix evidence. */
  sentBack: z.boolean(),
});
export type AcceptanceDetail = z.infer<typeof AcceptanceDetail>;

/** The two answers to an acceptance card: ship the work as it is, or send it back with a note. */
export const AcceptanceChoice = { Accept: 'accept', SendBack: 'send_back' } as const;
export type AcceptanceChoice = (typeof AcceptanceChoice)[keyof typeof AcceptanceChoice];

/** Whether acceptance is checking, and when it is not, why. */
export const AcceptanceChecking = z.discriminatedUnion('on', [
  z.object({ on: z.literal(true) }),
  z.object({ on: z.literal(false), reason: z.enum(['no_account', 'off']) }),
]);
export type AcceptanceChecking = z.infer<typeof AcceptanceChecking>;

/** The Board's acceptance counts for the last `days` days. */
export const AcceptanceFigures = z.object({
  days: z.number().int(),
  completed: z.number().int(),
  sentBack: z.number().int(),
  sentToYou: z.number().int(),
  checking: AcceptanceChecking,
});
export type AcceptanceFigures = z.infer<typeof AcceptanceFigures>;

/** The query string of `GET /projects/:projectId/acceptance-figures`: the same periods as the rigor figures. */
export const AcceptanceFiguresQuery = z.strictObject({
  days: z.coerce.number().pipe(z.literal(RIGOR_FIGURES_PERIODS)).default(7),
});
export type AcceptanceFiguresQuery = z.output<typeof AcceptanceFiguresQuery>;
