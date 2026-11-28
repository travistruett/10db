import { z } from 'zod';
import { TaskId } from './ids';
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

/**
 * The answers to an acceptance card: accept the criteria without proof, send the work back with a note, or drop
 * the criteria from the task. Only the builder gives Accept or Drop: the daemon refuses both from an agent or a
 * rule, since either one lowers the bar. A card raised before Drop existed offers only the first two.
 */
export const AcceptanceChoice = { Accept: 'accept', SendBack: 'send_back', Drop: 'drop' } as const;
export type AcceptanceChoice = (typeof AcceptanceChoice)[keyof typeof AcceptanceChoice];

/** Whether acceptance is checking, and when it is not, why. */
export const AcceptanceChecking = z.discriminatedUnion('on', [
  z.object({ on: z.literal(true) }),
  z.object({ on: z.literal(false), reason: z.enum(['no_account', 'off']) }),
]);
export type AcceptanceChecking = z.infer<typeof AcceptanceChecking>;

/** One run behind a Board count: the task, when it happened, and for a send-back who sent it back. */
export const AcceptanceRow = z.object({
  taskId: TaskId,
  title: z.string(),
  at: z.string(),
  by: z.string().optional(),
});
export type AcceptanceRow = z.infer<typeof AcceptanceRow>;

/** The Board's acceptance counts for the last `days` days, and the newest rows behind each. */
export const AcceptanceFigures = z.object({
  days: z.number().int(),
  completed: z.number().int(),
  sentBack: z.number().int(),
  sentToYou: z.number().int(),
  rows: z.object({
    completed: z.array(AcceptanceRow),
    sentBack: z.array(AcceptanceRow),
    sentToYou: z.array(AcceptanceRow),
  }),
  checking: AcceptanceChecking,
});
export type AcceptanceFigures = z.infer<typeof AcceptanceFigures>;

/** The query string of `GET /projects/:projectId/acceptance-figures`: the same periods as the rigor figures. */
export const AcceptanceFiguresQuery = z.strictObject({
  days: z.coerce.number().pipe(z.literal(RIGOR_FIGURES_PERIODS)).default(7),
});
export type AcceptanceFiguresQuery = z.output<typeof AcceptanceFiguresQuery>;
