import { ConflictError, type BatchDto, type TaskDto } from '@10db/contracts';
import {
  getBatch,
  getTask,
  insertLandingGroup,
  listBatches,
  listWorkstreams,
  transitionBatch,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { NOTICE_KEY } from './notices';

// Shape spec §10.4. Tasks of one landing group start into one batch, so one pull request; a task of
// the group started later joins that batch while it is open, and makes a new one once it has shipped.

let h: DeliveryHarness;
beforeEach(() => {
  h = createDeliveryHarness({ workspaceMode: 'worktree' }, { trigger: false });
});
afterEach(() => {
  h.close();
});

/** A landing group of the tasks, written as Convert writes it. */
function landing(title: string, tasks: readonly TaskDto[]): void {
  h.state.write((w) =>
    insertLandingGroup(w, {
      projectId: h.project.id,
      title,
      taskIds: tasks.map((t) => t.id),
    }),
  );
}

function batchOf(task: TaskDto): BatchDto {
  const ws = listBatches(h.store.db)
    .flatMap((b) => listWorkstreams(h.store.db, { batchId: b.id }).map((w) => [b, w.taskId]))
    .find(([, id]) => id === task.id);
  if (!ws) throw new Error(`${task.title} is in no batch`);
  return ws[0] as BatchDto;
}

describe('starting the tasks of a landing', () => {
  it('puts two unrelated ready tasks of one landing in one batch, titled after the landing', async () => {
    const [a, b, c] = ['Alpha', 'Beta', 'Gamma'].map((t) => h.addTask(t));
    if (!a || !b || !c) throw new Error('tasks');
    landing('Real areas', [a, c]);
    const started = h.starter.startBatch(h.project.id, {
      title: 'Start',
      taskIds: [a.id, b.id, c.id],
    });
    expect(started.map((x) => x.title)).toEqual(['Real areas', 'Beta']);
    await h.jobs.idle();
    const [landed, alone] = started.map((x) => getBatch(h.store.db, x.id));
    if (!landed || !alone) throw new Error('two batches expected');
    expect(landed.state).toBe('OPEN');
    expect(listWorkstreams(h.store.db, { batchId: landed.id }).map((w) => w.taskId)).toEqual([
      a.id,
      c.id,
    ]);
    expect(listWorkstreams(h.store.db, { batchId: alone.id }).map((w) => w.taskId)).toEqual([b.id]);
  });

  it('starts a single-placement set of no landing exactly as it did', async () => {
    const tasks = ['Alpha', 'Beta'].map((t) => h.addTask(t));
    const started = h.starter.startBatch(h.project.id, {
      title: 'Start',
      taskIds: tasks.map((t) => t.id),
    });
    expect(started.map((x) => x.title)).toEqual(['Alpha', 'Beta']);
    await h.jobs.idle();
  });

  it('refuses a landing whose tasks work in different places, and starts nothing', () => {
    const a = h.addTask('Alpha', { workspaceMode: 'worktree' });
    const b = h.addTask('Beta', { workspaceMode: 'shared' });
    landing('Real areas', [a, b]);
    expect(() =>
      h.starter.startBatch(h.project.id, { title: 'Start', taskIds: [a.id, b.id] }),
    ).toThrow(/Real areas.*different places|share a pull request/);
    expect(listBatches(h.store.db)).toEqual([]);
  });

  it('refuses a landing whose tasks land differently', () => {
    const a = h.addTask('Alpha');
    const b = h.addTask('Beta', { landing: { kind: 'hold' } });
    landing('Real areas', [a, b]);
    expect(() =>
      h.starter.startBatch(h.project.id, { title: 'Start', taskIds: [a.id, b.id] }),
    ).toThrow(ConflictError);
    expect(listBatches(h.store.db)).toEqual([]);
  });
});

describe('a late task of a landing', () => {
  it("joins the landing's open batch instead of making its own", async () => {
    const a = h.addTask('Alpha');
    const b = h.addTask('Beta');
    landing('Real areas', [a, b]);
    const [first] = h.starter.startBatch(h.project.id, { title: 'Start', taskIds: [a.id] });
    await h.jobs.idle();
    if (!first) throw new Error('no batch');
    const joined = h.starter.startBatch(h.project.id, { title: 'Start', taskIds: [b.id] });
    expect(joined.map((x) => x.id)).toEqual([first.id]);
    await h.jobs.idle();
    expect(listBatches(h.store.db)).toHaveLength(1);
    expect(listWorkstreams(h.store.db, { batchId: first.id }).map((w) => w.taskId)).toEqual([
      a.id,
      b.id,
    ]);
    expect(getBatch(h.store.db, first.id).notices).toEqual([]);
    expect(getTask(h.store.db, b.id).workspaceMode).toBe('worktree');
  });

  it("is refused while the landing's batch is shipping, saying why", async () => {
    const a = h.addTask('Alpha');
    const b = h.addTask('Beta');
    landing('Real areas', [a, b]);
    const [first] = h.starter.startBatch(h.project.id, { title: 'Start', taskIds: [a.id] });
    await h.jobs.idle();
    if (!first) throw new Error('no batch');
    h.state.write((w) => transitionBatch(w, first.id, { to: 'SHIPPING' }));
    expect(() => h.starter.startBatch(h.project.id, { title: 'Start', taskIds: [b.id] })).toThrow(
      /Beta.*Real areas.*shipping/i,
    );
    expect(listBatches(h.store.db)).toHaveLength(1);
  });

  it('makes a new batch once the landing has shipped, with a notice saying why', async () => {
    const a = h.addTask('Alpha');
    const b = h.addTask('Beta');
    landing('Real areas', [a, b]);
    const [first] = h.starter.startBatch(h.project.id, { title: 'Start', taskIds: [a.id] });
    await h.jobs.idle();
    if (!first) throw new Error('no batch');
    h.state.write((w) => {
      transitionBatch(w, first.id, { to: 'SHIPPING' });
      transitionBatch(w, first.id, { to: 'SHIPPED' });
    });
    const [second] = h.starter.startBatch(h.project.id, { title: 'Start', taskIds: [b.id] });
    if (!second) throw new Error('no second batch');
    expect(second.id).not.toBe(first.id);
    await h.jobs.idle();
    expect(batchOf(b).id).toBe(second.id);
    const notice = getBatch(h.store.db, second.id).notices.find(
      (n) => n.key === NOTICE_KEY.landingShipped,
    );
    expect(notice?.line).toContain('Real areas');
    expect(notice?.body).toContain(first.title);
    // The batch that shipped says nothing new.
    expect(getBatch(h.store.db, first.id).notices).toEqual([]);
  });

  it('a task alone in its landing starts as any task does, with no notice', async () => {
    const a = h.addTask('Alpha');
    landing('Real areas', [a]);
    const [batch] = h.starter.startBatch(h.project.id, { title: 'Start', taskIds: [a.id] });
    await h.jobs.idle();
    if (!batch) throw new Error('no batch');
    expect(getBatch(h.store.db, batch.id).notices).toEqual([]);
  });
});
