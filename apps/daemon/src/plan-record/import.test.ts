import {
  mintId,
  ShapeProposalBody,
  type PlanBundle,
  type ProjectDto,
  type ShapeId,
} from '@10db/contracts';
import {
  BUILDER_HANDLE,
  createTestStore,
  findDocument,
  getShape,
  getShapeEntry,
  insertPerson,
  listAttachmentRevisions,
  listEventsAfter,
  listShapeEntries,
  listShapeFindings,
  listShapeMessages,
  listShapeProposals,
  listShapes,
  patchShapeProposal,
  seedProject,
  type Store,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bundleJson, inlineBodies, P1_BODY, parseBundle } from '../../test/plan-bundle-fixture';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { importBundle, planImportChanges } from './import';
import { loadStoredRecord } from './lookup';
import { validateBundle } from './validate-bundle';

let store: Store;
let close: () => void;
let state: StateStore;
let project: ProjectDto;
beforeEach(() => {
  ({ store, close } = createTestStore());
  state = createStateStore(store, createEventBus());
  project = seedProject(store, { name: 'alpha' });
  store.write((ctx) => insertPerson(ctx, { handle: BUILDER_HANDLE, name: 'You', isBuilder: true }));
});
afterEach(() => {
  close();
});

/** Validates, plans and imports a bundle as the service does, in one write. */
function importInto(bundle: PlanBundle, projectOf: ProjectDto = project) {
  return state.write((ctx) => {
    const bodies = inlineBodies(bundle);
    const stored = loadStoredRecord(ctx.tx, projectOf.id, bundle.id);
    const issues = validateBundle({
      bundle,
      bodies,
      projectId: projectOf.id,
      areaNames: new Set(projectOf.areas.map((a) => a.name)),
      stored,
    });
    if (issues.length > 0) throw new Error(issues.map((i) => i.message).join('; '));
    const changes = planImportChanges(stored, bundle, bodies);
    return importBundle(ctx, { projectId: projectOf.id, bundle, bodies, changes });
  });
}

const AT_LATER = '2026-11-13T08:00:00.000Z';
const fresh = () => bundleJson(project.id);
const TABLES = [
  'shapes',
  'shape_messages',
  'shape_attachments',
  'shape_attachment_revisions',
  'shape_entries',
  'shape_entry_versions',
  'shape_findings',
  'shape_proposals',
] as const;
/** Row counts of the record's tables and the event log. */
function counts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of TABLES)
    out[t] = Number(store.db.$client.prepare(`SELECT count(*) AS n FROM ${t}`).pluck().get());
  out['events'] = listEventsAfter(store.db, 0, 100_000).length;
  return out;
}

function proposalBody(shapeId: ShapeId, key: string): unknown {
  return listShapeProposals(store.db, shapeId).find((p) => p.key === key)?.body;
}

