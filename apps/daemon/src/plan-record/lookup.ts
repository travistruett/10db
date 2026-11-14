import {
  PlanEntryBody,
  ShapeProposalBody,
  TaskStatus,
  type GoalId,
  type PlanDocumentKind,
  type PlanEntryState,
  type PlanRef,
  type ProjectId,
  type ShapeFindingKind,
  type ShapeFindingSeverity,
  type ShapeFindingState,
  type ShapeId,
  type ShapeProposalKind,
  type ShapeProposalState,
  type ShapeState,
  type TaskId,
} from '@10db/contracts';
import {
  getAttachmentRevisionById,
  getDocumentAttachment,
  getShape,
  getShapeBundleOrigin,
  getShapeByBundle,
  getTask,
  getTaskContext,
  latestAnchorChecksOfTask,
  latestWorkstreamOf,
  listAttachmentRevisions,
  listDocuments,
  listShapeEntries,
  listShapeFindings,
  listShapeLinks,
  listShapeProposals,
  shapeEntryContent,
  type DbReader,
  type ShapeAttachmentRow,
  type ShapeProposalRow,
} from '@10db/db';
import type { PlanRecordForExport } from './export-layout';
import type { RecordKeyKind, StoredRecord } from './validate-bundle';

// What a Plan imported from a bundle holds now, read once so a re-import is judged against it.

/** A task Convert made from the Plan, as it stands now. */
export interface ConvertedTask {
  readonly taskId: TaskId;
  readonly started: boolean;
  readonly title: string;
  readonly description: string;
  readonly acceptanceCriteria: readonly string[];
  readonly areas: readonly string[];
  /** The keys of the tasks it depends on, where Convert made them. */
  readonly dependsOn: readonly string[];
  /** Its pin, with the record's revision number; null when it has none. */
  readonly planRef: PlanRef | null;
  readonly cites: readonly string[];
}

export interface StoredProposal {
  readonly kind: ShapeProposalKind;
  readonly state: ShapeProposalState;
  readonly pinned: boolean;
  /** Its body parsed and written as canonical JSON, to compare with a bundle's. */
  readonly body: string;
}

/** Everything a re-import compares with; `StoredRecord` is the part the validator reads. */
export interface StoredPlan extends StoredRecord {
  readonly state: ShapeState;
  readonly round: number;
  /** Per document key: the record number of each bundle number, and the latest record number. */
  readonly numbering: ReadonlyMap<
    string,
    { readonly byBundle: ReadonlyMap<number, number>; readonly latest: number }
  >;
  readonly entries: ReadonlyMap<
    string,
    { readonly content: string; readonly state: PlanEntryState }
  >;
  /** Imported findings by bundle key, as `findingContent` text. */
  readonly findings: ReadonlyMap<string, string>;
  readonly proposals: ReadonlyMap<string, StoredProposal>;
  readonly converted: ReadonlyMap<string, ConvertedTask>;
  readonly goals: ReadonlyMap<string, GoalId>;
}

/** JSON with every object's keys sorted and undefined fields dropped. */
export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v === null || typeof v !== 'object') return v;
    return Object.fromEntries(
      Object.entries(v)
        .filter(([, inner]) => inner !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, inner]) => [k, sort(inner)]),
    );
  };
  return JSON.stringify(sort(value));
}

/** A proposal body as canonical JSON, read through its kind's schema; empty when it doesn't parse. */
export function proposalBodyText(kind: ShapeProposalKind, body: unknown): string {
  const parsed = ShapeProposalBody[kind].safeParse(body);
  return parsed.success ? canonicalJson(parsed.data) : '';
}

/** What an imported finding says, to compare a stored one with a bundle's. */
export function findingContent(f: {
  readonly document: string;
  readonly revision: number | null;
  readonly section: string | null;
  readonly effortKey: string;
  readonly reviewerName: string | null;
  readonly round: number;
  readonly kind: ShapeFindingKind;
  readonly severity: ShapeFindingSeverity | null;
  readonly severityText: string | null;
  readonly text: string;
  readonly state: ShapeFindingState;
  readonly outcomeText: string | null;
  readonly how: string | null;
  readonly howDetail: string | null;
}): string {
  return canonicalJson(f);
}

