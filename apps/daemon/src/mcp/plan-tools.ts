import {
  InvalidError,
  matchesSearch,
  NotFoundError,
  parseSectionRef,
  ShapeProposalBody,
  type McpToolOutputs,
  type PlanToolName,
  type PlanSearchKind,
  type ShapeId,
  type WorkstreamId,
} from '@10db/contracts';
import {
  findDocument,
  findShapeLinkOfGoal,
  findShapeLinkOfTask,
  getAttachmentRevision,
  getAttachmentRevisionById,
  getDocumentAttachment,
  getTask,
  getTaskContext,
  getWorkstream,
  getWorkstreamRow,
  listAnchorChecks,
  listAttachmentRevisions,
  listDocuments,
  listShapeEntries,
  listShapeFindings,
  listShapeProposals,
  getShapeEntry,
  type DbReader,
} from '@10db/db';
import { z } from 'zod';
import { indexSections, sectionText } from '../plan-record';
import type { ToolHandlers } from './tools';

// A lane's read-only tools over its task's Plan. Every lookup is keyed by the Plan the task was made
// from, so a lane never reads another Plan's record, whatever keys the two share.

type Out<K extends PlanToolName> = z.output<(typeof McpToolOutputs)[K]>;

export const PLAN_TOOL_DESCRIPTIONS: Record<PlanToolName, string> = {
  get_plan_section:
    "Read a section of your task's Plan, by doc#slug as your brief names it (a task's is task-N). Without revision you get the revision your task was made from.",
  get_plan_entry:
    "Read a decision, fact, experiment, name, intent, question or review finding of your task's Plan by its key, such as one your brief lists under Not included.",
  find_plan_entries:
    "Search your task's Plan: its entries, decisions, questions, review findings and section texts. A section hit names its revision for get_plan_section.",
};

const NO_PLAN = 'This task has no Plan.';
const SNIPPET = 200;

/** The Plan a workstream's task belongs to: its pin, else its own or its goal's link. */
function planOf(db: DbReader, workstreamId: WorkstreamId): ShapeId {
  const task = getTask(db, getWorkstream(db, workstreamId).taskId);
  const pinned = getTaskContext(db, task.id);
  if (pinned) return pinned.shapeId;
  const link =
    findShapeLinkOfTask(db, task.id) ??
    (task.goalId ? findShapeLinkOfGoal(db, task.goalId) : undefined);
  if (!link) throw new InvalidError(NO_PLAN);
  return link.shapeId;
}

const snippet = (text: string): string =>
  text.length > SNIPPET ? `${text.slice(0, SNIPPET - 1)}…` : text;

/** The string values of an entry's stored body, in order, so a search never matches a field name. */
function bodyText(body: unknown): string {
  const out: string[] = [];
  const stack: unknown[] = [body];
  for (let at = stack.pop(); at !== undefined; at = stack.pop()) {
    if (typeof at === 'string') out.push(at);
    else if (typeof at === 'number') out.push(String(at));
    else if (Array.isArray(at)) {
      const items: readonly unknown[] = at;
      stack.push(...[...items].reverse());
    } else if (typeof at === 'object' && at !== null) {
      const values: readonly unknown[] = Object.values(at);
      stack.push(...[...values].reverse());
    }
  }
  return out.join(' ');
}

