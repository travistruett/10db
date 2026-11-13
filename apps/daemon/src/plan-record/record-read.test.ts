import { ShapeOrigin, type ProjectDto, type ShapeId } from '@10db/contracts';
import {
  createTestStore,
  insertShape,
  seedProject,
  upsertShapeAttachment,
  type Store,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { readPlanRecord, readPlanRevision } from './record-read';
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