describe('importBundle', () => {
  it('a bundle imports into one new Plan with everything readable', () => {
    const result = importInto(parseBundle(fresh()));
    expect(result).toMatchObject({ dryRun: false, created: true });
    const shape = getShape(store.db, result.shapeId);
    expect(shape).toMatchObject({ title: 'Remote host', state: 'proposed', round: 1 });
    expect(shape.importedAt).not.toBeNull();

    const p1 = findDocument(store.db, result.shapeId, 'p1');
    expect(p1 && Buffer.from(p1.body).equals(Buffer.from(P1_BODY))).toBe(true);
    expect(p1 && listAttachmentRevisions(store.db, p1.id)).toMatchObject([
      { number: 1, bundleNumber: 1, note: 'first', author: 'opus' },
    ]);
    expect(findDocument(store.db, result.shapeId, 's1')).toMatchObject({ kind: 'spec', key: 'g1' });

    expect(listShapeFindings(store.db, result.shapeId)).toMatchObject([
      {
        reviewer: 'imported',
        reviewerName: 'fable plan reviewer',
        severityText: 'blocking, security',
        outcomeText: 'partial: revoked-device column is a stub',
        state: 'resolved',
        round: 1,
        section: 'task-2',
        effortKey: 'p1',
        howDetail: 'The column exists; nothing writes it yet.',
      },
    ]);
    expect(listShapeFindings(store.db, result.shapeId)[0]?.revisionId).toBe(
      p1 && listAttachmentRevisions(store.db, p1.id)[0]?.id,
    );
    expect(listShapeEntries(store.db, result.shapeId).map((e) => [e.key, e.kind])).toEqual([
      ['i1', 'intent'],
      ['f1', 'fact'],
      ['n1', 'name'],
      ['x1', 'experiment'],
    ]);
    expect(getShapeEntry(store.db, result.shapeId, 'i1')?.title).toBe(
      'Plans never go in the repo.',
    );

    const decision = ShapeProposalBody.decision.parse(proposalBody(result.shapeId, 'd1'));
    expect(decision).toMatchObject({
      decidedAt: '2026-11-12',
      quote: 'Plans never go in the repo.',
      lasting: true,
      alternatives: [{ option: 'Docs PRs', whyNot: 'They land in the repo' }],
    });
    const goal = ShapeProposalBody.goal.parse(proposalBody(result.shapeId, 'g1'));
    expect(goal.tasks.map((t) => [t.key, t.planRef, t.size, t.cites])).toEqual([
      [
        't1',
        { document: 'p1', revision: 1, section: 'task-1', shared: ['calls-made'] },
        'S',
        ['f1', 'd1', 'i1', 'n1', 'x1'],
      ],
      ['t2', { document: 'p1', revision: 1, section: 'task-2', shared: ['calls-made'] }, 'M', []],
    ]);
    expect(goal.tasks[1]?.depends_on).toEqual(['t1']);
    expect(ShapeProposalBody.goal.parse(proposalBody(result.shapeId, 'g2')).tasks[0]).toMatchObject(
      { depends_on: [], dependsOnOutside: ['t1'] },
    );
    expect(ShapeProposalBody.question.parse(proposalBody(result.shapeId, 'q1'))).toMatchObject({
      for: 'designer',
      about: 't1',
      blocks: 'P2',
    });
    expect(
      listShapeMessages(store.db, result.shapeId).map((m) => [m.author, m.kind, m.body]),
    ).toEqual([
      [
        'note',
        'notice',
        'Imported from claude_code ses-abc (claude-opus-5-5) on 2026-11-12: 2 documents, 4 entries, 2 decisions, 1 findings, 1 questions, 4 tasks.',
      ],
    ]);
  });

  it('a loose task imports with its ceremony', () => {
    const { shapeId } = importInto(parseBundle(fresh()));
    expect(ShapeProposalBody.task.parse(proposalBody(shapeId, 't4'))).toMatchObject({
      ceremony: 'spec',
      size: 'L',
    });
  });

  it('the same bundle twice changes nothing', () => {
    importInto(parseBundle(fresh()));
    const before = counts();
    const again = importInto(parseBundle(fresh()));
    expect(again.created).toBe(false);
    expect(again.changes).toMatchObject({
      documents: [],
      entries: { added: [], changed: [], superseded: [] },
      findings: { added: [], changed: [] },
      proposals: { added: [], replaced: [], changeTasks: [], additions: [], leftAlone: [] },
    });
    expect(counts()).toEqual(before);
  });

  it('quotes cut across an emoji or ending in CRLF, imported three times, change nothing', () => {
    const json = () => {
      const out = fresh();
      out['intent'] = [
        {
          key: 'i1',
          quote: `${'a'.repeat(118)}\u{1F600} and on`,
          speaker: 'b',
          saidAt: '2026-11-12',
        },
        { key: 'i2', quote: 'First line\r\nsecond', speaker: 'b', saidAt: '2026-11-12' },
      ];
      return parseBundle(out);
    };
    const first = importInto(json());
    expect(getShapeEntry(store.db, first.shapeId, 'i2')?.title).toBe('First line');
    expect(getShapeEntry(store.db, first.shapeId, 'i1')?.title).toBe(
      `${'a'.repeat(118)}\u{1F600}…`,
    );
    importInto(json());
    const before = counts();
    importInto(json());
    expect(counts()).toEqual(before);
  });

  it('a dry run writes nothing and answers what a real import then writes', () => {
    const bundle = parseBundle(fresh());
    const before = counts();
    const preview = planImportChanges(
      loadStoredRecord(store.db, project.id, bundle.id),
      bundle,
      inlineBodies(bundle),
    );
    expect(counts()).toEqual(before);
    expect(importInto(bundle).changes).toEqual(preview);
    expect(preview.proposals.added).toEqual(['g1', 'g2', 't4', 'l1', 'd1', 'd2', 'q1']);
  });

  it('re-import appends revision 2 only', () => {
    const { shapeId } = importInto(parseBundle(fresh()));
    const next = fresh();
    const docs = next['documents'] as { revisions: unknown[] }[];
    docs[0]?.revisions.push({ number: 2, body: `${P1_BODY}## Task 4: More\n`, at: AT_LATER });
    const again = importInto(parseBundle(next));
    expect(again.changes.documents).toEqual([{ key: 'p1', added: [2] }]);
    const p1 = findDocument(store.db, shapeId, 'p1');
    expect(p1 && listAttachmentRevisions(store.db, p1.id).map((r) => r.number)).toEqual([1, 2]);
    expect(listShapeMessages(store.db, shapeId).at(-1)?.body).toMatch(/^Re-imported from/);
  });

  it('re-import versions a changed fact and supersedes a dropped one', () => {
    const { shapeId } = importInto(parseBundle(fresh()));
    const next = fresh();
    const entries = next['entries'] as Record<string, unknown>[];
    next['entries'] = entries
      .filter((e) => e['key'] !== 'n1')
      .map((e) => (e['key'] === 'f1' ? { ...e, body: { claim: 'The runner packs twice.' } } : e));
    // n1 is cited by t1; the cite goes with it.
    const goals = next['goals'] as { tasks: Record<string, unknown>[] }[];
    const t1 = goals[0]?.tasks[0];
    if (t1) t1['cites'] = ['f1', 'd1', 'i1', 'x1'];
    const again = importInto(parseBundle(next));
    expect(again.changes.entries).toEqual({ added: [], changed: ['f1'], superseded: ['n1'] });
    expect(getShapeEntry(store.db, shapeId, 'f1')).toMatchObject({
      version: 2,
      body: { claim: 'The runner packs twice.' },
    });
    expect(getShapeEntry(store.db, shapeId, 'n1')).toMatchObject({
      version: 2,
      state: 'superseded',
    });
  });

  it('re-import replaces a pending task and keeps a pinned one', () => {
    const { shapeId } = importInto(parseBundle(fresh()));
    const pinned = listShapeProposals(store.db, shapeId).find((p) => p.key === 'g2');
    store.write((ctx) => {
      if (pinned) patchShapeProposal(ctx, pinned.id, { pinned: ['title'] });
    });
    const next = fresh();
    const tasks = next['tasks'] as Record<string, unknown>[];
    if (tasks[0]) tasks[0]['title'] = 'Document pairing well';
    const goals = next['goals'] as Record<string, unknown>[];
    if (goals[1]) goals[1]['title'] = 'Showing, renamed';
    const again = importInto(parseBundle(next));
    expect(again.changes.proposals).toMatchObject({ replaced: ['t4'], keptPinned: ['g2'] });
    expect(ShapeProposalBody.task.parse(proposalBody(shapeId, 't4')).title).toBe(
      'Document pairing well',
    );
    expect(ShapeProposalBody.goal.parse(proposalBody(shapeId, 'g2')).title).toBe('Showing');
  });

  it('a failure midway writes nothing', () => {
    const bundle = parseBundle(fresh());
    const before = counts();
    const last = bundle.questions[0];
    // Past the bundle's own schema, so only the proposal body's parse refuses it.
    const broken: PlanBundle = { ...bundle, questions: last ? [{ ...last, text: '' }] : [] };
    expect(() => importInto(broken)).toThrow();
    expect(counts()).toEqual(before);
    expect(listShapes(store.db, project.id)).toEqual([]);
  });
});

