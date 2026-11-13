import { z } from 'zod';
import { DecisionId, ShapeFindingId, ShapeId, ShapeProposalId, TaskId, WorkstreamId } from './ids';
import { BundleOrigin } from './plan-bundle';
import {
  AnchorCheckDto,
  PlanAlternative,
  PlanAnchor,
  PlanDocumentKind,
  PlanEntryKind,
  PlanEntryState,
  SectionIndexEntry,
} from './plan-record';
import {
  ShapeFindingKind,
  ShapeFindingReviewer,
  ShapeFindingSeverity,
  ShapeFindingState,
  ShapeProposalState,
} from './shape';

// What the Record view reads of a Plan: its documents with every revision, and its lists a page at a
// time, filtered, sorted and paged by the daemon.

const Timestamp = z.iso.datetime();

type ValueOf<T> = T[keyof T];

// --- The record and a revision -----------------------------------------------------------------

export const PlanRecordRevision = z.object({
  number: z.int().min(1),
  /** The bundle's own number for it; null for a revision 10db wrote. */
  bundleNumber: z.int().min(1).nullable(),
  sha256: z.string(),
  note: z.string().nullable(),
  author: z.string().nullable(),
  authoredAt: Timestamp.nullable(),
  createdAt: Timestamp,
  sections: z.array(SectionIndexEntry),
});
export type PlanRecordRevision = z.infer<typeof PlanRecordRevision>;

export const PlanRecordDocument = z.object({
  key: z.string(),
  kind: z.enum([...Object.values(PlanDocumentKind), 'eval']),
  title: z.string(),
  /** The goal key a spec or an eval is the spec of; null for the rest. */
  effortKey: z.string().nullable(),
  /** Oldest first. */
  revisions: z.array(PlanRecordRevision),
});
export type PlanRecordDocument = z.infer<typeof PlanRecordDocument>;

/** `GET /shapes/:shapeId/record`: the documents whole, and how many rows each list holds. */
export const PlanRecordDto = z.object({
  shapeId: ShapeId,
  title: z.string(),
  importedAt: Timestamp.nullable(),
  origin: BundleOrigin.nullable(),
  documents: z.array(PlanRecordDocument),
  counts: z.object({
    decisions: z.int().min(0),
    evidence: z.int().min(0),
    reviews: z.int().min(0),
    questions: z.int().min(0),
    tasks: z.int().min(0),
  }),
});
export type PlanRecordDto = z.infer<typeof PlanRecordDto>;

/** `GET /shapes/:shapeId/documents/:key/revisions/:number`: one revision's text, byte for byte. */
export const PlanDocumentRevisionDto = z.object({
  key: z.string(),
  number: z.int().min(1),
  title: z.string(),
  body: z.string(),
});
export type PlanDocumentRevisionDto = z.infer<typeof PlanDocumentRevisionDto>;

// --- The lists -----------------------------------------------------------------------------------

export const PlanRecordList = {
  Decisions: 'decisions',
  Evidence: 'evidence',
  Reviews: 'reviews',
  Questions: 'questions',
  Tasks: 'tasks',
} as const;
export type PlanRecordList = ValueOf<typeof PlanRecordList>;

/** The page sizes a list answers, as the Knowledge lists do. */
export const PLAN_RECORD_PAGE_SIZES = [25, 50, 100] as const;
export type PlanRecordPageSize = (typeof PLAN_RECORD_PAGE_SIZES)[number];

/** Every state a list's rows can be in; a list filtered by a state none of its rows has is empty. */
const RecordState = z.enum([
  ...new Set([
    ...Object.values(ShapeProposalState),
    ...Object.values(PlanEntryState),
    ...Object.values(ShapeFindingState),
  ]),
]);

/**
 * The query string of `GET /shapes/:shapeId/record/:list`. `state` narrows every list but tasks;
 * `kind` narrows evidence by entry kind and reviews by finding kind; `document` narrows reviews.
 */
export const PlanRecordQuery = z.strictObject({
  state: RecordState.optional(),
  kind: z.enum([...Object.values(PlanEntryKind), ...Object.values(ShapeFindingKind)]).optional(),
  document: z.string().min(1).max(200).optional(),
  q: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .refine(
      (n): n is PlanRecordPageSize => (PLAN_RECORD_PAGE_SIZES as readonly number[]).includes(n),
      'a page holds 25, 50 or 100 rows',
    )
    .default(25),
});
export type PlanRecordQuery = z.output<typeof PlanRecordQuery>;

export const PlanDecisionRow = z.object({
  /** The proposal row; a key re-imported over a replaced row has one row per import. */
  id: ShapeProposalId,
  key: z.string(),
  question: z.string(),
  choice: z.string(),
  rationale: z.string(),
  alternatives: z.array(PlanAlternative),
  quote: z.string().nullable(),
  lasting: z.boolean(),
  /** The day the builder decided it; null for one still open. */
  decidedAt: z.iso.date().nullable(),
  state: z.enum(ShapeProposalState),
  /** The Knowledge decision Convert wrote for it; null when none was. */
  decisionId: DecisionId.nullable(),
});
export type PlanDecisionRow = z.infer<typeof PlanDecisionRow>;

