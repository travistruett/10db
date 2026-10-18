import { z } from 'zod';
import { InboxOption } from './entities';
import { HandoffDto, HandoffInput } from './handoff';
import {
  ClaimId,
  DecisionId,
  DeviationId,
  EvidenceId,
  HandoffId,
  InboxItemId,
  ProposalId,
  WorkstreamId,
} from './ids';
import { ClaimKind, ProposalKind, QuestionCategory, Severity, Urgency, Verdict } from './states';
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
  RequestClaim: 'request_claim',
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
});
export type KnowledgeHit = z.infer<typeof KnowledgeHit>;

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
    decisions: z.array(KnowledgeHit),
    budgetUsed: z.int(),
    droppedCount: z.int(),
    empty: z.boolean(),
  }),
});
export type ContextPack = z.infer<typeof ContextPack>;

export const McpToolInputs = {
  get_context: z.object({}),
  find_knowledge: z.object({ query: z.string().min(1), limit: z.int().min(1).max(20).default(5) }),
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
  }),
  report_deviation: z.object({
    opId: OpId,
    cause: z.string().min(1),
    severity: z.enum(Severity),
    reason: z.string().min(1),
  }),
  request_claim: z.object({
    opId: OpId,
    kind: z.enum(ClaimKind),
    name: z.string().min(1),
    reason: z.string().min(1),
  }),
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
  }),
} as const satisfies Record<McpToolName, z.ZodType>;

export const McpToolOutputs = {
  get_context: ContextPack,
  find_knowledge: z.object({ results: z.array(KnowledgeHit), empty: z.boolean() }),
  ask_human: z.object({ inboxId: InboxItemId, answer: z.string(), note: z.string().nullable() }),
  record_decision: z.object({ decisionId: DecisionId }),
  propose: z.object({ proposalId: ProposalId }),
  report_deviation: z.object({ deviationId: DeviationId }),
  request_claim: z.discriminatedUnion('granted', [
    z.object({ granted: z.literal(true), claimId: ClaimId }),
    z.object({ granted: z.literal(false), heldBy: WorkstreamId.nullable(), inboxId: InboxItemId }),
  ]),
  commit: z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/), alreadyCommitted: z.boolean() }),
  record_evidence: z.object({ evidenceId: EvidenceId }),
  write_handoff: z.object({ handoffId: HandoffId, instruction: z.string() }),
  complete_step: z.object({ instruction: z.string() }),
} as const satisfies Record<McpToolName, z.ZodType>;
