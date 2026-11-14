import { z } from 'zod';
import { Rigor } from './rigor';

/** The periods, in days, the rigor figures cover. */
export const RIGOR_FIGURES_PERIODS = [7, 14, 30] as const;

const Period = z.literal(RIGOR_FIGURES_PERIODS);
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
  /** Steps that ran: each counts once per workstream, however many times it was sent back. */
  stepsPerTask: z.number().nonnegative().nullable(),
  sessionsPerTask: z.number().nonnegative().nullable(),
  /** Distinct pull request URLs that carried a task; a CI-fix or re-cut batch reuses its pull request. */
  pullRequestsPerTask: z.number().nonnegative().nullable(),
  /**
   * The same three figures over goals: for each goal with a done task of this rigor, that rigor's tasks of
   * the goal summed (steps, sessions, distinct pull request URLs), averaged over those goals. Null when no
   * done task of the rigor is in a goal.
   */
  stepsPerGoal: z.number().nonnegative().nullable(),
  sessionsPerGoal: z.number().nonnegative().nullable(),
  pullRequestsPerGoal: z.number().nonnegative().nullable(),
  /** Times a reviewer sent the work back (a builder's send-back and a gate failure are not counted). */
  sentBackPerTask: z.number().nonnegative().nullable(),
  /** The share of done tasks, 0 to 1, that shipped with findings filed as a follow-up. */
  shippedWithFindings: z.number().min(0).max(1).nullable(),
});
export type RigorFiguresRowDto = z.infer<typeof RigorFiguresRowDto>;

export const RigorFiguresDto = z.object({
  period: Period,
  /** One row per rigor, Light to Critical, then the row for all of them. */
  rows: z.array(RigorFiguresRowDto),
  /**
   * The project's tasks' answered sizing calls in the period (acted or overridden), and how many the
   * builder overrode; null when there were none.
   */
  judgeOverride: z
    .object({ calls: z.int().positive(), overridden: z.int().nonnegative() })
    .nullable(),
});
export type RigorFiguresDto = z.infer<typeof RigorFiguresDto>;
