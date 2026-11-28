import { z } from 'zod';
import { CardDecider } from './card-decider';
import { Notice } from './entities';
import { AccountId, ProjectId, TaskId, WorkstreamId } from './ids';

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

/**
 * The rules whose decisions Activity shows, each with its stable key (what Ask Me Next Time names) and the name a
 * row gives it. A new rule that decides for the builder adds a key and a name here.
 */
export const DecisionRule = {
  StrayWrite: 'stray-write',
  FlakyCheck: 'flaky-check',
  MoveBack: 'move-back-after-limit',
  ClaimDeadlock: 'claim-deadlock',
  PlanReviewStep: 'plan-review-step',
  ProposalFiled: 'proposal-filed',
  PlanGoesAhead: 'plan-goes-ahead',
  MigrateAfterLanding: 'migrate-after-landing',
} as const;
export type DecisionRule = (typeof DecisionRule)[keyof typeof DecisionRule];

export const DECISION_RULE_NAMES: Record<DecisionRule, string> = {
  [DecisionRule.StrayWrite]: 'A write outside every claim, left to be committed',
  [DecisionRule.FlakyCheck]: 'A flaky check, rerun once',
  [DecisionRule.MoveBack]: 'A project moved back after its account’s limit reset',
  [DecisionRule.ClaimDeadlock]: 'A claim deadlock, ended by the later task yielding',
  [DecisionRule.PlanReviewStep]: 'A planner’s ask for review, run as a Plan Review step',
  [DecisionRule.ProposalFiled]: 'A lane’s proposal, filed as a task without a card',
  [DecisionRule.PlanGoesAhead]: 'A plan that needs nothing from you, built after its review',
  [DecisionRule.MigrateAfterLanding]: 'A landing’s migrations, applied to your dev database',
};

/** A move 10db can take back, with what the daemon needs to do it. */
export const UndoAction = z.discriminatedUnion('kind', [
  /** Moves a project to an account: the one it was on before 10db moved it. */
  z.strictObject({
    kind: z.literal('move_project'),
    projectId: ProjectId,
    accountId: AccountId,
  }),
  /** Forgets a claim deadlock's yield between two tasks, so their next deadlock counts as the first. */
  z.strictObject({
    kind: z.literal('forget_claim_deadlock'),
    a: WorkstreamId,
    b: WorkstreamId,
  }),
]);
export type UndoAction = z.infer<typeof UndoAction>;

/**
 * Who made a decision a notice reports, and whether it can be taken back. A decision that changed nothing, or
 * whose effect can't be reversed, is `final` and says why.
 */
export const NoticeDecision = z.strictObject({
  by: z.enum([CardDecider.Rule, CardDecider.Judge]),
  rule: z.enum(DecisionRule),
  /** The judge's confidence, 0 to 1; null for a rule. */
  confidence: z.number().min(0).max(1).nullable(),
  undo: z.discriminatedUnion('state', [
    z.strictObject({ state: z.literal('undoable'), action: UndoAction }),
    z.strictObject({ state: z.literal('final'), reason: z.string().min(1).max(200) }),
  ]),
});
export type NoticeDecision = z.infer<typeof NoticeDecision>;

/**
 * What a notice.posted event holds: a notice that asks the builder nothing, and where it was posted. A notice
 * that reports a decision 10db made for the builder carries it.
 */
export const NoticePostedData = z.strictObject({
  projectId: ProjectId.nullable(),
  taskId: TaskId.nullable(),
  key: Notice.shape.key,
  tone: Notice.shape.tone,
  line: Notice.shape.line,
  body: Notice.shape.body,
  decision: NoticeDecision.optional(),
});
export type NoticePostedData = z.infer<typeof NoticePostedData>;

/** `GET /activity/page`: filters and the cursor for one page of notices, newest first. */
export const ActivityPageQuery = z
  .strictObject({
    project: ProjectId.optional(),
    task: TaskId.optional(),
    /** Matches the line or the body; case-insensitive for ASCII. */
    q: z.string().trim().min(1).max(200).optional(),
    /** `true` keeps only what 10db decided for the builder, leaving out plain notices. */
    decided: z.literal('true').optional(),
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
  /** The decision's rule is set to ask for this row's project: its next occurrence is a card. */
  asking: z.boolean(),
  /** The row's decision was taken back, so Undo is no longer offered. */
  undone: z.boolean(),
});
export type ActivityRow = z.infer<typeof ActivityRow>;

/** The row an Undo or Ask Me Next Time names: the row's `seq`. */
export const ActivityRowRef = z.strictObject({ seq: z.int().positive() });
export type ActivityRowRef = z.infer<typeof ActivityRowRef>;

/** One page of Activity; `next` is the cursor for the following page, null at the end. */
export const ActivityPageDto = z.object({
  rows: z.array(ActivityRow),
  next: z.int().positive().nullable(),
});
export type ActivityPageDto = z.infer<typeof ActivityPageDto>;
