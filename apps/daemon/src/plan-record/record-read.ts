import {
  matchesSearch,
  NotFoundError,
  ShapeProposalBody,
  ShapeProposalState,
  type PlanDecisionRow,
  type PlanDocumentRevisionDto,
  type PlanEvidenceRow,
  type PlanQuestionRow,
  type PlanRecordDocument,
  type PlanRecordDto,
  type PlanRecordList,
  type PlanRecordPage,
  type PlanRecordQuery,
  type PlanReviewGroup,
  type PlanReviewRow,
  type PlanTaskRow,
  type ShapeId,
  type TaskId,
  type TaskPlanContextDto,
} from '@10db/contracts';
import {
  findDocument,
  getAttachmentRevision,
  getAttachmentRevisionById,
  getDocumentAttachment,
  getShape,
  getShapeBundleOrigin,
  getTask,
  getTaskContext,
  latestAnchorChecksOfTask,
  listAttachmentRevisions,
  listDocuments,
  listShapeEntries,
  listShapeFindings,
  listShapeLinks,
  listShapeProposals,
  type DbReader,
  type ShapeAttachmentRow,
  type ShapeProposalRow,
} from '@10db/db';
import { anchorCheckDto } from './check-dto';

// What the Record view reads of a Plan. Every list is filtered, sorted and paged here, never in the
// browser, so a page of 25 is the same 25 rows wherever it is read.

/** One page of `rows`; a page past the end answers the last one. */
function pageOf<T>(
  rows: readonly T[],
  query: { readonly page: number; readonly pageSize: number },
): { rows: T[]; total: number; page: number; pageSize: number } {
  const last = Math.max(1, Math.ceil(rows.length / query.pageSize));
  const page = Math.min(query.page, last);
  const start = (page - 1) * query.pageSize;
  return {
    rows: rows.slice(start, start + query.pageSize),
    total: rows.length,
    page,
    pageSize: query.pageSize,
  };
}

/** Whether every word typed starts a word of `parts`; no search matches everything. */
const searched = (q: string | undefined, parts: readonly (string | null | undefined)[]): boolean =>
  q === undefined || q === '' || matchesSearch(parts.filter((p) => p != null).join('\n'), q);

/** Every string value inside a parsed entry body, never its field names, for search. */
function stringsOf(value: unknown): string[] {
  const out: string[] = [];
  JSON.stringify(value, (_key, inner: unknown) => {
    if (typeof inner === 'string') out.push(inner);
    return inner;
  });
  return out;
}

/**
 * A proposal row stands unless a later round replaced it: with no state asked for, a list leaves
 * superseded rows out, so a re-imported key shows once.
 */
const proposalShown = (row: ShapeProposalRow, state: string | undefined): boolean =>
  state === undefined ? row.state !== ShapeProposalState.Superseded : row.state === state;

function documentKeys(db: DbReader, shapeId: ShapeId): Map<string, string> {
  return new Map(listDocuments(db, shapeId).map((d) => [d.id, d.documentKey]));
}

/** A record document's kind; `listDocuments` answers only these and evals. */
function recordKind(kind: ShapeAttachmentRow['kind']): PlanRecordDocument['kind'] {
  switch (kind) {
    case 'research':
    case 'spec':
    case 'plan':
    case 'guide':
    case 'eval':
      return kind;
    case 'mermaid':
    case 'chart':
    case 'mockup':
      return 'guide';
  }
}

/** The goal key a spec or an eval is the spec of; null for a record document that names none. */
function effortKeyOf(doc: ShapeAttachmentRow): string | null {
  if (doc.kind !== 'spec' && doc.kind !== 'eval') return null;
  return doc.docKey === null || doc.docKey !== doc.key ? doc.key : null;
}

function decisionRows(db: DbReader, shapeId: ShapeId, query: PlanRecordQuery): PlanDecisionRow[] {
  const written = new Map(
    listShapeLinks(db, shapeId).flatMap((l) =>
      l.decisionId === null ? [] : [[l.key, l.decisionId] as const],
    ),
  );
  return listShapeProposals(db, shapeId).flatMap((row): PlanDecisionRow[] => {
    if (row.kind !== 'decision' || !proposalShown(row, query.state)) return [];
    const d = ShapeProposalBody.decision.parse(row.body);
    const out: PlanDecisionRow = {
      key: row.key,
      question: d.question,
      choice: d.choice,
      rationale: d.rationale,
      alternatives: d.alternatives,
      quote: d.quote ?? null,
      lasting: d.lasting,
      decidedAt: d.decidedAt ?? null,
      state: row.state,
      decisionId: written.get(row.key) ?? null,
    };
    return searched(query.q, [
      out.key,
      out.question,
      out.choice,
      out.rationale,
      out.quote,
      ...out.alternatives.flatMap((a) => [a.option, a.whyNot]),
    ])
      ? [out]
      : [];
  });
}