/** The newest check run of one task, of this entry's anchors. */
export const PlanEvidenceTaskChecks = z.object({
  taskId: TaskId,
  results: z.array(AnchorCheckDto),
});
export type PlanEvidenceTaskChecks = z.infer<typeof PlanEvidenceTaskChecks>;

export const PlanEvidenceRow = z.object({
  key: z.string(),
  kind: z.enum(PlanEntryKind),
  title: z.string(),
  version: z.int().min(1),
  /** The entry's body as its kind's schema reads it (`PlanEntryBody`). */
  body: z.record(z.string(), z.unknown()),
  anchors: z.array(PlanAnchor),
  sources: z.array(z.string()),
  verified: z.boolean(),
  checkedAt: z.string().nullable(),
  state: z.enum(PlanEntryState),
  checks: z.array(PlanEvidenceTaskChecks),
});
export type PlanEvidenceRow = z.infer<typeof PlanEvidenceRow>;

export const PlanReviewRow = z.object({
  id: ShapeFindingId,
  /** The bundle's key for an imported finding; null for a session's own. */
  key: z.string().nullable(),
  /** The document it reviewed; the effort key when it names no revision. */
  document: z.string(),
  revision: z.int().min(1).nullable(),
  section: z.string().nullable(),
  round: z.int().min(0),
  /** The reviewer's own name when the record has it, else the session reviewer. */
  reviewer: z.string(),
  reviewerKind: z.enum(ShapeFindingReviewer),
  kind: z.enum(ShapeFindingKind),
  severity: z.enum(ShapeFindingSeverity).nullable(),
  severityText: z.string().nullable(),
  text: z.string(),
  state: z.enum(ShapeFindingState),
  outcomeText: z.string().nullable(),
  how: z.string().nullable(),
  howDetail: z.string().nullable(),
});
export type PlanReviewRow = z.infer<typeof PlanReviewRow>;

/** One document, revision and round of findings, counted over the whole filtered list. */
export const PlanReviewGroup = z.object({
  document: z.string(),
  revision: z.int().min(1).nullable(),
  round: z.int().min(0),
  total: z.int().min(0),
  high: z.int().min(0),
  medium: z.int().min(0),
  low: z.int().min(0),
});
export type PlanReviewGroup = z.infer<typeof PlanReviewGroup>;

/** A question the record holds open: a question proposal, or a decision not yet decided. */
export const PlanQuestionRow = z.object({
  id: ShapeProposalId,
  key: z.string(),
  source: z.enum(['question', 'decision']),
  text: z.string(),
  for: z.string().nullable(),
  about: z.string().nullable(),
  blocks: z.string().nullable(),
  state: z.enum(ShapeProposalState),
});
export type PlanQuestionRow = z.infer<typeof PlanQuestionRow>;

export const PlanTaskRow = z.object({
  taskId: TaskId,
  key: z.string(),
  title: z.string(),
  /** The section it was made from, with the record's revision number; null for a task with no pin. */
  planRef: z
    .object({ document: z.string(), revision: z.int().min(1), section: z.string() })
    .nullable(),
});
export type PlanTaskRow = z.infer<typeof PlanTaskRow>;

const pageFields = {
  /** How many rows match the filters, on every page together. */
  total: z.int().min(0),
  /** The page answered: the one asked for, or the last one when that was past the end. */
  page: z.int().min(1),
  pageSize: z.int().min(1),
};

/** One page of one list. */
export const PlanRecordPage = z.discriminatedUnion('list', [
  z.object({ list: z.literal('decisions'), rows: z.array(PlanDecisionRow), ...pageFields }),
  z.object({ list: z.literal('evidence'), rows: z.array(PlanEvidenceRow), ...pageFields }),
  z.object({
    list: z.literal('reviews'),
    rows: z.array(PlanReviewRow),
    /** Every group of the filtered list, in its order, so a group's header counts all its rows. */
    groups: z.array(PlanReviewGroup),
    ...pageFields,
  }),
  z.object({ list: z.literal('questions'), rows: z.array(PlanQuestionRow), ...pageFields }),
  z.object({ list: z.literal('tasks'), rows: z.array(PlanTaskRow), ...pageFields }),
]);
export type PlanRecordPage = z.infer<typeof PlanRecordPage>;

// --- A task's Plan context ---------------------------------------------------------------------

/**
 * `GET /tasks/:taskId/plan-context`: the section a task is pinned to, the Plan block its lane last
 * got (stored when it was packed, so a later re-import never changes it), and its newest anchor checks.
 */
export const TaskPlanContextDto = z.object({
  context: z
    .object({
      shapeId: ShapeId,
      /** The Plan's title. */
      title: z.string(),
      /** `doc#slug`. */
      ref: z.string(),
      revision: z.int().min(1),
    })
    .nullable(),
  packed: z.object({ at: Timestamp, workstreamId: WorkstreamId, text: z.string() }).nullable(),
  checks: z.array(AnchorCheckDto),
});
export type TaskPlanContextDto = z.infer<typeof TaskPlanContextDto>;
