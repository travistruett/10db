import { unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getBatch, listBatches, listWorkstreams } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { createInboxService, type InboxService } from '../inbox';
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
