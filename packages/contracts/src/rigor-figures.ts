import { z } from 'zod';
import { Rigor } from './rigor';

/** The periods, in days, the rigor figures cover. */
export const RIGOR_FIGURES_PERIODS = [7, 14, 30] as const;

const Period = z.union([z.literal(7), z.literal(14), z.literal(30)]);
export type RigorFiguresPeriod = z.infer<typeof Period>;

/** The period the figures cover when none is asked for. */
const DEFAULT_RIGOR_FIGURES_DAYS: RigorFiguresPeriod = 14;

/** The query string of `GET /projects/:projectId/rigor-figures`. */
export const RigorFiguresQuery = z.strictObject({
  days: z.coerce.number().pipe(Period).default(DEFAULT_RIGOR_FIGURES_DAYS),
});
export type RigorFiguresQuery = z.output<typeof RigorFiguresQuery>;

/** The row that counts every done task, whatever its rigor. */
export const ALL_RIGORS = 'all';

/**
 * What the tasks of one rigor, done in the period, took. Averages are per done task and null when no
 * task of the rigor was done.
 */
export const RigorFiguresRowDto = z.object({
  rigor: z.union([z.enum(Rigor), z.literal(ALL_RIGORS)]),
  tasksDone: z.int().nonnegative(),
  /** Steps that ran: a step sent back and run again counts once. */
  stepsPerTask: z.number().nonnegative().nullable(),
  sessionsPerTask: z.number().nonnegative().nullable(),
  /** Times a reviewer or a gate sent the work back. */
  sendBacksPerTask: z.number().nonnegative().nullable(),
  /**
   * The distinct pull requests that carried a goal's done tasks of this rigor, averaged over the goals with
   * such a task. Null when no done task of the rigor is in a goal.
   */
  pullRequestsPerGoal: z.number().nonnegative().nullable(),
  /** The share of done tasks, 0 to 1, that shipped with findings filed as a follow-up. */
  shippedWithFindings: z.number().min(0).max(1).nullable(),
});
export type RigorFiguresRowDto = z.infer<typeof RigorFiguresRowDto>;

export const RigorFiguresDto = z.object({
  period: Period,
  /** One row per rigor, Light to Critical, then the row for all of them. */
  rows: z.array(RigorFiguresRowDto),
  /**
   * The judge's sizing calls in the period, across every project, and how many the builder overrode;
   * null when the judge made none.
   */
  judgeOverride: z
    .object({ calls: z.int().positive(), overridden: z.int().nonnegative() })
    .nullable(),
});
export type RigorFiguresDto = z.infer<typeof RigorFiguresDto>;
