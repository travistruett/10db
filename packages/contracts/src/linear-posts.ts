import { z } from 'zod';
import { ExternalLink } from './external';
import { LinearPostId, SessionId, TaskId } from './ids';

/** The moments of a task's life that the Linear reporter writes about. */
export const LinearEventKind = {
  RunStarted: 'run_started',
  Waiting: 'waiting',
  Verdict: 'verdict',
  Ended: 'ended',
  PrOpened: 'pr_opened',
  PrMerged: 'pr_merged',
  /** The work landed on its base branch with no pull request, as a Commit Directly copy does. */
  Landed: 'landed',
} as const;
export type LinearEventKind = (typeof LinearEventKind)[keyof typeof LinearEventKind];

/** The patterns 10db itself withholds an update for, apart from the guard's secret patterns. */
export const LinearWithheldPattern = {
  /** The update's detail lacks what its post needs, such as a pull request url. */
  NothingToReport: 'nothing to report',
} as const;
export type LinearWithheldPattern =
  (typeof LinearWithheldPattern)[keyof typeof LinearWithheldPattern];

export const LinearPostState = {
  Pending: 'pending',
  Recorded: 'recorded',
  Withheld: 'withheld',
  Failed: 'failed',
} as const;
export type LinearPostState = (typeof LinearPostState)[keyof typeof LinearPostState];

/** One update the reporter owes, or has made, on a task's Linear issue. */
export const LinearPostDto = z.strictObject({
  id: LinearPostId,
  taskId: TaskId,
  event: z.enum(LinearEventKind),
  attempt: z.number().int().min(1),
  /** What the event was: the verdict, the end state, the PR url, the landed base branch and commit, the Inbox card's title. */
  detail: z.record(z.string(), z.json()),
  state: z.enum(LinearPostState),
  tries: z.number().int().min(0),
  dueAt: z.iso.datetime().nullable(),
  lastError: z.string().nullable(),
  withheldPattern: z.string().nullable(),
  sessionId: SessionId.nullable(),
  commentIds: z.array(z.string()),
  statusSet: z.string().nullable(),
  attachmentUrl: z.string().nullable(),
  dismissedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  recordedAt: z.iso.datetime().nullable(),
});
export type LinearPostDto = z.infer<typeof LinearPostDto>;

/**
 * A task's Linear issue and the updates made for it. A follow-up of a linked task reports to that task's issue,
 * so its link is the source's and `followUpOf` names the source; its `posts` are its own rows only.
 */
export const TaskLinearDto = z.strictObject({
  link: ExternalLink.nullable(),
  followUpOf: z.strictObject({ id: TaskId, title: z.string() }).nullable(),
  posts: z.array(LinearPostDto),
});
export type TaskLinearDto = z.infer<typeof TaskLinearDto>;

/** `linear-reporter.<projectId>` in app_settings; absent reads as { on: true, note: '' }; a malformed value reads as off. */
export const LinearReporterSettings = z.strictObject({
  on: z.boolean(),
  note: z.string().max(4000),
});
export type LinearReporterSettings = z.infer<typeof LinearReporterSettings>;

/** The longest comment body the reporter's agent may hand 10db for one post. */
export const MAX_COMMENT_BODY_CHARS = 10_000;

/**
 * What the reporter's agent hands 10db for one owed update: the comment's body and nothing else (10db adds the
 * footer, writes the comment and records its id), or that the update has nothing to report. Exactly one of the
 * two is given; the daemon checks it, so the tool's schema stays a plain object.
 */
/** The type Linear gives every workflow status of a team. */
export const LinearStatusType = {
  Triage: 'triage',
  Backlog: 'backlog',
  Unstarted: 'unstarted',
  Started: 'started',
  Completed: 'completed',
  Canceled: 'canceled',
} as const;
export type LinearStatusType = (typeof LinearStatusType)[keyof typeof LinearStatusType];

/** One of a team's statuses, as Linear's `list_issue_statuses` shows it. */
export const LinearTeamStatus = z.strictObject({
  name: z.string().min(1).max(200),
  type: z.enum(LinearStatusType),
  position: z.number(),
});
export type LinearTeamStatus = z.infer<typeof LinearTeamStatus>;

/** What the reporter reads from Linear for one owed update, so 10db can pick the status move. */
export const PickLinearStatusInput = z.strictObject({
  postId: LinearPostId,
  /** The issue's own status now. */
  current: LinearTeamStatus,
  /** Every status of the issue's team. */
  statuses: z.array(LinearTeamStatus).min(1).max(100),
});
export type PickLinearStatusInput = z.infer<typeof PickLinearStatusInput>;

export const ReportLinearPostInput = z.strictObject({
  postId: LinearPostId,
  body: z.string().max(MAX_COMMENT_BODY_CHARS).optional(),
  nothingToReport: z.boolean().optional(),
});
export type ReportLinearPostInput = z.infer<typeof ReportLinearPostInput>;

/** How a pending row ends when 10db settles it: its comment written, or the text withheld. */
export type LinearPostOutcome =
  | {
      readonly state: 'recorded';
      readonly commentIds: readonly string[];
      readonly statusSet: string | null;
      readonly attachmentUrl: string | null;
    }
  | { readonly state: 'withheld'; readonly pattern: string };
