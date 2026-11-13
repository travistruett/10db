import { z } from 'zod';
import { Headline, Title, Why } from './entities';
import { BriefKey, GoalBriefCriterion } from './goals';
import { ProjectId, ShapeId } from './ids';
import {
  PlanAlternative,
  PlanAnchor,
  PlanDocumentKind,
  PlanEntryBody,
  PlanRef,
  SectionSlug,
} from './plan-record';
import {
  Ceremony,
  RecordScope,
  ShapeFindingKind,
  ShapeFindingSeverity,
  ShapeFindingState,
  TaskSize,
} from './shape';

// A planning effort as one JSON file, the bundle a Plan imports (`POST /projects/:id/plans/import` and the
// builder tool `import_plan`). Every object is strict, so a misspelt field is refused rather than lost.

const Timestamp = z.iso.datetime();
const Text = z.string().min(1);

/** One revision of a document: its text inline, or in a file beside the bundle (`bodyPath`). */
export const BundleRevision = z
  .strictObject({
    number: z.int().min(1),
    body: z.string().optional(),
    bodyPath: Text.optional(),
    note: z.string().default(''),
    author: z.string().default(''),
    at: Timestamp,
  })
  .refine((r) => (r.body === undefined) !== (r.bodyPath === undefined), {
    message: 'A revision gives either body or bodyPath, not both and not neither',
  });
export type BundleRevision = z.infer<typeof BundleRevision>;

export const BundleDocument = z.strictObject({
  key: BriefKey,
  kind: z.enum(PlanDocumentKind),
  title: Text,
  /** The goal of the bundle a `spec` is the spec of. */
  effort: BriefKey.optional(),
  revisions: z.array(BundleRevision).min(1),
});
export type BundleDocument = z.infer<typeof BundleDocument>;

/** The builder's words, as said. */
export const BundleIntent = z.strictObject({
  key: BriefKey,
  quote: Text,
  speaker: Text,
  saidAt: z.iso.date(),
  title: Text.optional(),
});
export type BundleIntent = z.infer<typeof BundleIntent>;

const entryFields = {
  key: BriefKey,
  title: Text,
  anchors: z.array(PlanAnchor).default([]),
  sources: z.array(Text).default([]),
  verified: z.boolean(),
  checkedAt: z.iso.date().nullable(),
};

/** A fact, experiment or name; its body is the one its kind has (`PlanEntryBody`). */
export const BundleEntry = z.discriminatedUnion('kind', [
  z.strictObject({ ...entryFields, kind: z.literal('fact'), body: PlanEntryBody.fact }),
  z.strictObject({
    ...entryFields,
    kind: z.literal('experiment'),
    body: PlanEntryBody.experiment,
  }),
  z.strictObject({ ...entryFields, kind: z.literal('name'), body: PlanEntryBody.name }),
]);
export type BundleEntry = z.infer<typeof BundleEntry>;

/** A decision the effort reached; with `decidedAt` the builder accepted it. */
export const BundleDecision = z
  .strictObject({
    key: BriefKey,
    question: Text,
    choice: Text,
    rationale: Text,
    alternatives: z.array(PlanAlternative).default([]),
    quote: Text.optional(),
    /** Whether it outlives the effort; only a lasting decision reaches Knowledge. */
    lasting: z.boolean(),
    scope: z.enum(RecordScope),
    area: Text.optional(),
    anchors: z.array(PlanAnchor).default([]),
    decidedAt: z.iso.date().optional(),
  })
  .refine((d) => (d.scope === RecordScope.Area) === (d.area !== undefined), {
    message: 'An area decision names its area; no other decision does',
  });
export type BundleDecision = z.infer<typeof BundleDecision>;

/**
 * A review finding on a document revision. `severity` and `state` are what 10db reads; `severityText`,
 * `outcomeText` and `howDetail` keep the reviewer's and the author's own words.
 */
export const BundleFinding = z.strictObject({
  key: BriefKey,
  document: BriefKey,
  revision: z.int().min(1),
  section: SectionSlug.optional(),
  reviewer: Text,
  round: z.int().min(0),
  kind: z.enum(ShapeFindingKind).default(ShapeFindingKind.Finding),
  severity: z.enum(ShapeFindingSeverity).nullable(),
  severityText: Text.optional(),
  text: Text,
  state: z.enum(ShapeFindingState),
  outcomeText: Text.optional(),
  how: Text.max(200).optional(),
  howDetail: Text.optional(),
});
export type BundleFinding = z.infer<typeof BundleFinding>;

export const BundleQuestion = z.strictObject({
  key: BriefKey,
  text: Text,
  /** A role or a person; the builder when absent. */
  owner: Text.optional(),
  /** The goal or task of the bundle it belongs to. */
  about: BriefKey.optional(),
  /** What it holds up, in words. */
  blocks: Text.optional(),
});
export type BundleQuestion = z.infer<typeof BundleQuestion>;

/** A task, in a goal or loose. `ceremony` is read for a loose task only; a goal's tasks take the goal's. */
export const BundleTask = z.strictObject({
  key: BriefKey,
  title: Title,
  headline: Headline.default(''),
  why: Why.default(''),
  description: z.string().default(''),
  criteria: z.array(Text).default([]),
  areas: z.array(Text).min(1),
  dependsOn: z.array(BriefKey).default([]),
  size: z.enum(TaskSize).default(TaskSize.M),
  ceremony: z.enum(Ceremony).default(Ceremony.Direct),
  planRef: PlanRef.optional(),
  /** Keys of intent, entries and decisions of the bundle the task's brief carries. */
  cites: z.array(BriefKey).default([]),
});
export type BundleTask = z.infer<typeof BundleTask>;

