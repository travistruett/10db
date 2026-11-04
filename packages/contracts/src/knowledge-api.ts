import { z } from 'zod';
import { AreaName } from './entities';
import { ProjectId } from './ids';
import {
  DecisionDto,
  PrincipleDto,
  PrincipleStatement,
  ReasonInput,
  TopicKey,
  DecisionInput,
} from './knowledge';
import { SearchMatch } from './knowledge-search';
import { KnowledgeScope, PrincipleKind, ProposalStatus } from './states';

// The builder-facing knowledge routes (docs/knowledge-api.md): one list of a project's decisions and
// principles together, writes that name a place instead of a target object, dry runs and a source.

/** Where a write came from when it did not come from 10db's own screens, stored as a builder source. */
export const KnowledgeSource = z.strictObject({
  via: z.string().trim().min(1).max(60).describe('The tool that wrote it, such as claude_code.'),
  sessionId: z.string().trim().min(1).max(200).optional().describe("The tool's own session id."),
  cwd: z.string().trim().min(1).max(1000).optional(),
  quote: z.string().trim().min(1).max(2000).optional().describe("The builder's own words."),
});
export type KnowledgeSource = z.infer<typeof KnowledgeSource>;

/** What a list item is: a decision or a principle. */
export const KnowledgeItemKind = { Decision: 'decision', Principle: 'principle' } as const;
export type KnowledgeItemKind = (typeof KnowledgeItemKind)[keyof typeof KnowledgeItemKind];

/** A decision in the combined list: its `DecisionDto` and `kind: "decision"`. */
export const DecisionItem = DecisionDto.extend({ kind: z.literal(KnowledgeItemKind.Decision) });
export type DecisionItem = z.infer<typeof DecisionItem>;

/** A principle in the combined list: its `PrincipleDto` with `kind: "principle"`; its own kind is `principleKind`. */
export const PrincipleItem = PrincipleDto.omit({ kind: true }).extend({
  kind: z.literal(KnowledgeItemKind.Principle),
  principleKind: z.enum(PrincipleKind),
});
export type PrincipleItem = z.infer<typeof PrincipleItem>;

export const KnowledgeItemDto = z.discriminatedUnion('kind', [DecisionItem, PrincipleItem]);
export type KnowledgeItemDto = z.infer<typeof KnowledgeItemDto>;

/** What a dry run says would be written: the item without the id and source it would be given. */
export const KnowledgeDraftDto = z.discriminatedUnion('kind', [
  DecisionItem.omit({ id: true, sourceId: true }),
  PrincipleItem.omit({ id: true, sourceId: true }),
]);
export type KnowledgeDraftDto = z.infer<typeof KnowledgeDraftDto>;

export const KnowledgeDryRunDto = z.object({
  dryRun: z.literal(true),
  wouldWrite: KnowledgeDraftDto,
  /** The record the write would stop being current, as it is now; null when there is none. */
  replaces: KnowledgeItemDto.nullable(),
  /** The record a withdrawal would make current again, as it would then be; null when there is none. */
  restores: KnowledgeItemDto.nullable(),
});
export type KnowledgeDryRunDto = z.infer<typeof KnowledgeDryRunDto>;

export const KnowledgeSearchState = z.object({
  /** False when a search index could not be repaired at start; a list with `q` is then empty. */
  available: z.boolean(),
  message: z.string().nullable(),
});
export type KnowledgeSearchState = z.infer<typeof KnowledgeSearchState>;

export const KnowledgeListDto = z.object({
  items: z.array(KnowledgeItemDto),
  /** True when more matched than `limit`. */
  truncated: z.boolean(),
  search: KnowledgeSearchState,
});
export type KnowledgeListDto = z.infer<typeof KnowledgeListDto>;

/** `kind` filters the list: a kind of item, or a kind of principle (which leaves out decisions). */
export const KnowledgeListKind = z.enum([
  KnowledgeItemKind.Decision,
  KnowledgeItemKind.Principle,
  ...Object.values(PrincipleKind),
]);
export type KnowledgeListKind = z.infer<typeof KnowledgeListKind>;

export const KNOWLEDGE_LIST_LIMIT = 100;

/** The most `q` may hold, in UTF-16 code units (what zod's `max` counts), not characters. */
export const KNOWLEDGE_SEARCH_MAX_LENGTH = 200;

/**
 * `text` cut to at most KNOWLEDGE_SEARCH_MAX_LENGTH code units, never in the middle of a surrogate
 * pair. A text input's `maxlength` may count graphemes (WebKit), so 150 emoji pass it yet exceed the
 * limit; clamp what the input reports as well.
 */