export function createPlanToolHandlers(
  db: DbReader,
  workstreamId: WorkstreamId,
): Pick<ToolHandlers, PlanToolName> {
  return {
    get_plan_section: ({ ref, revision }) =>
      Promise.resolve().then(() => {
        const shapeId = planOf(db, workstreamId);
        const parsed = parseSectionRef(ref);
        if (parsed === null) throw new InvalidError(`${ref} is not a doc#slug reference`);
        const document = findDocument(db, shapeId, parsed.document);
        if (!document) throw new NotFoundError('plan section', ref);
        const task = getTask(db, getWorkstream(db, workstreamId).taskId);
        const pinned = getTaskContext(db, task.id);
        const pinnedRevision = pinned
          ? getAttachmentRevisionById(db, pinned.revisionId)
          : undefined;
        const read =
          revision !== undefined
            ? getAttachmentRevision(db, document.id, revision)
            : pinnedRevision?.attachmentId === document.id
              ? pinnedRevision
              : listAttachmentRevisions(db, document.id).at(-1);
        if (!read) throw new NotFoundError('plan section', `${ref} (revision ${String(revision)})`);
        const sections = document.kind === 'eval' ? [] : read.sections;
        const entry = sections.find((s) => s.slug === parsed.section);
        if (!entry) throw new NotFoundError('plan section', ref);
        return {
          ref,
          document: parsed.document,
          revision: read.number,
          title: entry.title,
          text: sectionText(read.body, entry),
        };
      }),

    get_plan_entry: ({ key }) =>
      Promise.resolve().then((): Out<'get_plan_entry'> => {
        const shapeId = planOf(db, workstreamId);
        const entry = getShapeEntry(db, shapeId, key);
        if (entry) {
          const base = getWorkstreamRow(db, workstreamId).baseHead;
          const checks =
            base === null
              ? []
              : listAnchorChecks(db, workstreamId, base)
                  .filter((c) => c.entryKey === key && c.entryVersion === entry.version)
                  .map((c) => ({
                    entryKey: c.entryKey,
                    entryVersion: c.entryVersion,
                    anchorIndex: c.anchorIndex,
                    result: c.result,
                    line: c.line,
                    checkedCommit: c.checkedCommit,
                    note: c.note,
                    workstreamId: c.workstreamId,
                    at: c.createdAt,
                  }));
          return {
            kind: entry.kind,
            key,
            title: entry.title,
            version: entry.version,
            // The stored body was parsed by its kind's schema; as output it is plain JSON.
            body: z.json().parse(entry.body),
            anchors: entry.anchors,
            checks,
            sources: entry.sources,
            verified: entry.verified,
            checkedAt: entry.checkedAt,
            state: entry.state,
          };
        }
        const row = listShapeProposals(db, shapeId).find((r) => r.key === key);
        if (row?.kind === 'decision') {
          const d = ShapeProposalBody.decision.parse(row.body);
          return {
            kind: 'decision',
            key,
            question: d.question,
            choice: d.choice,
            rationale: d.rationale,
            alternatives: d.alternatives,
            quote: d.quote ?? null,
            lasting: d.lasting,
            state: row.state,
          };
        }
        if (row?.kind === 'question') {
          const q = ShapeProposalBody.question.parse(row.body);
          return { kind: 'question', key, text: q.text, for: q.for, blocks: q.blocks ?? null };
        }
        const finding = listShapeFindings(db, shapeId).find((f) => f.bundleKey === key);
        if (finding) {
          const at =
            finding.revisionId === null
              ? undefined
              : getAttachmentRevisionById(db, finding.revisionId);
          const document = at ? getDocumentAttachment(db, at.attachmentId) : undefined;
          return {
            kind: 'finding',
            key,
            document: document ? (document.docKey ?? document.key) : null,
            revision: at?.number ?? null,
            section: finding.section,
            reviewer: finding.reviewerName ?? finding.reviewer,
            severity: finding.severityText ?? finding.severity ?? finding.kind,
            text: finding.text,
            state: finding.state,
          };
        }
        throw new NotFoundError('plan entry', key);
      }),

    find_plan_entries: ({ query, kinds, limit }) =>
      Promise.resolve().then(() => {
        const shapeId = planOf(db, workstreamId);
        const wanted = (kind: PlanSearchKind): boolean =>
          kinds === undefined || kinds.includes(kind);
        const hits: Out<'find_plan_entries'>['hits'] = [];
        for (const e of listShapeEntries(db, shapeId)) {
          const body = bodyText(e.body);
          if (wanted(e.kind) && matchesSearch(`${e.title} ${body}`, query))
            hits.push({
              kind: e.kind,
              key: e.key,
              title: e.title,
              snippet: snippet(body),
              revision: null,
            });
        }
        for (const row of listShapeProposals(db, shapeId)) {
          if (row.kind === 'decision' && wanted('decision')) {
            const d = ShapeProposalBody.decision.parse(row.body);
            const text = `${d.question} ${d.choice} ${d.rationale}`;
            if (matchesSearch(text, query))
              hits.push({
                kind: 'decision',
                key: row.key,
                title: d.question,
                snippet: snippet(d.choice),
                revision: null,
              });
          } else if (row.kind === 'question' && wanted('question')) {
            const q = ShapeProposalBody.question.parse(row.body);
            if (matchesSearch(q.text, query))
              hits.push({
                kind: 'question',
                key: row.key,
                title: q.text,
                snippet: snippet(q.text),
                revision: null,
              });
          }
        }
        if (wanted('finding'))
          for (const f of listShapeFindings(db, shapeId))
            if (f.bundleKey !== null && matchesSearch(f.text, query))
              hits.push({
                kind: 'finding',
                key: f.bundleKey,
                title: f.text,
                snippet: snippet(f.text),
                revision: null,
              });
        if (wanted('section'))
          for (const doc of listDocuments(db, shapeId)) {
            if (doc.kind === 'eval') continue;
            const latest = listAttachmentRevisions(db, doc.id).at(-1);
            const body = latest?.body ?? doc.body;
            const index = latest?.sections ?? indexSections(body);
            for (const section of index) {
              const text = sectionText(body, section);
              if (matchesSearch(text, query))
                hits.push({
                  kind: 'section',
                  key: `${doc.documentKey}#${section.slug}`,
                  title: section.title,
                  snippet: snippet(text),
                  revision: latest?.number ?? null,
                });
            }
          }
        const kept = hits.slice(0, limit);
        return { hits: kept, empty: kept.length === 0 };
      }),
  };
}
