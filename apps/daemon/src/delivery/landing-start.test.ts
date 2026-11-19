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
  it('puts two unrelated ready tasks of one landing in one batch, titled after the landing; starts a set of no landing, and a task alone in its landing, as it did, with no notice', async () => {
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

    // A single-placement set of no landing.
    const plain = ['Delta', 'Epsilon'].map((t) => h.addTask(t));
    const separate = h.starter.startBatch(h.project.id, {
      title: 'Start',
      taskIds: plain.map((t) => t.id),
    });
    expect(separate.map((x) => x.title)).toEqual(['Delta', 'Epsilon']);
    await h.jobs.idle();

    // A task alone in its landing.
    const solo = h.addTask('Zeta');
    landing('Solo', [solo]);
    const [batch] = h.starter.startBatch(h.project.id, { title: 'Start', taskIds: [solo.id] });
    await h.jobs.idle();
    if (!batch) throw new Error('no batch');
    expect(getBatch(h.store.db, batch.id).notices).toEqual([]);
  });

  it('refuses a landing whose tasks work in different places, or land differently, and starts nothing', () => {
    const a = h.addTask('Alpha', { workspaceMode: 'worktree' });
    const b = h.addTask('Beta', { workspaceMode: 'shared' });
    landing('Real areas', [a, b]);
    expect(() =>
      h.starter.startBatch(h.project.id, { title: 'Start', taskIds: [a.id, b.id] }),
    ).toThrow(/Real areas.*different places|share a pull request/);
    expect(listBatches(h.store.db)).toEqual([]);

    const merging = h.addTask('Gamma');
    const held = h.addTask('Delta', { landing: { kind: 'hold' } });
    landing('Other areas', [merging, held]);
    expect(() =>
      h.starter.startBatch(h.project.id, { title: 'Start', taskIds: [merging.id, held.id] }),
    ).toThrow(ConflictError);
    expect(listBatches(h.store.db)).toEqual([]);
  });
});

describe('a late task of a landing', () => {
  it("joins the landing's open batch instead of making its own, is refused while that batch ships, saying why, and makes a new batch with a notice once it has shipped", async () => {
    const a = h.addTask('Alpha');
    const b = h.addTask('Beta');
    const c = h.addTask('Gamma');
    landing('Real areas', [a, b, c]);
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

    h.state.write((w) => transitionBatch(w, first.id, { to: 'SHIPPING' }));
    expect(() => h.starter.startBatch(h.project.id, { title: 'Start', taskIds: [c.id] })).toThrow(
      /Gamma.*Real areas.*shipping/i,
    );
    expect(listBatches(h.store.db)).toHaveLength(1);

    h.state.write((w) => transitionBatch(w, first.id, { to: 'SHIPPED' }));
    const [second] = h.starter.startBatch(h.project.id, { title: 'Start', taskIds: [c.id] });
    if (!second) throw new Error('no second batch');
    expect(second.id).not.toBe(first.id);
    await h.jobs.idle();
    expect(batchOf(c).id).toBe(second.id);
    const notice = getBatch(h.store.db, second.id).notices.find(
      (n) => n.key === NOTICE_KEY.landingShipped,
    );
    expect(notice?.line).toContain('Real areas');
    expect(notice?.body).toContain(first.title);
    // The batch that shipped says nothing new.
    expect(getBatch(h.store.db, first.id).notices).toEqual([]);
  });
});
