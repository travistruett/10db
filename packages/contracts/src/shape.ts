import { z } from 'zod';
import { Headline, Title, Why } from './entities';
import { BriefKey, GoalBrief, GoalBriefTask } from './goals';
import {
  DecisionId,
  GoalId,
  ProjectId,
  ShapeFindingId,
  ShapeId,
  ShapeMessageId,
  TaskId,
} from './ids';
import { TopicKey } from './knowledge';
import { KnowledgeScope, PrincipleKind } from './states';
import { SeeScreenInput } from './shape-screens';

// Shape spec: docs/superpowers/specs/2026-11-02-10db-brainstorm-chat-design.md (§5.3, §5.5, §6, §13).
// Contracts only; the daemon module that runs a conversation comes in later tasks.

const Timestamp = z.iso.datetime();

type ValueOf<T> = T[keyof T];

// --- Vocabularies -------------------------------------------------------------------------------

export const ShapeState = {
  Listening: 'listening',
  Proposed: 'proposed',
  Converted: 'converted',
} as const;
export type ShapeState = ValueOf<typeof ShapeState>;

/** Where a conversation began: the app, or a builder's Claude Code session (`start_shape`, §5.6). */
export const ShapeOrigin = { App: 'app', ClaudeCode: 'claude_code' } as const;
export type ShapeOrigin = ValueOf<typeof ShapeOrigin>;

export const ShapeMessageAuthor = { Builder: 'builder', Claude: 'claude', Note: 'note' } as const;
export type ShapeMessageAuthor = ValueOf<typeof ShapeMessageAuthor>;

/**
 * What a transcript row is (§5.3). `propose`, `edit` and `digest` notes can't be cited as a
 * proposal's source; an `event` note (an engine event reopening the conversation, §12) can.
 */
export const ShapeMessageKind = {
  Text: 'text',
  Tool: 'tool',
  Propose: 'propose',
  /** The note that starts a rehearsal turn (§7); like Propose it can't be cited as a source. */
  Rehearse: 'rehearse',
  Edit: 'edit',
  Digest: 'digest',
  Event: 'event',
  Notice: 'notice',
  /** A screenshot the session took with `see_screen` (§5.5); its body is a ScreenMessageBody. */
  Screen: 'screen',
} as const;
export type ShapeMessageKind = ValueOf<typeof ShapeMessageKind>;

/** A `shape_proposals` row's kind (§6 Rows); a `task` with a `goalId` is an addition. */
export const ShapeProposalKind = {
  Goal: 'goal',
  Task: 'task',
  ChangeTask: 'change_task',
  RemoveTask: 'remove_task',
  Decision: 'decision',
  Principle: 'principle',
  Question: 'question',
  Landing: 'landing',
} as const;
export type ShapeProposalKind = ValueOf<typeof ShapeProposalKind>;

export const ShapeProposalState = {
  Pending: 'pending',
  Superseded: 'superseded',
  Rejected: 'rejected',
  Accepted: 'accepted',
} as const;
export type ShapeProposalState = ValueOf<typeof ShapeProposalState>;

/** How much review an effort gets before Convert (§7). */
export const Ceremony = { Direct: 'direct', Spec: 'spec' } as const;
export type Ceremony = ValueOf<typeof Ceremony>;

/** Lane-time buckets (§8): S under 1 h, M 1–3 h, L 3–8 h, XL over 8 h. */
export const TaskSize = { S: 'S', M: 'M', L: 'L', XL: 'XL' } as const;
export type TaskSize = ValueOf<typeof TaskSize>;

/** The same vocabulary as the knowledge scope, kept in one place (`states.ts`). */
export const RecordScope = KnowledgeScope;
export type RecordScope = KnowledgeScope;

// --- PlanDraft (§6) -----------------------------------------------------------------------------

/**
 * The builder's messages (or an engine-event note) a proposal came from. Absent keeps the row's
 * stored ids, so a resumed session never restates ids it can no longer see.
 */
const SourceMessageIds = z.array(ShapeMessageId).min(1).optional();

/** Reserved for later annotation kinds; empty until one exists. */
const Annotations = z.array(z.json()).max(0).default([]);

/** A task's size: finished tasks it resembles (`basis`), or a bucket when there are none (§8). */
const sizing = {
  basis: z.array(TaskId).min(1).optional(),
  size: z.enum(TaskSize).optional(),
};

function oneSizing(task: { basis?: unknown; size?: unknown }): boolean {
  return (task.basis === undefined) !== (task.size === undefined);
}
const ONE_SIZING = { message: 'Give either basis or size, not both and not neither' };

