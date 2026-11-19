import { z } from 'zod';

/** What a status line reports: a hold that pauses work and ends by itself, so it asks the builder nothing. */
export const StatusKind = {
  /** The admission gate holds new lanes: the Mac is overloaded. */
  AdmissionHold: 'admission_hold',
  /** A shaping conversation keeps the app's update waiting, and lanes are paused. */
  UpdateHold: 'update_hold',
  /** An account's queued work waits for its model list. */
  ModelListWait: 'model_list_wait',
} as const;
export type StatusKind = (typeof StatusKind)[keyof typeof StatusKind];

export const StatusLine = z.object({
  /** Names the hold, so a hold that continues is one line. */
  key: z.string().min(1),
  kind: z.enum([StatusKind.AdmissionHold, StatusKind.UpdateHold, StatusKind.ModelListWait]),
  /** A few words naming the cause, for the rail, where the sentence does not fit. */
  label: z.string().min(1),
  /** The one sentence: the popover's heading. */
  line: z.string().min(1),
  /** Why, and what the builder can do about it; the busy processes are in `culprits`, not here. */
  details: z.string(),
  /** When the hold began. */
  since: z.iso.datetime(),
  /** Plain names of what is busiest, at most three ("Docker", "file indexing", "10db's own work"); empty where none. */
  busiest: z.array(z.string()),
  /** The busiest processes behind the hold; empty where none. */
  culprits: z.array(
    z.object({
      /** The program's short name, not its path. */
      name: z.string(),
      cpuPct: z.number().nonnegative(),
      /** Whose it is: a lane or gate of 10db's, or "not 10db’s". */
      owner: z.string(),
    }),
  ),
});
export type StatusLine = z.infer<typeof StatusLine>;

/** How busy the Mac is: 1 is where 10db holds new work. */
export const BusyLevel = z.object({
  /** The 1-minute load over the overload limit (the factor times the cores), rounded to tenths. */
  level: z.number().nonnegative(),
  /** 10db is holding new work for it now. */
  holding: z.boolean(),
  /** While holding, plain names of what is busiest, at most three; empty otherwise. */
  busiest: z.array(z.string()),
});
export type BusyLevel = z.infer<typeof BusyLevel>;

/**
 * The holds shown now, oldest first (a hold is shown once it has lasted 2 minutes and for 2 minutes after it
 * lifts), and how busy the Mac is, which is null until the load has been read.
 */
export const StatusDto = z.object({ lines: z.array(StatusLine), busy: BusyLevel.nullable() });
export type StatusDto = z.infer<typeof StatusDto>;
