import { z } from 'zod';
import { Notice } from './entities';
import { ProjectId, TaskId } from './ids';

/** Rows on one Activity page when the query names no size. */
export const ACTIVITY_PAGE_SIZE = 50;
/** The most rows one Activity page may ask for. */
export const ACTIVITY_PAGE_SIZE_MAX = 100;
/** Identical notices with one key inside this window show as one Activity row with a count. */
export const ACTIVITY_GROUP_WINDOW_MS = 10 * 60_000;

/** The entity a notice.posted event is filed under: its task, else its project, else the app. */
export const NoticeEntity = { Task: 'task', Project: 'project', App: 'app' } as const;
export type NoticeEntity = (typeof NoticeEntity)[keyof typeof NoticeEntity];

/** The entity id of a notice that belongs to no project or task. */
export const APP_ENTITY_ID = 'app';

/** What a notice.posted event holds: a notice that asks the builder nothing, and where it was posted. */
export const NoticePostedData = z.strictObject({
  projectId: ProjectId.nullable(),
  taskId: TaskId.nullable(),
  key: Notice.shape.key,
  tone: Notice.shape.tone,
  line: Notice.shape.line,
  body: Notice.shape.body,
});
export type NoticePostedData = z.infer<typeof NoticePostedData>;

/** `GET /activity`: filters and the cursor for one page of notices, newest first. */
export const ActivityPageQuery = z
  .strictObject({
    project: ProjectId.optional(),
    task: TaskId.optional(),
    /** Matches the line or the body; case-insensitive for ASCII. */
    q: z.string().trim().min(1).max(200).optional(),
    /** The previous page's `next`: only events with a lower seq are returned. */
    after: z.coerce.number().int().positive().optional(),
    pageSize: z.coerce
      .number()
      .int()
      .min(1)
      .max(ACTIVITY_PAGE_SIZE_MAX)
      .default(ACTIVITY_PAGE_SIZE),
  })
  .refine((q) => q.project === undefined || q.task === undefined, {
    message: 'project or task, not both',
  });
export type ActivityPageQuery = z.infer<typeof ActivityPageQuery>;

/** One Activity row: a notice, or the identical notices of one key folded into it. */
export const ActivityRow = NoticePostedData.extend({
  /** The newest grouped notice's event seq: the row's key. */
  seq: z.int().positive(),
  /** The newest grouped notice's time. */
  at: z.iso.datetime(),
  /** The oldest grouped notice's time. */
  firstAt: z.iso.datetime(),
  count: z.int().min(1),
});
export type ActivityRow = z.infer<typeof ActivityRow>;

/** One page of Activity; `next` is the cursor for the following page, null at the end. */
export const ActivityPageDto = z.object({
  rows: z.array(ActivityRow),
  next: z.int().positive().nullable(),
});
export type ActivityPageDto = z.infer<typeof ActivityPageDto>;