export const PlanGoalTask = GoalBriefTask.extend({
  ...sizing,
  annotations: Annotations,
  /** Task keys outside this goal: a loose task, another goal's task or one already converted. */
  dependsOnOutside: z.array(BriefKey).default([]),
  sourceMessageIds: SourceMessageIds,
}).refine(oneSizing, ONE_SIZING);
export type PlanGoalTask = z.infer<typeof PlanGoalTask>;

/** A goal's proposed eval: a north-star objective, baseline criteria, the models under test, constraints. */
export const PlanEval = z.object({
  objective: z.string().min(1),
  baseline: z.array(z.string().min(1)).default([]),
  models: z.array(z.string().min(1)).default([]),
  constraints: z.array(z.string().min(1)).default([]),
});
export type PlanEval = z.infer<typeof PlanEval>;

export const PlanGoal = GoalBrief.extend({
  key: BriefKey,
  ceremony: z.enum(Ceremony),
  eval: PlanEval.optional(),
  tasks: z.array(PlanGoalTask).min(1),
  sourceMessageIds: SourceMessageIds,
});
export type PlanGoal = z.infer<typeof PlanGoal>;

const looseTaskFields = {
  key: BriefKey,
  title: Title,
  headline: Headline.default(''),
  why: Why.default(''),
  description: z.string().default(''),
  criteria: z.array(z.string().min(1)).default([]),
  areas: z.array(z.string().min(1)).min(1),
  ...sizing,
  ceremony: z.enum(Ceremony),
  /** Keys of any task in the draft, or of a task this conversation already converted. */
  dependsOn: z.array(BriefKey).default([]),
  annotations: Annotations,
  sourceMessageIds: SourceMessageIds,
};

export const PlanLooseTask = z.object(looseTaskFields).refine(oneSizing, ONE_SIZING);
export type PlanLooseTask = z.infer<typeof PlanLooseTask>;

/** A task added under a goal this conversation already converted. */
export const PlanAddition = z
  .object({ ...looseTaskFields, goalId: GoalId })
  .refine(oneSizing, ONE_SIZING);
export type PlanAddition = z.infer<typeof PlanAddition>;

/** Proposal keys that land together in one pull request (§10.4). */
export const PlanLanding = z.object({
  key: BriefKey,
  title: Title,
  keys: z.array(BriefKey).min(1),
  sourceMessageIds: SourceMessageIds,
});
export type PlanLanding = z.infer<typeof PlanLanding>;

const recordFields = {
  key: BriefKey,
  scope: z.enum(RecordScope),
  /** The area of an `area` record; absent for the others. */
  area: z.string().min(1).optional(),
  /** A current decision this record replaces. */
  supersedes: DecisionId.optional(),
  sourceMessageIds: SourceMessageIds,
};
const areaMatchesScope = (r: { scope: RecordScope; area?: string | undefined }): boolean =>
  (r.scope === RecordScope.Area) === (r.area !== undefined);
const AREA_SCOPE = { message: 'An area record names its area; no other record does' };

export const PlanDecisionRecord = z
  .object({
    ...recordFields,
    kind: z.literal('decision'),
    question: z.string().min(1),
    choice: z.string().min(1),
    rationale: z.string().min(1),
  })
  .refine(areaMatchesScope, AREA_SCOPE);

export const PlanPrincipleRecord = z
  .object({
    ...recordFields,
    kind: z.literal('principle'),
    statement: z.string().min(1),
    rationale: z.string().min(1),
    /** `policy`, `heuristic` or `belief`; Convert gives a record that names none `policy`. */
    principleKind: z.enum(PrincipleKind).optional(),
    /** The key the principle replaces the current one by; Convert makes one from the statement when absent. */
    topicKey: TopicKey.optional(),
  })
  .refine(areaMatchesScope, AREA_SCOPE);
export type PlanPrincipleRecord = z.infer<typeof PlanPrincipleRecord>;

export const PlanRecord = z.discriminatedUnion('kind', [PlanDecisionRecord, PlanPrincipleRecord]);
export type PlanRecord = z.infer<typeof PlanRecord>;

export const PlanQuestion = z.object({
  key: BriefKey,
  text: z.string().min(1),
  /** A role or a person. */
  for: z.string().min(1),
  /** The key of the goal or task the question belongs to; Convert stores it under that goal or task. */
  about: BriefKey.optional(),
  sourceMessageIds: SourceMessageIds,
});
export type PlanQuestion = z.infer<typeof PlanQuestion>;