describe('an import writes only its own Plan', () => {
  it('a second project’s bundle with the same id makes a second Plan', () => {
    const other = seedProject(store, { name: 'beta' });
    const first = importInto(parseBundle(fresh()));
    const second = importInto(parseBundle(bundleJson(other.id)), other);
    expect(second.created).toBe(true);
    expect(second.shapeId).not.toBe(first.shapeId);
    expect(listShapes(store.db, project.id).map((s) => s.id)).toEqual([first.shapeId]);
  });

  it('re-import never touches another Plan with the same keys', () => {
    const a = importInto(parseBundle(fresh()));
    const b = importInto(parseBundle({ ...fresh(), id: 'remote-host.copy' }));
    const snapshot = () => ({
      entries: listShapeEntries(store.db, b.shapeId),
      findings: listShapeFindings(store.db, b.shapeId),
      proposals: listShapeProposals(store.db, b.shapeId),
      messages: listShapeMessages(store.db, b.shapeId),
    });
    const before = snapshot();
    const next = fresh();
    const entries = next['entries'] as Record<string, unknown>[];
    if (entries[0]) entries[0]['title'] = 'Changed in a only';
    const tasks = next['tasks'] as Record<string, unknown>[];
    if (tasks[0]) tasks[0]['title'] = 'Changed in a only';
    const again = importInto(parseBundle(next));
    expect(again.shapeId).toBe(a.shapeId);
    expect(again.changes.entries.changed).toEqual(['f1']);
    expect(snapshot()).toEqual(before);
  });

  it('a bundle naming another project is refused before any write', () => {
    const before = counts();
    expect(() => importInto(parseBundle(bundleJson(mintId('Project'))))).toThrow(/another project/);
    expect(counts()).toEqual(before);
  });
});
