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
  /** The one sentence the header shows. */
  line: z.string().min(1),
  /** What the header's popover shows: why, and what the builder can do about it. */
  details: z.string(),
  /** When the hold began. */
  since: z.iso.datetime(),
  /** The busiest processes behind the hold; empty where none. */
  culprits: z.array(z.object({ name: z.string(), cpuPct: z.number().nonnegative() })),
});
export type StatusLine = z.infer<typeof StatusLine>;

/** The holds shown now, oldest first: a hold is shown once it has lasted 2 minutes and for 2 minutes after it lifts. */
export const StatusDto = z.object({ lines: z.array(StatusLine) });
export type StatusDto = z.infer<typeof StatusDto>;