/** New fields for a task this conversation converted that hasn't started; keyed `change:<taskId>`. */
export const PlanChange = z
  .object({
    taskId: TaskId,
    title: Title.optional(),
    description: z.string().optional(),
    acceptanceCriteria: z.array(z.string().min(1)).optional(),
    areas: z.array(z.string().min(1)).min(1).optional(),
    dependsOn: z.array(BriefKey).optional(),
    sourceMessageIds: SourceMessageIds,
  })
  .refine(
    (c) =>
      [c.title, c.description, c.acceptanceCriteria, c.areas, c.dependsOn].some(
        (f) => f !== undefined,
      ),
    { message: 'A change sets at least one field' },
  );
export type PlanChange = z.infer<typeof PlanChange>;

/** Removing a task this conversation converted that hasn't started; keyed `remove:<taskId>`. */
export const PlanRemoval = z.object({
  taskId: TaskId,
  why: z.string().min(1),
  sourceMessageIds: SourceMessageIds,
});
export type PlanRemoval = z.infer<typeof PlanRemoval>;

/**
 * The whole plan as one `propose_plan` call states it (§6). Shape only: the daemon checks the
 * rules that need the conversation and the project (keys, cycles, areas, bases, caps) on the
 * merged result.
 */
export const PlanDraft = z.object({
  goals: z.array(PlanGoal).default([]),
  looseTasks: z.array(PlanLooseTask).default([]),
  landings: z.array(PlanLanding).default([]),
  records: z.array(PlanRecord).default([]),
  questions: z.array(PlanQuestion).default([]),
  additions: z.array(PlanAddition).default([]),
  changes: z.array(PlanChange).default([]),
  removals: z.array(PlanRemoval).default([]),
});
export type PlanDraft = z.infer<typeof PlanDraft>;

/** The JSON body of a `shape_proposals` row, by its kind; parsed on read. */
export const ShapeProposalBody = {
  goal: PlanGoal,
  task: z.object({ ...looseTaskFields, goalId: GoalId.optional() }).refine(oneSizing, ONE_SIZING),
  change_task: PlanChange,
  remove_task: PlanRemoval,
  decision: PlanDecisionRecord,
  principle: PlanPrincipleRecord,
  question: PlanQuestion,
  landing: PlanLanding,
} as const satisfies Record<ShapeProposalKind, z.ZodType>;

// --- The conversation (§5.3, §13) ---------------------------------------------------------------

export const ShapeDto = z.object({
  id: ShapeId,
  projectId: ProjectId,
  title: z.string(),
  state: z.enum(ShapeState),
  origin: z.enum(ShapeOrigin),
  /** Set by the builder's first Propose, for good; `propose_plan` is refused until then. */
  proposeUnlocked: z.boolean(),
  /** The last reconciled round; 0 before the first proposal. */
  round: z.int().min(0),
  /** The model alias the builder chose for the conversation; null runs it on the `plan` role's. */
  model: z.string().nullable().default(null),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type ShapeDto = z.infer<typeof ShapeDto>;

/** A model the builder may choose for a conversation (Shape spec §5.1). */
export const ShapeModelAlias = z.string().regex(/^[a-z]+$/);

/** `PUT /shapes/:id/model`: the model alias to run the conversation on, or null for the `plan` role's. */
export const ShapeModelInput = z.strictObject({ model: ShapeModelAlias.nullable() });
export type ShapeModelInput = z.infer<typeof ShapeModelInput>;

export const ShapeMessageDto = z.object({
  id: ShapeMessageId,
  shapeId: ShapeId,
  author: z.enum(ShapeMessageAuthor),
  kind: z.enum(ShapeMessageKind),
  body: z.string(),
  createdAt: Timestamp,
});
export type ShapeMessageDto = z.infer<typeof ShapeMessageDto>;

// --- The Shape MCP tools (§5.5) -----------------------------------------------------------------

export const ShapeToolName = {
  NoteHeard: 'note_heard',
  SimilarTasks: 'similar_tasks',
  ProposePlan: 'propose_plan',
  Attach: 'attach',
  WriteSpec: 'write_spec',
  ReportFinding: 'report_finding',
  ResolveFinding: 'resolve_finding',
  FindRecords: 'find_records',
  SeeScreen: 'see_screen',
} as const;
export type ShapeToolName = ValueOf<typeof ShapeToolName>;

/** Keys that make a Vega-Lite spec load something; a chart carries its data inline only (§10.3). */
const URL_BEARING_KEYS = new Set(['url', 'href', 'src', 'srcset', 'background']);

function hasUrlKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasUrlKey);
  if (value === null || typeof value !== 'object') return false;
  return Object.entries(value).some(
    ([key, inner]) => URL_BEARING_KEYS.has(key) || hasUrlKey(inner),
  );
}

