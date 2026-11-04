import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConflictError, InboxKind, mintId } from '@10db/contracts';
import {
  getBatch,
  getInboxItem,
  getWorkstream,
  insertToolOp,
  listWorkstreams,
  transitionBatch,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { createInboxService, type InboxService } from '../inbox';
import { retryWorkstream } from '../team';
import { batchCardFields, createBatchCardAnswers } from './index';

let h: DeliveryHarness;
let inbox: InboxService;
let retries: { id: string; note: string | undefined }[];
beforeEach(() => {
  retries = [];
  h = createDeliveryHarness();
  inbox = createInboxService({
    state: h.state,
    onParkedAnswer: () => undefined,
    onFlagAnswer: createBatchCardAnswers({
      retry: (id, note) => {
        retries.push({ id, note });
        retryWorkstream(h.state, id, note);
      },
      shipper: h.shipper,
    }),
  });
});
afterEach(() => {
  h.close();
});

/**
 * A batch of Alpha (failed, with its card) and Beta (left in `beta`), with one commit on its branch.
 * `alphaFiles` are commits Alpha made through the commit tool, before Beta's.
 */
async function failedInBatch(
  beta: 'WAITING_HUMAN' | 'DONE' | 'CANCELLED',
  alphaFiles: Record<string, string> = {},
) {
  const alpha = h.addTask('Alpha');
  const other = h.addTask('Beta', { areas: ['ui'] });
  const started = h.only(
    h.starter.startBatch(h.project.id, {
      title: 'Greetings',
      taskIds: [alpha.id, other.id],
    }),
  );
  await h.jobs.idle();
  const [a, b] = listWorkstreams(h.store.db, { batchId: started.id });
  if (!a || !b) throw new Error('two workstreams expected');
  for (const [path, content] of Object.entries(alphaFiles)) {
    const sha = h.commit(path, content);
    h.state.write((w) => {
      insertToolOp(w, {
        workstreamId: a.id,
        sessionId: mintId('Session'),
        opId: `op-${path}`,
        tool: 'commit',
        result: { sha, alreadyCommitted: false },
      });
    });
  }
  h.commit('src/ui/beta.txt');
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
    expect(card.options.map((o) => o.label)).toEqual([
      'Retry',
      'Ship anyway',
      'Ship without it',
      'Later',
    ]);
    expect(card.detail).toEqual({ batchCard: { batchId, workstreamId: failed } });
    expect(batchCardFields({ id: failed, batchId: null })).toBeNull();
  });

  it('says beside Ship anyway that the failed task’s commits will be in the pull request', async () => {
    const { card } = await failedInBatch('DONE');
    const describe = (label: string) => card.options.find((o) => o.label === label)?.description;
    expect(describe('Ship anyway')).toMatch(/its commits will be in the pull request/i);
    expect(describe('Ship without it')).toMatch(/reverts its commits on the batch branch/i);
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

  it.each([
    {
      name: 'a typed note',
      answer: { choice: 'Retry', note: 'Reuse the card.' },
      note: 'Reuse the card.',
    },
    { name: 'no note', answer: { choice: 'Retry' }, note: undefined },
    { name: 'a blank note', answer: { choice: 'Retry', note: '  ' }, note: undefined },
  ])('hands the retry $name', async ({ answer, note }) => {
    const { card, failed } = await failedInBatch('DONE');
    inbox.answer(card.id, answer);
    expect(retries).toEqual([{ id: failed, note }]);
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

  it('refuses Ship anyway in a failed batch with unfinished work instead of reopening it, then ships', async () => {
    const { card, batchId } = await failedInBatch('WAITING_HUMAN');
    h.state.write((c) =>
      transitionBatch(c, batchId, { to: 'FAILED', patch: { failure: 'wrong_branch' } }),
    );
    expect(() => inbox.answer(card.id, { choice: 'Ship anyway' })).toThrow(
      /still has unfinished work: Beta \(waiting_human\)/,
    );
    expect(getInboxItem(h.store.db, card.id).state).toBe('OPEN');
    expect(getBatch(h.store.db, batchId)).toMatchObject({
      state: 'FAILED',
      failure: 'wrong_branch',
    });
    const beta = listWorkstreams(h.store.db, { batchId }).find((w) => w.state === 'WAITING_HUMAN');
    if (!beta) throw new Error('Beta waits');
    h.settle(beta.id, 'DONE');
    expect(inbox.answer(card.id, { choice: 'Ship anyway' }).state).toBe('RESOLVED');
    await h.jobs.idle();
    expect(getBatch(h.store.db, batchId).state).toBe('SHIPPED');
  });

  describe('Ship without it', () => {
    it('opens a pull request with every other task’s changes and none of the failed one’s, from one revert commit naming it', async () => {
      const { card, batchId, failed } = await failedInBatch('DONE', {
        'src/api/alpha-1.txt': 'one\n',
        'src/api/alpha-2.txt': 'two\n',
      });
      expect(inbox.answer(card.id, { choice: 'Ship without it' }).state).toBe('RESOLVED');
      await h.jobs.idle();

      const shipped = getBatch(h.store.db, batchId);
      expect(shipped.state).toBe('SHIPPED');
      const branch = shipped.branch ?? '';
      expect(h.origin$('diff', '--name-only', 'main', branch)).toBe('src/ui/beta.txt');
      const subjects = h
        .origin$('log', '--format=%s', `main..${branch}`)
        .split('\n')
        .filter((s) => s.startsWith('revert'));
      expect(subjects).toEqual(['revert: leave out "Alpha"']);
      expect(h.git$('status', '--porcelain', '--untracked-files=all')).toBe('');

      // The task's drawer says so; the pull request's body leaves its work out of "What and why".
      const alpha = getWorkstream(h.store.db, failed);
      expect(alpha.notice).toMatchObject({
        key: 'left-out',
        line: 'Left out of the pull request: its 2 commits were reverted',
      });
      const body = h.gh.body(shipped.prUrl ?? '');
      expect(body).toContain('- Alpha (failed, left out of this pull request)');
      expect(body).not.toContain('### Alpha');
    });

    it('ships the rest, with no revert commit, when the failed task committed nothing', async () => {
      const { card, batchId, failed } = await failedInBatch('DONE');
      expect(inbox.answer(card.id, { choice: 'Ship without it' }).state).toBe('RESOLVED');
      await h.jobs.idle();

      const shipped = getBatch(h.store.db, batchId);
      expect(shipped.state).toBe('SHIPPED');
      expect(h.origin$('log', '--format=%s', `main..${shipped.branch ?? ''}`)).toBe(
        'Add src/ui/beta.txt',
      );
      expect(getWorkstream(h.store.db, failed).notice?.line).toBe(
        'Left out of the pull request: it had no commits to revert',
      );
    });

    it('ships nothing and raises a card naming the files when the revert conflicts', async () => {
      const { card, batchId, failed } = await failedInBatch('DONE', {
        'src/api/shared.txt': 'alpha\n',
      });
      // Beta built on Alpha's file, so undoing Alpha's commit can't be done cleanly.
      h.commit('src/api/shared.txt', 'alpha\nbeta\n');
      const tip = h.git$('rev-parse', 'HEAD');

      expect(inbox.answer(card.id, { choice: 'Ship without it' }).state).toBe('RESOLVED');
      await h.jobs.idle();

      expect(getBatch(h.store.db, batchId).state).toBe('OPEN');
      expect(h.gh.prCreates()).toEqual([]);
      expect(h.git$('rev-parse', 'HEAD')).toBe(tip);
      expect(getWorkstream(h.store.db, failed).notice).toBeNull();
      const conflict = h.only(h.cards().filter((c) => c.title.includes('conflict')));
      expect(conflict.title).toBe('Alpha was not left out: reverting its commits conflicts');
      expect(conflict.body).toContain('- src/api/shared.txt');
      expect(conflict.body).toMatch(/Nothing was shipped/);
    });

    it('ships nothing and says so when uncommitted changes are in a file the revert writes', async () => {
      const { card, batchId } = await failedInBatch('DONE', { 'src/api/alpha.txt': 'alpha\n' });
      writeFileSync(join(h.repo, 'src/api/alpha.txt'), 'edited\n');

      inbox.answer(card.id, { choice: 'Ship without it' });
      await h.jobs.idle();

      expect(getBatch(h.store.db, batchId).state).toBe('OPEN');
      expect(h.gh.prCreates()).toEqual([]);
      const blocked = h.only(h.cards().filter((c) => c.title.includes('was not left out')));
      expect(blocked.body).toContain('- src/api/alpha.txt');
      expect(blocked.body).toMatch(/uncommitted/i);
    });

    it('refuses while other work is unfinished, keeping the card open', async () => {
      const { card } = await failedInBatch('WAITING_HUMAN');
      expect(() => inbox.answer(card.id, { choice: 'Ship without it' })).toThrow(
        /still has unfinished work: Beta \(waiting_human\)/,
      );
      expect(getInboxItem(h.store.db, card.id).state).toBe('OPEN');
    });

    it('refuses when no other task finished, since nothing would be left to ship', async () => {
      const { card } = await failedInBatch('CANCELLED');
      expect(() => inbox.answer(card.id, { choice: 'Ship without it' })).toThrow(ConflictError);
      expect(() => inbox.answer(card.id, { choice: 'Ship without it' })).toThrow(
        /no other task in batch "Greetings" finished/,
      );
      expect(getInboxItem(h.store.db, card.id).state).toBe('OPEN');
    });
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
