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

/** `GET /tasks/:taskId/design-checks`: the task's newest check, for its drawer. */
export const TaskDesignCheckDto = z.object({
  taskId: TaskId,
  newest: DesignCheckDto.nullable(),
});
export type TaskDesignCheckDto = z.infer<typeof TaskDesignCheckDto>;
