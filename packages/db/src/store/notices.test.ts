import type { Notice } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearBatchNotice,
  clearWorkstreamNotices,
  createTestStore,
  getBatch,
  getWorkstream,
  insertBatch,
  insertTask,
  insertWorkstream,
  seedProject,
  setBatchNotice,
  setWorkstreamNotice,
  type Store,
} from './index';

let store: Store;
let close: () => void;
beforeEach(() => {
  ({ store, close } = createTestStore());
});
afterEach(() => {
  close();
});

const conflict: Notice = {
  key: 'base-conflict',
  tone: 'warning',
  line: 'Conflicts with main',
  body: 'src/a.ts',
};

function seed() {
  const project = seedProject(store, { delivery: 'pull_request' });
  const batch = store.write((ctx) =>
    insertBatch(ctx, { projectId: project.id, title: 'Greetings', baseBranch: 'main' }),
  ).value;
  const task = store.write((ctx) =>
    insertTask(ctx, project.id, { title: 'Alpha', acceptanceCriteria: ['x'], areas: ['api'] }),
  ).value;
  const workstream = store.write((ctx) =>
    insertWorkstream(ctx, task.id, { batchId: batch.id }),
  ).value;
  return { batch, workstream };
}

describe('batch notices', () => {
  it('a batch starts with none', () => {
    expect(seed().batch.notices).toEqual([]);
  });

  it('sets a notice and tells clients the batch changed', () => {
    const { batch } = seed();
    const { value, events } = store.write((ctx) => setBatchNotice(ctx, batch.id, conflict));
    expect(value).toBe(true);
    expect(getBatch(store.db, batch.id).notices).toEqual([conflict]);
    expect(events.map((e) => [e.type, e.entityId])).toEqual([['batch.updated', batch.id]]);
  });

  it('a notice that says what is already there writes nothing and tells no one', () => {
    const { batch } = seed();
    store.write((ctx) => setBatchNotice(ctx, batch.id, conflict));
    const before = getBatch(store.db, batch.id).updatedAt;
    const { value, events } = store.write((ctx) => setBatchNotice(ctx, batch.id, conflict));
    expect(value).toBe(false);
    expect(events).toEqual([]);
    expect(getBatch(store.db, batch.id).updatedAt).toBe(before);
  });

  it('a notice with the same key replaces the old one; another key stands beside it', () => {
    const { batch } = seed();
    const other: Notice = {
      key: 'in-the-way',
      tone: 'warning',
      line: 'Files in the way',
      body: '',
    };
    store.write((ctx) => setBatchNotice(ctx, batch.id, conflict));
    store.write((ctx) => setBatchNotice(ctx, batch.id, other));
    store.write((ctx) => setBatchNotice(ctx, batch.id, { ...conflict, body: 'src/b.ts' }));
    expect(getBatch(store.db, batch.id).notices).toEqual([
      { ...conflict, body: 'src/b.ts' },
      other,
    ]);
  });

  it('clears a notice by key, and clearing one that is not there does nothing', () => {
    const { batch } = seed();
    store.write((ctx) => setBatchNotice(ctx, batch.id, conflict));
    const none = store.write((ctx) => clearBatchNotice(ctx, batch.id, 'nope'));
    expect(none.value).toBe(false);
    expect(none.events).toEqual([]);
    const cleared = store.write((ctx) => clearBatchNotice(ctx, batch.id, conflict.key));
    expect(cleared.value).toBe(true);
    expect(getBatch(store.db, batch.id).notices).toEqual([]);
  });
});

describe('workstream notices', () => {
  const waiting: Notice = {
    key: 'claim-wait',
    tone: 'info',
    line: 'Waiting for hazard migrations: task "Beta" holds it',
    body: 'x',
  };

  it('a workstream starts with none', () => {
    expect(seed().workstream.notice).toBeNull();
  });

  it('sets and clears the notice, telling clients only when it changed', () => {
    const { workstream } = seed();
    const set = store.write((ctx) => setWorkstreamNotice(ctx, workstream.id, waiting));
    expect(set.value).toBe(true);
    expect(getWorkstream(store.db, workstream.id).notice).toEqual(waiting);
    expect(set.events.length).toBeGreaterThan(0);
    const again = store.write((ctx) => setWorkstreamNotice(ctx, workstream.id, waiting));
    expect(again.value).toBe(false);
    expect(again.events).toEqual([]);
    const cleared = store.write((ctx) => setWorkstreamNotice(ctx, workstream.id, null));
    expect(cleared.value).toBe(true);
    expect(getWorkstream(store.db, workstream.id).notice).toBeNull();
  });

  it('clears every run’s notice at once, as a restart does', () => {
    const { workstream } = seed();
    store.write((ctx) => setWorkstreamNotice(ctx, workstream.id, waiting));
    const { value } = store.write((ctx) => clearWorkstreamNotices(ctx));
    expect(value).toEqual([workstream.id]);
    expect(getWorkstream(store.db, workstream.id).notice).toBeNull();
  });
});