function evidenceRows(db: DbReader, shapeId: ShapeId, query: PlanRecordQuery): PlanEvidenceRow[] {
  const entries = listShapeEntries(db, shapeId).filter(
    (e) =>
      (query.state === undefined || e.state === query.state) &&
      (query.kind === undefined || e.kind === query.kind) &&
      searched(query.q, [
        e.key,
        e.title,
        ...stringsOf(e.body),
        ...e.sources,
        ...e.anchors.map((a) => (a.kind === 'code' ? a.path : a.url)),
      ]),
  );
  // Each task's newest check run, read once for every entry on the page.
  const runs = listShapeLinks(db, shapeId).flatMap((l) =>
    l.taskId === null ? [] : [{ taskId: l.taskId, rows: latestAnchorChecksOfTask(db, l.taskId) }],
  );
  return entries.map((e) => ({
    key: e.key,
    kind: e.kind,
    title: e.title,
    version: e.version,
    body: { ...e.body },
    anchors: e.anchors,
    sources: e.sources,
    verified: e.verified,
    checkedAt: e.checkedAt,
    state: e.state,
    // A check of an earlier version of the entry says nothing about this one.
    checks: runs.flatMap(({ taskId, rows }) => {
      const results = rows
        .filter((r) => r.entryKey === e.key && r.entryVersion === e.version)
        .map(anchorCheckDto);
      return results.length === 0 ? [] : [{ taskId, results }];
    }),
  }));
}

/** Compares keys by their text, numbers inside them by value (`p1-r1-2` before `p1-r1-10`). */
const byKey = (a: string, b: string): number =>
  a.localeCompare(b, 'en', { numeric: true, sensitivity: 'variant' });

/** A finding with a key (an imported one) before one without. */
const byOptionalKey = (a: string | null, b: string | null): number =>
  a === null || b === null ? Number(a === null) - Number(b === null) : byKey(a, b);

function reviewRows(db: DbReader, shapeId: ShapeId, query: PlanRecordQuery): PlanReviewRow[] {
  const keys = documentKeys(db, shapeId);
  const rows = listShapeFindings(db, shapeId).flatMap((f): PlanReviewRow[] => {
    const revision =
      f.revisionId === null ? undefined : getAttachmentRevisionById(db, f.revisionId);
    const row: PlanReviewRow = {
      id: f.id,
      key: f.bundleKey,
      document: (revision && keys.get(revision.attachmentId)) ?? f.effortKey,
      revision: revision?.number ?? null,
      section: f.section,
      round: f.round,
      reviewer: f.reviewerName ?? f.reviewer,
      reviewerKind: f.reviewer,
      kind: f.kind,
      severity: f.severity,
      severityText: f.severityText,
      text: f.text,
      state: f.state,
      outcomeText: f.outcomeText,
      how: f.how,
      howDetail: f.howDetail,
    };
    const kept =
      (query.state === undefined || row.state === query.state) &&
      (query.kind === undefined || row.kind === query.kind) &&
      (query.document === undefined || row.document === query.document) &&
      searched(query.q, [
        row.key,
        row.text,
        row.reviewer,
        row.severityText,
        row.outcomeText,
        row.how,
        row.howDetail,
      ]);
    return kept ? [row] : [];
  });
  return rows.sort(
    (a, b) =>
      byKey(a.document, b.document) ||
      (a.revision ?? 0) - (b.revision ?? 0) ||
      a.round - b.round ||
      byOptionalKey(a.key, b.key) ||
      byKey(a.id, b.id),
  );
}

/** The groups of sorted review rows, in order, each counted whole. */
function reviewGroups(rows: readonly PlanReviewRow[]): PlanReviewGroup[] {
  const groups: PlanReviewGroup[] = [];
  for (const row of rows) {
    let group = groups.at(-1);
    if (
      group?.document !== row.document ||
      group.revision !== row.revision ||
      group.round !== row.round
    ) {
      group = {
        document: row.document,
        revision: row.revision,
        round: row.round,
        total: 0,
        high: 0,
        medium: 0,
        low: 0,
      };
      groups.push(group);
    }
    group.total += 1;
    if (row.severity !== null) group[row.severity] += 1;
  }
  return groups;
}

function questionRows(db: DbReader, shapeId: ShapeId, query: PlanRecordQuery): PlanQuestionRow[] {
  const proposals = listShapeProposals(db, shapeId);
  const asked = proposals.flatMap((row): PlanQuestionRow[] => {
    if (row.kind !== 'question' || !proposalShown(row, query.state)) return [];
    const q = ShapeProposalBody.question.parse(row.body);
    return [
      {
        key: row.key,
        source: 'question',
        text: q.text,
        for: q.for,
        about: q.about ?? null,
        blocks: q.blocks ?? null,
        state: row.state,
      },
    ];
  });
  // A decision still open is a question too; only a pending one is open.
  const undecided = proposals.flatMap((row): PlanQuestionRow[] => {
    if (row.kind !== 'decision' || row.state !== ShapeProposalState.Pending) return [];
    if (query.state !== undefined && query.state !== row.state) return [];
    const d = ShapeProposalBody.decision.parse(row.body);
    if (d.decidedAt !== undefined) return [];
    return [
      {
        key: row.key,
        source: 'decision',
        text: d.question,
        for: null,
        about: null,
        blocks: null,
        state: row.state,
      },
    ];
  });
  return [...asked, ...undecided].filter((r) =>
    searched(query.q, [r.key, r.text, r.for, r.about, r.blocks]),
  );
}

