import { ConflictError, InboxKind } from '@10db/contracts';
import { getBatch, getInboxItem, getWorkstream, listWorkstreams, transitionBatch } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { createInboxService, type InboxService } from '../inbox';
import { retryWorkstream } from '../team';
import { batchCardFields, createBatchCardAnswers } from './index';

let h: DeliveryHarness;
let inbox: InboxService;
beforeEach(() => {
  h = createDeliveryHarness();
  inbox = createInboxService({
    state: h.state,
    onParkedAnswer: () => undefined,
    onFlagAnswer: createBatchCardAnswers({
      retry: (id) => {
        retryWorkstream(h.state, id);
      },
      ship: (batchId) => {
        h.shipper.ship(batchId);
      },
    }),
  });
});
afterEach(() => {
  h.close();
});

/** A batch of Alpha (failed, with its card) and Beta (left in `beta`), with one commit on its branch. */
async function failedInBatch(beta: 'WAITING_HUMAN' | 'DONE') {
  const alpha = h.addTask('Alpha');
  const other = h.addTask('Beta', { areas: ['ui'] });
  const started = h.starter.startBatch(h.project.id, {
    title: 'Greetings',
    taskIds: [alpha.id, other.id],
  });
  await h.jobs.idle();
  h.commit('src/ui/beta.txt');
  const [a, b] = listWorkstreams(h.store.db, { batchId: started.id });
  if (!a || !b) throw new Error('two workstreams expected');
  h.settle(b.id, beta);
  h.settle(a.id, 'FAILED');
  const fields = batchCardFields({ id: a.id, batchId: started.id });
  if (!fields) throw new Error('a batch member gets card actions');
  const card = inbox.flag({
    projectId: h.project.id,
    workstreamId: a.id,
    title: 'Workstream failed: Alpha',
    body: 'The gate failed 4 times',
    ...fields,
  });
  return { batchId: started.id, failed: a.id, card };
}

describe('the failed workstream card', () => {
  it('offers Retry, Ship anyway and Later only for a workstream in a batch', async () => {
    const { card, batchId, failed } = await failedInBatch('DONE');
    expect(card.options.map((o) => o.label)).toEqual(['Retry', 'Ship anyway', 'Later']);
    expect(card.detail).toEqual({ batchCard: { batchId, workstreamId: failed } });
    expect(batchCardFields({ id: failed, batchId: null })).toBeNull();
  });

  it('retries the workstream, reopening a failed batch', async () => {
    const { card, batchId, failed } = await failedInBatch('DONE');
    h.state.write((c) =>
      transitionBatch(c, batchId, { to: 'FAILED', patch: { failure: 'gate_failed' } }),
    );
    expect(inbox.answer(card.id, { choice: 'Retry' }).state).toBe('RESOLVED');
    expect(getWorkstream(h.store.db, failed).state).toBe('QUEUED');
    expect(getBatch(h.store.db, batchId).state).toBe('OPEN');
  });

  it('refuses Ship anyway while other work is unfinished, keeping the card open, then ships', async () => {
    const { card, batchId } = await failedInBatch('WAITING_HUMAN');
    expect(() => inbox.answer(card.id, { choice: 'Ship anyway' })).toThrow(ConflictError);
    expect(getInboxItem(h.store.db, card.id).state).toBe('OPEN');
    const beta = listWorkstreams(h.store.db, { batchId }).find((w) => w.state === 'WAITING_HUMAN');
    if (!beta) throw new Error('Beta waits');
    h.settle(beta.id, 'DONE');
    expect(inbox.answer(card.id, { choice: 'Ship anyway' }).state).toBe('RESOLVED');
    await h.jobs.idle();
    expect(getBatch(h.store.db, batchId).state).toBe('SHIPPED');
  });

  it('does nothing for Later, and leaves other flag cards alone', async () => {
    const { card, batchId, failed } = await failedInBatch('DONE');
    expect(inbox.answer(card.id, { choice: 'Later' }).state).toBe('RESOLVED');
    expect(getWorkstream(h.store.db, failed).state).toBe('FAILED');
    expect(getBatch(h.store.db, batchId).state).toBe('OPEN');
    const plain = inbox.flag({
      projectId: h.project.id,
      workstreamId: null,
      title: 'FYI',
      body: '',
    });
    expect(plain.kind).toBe(InboxKind.Flag);
    expect(inbox.answer(plain.id, { choice: 'dismiss' }).state).toBe('RESOLVED');
  });
});