/** A Vega-Lite spec whose data is `data.values` and which names no URL anywhere. */
export const ChartSpec = z
  .record(z.string(), z.json())
  .refine((spec) => !hasUrlKey(spec), { message: 'A chart loads nothing: no url or href' })
  .refine(
    (spec) => {
      const data = spec['data'];
      return (
        data !== null &&
        typeof data === 'object' &&
        !Array.isArray(data) &&
        Array.isArray(data['values'])
      );
    },
    { message: 'A chart carries its data inline in data.values' },
  );

export const ShapeAttachment = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('mermaid'), source: z.string().min(1) }),
  z.object({ kind: z.literal('chart'), spec: ChartSpec }),
  z.object({ kind: z.literal('mockup'), html: z.string().min(1) }),
]);
export type ShapeAttachment = z.infer<typeof ShapeAttachment>;

/** What an attachment hangs on: a proposal by key, or a goal or task already converted. */
export const ShapeAttachTarget = z.union([
  z.object({ key: BriefKey }),
  z.object({ goalId: GoalId }),
  z.object({ taskId: TaskId }),
]);
export type ShapeAttachTarget = z.infer<typeof ShapeAttachTarget>;

export const ShapeFindingSeverity = { Low: 'low', Medium: 'medium', High: 'high' } as const;
export type ShapeFindingSeverity = ValueOf<typeof ShapeFindingSeverity>;

/** The reviewers a Shape session may launch with `Agent` (§7). */
export const ShapeReviewer = {
  Scope: 'scope',
  Engineering: 'engineering',
  Rehearsal: 'rehearsal',
} as const;
export type ShapeReviewer = ValueOf<typeof ShapeReviewer>;

/** A finding is open until the session resolves it or the builder dismisses it (§7). */
export const ShapeFindingState = {
  Open: 'open',
  Resolved: 'resolved',
  Dismissed: 'dismissed',
} as const;
export type ShapeFindingState = ValueOf<typeof ShapeFindingState>;

/** A `finding` is a review comment; a `question` is what the rehearsal's implementer would have to ask. */
export const ShapeFindingKind = { Finding: 'finding', Question: 'question' } as const;
export type ShapeFindingKind = ValueOf<typeof ShapeFindingKind>;

/** A reviewer's report; `none` is a rehearsal with nothing to ask, which still marks the task read. */
export const ShapeFindingReport = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('finding'),
    severity: z.enum(ShapeFindingSeverity),
    text: z.string().min(1),
  }),
  z.object({ kind: z.literal('question'), text: z.string().min(1) }),
  z.object({ kind: z.literal('none') }),
]);
export type ShapeFindingReport = z.infer<typeof ShapeFindingReport>;

/** A one-line `how`, as the sidebar shows it. */
const HowResolved = z.string().min(1).max(200);

export const ShapeToolInputs = {
  note_heard: z.object({ items: z.array(z.string().min(1).max(80)).max(12) }),
  similar_tasks: z.object({ query: z.string().min(1) }),
  propose_plan: z.object({ draft: PlanDraft }),
  attach: z.object({ target: ShapeAttachTarget, attachment: ShapeAttachment }),
  write_spec: z.object({ effortKey: BriefKey, markdown: z.string().min(1) }),
  report_finding: z.object({
    effortKey: BriefKey,
    taskKey: BriefKey.optional(),
    /** The hash the rehearsal note listed the task at; a mark at a stale hash is discarded. */
    taskHash: z.string().min(1).optional(),
    /**
     * The rehearsal's closing report: the questions reported so far were all of them. A `none` closes
     * the rehearsal too. The task is marked read only on a closing report.
     */
    final: z.boolean().optional(),
    /** Set by 10db's PreToolUse hook from the subagent's type, over whatever the model wrote. */
    reviewer: z.enum(ShapeReviewer).optional(),
    finding: ShapeFindingReport,
  }),
  resolve_finding: z.object({ findingId: ShapeFindingId, how: HowResolved }),
  find_records: z.object({ query: z.string().min(1) }),
  see_screen: SeeScreenInput,
} as const satisfies Record<ShapeToolName, z.ZodType>;
