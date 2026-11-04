import { z } from 'zod';
import { InboxOption, Title } from './entities';
import { HandoffDto, HandoffInput } from './handoff';
import {
  ClaimId,
  DecisionId,
  DeviationId,
  EvidenceId,
  HandoffId,
  InboxItemId,
  PrincipleId,
  ProposalId,
  TaskId,
  WorkstreamId,
} from './ids';
import { PrincipleDraft } from './knowledge';
import {
  ClaimKind,
  KnowledgeScope,
  PrincipleKind,
  ProposalKind,
  QuestionCategory,
  RiskTag,
  Severity,
  Urgency,
  Verdict,
} from './states';
import { MAX_STEP_SUMMARY } from './steps';

const OpId = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,100}$/)
  .describe('A unique ID for this call. Reuse it only when retrying the same call.');

export const McpToolName = {
  GetContext: 'get_context',
  FindKnowledge: 'find_knowledge',
  AskHuman: 'ask_human',
  RecordDecision: 'record_decision',
  Propose: 'propose',
  ReportDeviation: 'report_deviation',
  FileFollowUp: 'file_follow_up',
  RequestClaim: 'request_claim',
  InstallDependencies: 'install_dependencies',
  Commit: 'commit',
  RecordEvidence: 'record_evidence',
  WriteHandoff: 'write_handoff',
  CompleteStep: 'complete_step',
} as const;
export type McpToolName = (typeof McpToolName)[keyof typeof McpToolName];

export const KnowledgeHit = z.object({
  kind: z.literal('decision'),
  id: DecisionId,
  question: z.string(),
  choice: z.string(),
  rationale: z.string(),
  scope: z.enum(KnowledgeScope),
  area: z.string().nullable(),
});
export type KnowledgeHit = z.infer<typeof KnowledgeHit>;

export const PrincipleHit = z.object({
  kind: z.literal('principle'),
  id: PrincipleId,
  statement: z.string(),
  principleKind: z.enum(PrincipleKind),
  topicKey: z.string(),
  scope: z.enum(KnowledgeScope),
  area: z.string().nullable(),
});
export type PrincipleHit = z.infer<typeof PrincipleHit>;

/** Which shelf `find_knowledge` searches. */
export const KnowledgeKindFilter = {
  Any: 'any',
  Decision: 'decision',
  Principle: 'principle',
} as const;
export type KnowledgeKindFilter = (typeof KnowledgeKindFilter)[keyof typeof KnowledgeKindFilter];

export const ContextPack = z.object({
  task: z.object({
    title: z.string(),
    description: z.string(),
    acceptanceCriteria: z.array(z.string()),
  }),
  claims: z.array(z.object({ kind: z.enum(ClaimKind), name: z.string() })),
  handoff: HandoffDto.nullable(),
  pendingAnswer: z
    .object({ question: z.string(), answer: z.string(), note: z.string().nullable() })
    .nullable(),
  knowledge: z.object({
    policies: z.array(PrincipleHit),
    heuristics: z.array(PrincipleHit),
    decisions: z.array(KnowledgeHit),
    /** The budget in estimated tokens, and how much of it the shelves used (spec §9 `budget_used`). */
    budget: z.int(),
    budgetUsed: z.int(),
    /** What each shelf left out for want of room (spec §9 `dropped_count`, per shelf). */
    dropped: z.object({ policies: z.int(), heuristics: z.int(), decisions: z.int() }),
    droppedCount: z.int(),
    empty: z.boolean(),
  }),
});
export type ContextPack = z.infer<typeof ContextPack>;

/** Most follow-up tasks one step result may file. */
export const MAX_FOLLOW_UPS = 10;

/** A task a review step asks 10db to file: the rest (project, landing, areas, Icebox) comes from the task it reviews. */
export const FollowUpInput = z.object({
  title: Title.describe('The outcome, as what is true when it is done.'),
  description: z.string().min(1).describe('What you saw, where, and why it matters.'),
  acceptanceCriteria: z.array(z.string().min(1)).default([]),
});
export type FollowUpInput = z.infer<typeof FollowUpInput>;

/** A section an implementer left out of its task: the rest comes from the task it is working on. */
export const RemainingWorkInput = z.object({
  title: Title.describe('The outcome, as what is true when this remaining section is done.'),
  description: z
    .string()
    .min(1)
    .describe(
      'What is left to do, what this task already covers, and where the next session should start.',
    ),
  acceptanceCriteria: z
    .array(z.string().min(1))
    .default([])
    .describe('What must be true for this remaining section to count as done.'),
});
export type RemainingWorkInput = z.infer<typeof RemainingWorkInput>;