export function clampKnowledgeSearch(text: string): string {
  if (text.length <= KNOWLEDGE_SEARCH_MAX_LENGTH) return text;
  let end = KNOWLEDGE_SEARCH_MAX_LENGTH;
  const last = text.charCodeAt(end - 1);
  // A high surrogate at the cut has lost its low half.
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

/** The query string of `GET /projects/:projectId/knowledge`. */
export const KnowledgeListQuery = z.strictObject({
  q: z.string().trim().max(KNOWLEDGE_SEARCH_MAX_LENGTH).optional(),
  match: z.enum(SearchMatch).optional(),
  kind: KnowledgeListKind.optional(),
  scope: z.enum(KnowledgeScope).optional(),
  area: AreaName.optional(),
  history: z
    .enum(['0', '1'])
    .default('0')
    .transform((v) => v === '1'),
  limit: z.coerce.number().int().min(1).max(500).default(KNOWLEDGE_LIST_LIMIT),
});
export type KnowledgeListQuery = z.output<typeof KnowledgeListQuery>;

const Scope = z.enum(KnowledgeScope);
const DryRun = z.boolean().optional().describe('Write nothing; answer what would be written.');

/** `POST /projects/:projectId/decisions`: a decision the builder records. */
export const DecisionWrite = z.strictObject({
  scope: Scope.optional().describe('you, project or area. Default: project.'),
  area: AreaName.optional().describe('The area, for scope "area".'),
  question: DecisionInput.shape.question,
  choice: DecisionInput.shape.choice,
  rationale: DecisionInput.shape.rationale,
  source: KnowledgeSource.optional(),
  dryRun: DryRun,
});
export type DecisionWrite = z.infer<typeof DecisionWrite>;

const changes = (o: Record<string, unknown>, keys: readonly string[]): boolean =>
  keys.some((k) => o[k] !== undefined);

const DECISION_FIELDS = ['scope', 'area', 'question', 'choice', 'rationale'] as const;

/** `POST /decisions/:id/supersede`: the fields to change; the rest are kept from the decision replaced. */
export const DecisionEdit = z
  .strictObject({
    projectId: ProjectId.optional().describe('Needed only to move a "you" record into a project.'),
    scope: Scope.optional(),
    area: AreaName.optional(),
    question: DecisionInput.shape.question.optional(),
    choice: DecisionInput.shape.choice.optional(),
    rationale: DecisionInput.shape.rationale.optional(),
    source: KnowledgeSource.optional(),
    dryRun: DryRun,
  })
  .refine((o) => changes(o, DECISION_FIELDS), {
    message: `name at least one field to change: ${DECISION_FIELDS.join(', ')}`,
  });
export type DecisionEdit = z.infer<typeof DecisionEdit>;

/** `POST /projects/:projectId/principles`: a principle the builder states; confirmed at once. */
export const PrincipleWrite = z.strictObject({
  scope: Scope.optional().describe('you, project or area. Default: project.'),
  area: AreaName.optional(),
  statement: PrincipleStatement,
  kind: z.enum(PrincipleKind).optional().describe('Default: heuristic.'),
  topicKey: TopicKey.optional().describe('Default: made from the statement.'),
  rationale: z.string().trim().min(1).max(2000).optional(),
  quote: z.string().max(2000).optional(),
  source: KnowledgeSource.optional(),
  dryRun: DryRun,
});
export type PrincipleWrite = z.infer<typeof PrincipleWrite>;

const PRINCIPLE_FIELDS = ['scope', 'area', 'statement', 'kind', 'topicKey', 'rationale'] as const;

/** `POST /principles/:id/supersede`: the fields to change; the rest are kept from the principle replaced. */
export const PrincipleEdit = z
  .strictObject({
    projectId: ProjectId.optional().describe('Needed only to move a "you" record into a project.'),
    scope: Scope.optional(),
    area: AreaName.optional(),
    statement: PrincipleStatement.optional(),
    kind: z.enum(PrincipleKind).optional(),
    topicKey: TopicKey.optional(),
    rationale: z.string().trim().min(1).max(2000).optional(),
    quote: z.string().max(2000).optional(),
    source: KnowledgeSource.optional(),
    dryRun: DryRun,
  })
  .refine((o) => changes(o, PRINCIPLE_FIELDS), {
    message: `name at least one field to change: ${PRINCIPLE_FIELDS.join(', ')}`,
  });
export type PrincipleEdit = z.infer<typeof PrincipleEdit>;

/** `POST …/retire` and `POST …/withdraw`: a reason, and the source and dry run every write takes. */
export const KnowledgeReason = z.strictObject({
  ...ReasonInput.shape,
  source: KnowledgeSource.optional(),
  dryRun: DryRun,
});
export type KnowledgeReason = z.infer<typeof KnowledgeReason>;

/** `POST /proposals/:id/accept`: any field given replaces the proposed principle's before it is confirmed. */
export const ProposalVerdictAccept = z.strictObject({
  scope: Scope.optional().describe("Default: the proposal's own."),
  area: AreaName.optional(),
  statement: PrincipleStatement.optional(),
  kind: z.enum(PrincipleKind).optional(),
  topicKey: TopicKey.optional(),
  note: z.string().max(4000).optional(),
  source: KnowledgeSource.optional(),
  dryRun: DryRun,
});
export type ProposalVerdictAccept = z.infer<typeof ProposalVerdictAccept>;

export const ProposalVerdictReject = z.strictObject({
  note: z.string().max(4000).optional(),
  source: KnowledgeSource.optional(),
});
export type ProposalVerdictReject = z.infer<typeof ProposalVerdictReject>;

/** The query string of `GET /projects/:projectId/proposals`. */
export const ProposalListQuery = z.strictObject({
  status: z.enum(ProposalStatus).default(ProposalStatus.Pending),
});
export type ProposalListQuery = z.output<typeof ProposalListQuery>;
