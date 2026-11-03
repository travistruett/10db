import { z } from 'zod';
import { AreaName } from './entities';
import {
  DecisionId,
  InboxItemId,
  PrincipleId,
  ProjectId,
  ProposalId,
  SessionId,
  SourceId,
  WorkstreamId,
} from './ids';
import {
  KnowledgeScope,
  KnowledgeState,
  PrincipleKind,
  PrincipleStatus,
  ProposalKind,
  ProposalStatus,
  SourceKind,
} from './states';

const Timestamp = z.iso.datetime();

export const TOPIC_KEY_MAX = 80;

/** The fixed key a principle supersedes by (spec §4): lowercase words joined by `.` or `-`. */
export const TopicKey = z
  .string()
  .max(TOPIC_KEY_MAX)
  .regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/, 'lowercase words joined by . or -');
export type TopicKey = z.infer<typeof TopicKey>;

/** FNV-1a over the text's UTF-16 code units: a short stable tag, not a security hash. */
function shortHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0').slice(0, 6);
}

/**
 * A topic key made from free text, whole words up to the limit; the builder can change it before
 * confirming. Text with no Latin letters or digits gets `untitled-` and a hash of the text, so two such
 * statements never share a key and the second never silently supersedes the first.
 */
export function topicKeyFrom(text: string): TopicKey {
  const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  let key = '';
  for (const word of words) {
    const next = key === '' ? word : `${key}-${word}`;
    if (next.length > TOPIC_KEY_MAX) {
      if (key === '') key = word.slice(0, TOPIC_KEY_MAX);
      break;
    }
    key = next;
  }
  return TopicKey.parse(key === '' ? `untitled-${shortHash(text.trim())}` : key);
}

/** Who a record applies to: the builder in every project, one project, or one area of a project. */
export const KnowledgeTarget = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal(KnowledgeScope.You) }),
  z.object({ scope: z.literal(KnowledgeScope.Project), projectId: ProjectId }),
  z.object({ scope: z.literal(KnowledgeScope.Area), projectId: ProjectId, area: AreaName }),
]);
export type KnowledgeTarget = z.infer<typeof KnowledgeTarget>;

export interface TargetColumns {
  readonly scope: KnowledgeScope;
  readonly projectId: ProjectId | null;
  readonly area: string | null;
}

/** The stored columns for a target. A `you` record has no project, so it applies in every project. */
export function targetColumns(target: KnowledgeTarget): TargetColumns {
  switch (target.scope) {
    case KnowledgeScope.You:
      return { scope: target.scope, projectId: null, area: null };
    case KnowledgeScope.Project:
      return { scope: target.scope, projectId: target.projectId, area: null };
    case KnowledgeScope.Area:
      return { scope: target.scope, projectId: target.projectId, area: target.area };
  }
}

export const DecisionInput = z.object({
  target: KnowledgeTarget,
  question: z.string().trim().min(1).max(2000),
  choice: z.string().trim().min(1).max(2000),
  rationale: z.string().trim().min(1).max(4000),
  /** The answered card this decision comes from; its provenance then points at the card. */
  fromInboxId: InboxItemId.optional(),
});
export type DecisionInput = z.infer<typeof DecisionInput>;

export const DecisionState = z.enum([
  KnowledgeState.Current,
  KnowledgeState.Superseded,
  KnowledgeState.Withdrawn,
]);
export type DecisionState = z.infer<typeof DecisionState>;