export const BundleGoal = z.strictObject({
  key: BriefKey,
  title: Title,
  objective: Text,
  cares_most: Text.optional(),
  criteria: z.array(GoalBriefCriterion).default([]),
  ceremony: z.enum(Ceremony).default(Ceremony.Spec),
  tasks: z.array(BundleTask).min(1),
});
export type BundleGoal = z.infer<typeof BundleGoal>;

/** Task keys that land together in one pull request. */
export const BundleLanding = z.strictObject({
  key: BriefKey,
  title: Title,
  keys: z.array(BriefKey).min(1),
});
export type BundleLanding = z.infer<typeof BundleLanding>;

/** Where the effort was made. */
export const BundleOrigin = z.strictObject({
  kind: z.enum(['claude_code', 'codex', 'other']),
  session: Text.optional(),
  model: Text.optional(),
  at: Timestamp,
});
export type BundleOrigin = z.infer<typeof BundleOrigin>;

/**
 * The path of every string in a parsed value that holds a lone surrogate, which storage would turn into
 * U+FFFD. Walks with a stack, not recursion, though a parsed bundle's depth is the schema's.
 */
function illFormedStrings(value: unknown): (string | number)[][] {
  const found: (string | number)[][] = [];
  const stack: { value: unknown; path: (string | number)[] }[] = [{ value, path: [] }];
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    const at = next.value;
    if (typeof at === 'string') {
      if (!at.isWellFormed()) found.push(next.path);
    } else if (Array.isArray(at)) {
      at.forEach((item: unknown, i) => stack.push({ value: item, path: [...next.path, i] }));
    } else if (typeof at === 'object' && at !== null) {
      for (const [key, item] of Object.entries(at))
        stack.push({ value: item, path: [...next.path, key] });
    }
  }
  return found.reverse();
}

/** A planning effort; importing the same `id` into the same project again updates its Plan. */
export const PlanBundle = z
  .strictObject({
    id: z
      .string()
      .regex(
        /^[a-z0-9][a-z0-9._-]{2,99}$/,
        'lowercase letters, digits, dots, underscores and hyphens, 3 to 100 of them',
      ),
    projectId: ProjectId,
    title: Text,
    origin: BundleOrigin,
    intent: z.array(BundleIntent).default([]),
    documents: z.array(BundleDocument),
    entries: z.array(BundleEntry).default([]),
    decisions: z.array(BundleDecision).default([]),
    findings: z.array(BundleFinding).default([]),
    questions: z.array(BundleQuestion).default([]),
    goals: z.array(BundleGoal).default([]),
    tasks: z.array(BundleTask).default([]),
    landings: z.array(BundleLanding).default([]),
  })
  .superRefine((bundle, ctx) => {
    for (const path of illFormedStrings(bundle))
      ctx.addIssue({ code: 'custom', path, message: 'holds a lone surrogate, which is not text' });
  });
export type PlanBundle = z.infer<typeof PlanBundle>;

// --- Import and export ----------------------------------------------------------------------------

/** The bundle's file (an absolute path; bodies by `bodyPath` beside it) or the bundle inline, never both. */
export const PlanImportInput = z.union([
  z.strictObject({ bundlePath: Text, dryRun: z.boolean().default(false) }),
  z.strictObject({ bundle: PlanBundle, dryRun: z.boolean().default(false) }),
]);
export type PlanImportInput = z.infer<typeof PlanImportInput>;

/** One reason a bundle can't be imported; `path` says where in plain words ("Finding p1-r1-3, revision"). */
export const PlanImportIssue = z.object({ path: z.string(), message: z.string() });
export type PlanImportIssue = z.infer<typeof PlanImportIssue>;

/** The 400 body of the import route: every issue at once. */
export const PlanImportError = z.object({ errors: z.array(PlanImportIssue) });
export type PlanImportError = z.infer<typeof PlanImportError>;

const Keys = z.array(z.string());

/** What an import adds, changes and keeps, by key; a dry run answers it and writes nothing. */
export const PlanImportChanges = z.object({
  /** Per document, the bundle revision numbers it adds. */
  documents: z.array(z.object({ key: z.string(), added: z.array(z.int()) })),
  entries: z.object({ added: Keys, changed: Keys, superseded: Keys }),
  findings: z.object({ added: Keys, changed: Keys }),
  proposals: z.object({
    added: Keys,
    replaced: Keys,
    keptPinned: Keys,
    /** `change:<taskId>` proposals for converted, unstarted tasks whose bundle task changed. */
    changeTasks: Keys,
    /** New tasks of a converted goal. */
    additions: Keys,
    leftAlone: z.array(z.object({ key: z.string(), why: z.string() })),
  }),
});
export type PlanImportChanges = z.infer<typeof PlanImportChanges>;

export const PlanImportPreview = z.object({
  dryRun: z.literal(true),
  /** The Plan a real import would update; null when it would make one. */
  shapeId: ShapeId.nullable(),
  title: z.string(),
  changes: PlanImportChanges,
});
export type PlanImportPreview = z.infer<typeof PlanImportPreview>;

export const PlanImportResult = z.object({
  dryRun: z.literal(false),
  shapeId: ShapeId,
  created: z.boolean(),
  changes: PlanImportChanges,
});
export type PlanImportResult = z.infer<typeof PlanImportResult>;

/** `POST /shapes/:shapeId/export`: an absolute folder outside every checkout. */
export const PlanExportInput = z.strictObject({ dir: Text });
export type PlanExportInput = z.infer<typeof PlanExportInput>;

/** The folder written and its files, relative to it. */
export const PlanExportResult = z.object({ dir: z.string(), files: z.array(z.string()) });
export type PlanExportResult = z.infer<typeof PlanExportResult>;
