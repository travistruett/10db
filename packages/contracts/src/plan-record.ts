import { z } from 'zod';
import { BriefKey } from './goals';
import { ShapeAttachmentRevisionId, ShapeId, WorkstreamId } from './ids';

// A Plan's record: the documents, entries and anchors a planning effort keeps on its Plan, and what a
// lane's brief carries of it. The bundle that imports a record is in `plan-bundle.ts`.

const Timestamp = z.iso.datetime();

type ValueOf<T> = T[keyof T];

// --- Vocabularies -------------------------------------------------------------------------------

/** What a document of a Plan's record is. A `spec` named by a goal is that effort's spec. */
export const PlanDocumentKind = {
  Research: 'research',
  Spec: 'spec',
  Plan: 'plan',
  Guide: 'guide',
} as const;
export type PlanDocumentKind = ValueOf<typeof PlanDocumentKind>;

/** What a record entry is: the builder's words, a checked fact, a run that showed something, or a name. */
export const PlanEntryKind = {
  Intent: 'intent',
  Fact: 'fact',
  Experiment: 'experiment',
  Name: 'name',
} as const;
export type PlanEntryKind = ValueOf<typeof PlanEntryKind>;

/** An entry the latest import no longer holds is superseded, never deleted. */
export const PlanEntryState = { Current: 'current', Superseded: 'superseded' } as const;
export type PlanEntryState = ValueOf<typeof PlanEntryState>;

/**
 * What checking one anchor found: its excerpt at its line (`current`), at another line (`moved`), nowhere
 * (`changed`), or not checked (`unchecked`, with a note). A URL anchor is never fetched (`url`).
 */
export const AnchorResult = {
  Current: 'current',
  Moved: 'moved',
  Changed: 'changed',
  Unchecked: 'unchecked',
  Url: 'url',
} as const;
export type AnchorResult = ValueOf<typeof AnchorResult>;

/** What a named thing in a plan is. */
export const PlanNameKind = {
  Type: 'type',
  Route: 'route',
  Table: 'table',
  Module: 'module',
  Env: 'env',
  Other: 'other',
} as const;
export type PlanNameKind = ValueOf<typeof PlanNameKind>;

// --- Sections -----------------------------------------------------------------------------------

/** The deepest heading level that starts a section; `#####` and deeper are text. */
export const SECTION_MAX_LEVEL = 4;

/** The longest a section slug may be, in UTF-16 code units. */
export const SECTION_SLUG_MAX_LENGTH = 200;