export const McpToolInputs = {
  get_context: z.object({}),
  find_knowledge: z.object({
    query: z.string().min(1),
    limit: z
      .int()
      .min(1)
      .max(20)
      .default(5)
      .describe('The most results per shelf: up to this many decisions and this many principles.'),
    kind: z
      .enum(KnowledgeKindFilter)
      .default(KnowledgeKindFilter.Any)
      .describe('Search only decisions, only principles, or both.'),
  }),
  ask_human: z.object({
    opId: OpId,
    category: z.enum(QuestionCategory),
    question: z.string().min(1).max(2000),
    options: z.array(InboxOption).min(2).max(4),
    recommendation: z.string().optional(),
    urgency: z.enum(Urgency).default(Urgency.Normal),
    consequences: z.string().optional(),
    affectedScope: z.string().optional(),
  }),
  record_decision: z.object({
    opId: OpId,
    question: z.string().min(1),
    choice: z.string().min(1),
    rationale: z.string().min(1),
    scope: z.enum(['project', 'area']),
    area: z.string().optional(),
  }),
  propose: z.object({
    opId: OpId,
    kind: z.enum(ProposalKind),
    title: z.string().min(1),
    body: z.string().min(1),
    /**
     * The risks the proposed work carries. A small new-task proposal with none is filed to the Icebox
     * without a card; one with a tag always raises a card.
     */
    riskTags: z.array(z.enum(RiskTag)).optional(),
    /** Set when the work must join a batch that is already running; a person decides that. */
    joinsRunningBatch: z.boolean().optional(),
    principle: PrincipleDraft.optional().describe(
      'For kind "principle": the rule itself. Without it, the body is used as the statement.',
    ),
  }),
  report_deviation: z.object({
    opId: OpId,
    cause: z.string().min(1),
    severity: z.enum(Severity),
    reason: z.string().min(1),
  }),
  file_follow_up: RemainingWorkInput.extend({ opId: OpId }),
  request_claim: z.object({
    opId: OpId,
    kind: z.enum(ClaimKind),
    name: z.string().min(1),
    reason: z.string().min(1),
  }),
  install_dependencies: z.object({ opId: OpId }),
  commit: z.object({
    opId: OpId,
    paths: z.array(z.string().min(1)).min(1).max(200),
    message: z.string().min(1).max(2000),
  }),
  record_evidence: z.object({
    opId: OpId,
    command: z.string().min(1),
    exitCode: z.int(),
    summary: z.string().min(1),
  }),
  write_handoff: HandoffInput.extend({ opId: OpId }),
  complete_step: z.object({
    opId: OpId,
    summary: z
      .string()
      .min(1)
      .max(MAX_STEP_SUMMARY)
      .describe('Your plan, or your findings as numbered notes.'),
    verdict: z
      .enum(Verdict)
      .nullable()
      .default(null)
      .describe('Required for plan_review, review and QA steps; null for a plan step.'),
    followUps: z
      .array(FollowUpInput)
      .max(MAX_FOLLOW_UPS)
      .default([])
      .describe(
        'Review, plan review and QA steps only: real problems that should not reject the work (on a later round, ones that are new and not caused by the fix). 10db files each as a task in the Icebox column and names it in your result.',
      ),
  }),
} as const satisfies Record<McpToolName, z.ZodType>;

export const McpToolOutputs = {
  get_context: ContextPack,
  find_knowledge: z.object({
    results: z.array(KnowledgeHit),
    /** Absent in a result recorded before principles were searchable. */
    principles: z.array(PrincipleHit).default([]),
    empty: z.boolean(),
  }),
  ask_human: z.object({ inboxId: InboxItemId, answer: z.string(), note: z.string().nullable() }),
  record_decision: z.object({ decisionId: DecisionId }),
  // A result recorded before self-filing or principles has neither id; it still parses.
  propose: z.object({
    proposalId: ProposalId,
    /** The task 10db filed to the Icebox by itself; null when a card was raised for a person. */
    taskId: TaskId.nullable().default(null),
    principleId: PrincipleId.nullable().default(null),
  }),
  report_deviation: z.object({ deviationId: DeviationId }),
  file_follow_up: z.object({ taskId: TaskId, title: z.string() }),
  request_claim: z.discriminatedUnion('granted', [
    z.object({ granted: z.literal(true), claimId: ClaimId }),
    z.object({
      granted: z.literal(false),
      /** The task holding the claim; null when no task does, as for a migrations hazard held back. */
      heldBy: WorkstreamId.nullable(),
      /** The card about it; null when the agent can fix the cause itself, as the instruction says. */
      inboxId: InboxItemId.nullable(),
      /**
       * True while the wait goes on: the call answers before the session's tool timeout and the agent
       * calls again with the same opId. False (or absent, in a result recorded before this field) for
       * a refusal: the builder made this task give up claims to end a claim deadlock, or the
       * migrations hazard is held back until the branch holds its base.
       */
      waiting: z.boolean().default(false),
      /** What to do next; null only in a result recorded by an older build. */
      instruction: z.string().nullable().default(null),
    }),
  ]),
  install_dependencies: z.object({
    /** True when the manifests are resolved, the lockfile is written and every package resolves. */
    installed: z.boolean(),
    /** The files the install changed in the copy (the lockfile among them), which the lane commits. */
    changed: z.array(z.string()).default([]),
    /** The install's log; null when nothing ran. */
    logPath: z.string().nullable().default(null),
    /** What to do next. */
    instruction: z.string(),
  }),
  commit: z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/), alreadyCommitted: z.boolean() }),
  record_evidence: z.object({ evidenceId: EvidenceId }),
  write_handoff: z.object({ handoffId: HandoffId, instruction: z.string() }),
  complete_step: z.object({
    instruction: z.string(),
    /** The tasks filed from `followUps`; absent in a result recorded before there were any. */
    followUps: z.array(z.object({ taskId: TaskId, title: z.string() })).default([]),
  }),
} as const satisfies Record<McpToolName, z.ZodType>;
