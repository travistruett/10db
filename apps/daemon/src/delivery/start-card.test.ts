import { unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConflictError, type TaskId, TaskStatus } from '@10db/contracts';
import {
  getBatch,
  getTask,
  insertSession,
  insertWorkstream,
  listBatches,
  listInbox,
  listWorkstreams,
  setTaskStatus,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { createInboxService, type InboxService } from '../inbox';
import { forTasks, startCards, startTitle } from './cards';
import { createStartCardAnswers, StartChoice } from './index';

let h: DeliveryHarness;
let inbox: InboxService;
beforeEach(() => {
  h = createDeliveryHarness({}, { trigger: false });
  inbox = createInboxService({
    state: h.state,
    onParkedAnswer: () => undefined,
    onFlagAnswer: createStartCardAnswers({ state: h.state, starter: h.starter }),
  });
});
afterEach(() => {
  h.close();
});

/** Refuses a start of `title`'s tasks because the checkout is dirty; returns the card. */
async function refusedStart(...titles: string[]) {
  const tasks = titles.map((t, i) => h.addTask(t, { areas: [i === 0 ? 'api' : 'ui'] }));
  writeFileSync(join(h.repo, 'scratch.txt'), 'uncommitted\n');
  h.starter.startBatch(h.project.id, { title: 'Greetings', taskIds: tasks.map((t) => t.id) });
  await h.jobs.idle();
  return { tasks, card: h.only(h.cards()) };
}

describe('the answers of a refused start', () => {
  it('offers Retry start and Cancel task, never a bare dismiss', async () => {
    const { card } = await refusedStart('Alpha');
    expect(card.options.map((o) => o.label)).toEqual([StartChoice.Retry, StartChoice.Cancel]);
    expect(card.options.every((o) => o.description.length > 0)).toBe(true);
  });

  it('starts the same tasks again on Retry start, closing the card', async () => {
    const { tasks, card } = await refusedStart('Alpha', 'Beta');
    unlinkSync(join(h.repo, 'scratch.txt'));
    inbox.answer(card.id, { choice: StartChoice.Retry });
    await h.jobs.idle();
    const batch = h.only(listBatches(h.store.db));
    // The card kept the builder's title, so the retried batch (and its pull request) still has it.
    expect(batch).toMatchObject({ title: 'Greetings', state: 'OPEN' });
    expect(
      listWorkstreams(h.store.db, { batchId: batch.id })
        .map((w) => w.taskId)
        .sort(),
    ).toEqual(tasks.map((t) => t.id).sort());
    expect(h.cards()).toEqual([]);
  });

  it('raises a fresh card when the retried start is refused again', async () => {
    const { card } = await refusedStart('Alpha');
    inbox.answer(card.id, { choice: StartChoice.Retry });
    await h.jobs.idle();
    const again = h.only(h.cards());
    expect(again.id).not.toBe(card.id);
    expect(again.options.map((o) => o.label)).toEqual([StartChoice.Retry, StartChoice.Cancel]);
    expect(listInbox(h.store.db, { states: ['RESOLVED'] }).map((i) => i.id)).toEqual([card.id]);
  });

  it('cancels the tasks it names on Cancel task, and starts nothing', async () => {
    const { tasks, card } = await refusedStart('Alpha', 'Beta');
    inbox.answer(card.id, { choice: StartChoice.Cancel });
    await h.jobs.idle();
    for (const t of tasks) expect(getTask(h.store.db, t.id).status).toBe(TaskStatus.Cancelled);
    expect(listBatches(h.store.db)).toEqual([]);
    expect(h.cards()).toEqual([]);
  });

  /**
   * Refuses a restart of a task that ran before (its run settled to `state` by `settle`) for an
   * unfinished dependency, which is refused before any new run is inserted. Answers Cancel task
   * and checks the task retires with its earlier run kept as the latest.
   */
  function cancelRefusedRestart(settle: (taskId: TaskId) => { id: string }) {
    const base = h.addTask('Base', { areas: ['ui'] });
    const task = h.addTask('Alpha', { areas: ['api'], dependsOn: [base.id] });
    const earlier = settle(task.id);
    expect(() =>
      h.starter.startBatch(h.project.id, { title: 'Again', taskIds: [task.id] }),
    ).toThrow(ConflictError);
    const card = h.only(h.cards());
    // No new run went in: the earlier run is still the task's latest.
    expect(listWorkstreams(h.store.db, {}).map((w) => w.id)).toEqual([earlier.id]);
    expect(card.options.map((o) => o.label)).toContain(StartChoice.Cancel);
    inbox.answer(card.id, { choice: StartChoice.Cancel });
    expect(getTask(h.store.db, task.id).status).toBe(TaskStatus.Cancelled);
    expect(h.cards()).toEqual([]);
    // The earlier run stays as history.
    expect(listWorkstreams(h.store.db, {}).map((w) => w.id)).toEqual([earlier.id]);
  }

  it('cancels a task that ran before and failed, when its restart is refused', () => {
    cancelRefusedRestart((taskId) => {
      const earlier = h.state.write((w) => insertWorkstream(w, taskId));
      h.settle(earlier.id, 'FAILED');
      return earlier;
    });
  });

  it('cancels a task whose latest run was cancelled in Factory, when its restart is refused', () => {
    cancelRefusedRestart((taskId) => {
      const earlier = h.state.write((w) => insertWorkstream(w, taskId));
      h.state.write((w) =>
        insertSession(w, {
          workstreamId: earlier.id,
          provider: 'claude',
          model: 'sonnet',
          effort: 'medium',
          mode: 'managed',
          mcpTokenHash: 'hash-factory-cancel',
        }),
      );
      h.settle(earlier.id, 'CANCELLED');
      return earlier;
    });
  });

  it('cancels a reopened task, whose latest run finished, when its restart is refused', () => {
    cancelRefusedRestart((taskId) => {
      const earlier = h.state.write((w) => insertWorkstream(w, taskId));
      h.settle(earlier.id, 'DONE');
      // reopenTask leaves the task open with its finished run as the latest.
      h.state.write((w) => {
        setTaskStatus(w, taskId, 'open');
      });
      return earlier;
    });
  });

  it('titles a repeated start after its first task, and keeps the title within 200 characters', () => {
    const one = h.addTask('Alpha');
    expect(startTitle([one])).toBe('Alpha');
    const long = h.addTask('x'.repeat(200));
    const title = startTitle([long, one, one]);
    expect(title).toHaveLength(200);
    expect(title.endsWith(' and 2 more')).toBe(true);
  });

  it('offers Cancel task alone for the tasks of a CI fix batch, whose start cannot be repeated', () => {
    const card = forTasks(startCards.notStarted(new Error('boom')), [h.addTask('Fix').id], null);
    expect(card.options?.map((o) => o.label)).toEqual([StartChoice.Cancel]);
  });

  it('keeps unfinished-dependency refusals answerable: retry stays refused until the dependency is done', () => {
    const base = h.addTask('Base', { areas: ['api'] });
    const top = h.addTask('Top', { areas: ['ui'], dependsOn: [base.id] });
    expect(() => h.starter.startBatch(h.project.id, { title: 'Top', taskIds: [top.id] })).toThrow(
      ConflictError,
    );
    const card = h.only(h.cards());
    expect(card.options.map((o) => o.label)).toEqual([StartChoice.Retry, StartChoice.Cancel]);
    expect(() => inbox.answer(card.id, { choice: StartChoice.Retry })).toThrow(ConflictError);
    expect(h.cards().map((c) => c.id)).toEqual([card.id]);
  });

  it('retries a fix task refused for an unfinished dependency into the copy batch it named', async () => {
    const base = h.addTask('Base', { areas: ['api'] });
    const first = h.addTask('First', { areas: ['ui'], workspaceMode: 'worktree' });
    const batch = h.only(
      h.starter.startBatch(h.project.id, { title: 'First', taskIds: [first.id] }),
    );
    await h.jobs.idle();
    expect(getBatch(h.store.db, batch.id).state).toBe('OPEN');
    const fix = h.addTask('Fix', {
      areas: ['ui'],
      workspaceMode: 'worktree',
      dependsOn: [base.id],
    });
    expect(() =>
      h.starter.startBatch(h.project.id, { title: 'Fix', taskIds: [fix.id], batchId: batch.id }),
    ).toThrow(ConflictError);
    const card = h.only(h.cards());
    expect(card.options.map((o) => o.label)).toEqual([StartChoice.Retry, StartChoice.Cancel]);
    h.state.write((w) => {
      setTaskStatus(w, base.id, TaskStatus.Done);
    });
    inbox.answer(card.id, { choice: StartChoice.Retry });
    await h.jobs.idle();
    expect(listBatches(h.store.db).map((b) => b.id)).toEqual([batch.id]);
    expect(listWorkstreams(h.store.db, { batchId: batch.id }).map((w) => w.taskId)).toEqual([
      first.id,
      fix.id,
    ]);
    expect(h.cards()).toEqual([]);
  });

  it('retries a refused join with the batch it named', async () => {
    const first = h.addTask('First', { areas: ['api'] });
    const batch = h.only(
      h.starter.startBatch(h.project.id, { title: 'Greetings', taskIds: [first.id] }),
    );
    await h.jobs.idle();
    const fix = h.addTask('Fix', { areas: ['api'] });
    h.git$('switch', '-q', '-c', 'elsewhere');
    h.starter.startBatch(h.project.id, {
      title: 'Greetings',
      taskIds: [fix.id],
      batchId: batch.id,
    });
    await h.jobs.idle();
    const card = h.only(h.cards());
    expect(card.options.map((o) => o.label)).toEqual([StartChoice.Retry, StartChoice.Cancel]);
    h.git$('switch', '-q', getBatch(h.store.db, batch.id).branch ?? '');
    inbox.answer(card.id, { choice: StartChoice.Retry });
    await h.jobs.idle();
    expect(listWorkstreams(h.store.db, { batchId: batch.id }).map((w) => w.taskId)).toContain(
      fix.id,
    );
    expect(h.cards()).toEqual([]);
  });
});