/** A task's pin as `doc#slug` and the record's revision number; null when it has none. */
function pinOf(
  db: DbReader,
  taskId: TaskId,
): { shapeId: ShapeId; document: string; revision: number; section: string } | null {
  const context = getTaskContext(db, taskId);
  if (!context) return null;
  const revision = getAttachmentRevisionById(db, context.revisionId);
  const doc = revision ? getDocumentAttachment(db, revision.attachmentId) : undefined;
  if (!revision || !doc) return null;
  return {
    shapeId: context.shapeId,
    document: doc.docKey ?? doc.key,
    revision: revision.number,
    section: context.section,
  };
}

function taskRows(db: DbReader, shapeId: ShapeId, query: PlanRecordQuery): PlanTaskRow[] {
  return listShapeLinks(db, shapeId).flatMap((link): PlanTaskRow[] => {
    if (link.taskId === null) return [];
    const title = getTask(db, link.taskId).title;
    if (!searched(query.q, [link.key, title])) return [];
    const pin = pinOf(db, link.taskId);
    return [
      {
        taskId: link.taskId,
        key: link.key,
        title,
        planRef: pin && { document: pin.document, revision: pin.revision, section: pin.section },
      },
    ];
  });
}

/** One page of one of a Plan's lists. */
export function readPlanRecordPage(
  db: DbReader,
  shapeId: ShapeId,
  list: PlanRecordList,
  query: PlanRecordQuery,
): PlanRecordPage {
  getShape(db, shapeId);
  switch (list) {
    case 'decisions':
      return { list, ...pageOf(decisionRows(db, shapeId, query), query) };
    case 'evidence':
      return { list, ...pageOf(evidenceRows(db, shapeId, query), query) };
    case 'reviews': {
      const rows = reviewRows(db, shapeId, query);
      return { list, ...pageOf(rows, query), groups: reviewGroups(rows) };
    }
    case 'questions':
      return { list, ...pageOf(questionRows(db, shapeId, query), query) };
    case 'tasks':
      return { list, ...pageOf(taskRows(db, shapeId, query), query) };
  }
}

/** A Plan's documents with every revision, and how many rows each list holds unfiltered. */
export function readPlanRecord(db: DbReader, shapeId: ShapeId): PlanRecordDto {
  const shape = getShape(db, shapeId);
  const all: PlanRecordQuery = { page: 1, pageSize: 25 };
  return {
    shapeId,
    title: shape.title,
    importedAt: shape.importedAt,
    origin: getShapeBundleOrigin(db, shapeId),
    documents: listDocuments(db, shapeId).map((doc) => ({
      key: doc.documentKey,
      kind: recordKind(doc.kind),
      title: doc.title ?? doc.documentKey,
      effortKey: effortKeyOf(doc),
      revisions: listAttachmentRevisions(db, doc.id).map((r) => ({
        number: r.number,
        bundleNumber: r.bundleNumber,
        sha256: r.sha256,
        note: r.note,
        author: r.author,
        authoredAt: r.authoredAt,
        createdAt: r.createdAt,
        sections: r.sections,
      })),
    })),
    counts: {
      decisions: decisionRows(db, shapeId, all).length,
      evidence: evidenceRows(db, shapeId, all).length,
      reviews: reviewRows(db, shapeId, all).length,
      questions: questionRows(db, shapeId, all).length,
      tasks: taskRows(db, shapeId, all).length,
    },
  };
}

/** One revision of a Plan's document, byte for byte as stored. */
export function readPlanRevision(
  db: DbReader,
  shapeId: ShapeId,
  key: string,
  number: number,
): PlanDocumentRevisionDto {
  getShape(db, shapeId);
  const doc = findDocument(db, shapeId, key);
  const revision = doc ? getAttachmentRevision(db, doc.id, number) : undefined;
  if (!doc || !revision) throw new NotFoundError('document revision', `${key}#${String(number)}`);
  return { key, number, title: doc.title ?? key, body: revision.body };
}

/** The section a task is pinned to, the Plan block its lane last got, and its newest checks. */
export function readTaskPlanContext(db: DbReader, taskId: TaskId): TaskPlanContextDto {
  getTask(db, taskId);
  const pin = pinOf(db, taskId);
  const context = getTaskContext(db, taskId);
  const packed =
    context?.packedText != null && context.packedAt !== null && context.packedWorkstreamId !== null
      ? { at: context.packedAt, workstreamId: context.packedWorkstreamId, text: context.packedText }
      : null;
  return {
    context: pin && {
      shapeId: pin.shapeId,
      title: getShape(db, pin.shapeId).title,
      ref: `${pin.document}#${pin.section}`,
      revision: pin.revision,
    },
    packed,
    checks: latestAnchorChecksOfTask(db, taskId).map(anchorCheckDto),
  };
}
