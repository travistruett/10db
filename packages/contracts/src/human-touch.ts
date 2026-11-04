import { z } from 'zod';

/**
 * The title every workstream-failure card starts with. The failure card is a flag with no kind of its
 * own, so the human-touch count tells it from other flags by this prefix.
 */
export const WORKSTREAM_FAILED_TITLE_PREFIX = 'Workstream failed: ';

/** How many days, today included, the human-touch panel covers. */
export const HUMAN_TOUCH_DAYS = 14;

/**
 * One UTC day of how often a person was needed. The card counts are the day's inbox rows by kind;
 * a flag raised for a failed workstream counts under `workstreamFailed`, every other flag under `flag`.
 */
export const HumanTouchDayDto = z.object({
  /** The UTC day, `YYYY-MM-DD`. */
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  permission: z.int().nonnegative(),
  question: z.int().nonnegative(),
  workstreamFailed: z.int().nonnegative(),
  flag: z.int().nonnegative(),
  proposal: z.int().nonnegative(),
  review: z.int().nonnegative(),
  check: z.int().nonnegative(),
  /** Every card raised that day: the sum of the kinds above. */
  cards: z.int().nonnegative(),
  /** Tasks with a session running at some point of the day. */
  tasksRan: z.int().nonnegative(),
  /** `cards` over `tasksRan`; null when no task ran. */
  cardsPerTask: z.number().nonnegative().nullable(),
  /**
   * Minutes work waited on an answer: the time a card was open while the workstream it targets was
   * waiting on a person. A card answered while the task kept running adds none.
   */
  waitingMinutes: z.number().nonnegative(),
});
export type HumanTouchDayDto = z.infer<typeof HumanTouchDayDto>;

/** `GET /projects/:projectId/human-touch`: the last {@link HUMAN_TOUCH_DAYS} days, today first. */
export const HumanTouchDto = z.object({
  days: z.array(HumanTouchDayDto),
});
export type HumanTouchDto = z.infer<typeof HumanTouchDto>;