export const DecisionDto = z.object({
  id: DecisionId,
  projectId: ProjectId.nullable(),
  scope: z.enum(KnowledgeScope),
  area: z.string().nullable(),
  question: z.string(),
  choice: z.string(),
  rationale: z.string(),
  decidedBy: z.string(),
  supersedesId: DecisionId.nullable(),
  supersededById: DecisionId.nullable(),
  state: DecisionState,
  sourceId: SourceId,
  withdrawnAt: Timestamp.nullable(),
  withdrawnReason: z.string().nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type DecisionDto = z.infer<typeof DecisionDto>;

export const PrincipleStatement = z.string().trim().min(1).max(500);

const Quote = z.string().max(2000);
const Rationale = z.string().trim().min(1).max(2000);

/** What an agent, or 10db's answer detector, proposes; the builder picks the final scope. */
export const PrincipleDraft = z
  .object({
    statement: PrincipleStatement.describe('One rule, phrased as an instruction.'),
    kind: z
      .enum(PrincipleKind)
      .default(PrincipleKind.Heuristic)
      .describe('policy = must, heuristic = prefer, belief = context.'),
    topicKey: TopicKey.optional().describe(
      'A short stable key such as testing.no-sleeps; a later principle with the same key and scope replaces this one.',
    ),
    scope: z.enum(KnowledgeScope).default(KnowledgeScope.Project),
    area: AreaName.optional(),
    quote: Quote.optional().describe('The words this principle comes from, quoted exactly.'),
    rationale: Rationale.optional().describe('Why the rule holds, in a sentence.'),
  })
  .refine((d) => (d.scope === KnowledgeScope.Area) === (d.area !== undefined), {
    message: 'area is required for scope "area" and only allowed there',
    path: ['area'],
  });
export type PrincipleDraft = z.output<typeof PrincipleDraft>;

/** A principle the builder writes directly; it is confirmed at once. */
export const PrincipleInput = z.object({
  target: KnowledgeTarget,
  statement: PrincipleStatement,
  kind: z.enum(PrincipleKind),
  topicKey: TopicKey,
  quote: Quote.optional(),
  rationale: Rationale.optional(),
});
export type PrincipleInput = z.infer<typeof PrincipleInput>;

export const PrincipleDto = z.object({
  id: PrincipleId,
  projectId: ProjectId.nullable(),
  scope: z.enum(KnowledgeScope),
  area: z.string().nullable(),
  statement: z.string(),
  /** Why the rule holds; the Knowledge view shows it beside the statement. */
  rationale: z.string().nullable(),
  kind: z.enum(PrincipleKind),
  topicKey: z.string(),
  status: z.enum(PrincipleStatus),
  state: z.enum(KnowledgeState),
  supersedesId: PrincipleId.nullable(),
  supersededById: PrincipleId.nullable(),
  sourceId: SourceId,
  sourceQuote: z.string().nullable(),
  speaker: z.string().nullable(),
  confirmedBy: z.string().nullable(),
  confirmedAt: Timestamp.nullable(),
  retiredAt: Timestamp.nullable(),
  retiredReason: z.string().nullable(),
  withdrawnAt: Timestamp.nullable(),
  withdrawnReason: z.string().nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type PrincipleDto = z.infer<typeof PrincipleDto>;

/** Retiring or withdrawing a record needs a reason (spec §9: a withdrawn tombstone, never a silent delete). */
export const ReasonInput = z.object({ reason: z.string().trim().min(1).max(2000) });
export type ReasonInput = z.infer<typeof ReasonInput>;

export const ProposalDto = z.object({
  id: ProposalId,
  projectId: ProjectId,
  kind: z.enum(ProposalKind),
  title: z.string(),
  body: z.string(),
  status: z.enum(ProposalStatus),
  rationale: z.string().nullable(),
  /** The proposed principle, for a principle proposal. */
  principle: PrincipleDto.nullable(),
  sourceId: SourceId,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type ProposalDto = z.infer<typeof ProposalDto>;

/** Accepting a proposal; for a principle, any field given replaces the draft's before it is confirmed. */
export const ProposalAccept = z.object({
  target: KnowledgeTarget.optional(),
  statement: PrincipleStatement.optional(),
  kind: z.enum(PrincipleKind).optional(),
  topicKey: TopicKey.optional(),
  note: z.string().max(4000).optional(),
});
export type ProposalAccept = z.infer<typeof ProposalAccept>;

export const ProposalReject = z.object({ note: z.string().max(4000).optional() });
export type ProposalReject = z.infer<typeof ProposalReject>;

/** The source a confirmation, a retire or a withdrawal named: the tool, its session and the words. */
const ActionSource = z.object({
  via: z.string(),
  sessionId: z.string().nullable(),
  cwd: z.string().nullable(),
  quote: z.string().nullable(),
  recordedAt: Timestamp,
});

const Actor = z.object({
  at: Timestamp,
  by: z.string().nullable(),
  reason: z.string().nullable(),
  source: ActionSource.nullable(),
});

/** Where a record came from, resolved from its `sources` row (spec §9 provenance). */

export const ProvenanceDto = z.object({
  /** The record this answers for. */
  id: z.union([DecisionId, PrincipleId]),
  kind: z.enum(['decision', 'principle']),
  state: z.enum(KnowledgeState),
  sourceKind: z.enum(SourceKind),
  /** The `sources` row's own JSON, as stored. */
  sourceRef: z.record(z.string(), z.json()),
  /** For a source written through the builder API: the tool, its session and its working directory. */
  origin: z
    .object({
      via: z.string(),
      sessionId: z.string().nullable(),
      cwd: z.string().nullable(),
    })
    .nullable(),
  recordedAt: Timestamp,
  by: z.string(),
  /** The record this one replaced, and the one that replaced it. */
  supersedes: z.union([DecisionId, PrincipleId]).nullable(),
  supersededBy: z.union([DecisionId, PrincipleId]).nullable(),
  retired: Actor.nullable(),
  withdrawn: Actor.nullable(),
  inbox: z
    .object({
      id: InboxItemId,
      title: z.string(),
      choice: z.string().nullable(),
      note: z.string().nullable(),
    })
    .nullable(),
  session: z
    .object({ id: SessionId, workstreamId: WorkstreamId, taskTitle: z.string().nullable() })
    .nullable(),
  quote: z.string().nullable(),
  speaker: z.string().nullable(),
  confirmedBy: z.string().nullable(),
  confirmedAt: Timestamp.nullable(),
  confirmedSource: ActionSource.nullable(),
});
export type ProvenanceDto = z.infer<typeof ProvenanceDto>;

const Flag = z
  .enum(['0', '1'])
  .default('0')
  .transform((v) => v === '1');

/** The list routes' query string. `history` also returns superseded, retired, withdrawn and proposed records. */
export const KnowledgeQuery = z.object({
  projectId: ProjectId,
  scope: z.enum(KnowledgeScope).optional(),
  area: AreaName.optional(),
  kind: z.enum(PrincipleKind).optional(),
  q: z.string().trim().max(200).optional(),
  history: Flag,
});
export type KnowledgeQuery = z.output<typeof KnowledgeQuery>;

export const ProposalQuery = z.object({
  projectId: ProjectId,
  status: z.enum(ProposalStatus).default(ProposalStatus.Pending),
});
export type ProposalQuery = z.output<typeof ProposalQuery>;

/** The detail key of a "review this principle?" card. */
export const PRINCIPLE_REVIEW_DETAIL = 'principleReview';