/** A record document's kind; listDocuments answers only these and evals. */
function documentKind(kind: ShapeAttachmentRow['kind']): PlanDocumentKind | 'eval' {
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

/** The keys a proposal row holds, with what each names; none for a change or removal. */
function keysOf(row: ShapeProposalRow): [string, RecordKeyKind][] {
  switch (row.kind) {
    case 'goal':
      return [
        [row.key, 'goal'],
        ...ShapeProposalBody.goal
          .parse(row.body)
          .tasks.map((t): [string, RecordKeyKind] => [t.key, 'task']),
      ];
    case 'task':
      return [[row.key, 'task']];
    case 'landing':
      return [[row.key, 'landing']];
    case 'decision':
      return [[row.key, 'decision']];
    case 'question':
      return [[row.key, 'question']];
    case 'principle':
    case 'change_task':
    case 'remove_task':
      return [];
  }
}

/** The record a bundle id was imported into in a project, or null before its first import. */
export function loadStoredRecord(
  db: DbReader,
  projectId: ProjectId,
  bundleId: string,
): StoredPlan | null {
  const shape = getShapeByBundle(db, projectId, bundleId);
  if (!shape) return null;
  const kinds = new Map<string, RecordKeyKind>();
  const documents = new Map<
    string,
    { kind: PlanDocumentKind | 'eval'; effort: string | null; revisions: Map<number, string> }
  >();
  const numbering = new Map<string, { byBundle: Map<number, number>; latest: number }>();
  const docKeyOfAttachment = new Map<string, string>();
  for (const doc of listDocuments(db, shape.id)) {
    if (doc.docKey === null) continue;
    docKeyOfAttachment.set(doc.id, doc.docKey);
    kinds.set(doc.docKey, 'document');
    const revisions = listAttachmentRevisions(db, doc.id);
    const hashes = new Map<number, string>();
    const byBundle = new Map<number, number>();
    for (const r of revisions)
      if (r.bundleNumber !== null) {
        hashes.set(r.bundleNumber, r.sha256);
        byBundle.set(r.bundleNumber, r.number);
      }
    documents.set(doc.docKey, {
      kind: documentKind(doc.kind),
      effort: doc.kind === 'spec' && doc.key !== doc.docKey ? doc.key : null,
      revisions: hashes,
    });
    numbering.set(doc.docKey, {
      byBundle,
      latest: Math.max(0, ...revisions.map((r) => r.number)),
    });
  }

  const entries = new Map<string, { content: string; state: PlanEntryState }>();
  for (const entry of listShapeEntries(db, shape.id)) {
    kinds.set(entry.key, entry.kind);
    entries.set(entry.key, { content: shapeEntryContent(entry), state: entry.state });
  }

  const findings = new Map<string, string>();
  for (const f of listShapeFindings(db, shape.id)) {
    if (f.bundleKey === null) continue;
    kinds.set(f.bundleKey, 'finding');
    const revision =
      f.revisionId === null ? undefined : getAttachmentRevisionById(db, f.revisionId);
    findings.set(
      f.bundleKey,
      findingContent({
        document:
          revision === undefined ? '' : (docKeyOfAttachment.get(revision.attachmentId) ?? ''),
        revision: revision?.bundleNumber ?? null,
        section: f.section,
        effortKey: f.effortKey,
        reviewerName: f.reviewerName,
        round: f.round,
        kind: f.kind,
        severity: f.severity,
        severityText: f.severityText,
        text: f.text,
        state: f.state,
        outcomeText: f.outcomeText,
        how: f.how,
        howDetail: f.howDetail,
      }),
    );
  }

  const proposals = new Map<string, StoredProposal>();
  for (const row of listShapeProposals(db, shape.id)) {
    for (const [key, kind] of keysOf(row)) kinds.set(key, kind);
    proposals.set(row.key, {
      kind: row.kind,
      state: row.state,
      pinned: row.pinned.length > 0,
      body: proposalBodyText(row.kind, row.body),
    });
  }

  const links = listShapeLinks(db, shape.id);
  const keyOfTask = new Map<string, string>();
  for (const link of links) if (link.taskId !== null) keyOfTask.set(link.taskId, link.key);
  const goals = new Map<string, GoalId>();
  const converted = new Map<string, ConvertedTask>();
  for (const link of links) {
    if (link.goalId !== null) goals.set(link.key, link.goalId);
    if (link.taskId === null) continue;
    const task = getTask(db, link.taskId);
    const context = getTaskContext(db, link.taskId);
    const revision = context ? getAttachmentRevisionById(db, context.revisionId) : undefined;
    const document = revision ? getDocumentAttachment(db, revision.attachmentId) : undefined;
    converted.set(link.key, {
      taskId: link.taskId,
      started: task.status !== TaskStatus.Open || latestWorkstreamOf(db, link.taskId) !== undefined,
      title: task.title,
      description: task.description,
      acceptanceCriteria: task.acceptanceCriteria,
      areas: task.areas,
      dependsOn: task.dependsOn.flatMap((id) => keyOfTask.get(id) ?? []),
      planRef:
        context && revision && document
          ? {
              document: document.docKey ?? document.key,
              revision: revision.number,
              section: context.section,
              shared: context.shared,
            }
          : null,
      cites: context?.cites ?? [],
    });
  }

  return {
    shapeId: shape.id,
    state: shape.state,
    round: shape.round,
    documents,
    numbering,
    kinds,
    entries,
    findings,
    proposals,
    converted,
    goals,
  };
}

/** A Plan's whole record as an export reads it: latest revisions, entries, decisions, findings, questions. */
export function readRecordForExport(db: DbReader, shapeId: ShapeId): PlanRecordForExport {
  const shape = getShape(db, shapeId);
  const documents = listDocuments(db, shapeId).flatMap((doc) => {
    const revisions = listAttachmentRevisions(db, doc.id);
    const latest = revisions.at(-1);
    return doc.kind === 'eval'
      ? []
      : [
          {
            key: doc.documentKey,
            kind: doc.kind,
            title: doc.title ?? doc.documentKey,
            revision: latest?.number ?? 1,
            body: doc.body,
          },
        ];
  });
  const docKeyOfAttachment = new Map(listDocuments(db, shapeId).map((d) => [d.id, d.documentKey]));

  // The latest check of each cited anchor, per task of the Plan that has one.
  const checks = new Map<string, PlanRecordForExport['entries'][number]['checks'][number][]>();
  for (const link of listShapeLinks(db, shapeId)) {
    if (link.taskId === null) continue;
    const title = getTask(db, link.taskId).title;
    for (const row of latestAnchorChecksOfTask(db, link.taskId)) {
      const list = checks.get(row.entryKey) ?? [];
      list.push({
        task: title,
        result: row.result,
        line: row.line,
        checkedCommit: row.checkedCommit,
        note: row.note,
      });
      checks.set(row.entryKey, list);
    }
  }

  const intent: PlanRecordForExport['intent'][number][] = [];
  const entries: PlanRecordForExport['entries'][number][] = [];
  for (const e of listShapeEntries(db, shapeId)) {
    const body = PlanEntryBody[e.kind].parse(e.body);
    if (e.kind === 'intent' && 'quote' in body) intent.push({ key: e.key, ...body });
    else if (e.kind !== 'intent' && !('quote' in body))
      entries.push({
        key: e.key,
        kind: e.kind,
        title: e.title,
        version: e.version,
        state: e.state,
        body,
        anchors: e.anchors,
        checks: checks.get(e.key) ?? [],
      });
  }

  const decisions: PlanRecordForExport['decisions'][number][] = [];
  const questions: PlanRecordForExport['questions'][number][] = [];
  for (const row of listShapeProposals(db, shapeId)) {
    if (row.kind === 'decision') {
      const d = ShapeProposalBody.decision.parse(row.body);
      decisions.push({
        key: row.key,
        question: d.question,
        choice: d.choice,
        rationale: d.rationale,
        alternatives: d.alternatives,
        quote: d.quote ?? null,
        lasting: d.lasting,
        decidedAt: d.decidedAt ?? null,
        state: row.state,
      });
    } else if (row.kind === 'question') {
      const q = ShapeProposalBody.question.parse(row.body);
      questions.push({
        key: row.key,
        text: q.text,
        for: q.for,
        blocks: q.blocks ?? null,
        state: row.state,
      });
    }
  }

  const findings = listShapeFindings(db, shapeId).map((f) => {
    const revision =
      f.revisionId === null ? undefined : getAttachmentRevisionById(db, f.revisionId);
    return {
      document:
        revision === undefined
          ? f.effortKey
          : (docKeyOfAttachment.get(revision.attachmentId) ?? f.effortKey),
      revision: revision?.number ?? null,
      round: f.round,
      reviewer: f.reviewerName ?? f.reviewer,
      severity: f.severityText ?? f.severity,
      text: f.text,
      state: f.state,
      outcome: f.outcomeText,
      how: f.howDetail ?? f.how,
    };
  });

  return {
    title: shape.title,
    origin: getShapeBundleOrigin(db, shapeId),
    documents,
    intent,
    entries,
    decisions,
    findings,
    questions,
  };
}
