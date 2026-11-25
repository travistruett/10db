import type { TaskDto } from '@10db/contracts';
import {
  createTestStore,
  getTask,
  insertBatch,
  insertLocalCopy,
  insertTask,
  schema,
  type Store,
} from '@10db/db';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { seedWorkstream } from '../../test/fixtures';
import type { Gh, GhCall } from '../github';
import { unmergedDependencies } from './deps';

// A dependency whose run landed from a separate copy (a Commit Directly project) shipped with no
// pull request: it is on the local base branch, so it never counts as unmerged.

let close: () => void = () => undefined;
afterEach(() => {
  close();
});

/** A dependency done in a SHIPPED batch with no pull request, and a task that depends on it. */
function shippedDependency(opts: { copy: boolean }) {
  const test = createTestStore();
  close = test.close;
  const store: Store = test.store;
  const { project, task: dep, workstream } = seedWorkstream(store);
  const dependent = store.write((ctx) => {
    const batch = insertBatch(ctx, { projectId: project.id, title: 'Landed', baseBranch: 'main' });
    ctx.tx
      .update(schema.batches)
      .set({ state: 'SHIPPED' })
      .where(eq(schema.batches.id, batch.id))
      .run();
    ctx.tx
      .update(schema.workstreams)
      .set({ batchId: batch.id, state: 'DONE' })
      .where(eq(schema.workstreams.id, workstream.id))
      .run();
    if (opts.copy) insertLocalCopy(ctx, { batchId: batch.id, teardownCommand: 'true' });
    return insertTask(ctx, project.id, {
      title: 'Next',
      acceptanceCriteria: ['it works'],
      areas: ['api'],
      dependsOn: [dep.id],
    });
  }).value;
  const next = insertBatchId(store);
  return { store, dependent: getTask(store.db, dependent.id), dep, next };
}

function insertBatchId(store: Store) {
  const project = store.db.select().from(schema.projects).get();
  if (!project) throw new Error('no project');
  return store.write((ctx) =>
    insertBatch(ctx, { projectId: project.id, title: 'Next', baseBranch: 'main' }),
  ).value.id;
}

// The network is the one boundary: a pull request lookup is never made for a batch with none.
const gh = {
  prView: () => Promise.reject(new Error('no pull request to read')),
} as unknown as Gh;
const call = {} as GhCall;

function check(s: { store: Store; dependent: TaskDto; next: ReturnType<typeof insertBatchId> }) {
  return unmergedDependencies({
    db: s.store.db,
    gh,
    call,
    tasks: [s.dependent],
    inBatch: new Set([s.dependent.id]),
    batchId: s.next,
  });
}

describe('unmergedDependencies', () => {
  it('counts a dependency that landed from a separate copy as on the base', async () => {
    const s = shippedDependency({ copy: true });
    expect(await check(s)).toEqual([]);
  });

  it('still refuses a dependency shipped in a batch with no pull request and no copy', async () => {
    const s = shippedDependency({ copy: false });
    const found = await check(s);
    expect(found.map((f) => f.reason)).toEqual(['its batch "Landed" has no pull request']);
  });
});
