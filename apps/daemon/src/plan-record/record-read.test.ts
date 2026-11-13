import { ShapeOrigin, type ProjectDto, type ShapeId, type TaskId } from '@10db/contracts';
import {
  createTestStore,
  findDocument,
  getAttachmentRevision,
  insertAnchorChecks,
  insertShape,
  insertTask,
  insertWorkstream,
  seedProject,
  upsertShapeAttachment,
  upsertTaskContext,
  type Store,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bundleJson, inlineBodies, parseBundle } from '../../test/plan-bundle-fixture';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { importBundle, planImportChanges } from './import';
import { loadStoredRecord } from './lookup';
import { readPlanRecord, readPlanRevision, readTaskPlanContext } from './record-read';
import { appendRevision } from './revisions';

// The Record view's reads over a real database: what a Plan holds reads back as the row it is.

let store: Store;
let close: () => void;
let state: StateStore;
let project: ProjectDto;
beforeEach(() => {
  ({ store, close } = createTestStore());
  state = createStateStore(store, createEventBus());
  project = seedProject(store, { name: 'alpha' });
});
afterEach(() => {
  close();
});

const META = { note: null, author: null, bundleNumber: null, authoredAt: null } as const;

/** A conversation's Plan with a goal's spec (`write_spec`) and its eval (Convert), both keyed `g1`. */
function specAndEval(): ShapeId {
  return state.write((ctx) => {
    const shape = insertShape(ctx, project.id, { title: 'Pairing', origin: ShapeOrigin.App });
    for (const [kind, body] of [
      ['spec', '# Pairing spec\n'],
      ['eval', '{"checks":[]}'],
    ] as const) {
      const id = upsertShapeAttachment(ctx, { shapeId: shape.id, kind, key: 'g1', body });
      appendRevision(ctx, id, body, META);
    }
    return shape.id;
  });
}

describe('readPlanRevision', () => {
  it('a spec and an eval on one goal each read back their own text', () => {
    const shapeId = specAndEval();
    const docs = readPlanRecord(store.db, shapeId).documents;
    expect(docs.map((d) => [d.key, d.kind])).toEqual([
      ['g1', 'spec'],
      ['g1', 'eval'],
    ]);
    expect(new Set(docs.map((d) => d.id)).size).toBe(2);
    expect(
      docs.map((d) => {
        const revision = readPlanRevision(store.db, shapeId, d.id, 1);
        return [revision.key, revision.body];
      }),
    ).toEqual([
      ['g1', '# Pairing spec\n'],
      ['g1', '{"checks":[]}'],
    ]);
  });

  it("another Plan's document is not found through this one", () => {
    const shapeId = specAndEval();
    const other = specAndEval();
    const [theirs] = readPlanRecord(store.db, other).documents;
    if (!theirs) throw new Error('no document');
    expect(() => readPlanRevision(store.db, shapeId, theirs.id, 1)).toThrow('not found');
  });
});

type Json = Record<string, unknown>;

function importJson(json: Json): ShapeId {
  const bundle = parseBundle(json);
  const bodies = inlineBodies(bundle);
  return state.write(
    (ctx) =>
      importBundle(ctx, {
        projectId: project.id,
        bundle,
        bodies,
        changes: planImportChanges(loadStoredRecord(ctx.tx, project.id, bundle.id), bundle, bodies),
      }).shapeId,
  );
}

/** A task pinned to p1's Task 1, citing f1. */
function pinnedTask(shapeId: ShapeId): TaskId {
  const doc = findDocument(store.db, shapeId, 'p1');
  const revision = doc && getAttachmentRevision(store.db, doc.id, 1);
  if (!revision) throw new Error('no revision');
  return state.write((ctx) => {
    const task = insertTask(ctx, project.id, {
      title: 'Pair',
      description: '',
      acceptanceCriteria: ['x'],
      areas: ['api'],
    });
    upsertTaskContext(ctx, {
      taskId: task.id,
      shapeId,
      revisionId: revision.id,
      section: 'task-1',
      shared: [],
      cites: ['f1'],
    });
    return task.id;
  });
}

describe('readTaskPlanContext', () => {
  it("shows only the checks of each fact's current version", () => {
    const shapeId = importJson(bundleJson(project.id));
    const taskId = pinnedTask(shapeId);
    const ws = state.write((ctx) =>
      insertWorkstream(ctx, taskId, { first: { model: 'claude-sonnet-5-5', effort: 'medium' } }),
    );
    const check = (entryVersion: number, result: 'current' | 'changed') => ({
      workstreamId: ws.id,
      entryKey: 'f1',
      entryVersion,
      anchorIndex: 0,
      result,
      line: result === 'current' ? 3 : null,
      checkedCommit: 'abc123',
      note: null,
    });
    state.write((ctx) => {
      insertAnchorChecks(ctx, taskId, [check(1, 'current')]);
    });
    const next = bundleJson(project.id);
    const [f1] = next['entries'] as Json[];
    if (f1) f1['body'] = { claim: 'The runner packs twice.' };
    importJson(next);
    // The same run, at the same base, checks the new version too.
    state.write((ctx) => {
      insertAnchorChecks(ctx, taskId, [check(2, 'changed')]);
    });
    expect(
      readTaskPlanContext(store.db, taskId).checks.map((c) => [
        c.entryKey,
        c.entryVersion,
        c.result,
      ]),
    ).toEqual([['f1', 2, 'changed']]);
  });
});
