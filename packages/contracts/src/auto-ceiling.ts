import { z } from 'zod';

/** What a project's own work is counted by against its daily ceiling. */
export const CeilingMeasure = { Usd: 'usd', Share: 'share', Sessions: 'sessions' } as const;
export type CeilingMeasure = (typeof CeilingMeasure)[keyof typeof CeilingMeasure];

/** What a project's three ceiling fields hold until the builder changes them. */
export const AUTO_CEILING_DEFAULTS = { usd: 10, share: 0.1, sessions: 20 } as const;

/**
 * `GET /projects/:id/auto-ceiling`: what 10db's own work for the project has counted today (the project's
 * local day), the ceilings those are held to with the day's Carry On Todays, and the measure in use.
 * `reached` is the first measure at or past its ceiling, null while work may start.
 */
export const AutoCeilingTodayDto = z.object({
  day: z.iso.date(),
  usd: z.number(),
  share: z.number(),
  unmeasured: z.int(),
  carryOns: z.int().nonnegative(),
  /** The measure the project's account is counted by: dollars on a metered account, else the plan's share or sessions. */
  measure: z.enum(CeilingMeasure),
  reached: z.enum(CeilingMeasure).nullable(),
});
export type AutoCeilingTodayDto = z.infer<typeof AutoCeilingTodayDto>;