/** A heading's slug, as GitHub makes it; a `Task <n>` heading's is `task-<n>`. */
export const SectionSlug = z
  .string()
  .min(1)
  .max(SECTION_SLUG_MAX_LENGTH)
  .regex(/^[^\s#]+$/, 'a section slug has no spaces and no #');
export type SectionSlug = z.infer<typeof SectionSlug>;

/** One section of a document revision: UTF-16 offsets into its body, `end` exclusive. */
export const SectionIndexEntry = z.object({
  slug: SectionSlug,
  level: z.int().min(1).max(SECTION_MAX_LEVEL),
  title: z.string(),
  start: z.int().min(0),
  end: z.int().min(0),
});
export type SectionIndexEntry = z.infer<typeof SectionIndexEntry>;

/** Reads `doc#slug`; null for anything else. */
export function parseSectionRef(
  ref: string,
): { document: z.infer<typeof BriefKey>; section: SectionSlug } | null {
  const hash = ref.indexOf('#');
  if (hash < 0) return null;
  const document = BriefKey.safeParse(ref.slice(0, hash));
  const section = SectionSlug.safeParse(ref.slice(hash + 1));
  return document.success && section.success
    ? { document: document.data, section: section.data }
    : null;
}

// --- Anchors ------------------------------------------------------------------------------------

/** The most lines an anchor's excerpt may hold. */
export const EXCERPT_MAX_LINES = 5;

/** A path inside the repository: relative, no `..` segment, no NUL. */
const RepoPath = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith('/'), 'a repository path is relative')
  .refine((p) => !p.includes('\u0000'), 'a repository path has no NUL')
  .refine((p) => !p.split('/').includes('..'), 'a repository path has no .. segment');

/** Where a fact was read in code: the file, the line, the commit, and the lines found there. */
export const CodeAnchor = z.strictObject({
  kind: z.literal('code'),
  path: RepoPath,
  line: z.int().min(1),
  commit: z.string().regex(/^[0-9a-f]{7,40}$/, 'a commit is 7 to 40 hex digits'),
  excerpt: z
    .string()
    .refine((e) => e.trim().length > 0, 'an excerpt is not blank')
    // A line of punctuation alone (`}`) is found almost anywhere, so it proves nothing.
    .refine((e) => /[\p{L}\p{N}]/u.test(e), 'an excerpt holds a letter or a digit')
    .refine(
      (e) => e.split('\n').length <= EXCERPT_MAX_LINES,
      `an excerpt is at most ${String(EXCERPT_MAX_LINES)} lines`,
    ),
});
export type CodeAnchor = z.infer<typeof CodeAnchor>;

/** Where a fact was read on the web, and when; 10db never fetches it. */
export const UrlAnchor = z.strictObject({
  kind: z.literal('url'),
  url: z.url({ protocol: /^https?$/ }),
  readAt: z.iso.date(),
});
export type UrlAnchor = z.infer<typeof UrlAnchor>;

export const PlanAnchor = z.discriminatedUnion('kind', [CodeAnchor, UrlAnchor]);
export type PlanAnchor = z.infer<typeof PlanAnchor>;

// --- Entry bodies -------------------------------------------------------------------------------

const Text = z.string().min(1);

/** One phase of an effort's cost; `agents` is null when it wasn't counted. */
export const PlanCostRow = z.strictObject({
  phase: Text,
  agents: z.int().min(0).nullable(),
  tokens: z.int().min(0),
  approximate: z.boolean(),
});
export type PlanCostRow = z.infer<typeof PlanCostRow>;

/** An entry's body, by its kind. A fact is a claim, or the effort's cost. */
export const PlanEntryBody = {
  intent: z.strictObject({ quote: Text, speaker: Text, saidAt: z.iso.date() }),
  fact: z.union([
    z.strictObject({ claim: Text, detail: Text.optional() }),
    z.strictObject({
      kind: z.literal('cost'),
      rows: z.array(PlanCostRow).min(1),
      note: Text.optional(),
    }),
  ]),
  experiment: z.strictObject({ setup: Text, command: Text, output: Text, shows: Text }),
  name: z.strictObject({
    name: Text,
    kind: z.enum(PlanNameKind),
    definition: Text,
    owner: Text,
  }),
} as const satisfies Record<PlanEntryKind, z.ZodType>;
export type PlanEntryBody = { [K in PlanEntryKind]: z.infer<(typeof PlanEntryBody)[K]> };

// --- What a task points at ----------------------------------------------------------------------

/**
 * The section of a document a task was made from, and the document's sections every task shares. A
 * stored ref names the record's revision number; a bundle's ref names the bundle's own.
 */
export const PlanRef = z.strictObject({
  document: BriefKey,
  revision: z.int().min(1),
  section: SectionSlug,
  shared: z.array(SectionSlug).default([]),
});
export type PlanRef = z.infer<typeof PlanRef>;

/** An option a decision turned down, and why. */
export const PlanAlternative = z.strictObject({ option: Text, whyNot: Text });
export type PlanAlternative = z.infer<typeof PlanAlternative>;

// --- Anchor checks and the brief's block ---------------------------------------------------------

/** One check of one anchor of a cited fact, by one workstream at the base it read. */
export const AnchorCheckDto = z.object({
  entryKey: z.string(),
  /** The version of the entry whose anchor was checked. */
  entryVersion: z.int().min(1),
  anchorIndex: z.int().min(0),
  result: z.enum(AnchorResult),
  line: z.int().min(1).nullable(),
  checkedCommit: z.string().nullable(),
  note: z.string().nullable(),
  workstreamId: WorkstreamId,
  at: Timestamp,
});
export type AnchorCheckDto = z.infer<typeof AnchorCheckDto>;

/** Why a cited item no longer stands: a re-import superseded it, or it was dropped or replaced. */
export const PlanItemDropped = { Superseded: 'superseded', Rejected: 'rejected' } as const;
export type PlanItemDropped = (typeof PlanItemDropped)[keyof typeof PlanItemDropped];

/** Null for a cited item that stands; else why not, so the lane never reads it as live. */
const Dropped = z.enum(PlanItemDropped).nullable().default(null);

/** A section's text and its `doc#slug`. */
const SectionText = z.object({ ref: z.string(), text: z.string() });

/**
 * What a lane's brief carries of its task's Plan: its section and the shared sections whole, and the
 * items it cites as far as the budget goes, the rest named in `notIncluded`. Budgets are in estimated
 * tokens.
 */
export const PlanContext = z.object({
  shapeId: ShapeId,
  /** The revision the task is pinned to. */
  revisionId: ShapeAttachmentRevisionId,
  title: z.string(),
  document: z.object({ key: z.string(), title: z.string(), revision: z.int().min(1) }),
  goal: z.object({ objective: z.string(), why: z.string() }).nullable(),
  section: SectionText,
  shared: z.array(SectionText),
  decisions: z.array(
    z.object({
      key: z.string(),
      choice: z.string(),
      rationale: z.string(),
      lasting: z.boolean(),
      dropped: Dropped,
    }),
  ),
  names: z.array(
    z.object({
      key: z.string(),
      version: z.int().min(1),
      name: z.string(),
      definition: z.string(),
      dropped: Dropped,
    }),
  ),
  facts: z.array(
    z.object({
      key: z.string(),
      version: z.int().min(1),
      kind: z.enum(['fact', 'experiment']),
      /** The fact's one-line text: its claim, or what an experiment shows. */
      line: z.string(),
      anchors: z.array(PlanAnchor),
      checks: z.array(AnchorCheckDto),
      dropped: Dropped,
    }),
  ),
  /** Severity is the reviewer's own words when the record has them, else the enum. */
  findings: z.array(z.object({ key: z.string(), severity: z.string(), text: z.string() })),
  intent: z.array(
    z.object({
      key: z.string(),
      version: z.int().min(1),
      quote: z.string(),
      speaker: z.string(),
      dropped: Dropped,
    }),
  ),
  notIncluded: z.array(z.string()),
  budget: z.int().min(0),
  used: z.int().min(0),
});
export type PlanContext = z.infer<typeof PlanContext>;
