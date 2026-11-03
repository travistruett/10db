import { z } from 'zod';

// Shape spec §10.2. The factory preview: how the project's lanes would run the draft, with the work
// already running or queued holding its lanes first. A preview is read, never written.

/** One task's bar on a lane, in hours from now. */
export const ShapePreviewItem = z.object({
  /** The proposal key of a draft task, or the id of a task already running or queued. */
  key: z.string(),
  title: z.string(),
  startHours: z.number().min(0),
  endHours: z.number().min(0),
  /** Work already running or queued in the project, which holds its lane before the draft does. */
  existing: z.boolean(),
  /** On the critical path: the chain of waits that sets when the last task ends. */
  critical: z.boolean(),
});
export type ShapePreviewItem = z.infer<typeof ShapePreviewItem>;

/** Tasks that claim one area and so run one after the other. */
export const ShapePreviewClash = z.object({
  area: z.string(),
  titles: z.array(z.string()).min(2),
  /** The line the sidebar shows, as it reads in the spec's example. */
  text: z.string(),
});
export type ShapePreviewClash = z.infer<typeof ShapePreviewClash>;

export const ShapePreviewDto = z.object({
  /** One entry per lane, its bars in time order. */
  lanes: z.array(z.object({ items: z.array(ShapePreviewItem) })),
  /** Keys along the critical path, first to last. */
  criticalPath: z.array(z.string()),
  clashes: z.array(ShapePreviewClash),
  /** How many draft tasks the preview placed. */
  tasks: z.int().min(0),
  /** The draft's total, in lane hours. */
  totalLaneHours: z.number().min(0),
  /** When the last task would end, from lanes alone. */
  scheduleHours: z.number().min(0),
  /** The project's median non-lane time per finished task: queueing, review waits, CI. Null with no finished task. */
  nonLaneHoursPerTask: z.number().min(0).nullable(),
  /** The schedule plus the non-lane time of each task on the critical path; marked "estimate" on screen. */
  endEstimateHours: z.number().min(0),
});
export type ShapePreviewDto = z.infer<typeof ShapePreviewDto>;
