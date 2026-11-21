import { z } from 'zod';
import { DesignCheckId, ProjectId, ShapeAttachmentId, ShapeId, TaskId } from './ids';
import { ScreenTheme, ScreenViewport } from './task-screens';

// Plan-in-sessions spec §4, "Design review": a mock-up drawn to a picture and the app's pages shot as
// they are now, kept together with the verdict. The pictures go to the session's own model for a Design
// review and a lane's `check_design`, and nowhere else
// (`decisions/2026-11-20-design-review-shows-the-app-to-the-sessions-model.md`).

type ValueOf<T> = T[keyof T];

/** Why a check was made: a Design review of a plan, or a lane's `check_design` before its handoff. */
export const DesignCheckPurpose = { PlanReview: 'plan_review', LaneCheck: 'lane_check' } as const;
export type DesignCheckPurpose = ValueOf<typeof DesignCheckPurpose>;

/** One page's shot in a check: its picture's hash, or why there is none. */
export const DesignCheckShot = z.object({
  route: z.string(),
  viewport: ScreenViewport,
  theme: z.enum(ScreenTheme),
  /** The PNG's hash; null when the page could not be shot. */
  sha256: z.string().nullable(),
  /** Why there is no picture; null when there is one. */
  missing: z.string().nullable(),
});
export type DesignCheckShot = z.infer<typeof DesignCheckShot>;

export const DesignCheckDto = z.object({
  id: DesignCheckId,
  projectId: ProjectId,
  /** The plan's conversation, for a Design review; null for a lane's check. */
  shapeId: ShapeId.nullable(),
  /** The Board task, for a lane's check; null for a Design review, whose tasks are still plan rows. */
  taskId: TaskId.nullable(),
  attachmentId: ShapeAttachmentId,
  purpose: z.enum(DesignCheckPurpose),
  /** The drawn mock-up's PNG hash; null when it could not be drawn. */
  mockupSha256: z.string().nullable(),
  shots: z.array(DesignCheckShot),
  /** The project's `DESIGN.md` as the checkout holds it, or null when it has none. */
  designMdPath: z.string().nullable(),
  /** What the agent said the mock-up and the app still differ in; null until it says. */
  verdict: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type DesignCheckDto = z.infer<typeof DesignCheckDto>;

/** `GET /tasks/:taskId/design-checks`: the checks of the task's newest call, for its drawer. */
export const TaskDesignCheckDto = z.object({
  taskId: TaskId,
  /** One per mock-up the call drew; empty when the task has none. */
  checks: z.array(DesignCheckDto),
});
export type TaskDesignCheckDto = z.infer<typeof TaskDesignCheckDto>;

/** The lane tool that shows an agent its task's mock-up beside the app as it is now. */
export const CHECK_DESIGN_TOOL = 'check_design';

export const CheckDesignInput = z.object({
  verdict: z
    .string()
    .min(1)
    .max(2000)
    .optional()
    .describe(
      'On a second call, after you compared the pictures: what still differs between the mock-up and the app, or that nothing does. Kept with the check.',
    ),
});
export type CheckDesignInput = z.infer<typeof CheckDesignInput>;

export const CHECK_DESIGN_DESCRIPTION =
  "Shows you this task's approved mock-up drawn to a picture, beside pictures of the task's page or pages as the app shows them now, with the project's DESIGN.md path. Call it before you hand off, compare, and fix what differs; then call it again with `verdict` to record what still differs, or that nothing does. Every check is kept for the builder. In a task that runs in a separate copy, 10db serves no app there: it says so, and you compare by reading the mock-up's HTML in your brief. The pictures go to your model and stay on this Mac otherwise.";
