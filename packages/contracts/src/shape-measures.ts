import { z } from 'zod';
import { DecisionId, ShapeProposalId, TaskId } from './ids';
import { JudgeDecision } from './judge';
import { TaskSize } from './shape';

// Shape spec docs/superpowers/specs/2026-11-02-10db-brainstorm-chat-design.md §8 (sizes, lane time and
// calibration), §5.5 (find_records) and §9 (Jev's decisions, the opt-in and shadow scoring).

/**
 * Where a task's size came from: its basis tasks' lane time, Claude's bucket when it named none, or
 * the builder's pinned bucket ("size set by you"), which wins and is never counted in the measure.
 */
export const SizeSource = { Basis: 'basis', Size: 'size', Pinned: 'pinned' } as const;
export type SizeSource = (typeof SizeSource)[keyof typeof SizeSource];

/** One proposed task's derived size, with what it took once converted and finished. */
export const ShapeTaskSizeDto = z.object({
  proposalId: ShapeProposalId,
  /** The task's key: the proposal's own for a loose task, the goal task's for a goal. */
  key: z.string(),
  size: z.enum(TaskSize),
  /** Lane hours: the basis's median, or the bucket's median over finished tasks (its midpoint below 10). */
  hours: z.number().min(0),
  from: z.enum(SizeSource),
  /** The task Convert made of it; null while it is a proposal. */
  taskId: TaskId.nullable(),
  /** Lane hours the converted task took once finished; null until then, or when it has none recorded. */
  actualHours: z.number().min(0).nullable(),
  /** The actual is more than one bucket away from the size, either way. */
  missized: z.boolean(),
});
export type ShapeTaskSizeDto = z.infer<typeof ShapeTaskSizeDto>;

const Rate = z.object({
  /** Finished converted tasks measured. */
  n: z.int().min(0),
  /** Of them, those whose derived size is within one bucket of their lane time. */
  within: z.int().min(0),
});

/** Settings › Decisions › Sizing (§8 Calibration). */
export const SizingMeasureDto = Rate.extend({
  /** The same, by derived size. */
  buckets: z.object({ S: Rate, M: Rate, L: Rate, XL: Rate }),
  /** Finished converted tasks whose size the builder pinned: reported beside the share, never in it. */
  overrides: z.int().min(0),
});
export type SizingMeasureDto = z.infer<typeof SizingMeasureDto>;

export const SHAPE_JUDGE_DECISIONS = [
  JudgeDecision.ShapeReady,
  JudgeDecision.ShapeRecord,
  JudgeDecision.ShapeElsewhere,
] as const;
export type ShapeJudgeDecision = (typeof SHAPE_JUDGE_DECISIONS)[number];

/** How many scored answers, at what agreement, a shadow decision needs before it can show (§9). */
export const SHADOW_MIN_SCORED = 20;
export const SHADOW_MIN_AGREEMENT = 0.75;

/** One Shape decision's shadow answers and how many agreed with what happened. */
export const ShadowAgreementDto = z.object({
  decision: z.enum(SHAPE_JUDGE_DECISIONS),
  /** Answers the model gave, at or above the decision's floor. */
  answered: z.int().min(0),
  /** Of them, those whose outcome is known. */
  scored: z.int().min(0),
  agreed: z.int().min(0),
  /** Scored at least 20 times with at least 75% agreeing: it may be switched to showing. */
  canShow: z.boolean(),
});
export type ShadowAgreementDto = z.infer<typeof ShadowAgreementDto>;

/** Tasks that started, and the Inbox question cards raised on their workstreams. */
const QuestionRate = z.object({ tasks: z.int().min(0), cards: z.int().min(0) });

/**
 * Settings › Decisions › Questions (§7 Measure): Inbox question cards per task that a Shape
 * conversation converted, against the rate for the other tasks of the same projects. Only tasks that
 * started count, since a card needs a workstream to land on.
 */
export const QuestionMeasureDto = z.object({
  converted: QuestionRate,
  other: QuestionRate,
});
export type QuestionMeasureDto = z.infer<typeof QuestionMeasureDto>;

/** `GET /shape-measures`: what Settings › Decisions shows of Shape. */
export const ShapeMeasuresDto = z.object({
  sizing: SizingMeasureDto,
  questions: QuestionMeasureDto,
  shadow: z.array(ShadowAgreementDto),
});
export type ShapeMeasuresDto = z.infer<typeof ShapeMeasuresDto>;

/** A project's "Send brainstorm messages to fast models"; off by default (§9). */
export const ShapeJevSettingDto = z.object({ enabled: z.boolean() });
export type ShapeJevSettingDto = z.infer<typeof ShapeJevSettingDto>;

/** One `find_records` hit: a current decision with the date it was made (§5.5). */
export const RecordHit = z.object({
  kind: z.literal('decision'),
  id: DecisionId,
  question: z.string(),
  choice: z.string(),
  rationale: z.string(),
  /** `you` for a builder-wide decision, else `project` or `area`. */
  scope: z.string(),
  createdAt: z.iso.datetime(),
});
export type RecordHit = z.infer<typeof RecordHit>;
