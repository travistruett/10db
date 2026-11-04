import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConflictError, InboxKind, mintId, type BatchId, type WorkstreamId } from '@10db/contracts';
import {
  getBatch,
  getEvidence,
  getInboxItem,
  getWorkstream,
  insertToolOp,
  listEvidence,
  listWorkstreams,
  setTaskStatus,
  setWorkstreamNotice,
  transitionBatch,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { createInboxService, type InboxService } from '../inbox';
import {
  commitResultAsStored,
  insertPlannedWorkstream,
  planForStart,
  retryWorkstream,
} from '../team';
import { leftOutCards } from './cards';
import { raise } from './context';
import { batchCardFields, createBatchCardAnswers } from './index';
import { leftOutNotices } from './notices';

let h: DeliveryHarness;
let inbox: InboxService;
let retries: { id: string; note: string | undefined }[];

/** The inbox the builder answers through, with the card's answers wired to `h`. */
function answering(): InboxService {
  return createInboxService({
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
}

beforeEach(() => {
  retries = [];
  h = createDeliveryHarness();
  inbox = answering();
});
afterEach(() => {
  h.close();
});

/** Records `path` as a commit `workstreamId` made through the commit tool. */
function commitAs(workstreamId: WorkstreamId, path: string, content: string): string {
  const sha = h.commit(path, content);
  h.state.write((w) => {
    insertToolOp(w, {
      workstreamId,
      sessionId: mintId('Session'),
      opId: `op-${path}-${sha}`,
      tool: 'commit',
      result: { sha, alreadyCommitted: false },
    });
  });
  return sha;
}

/** Commits `path` for `workstreamId` and stores the result as the commit tool does, from the branch. */
async function commitAsTheToolRecords(
  workstreamId: WorkstreamId,
  path: string,
  content: string,
): Promise<string> {
  const sha = h.commit(path, content);
  const result = await commitResultAsStored(h.git, h.repo, { sha, alreadyCommitted: false });
  h.state.write((w) => {
    insertToolOp(w, {
      workstreamId,
      sessionId: mintId('Session'),
      opId: `op-${path}-${sha}`,
      tool: 'commit',
      result,
    });
  });
  return sha;
}

/** What 10db's base merge commits to the branch for a session to resolve. */
const MARKED_README = '<<<<<<< HEAD\n# ours\n||||||| base\n=======\n# theirs\n>>>>>>> main\n';

/** The failed card the runner raises for a run in a batch. */
function failedCard(workstreamId: WorkstreamId, batchId: BatchId) {
  const fields = batchCardFields({ id: workstreamId, batchId });
  if (!fields) throw new Error('a batch member gets card actions');
  return inbox.flag({
    projectId: h.project.id,
    workstreamId,
    title: 'Workstream failed',
    body: 'The review step rejected the work',
    ...fields,
  });
}

/** A batch of Alpha and Beta, both failed with commits, and Gamma, done. */
async function twoFailedInBatch() {
  const tasks = [h.addTask('Alpha'), h.addTask('Beta'), h.addTask('Gamma', { areas: ['ui'] })];
  const started = h.only(
    h.starter.startBatch(h.project.id, { title: 'Greetings', taskIds: tasks.map((t) => t.id) }),
  );
  await h.jobs.idle();
  const [a, b, c] = listWorkstreams(h.store.db, { batchId: started.id });
  if (!a || !b || !c) throw new Error('three workstreams expected');
  commitAs(a.id, 'src/api/alpha.txt', 'alpha\n');
  commitAs(b.id, 'src/api/beta.txt', 'beta\n');
  h.commit('src/ui/gamma.txt');
  h.settle(c.id, 'DONE');
  h.settle(a.id, 'FAILED');
  h.settle(b.id, 'FAILED');
  return { batchId: started.id, alpha: a.id, beta: b.id, betaTask: b.taskId };
}

/**
 * Alpha finished with a commit and the shipping gate sent it to merge in the same batch, where that
 * second run failed at its limit, having committed `merged`. Beta is done.
 */
async function failedInItsMerge(merged: (run: WorkstreamId) => void, batchTitle = 'Greetings') {
  const alpha = h.addTask('Alpha');
  const other = h.addTask('Beta', { areas: ['ui'] });
  const started = h.only(
    h.starter.startBatch(h.project.id, { title: batchTitle, taskIds: [alpha.id, other.id] }),
  );
  await h.jobs.idle();
  const [a, b] = listWorkstreams(h.store.db, { batchId: started.id });
  if (!a || !b) throw new Error('two workstreams expected');
  commitAs(a.id, 'src/api/alpha.txt', 'alpha\n');
  h.commit('src/ui/beta.txt');
  h.settle(a.id, 'DONE');
  const merge = h.state.write((w) => {
    setTaskStatus(w, alpha.id, 'open');
    return insertPlannedWorkstream(w, alpha.id, planForStart(w.tx, alpha.id), started.id);
  });
  merged(merge.id);
  h.settle(merge.id, 'FAILED');
  h.settle(b.id, 'DONE');
  return { batchId: started.id, merge: merge.id, card: failedCard(merge.id, started.id) };
}

/**
 * A batch of Alpha (failed, with its card) and Beta (left in `beta`), with one commit on its branch.
 * `alphaFiles` are commits Alpha made through the commit tool, before Beta's.
 */
async function failedInBatch(
  beta: 'WAITING_HUMAN' | 'DONE' | 'CANCELLED',
  alphaFiles: Record<string, string> = {},
  batchTitle = 'Greetings',
) {
  const alpha = h.addTask('Alpha');
  const other = h.addTask('Beta', { areas: ['ui'] });
  const started = h.only(
    h.starter.startBatch(h.project.id, {
      title: batchTitle,
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
    expect(describe('Ship without it')).toMatch(/every other task that failed .* is left out too/i);
  });

  it('says beside Retry what happens once the task is set to work somewhere else', async () => {
    // The card is written when the run fails and a placement change doesn't touch it, so it says this
    // up front: the daemon refuses that Retry.
    const { card } = await failedInBatch('DONE');
    const retry = card.options.find((o) => o.label === 'Retry')?.description;
    expect(retry).toMatch(/run this workstream again in its batch/i);
    expect(retry).toMatch(/set to work somewhere else/i);
    expect(retry).toMatch(/refused/i);
    expect(retry).toMatch(/set it back/i);
    expect(retry).toMatch(/start it over/i);
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

  describe('the title of a batch named after a task that left it', () => {
    it('is not the name of a superseded attempt that committed nothing', async () => {
      const { batchId, failed } = await failedInBatch('DONE', {}, 'Alpha');
      const alphaTask = getWorkstream(h.store.db, failed).taskId;
      // Alpha starts over fresh: the old attempt drops out of the batch, which ships by itself.
      h.state.write((w) => {
        insertPlannedWorkstream(w, alphaTask, planForStart(w.tx, alphaTask), null);
      });
      h.shipper.checkBatch(batchId);
      await h.jobs.idle();
      expect(getBatch(h.store.db, batchId).state).toBe('SHIPPED');
      expect(h.gh.prCreates().map((c) => c.title)).toEqual(['feat(app): beta']);
    });

    it('is not the name of a cancelled task whose work is not in it', async () => {
      const { batchId } = await failedInBatch('DONE', {}, 'Alpha');
      const alpha = listWorkstreams(h.store.db, { batchId }).find((w) => w.taskTitle === 'Alpha');
      if (!alpha) throw new Error('Alpha is a member');
      h.settle(alpha.id, 'CANCELLED');
      h.shipper.checkBatch(batchId);
      await h.jobs.idle();
      expect(getBatch(h.store.db, batchId).state).toBe('SHIPPED');
      expect(h.gh.prCreates().map((c) => c.title)).toEqual(['feat(app): beta']);
    });

    it('stays the name of a cancelled task whose commits are in the branch', async () => {
      const { batchId } = await failedInBatch('DONE', { 'src/api/alpha.txt': 'alpha\n' }, 'Alpha');
      const alpha = listWorkstreams(h.store.db, { batchId }).find((w) => w.taskTitle === 'Alpha');
      if (!alpha) throw new Error('Alpha is a member');
      h.settle(alpha.id, 'CANCELLED');
      h.shipper.checkBatch(batchId);
      await h.jobs.idle();
      expect(h.gh.prCreates().map((c) => c.title)).toEqual(['feat(app): alpha']);
    });

    it('stays the name of a superseded attempt whose commits Ship anyway puts in', async () => {
      const { card, failed } = await failedInBatch(
        'DONE',
        { 'src/api/alpha.txt': 'alpha\n' },
        'Alpha',
      );
      const alphaTask = getWorkstream(h.store.db, failed).taskId;
      h.state.write((w) => {
        insertPlannedWorkstream(w, alphaTask, planForStart(w.tx, alphaTask), null);
      });
      inbox.answer(card.id, { choice: 'Ship anyway' });
      await h.jobs.idle();
      expect(h.gh.prCreates().map((c) => c.title)).toEqual(['feat(app): alpha']);
    });

    it('is not the name of a closed task that committed nothing', async () => {
      const { card, failed } = await failedInBatch('DONE', {}, 'Alpha');
      const alphaTask = getWorkstream(h.store.db, failed).taskId;
      h.state.write((w) => {
        setTaskStatus(w, alphaTask, 'cancelled');
      });
      inbox.answer(card.id, { choice: 'Ship anyway' });
      await h.jobs.idle();
      expect(h.gh.prCreates().map((c) => c.title)).toEqual(['feat(app): beta']);
    });

    it('stays the name of a closed task whose commits Ship anyway puts in', async () => {
      const { card, failed } = await failedInBatch(
        'DONE',
        { 'src/api/alpha.txt': 'alpha\n' },
        'Alpha',
      );
      const alphaTask = getWorkstream(h.store.db, failed).taskId;
      h.state.write((w) => {
        setTaskStatus(w, alphaTask, 'cancelled');
      });
      inbox.answer(card.id, { choice: 'Ship anyway' });
      await h.jobs.idle();
      expect(h.gh.prCreates().map((c) => c.title)).toEqual(['feat(app): alpha']);
    });

    it('stays the name of a task started over when an earlier run’s work is on the branch', async () => {
      // The merge run failed having committed nothing, so it drops out, but the first run's commit stays.
      const { batchId, merge } = await failedInItsMerge(() => undefined, 'Alpha');
      const alphaTask = getWorkstream(h.store.db, merge).taskId;
      h.state.write((w) => {
        insertPlannedWorkstream(w, alphaTask, planForStart(w.tx, alphaTask), null);
      });
      h.shipper.checkBatch(batchId);
      await h.jobs.idle();
      expect(h.gh.prCreates().map((c) => c.title)).toEqual(['feat(app): alpha']);
    });
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

    it('does not title the pull request after the task it left out', async () => {
      const { card, batchId } = await failedInBatch('DONE', {}, 'Alpha');
      inbox.answer(card.id, { choice: 'Ship without it' });
      await h.jobs.idle();
      expect(getBatch(h.store.db, batchId).state).toBe('SHIPPED');
      expect(h.gh.prCreates().map((c) => c.title)).toEqual(['feat(app): beta']);
    });

    it('keeps the batch’s title when it is not the left-out task’s name', async () => {
      const { card } = await failedInBatch('DONE');
      inbox.answer(card.id, { choice: 'Ship without it' });
      await h.jobs.idle();
      expect(h.gh.prCreates().map((c) => c.title)).toEqual(['feat(app): greetings']);
    });

    it('keeps a batch named after the failed task when Ship anyway puts its commits in', async () => {
      const { card } = await failedInBatch('DONE', {}, 'Alpha');
      inbox.answer(card.id, { choice: 'Ship anyway' });
      await h.jobs.idle();
      expect(h.gh.prCreates().map((c) => c.title)).toEqual(['feat(app): alpha']);
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

    it('offers Ship without it again on the card of a stopped revert, which ships with no failed-task file', async () => {
      const { card, batchId } = await failedInBatch('DONE', { 'src/api/alpha.txt': 'alpha\n' });
      writeFileSync(join(h.repo, 'src/api/alpha.txt'), 'edited\n');
      inbox.answer(card.id, { choice: 'Ship without it' });
      await h.jobs.idle();
      const stopped = h.only(h.cards().filter((c) => c.title.includes('was not left out')));
      expect(stopped.options.map((o) => o.label)).toEqual([
        'Retry',
        'Ship anyway',
        'Ship without it',
        'Later',
      ]);
      expect(stopped.body).not.toMatch(/ship again/i);
      expect(stopped.body).toMatch(/answer Ship without it/);

      writeFileSync(join(h.repo, 'src/api/alpha.txt'), 'alpha\n');
      expect(inbox.answer(stopped.id, { choice: 'Ship without it' }).state).toBe('RESOLVED');
      await h.jobs.idle();

      const shipped = getBatch(h.store.db, batchId);
      expect(shipped.state).toBe('SHIPPED');
      expect(h.origin$('diff', '--name-only', 'main', shipped.branch ?? '')).toBe(
        'src/ui/beta.txt',
      );
    });

    it('says to answer it again on the conflict card too, never to ship again', async () => {
      const { card } = await failedInBatch('DONE', { 'src/api/shared.txt': 'alpha\n' });
      h.commit('src/api/shared.txt', 'alpha\nbeta\n');
      inbox.answer(card.id, { choice: 'Ship without it' });
      await h.jobs.idle();
      const conflict = h.only(h.cards().filter((c) => c.title.includes('conflict')));
      expect(conflict.options.map((o) => o.label)).toContain('Ship without it');
      expect(conflict.body).not.toMatch(/ship again/i);
    });

    it('leaves out every failed task in one revert commit naming them, and closes the other’s card', async () => {
      const { batchId, alpha, beta } = await twoFailedInBatch();
      const alphaCard = failedCard(alpha, batchId);
      const betaCard = failedCard(beta, batchId);

      expect(inbox.answer(alphaCard.id, { choice: 'Ship without it' }).state).toBe('RESOLVED');
      await h.jobs.idle();

      const shipped = getBatch(h.store.db, batchId);
      expect(shipped.state).toBe('SHIPPED');
      const branch = shipped.branch ?? '';
      expect(h.origin$('diff', '--name-only', 'main', branch)).toBe('src/ui/gamma.txt');
      const subjects = h
        .origin$('log', '--format=%s', `main..${branch}`)
        .split('\n')
        .filter((s) => s.startsWith('revert'));
      expect(subjects).toEqual(['revert: leave out "Alpha", "Beta"']);
      for (const id of [alpha, beta])
        expect(getWorkstream(h.store.db, id).notice).toMatchObject({
          key: 'left-out',
          line: 'Left out of the pull request: its commit was reverted',
        });
      const body = h.gh.body(shipped.prUrl ?? '');
      expect(body).toContain('- Alpha (failed, left out of this pull request)');
      expect(body).toContain('- Beta (failed, left out of this pull request)');
      expect(getInboxItem(h.store.db, betaCard.id).state).toBe('CANCELLED');
    });

    it('leaves out a superseded attempt’s commits with the failed task’s, and clears its notice', async () => {
      const { batchId, alpha, betaTask } = await twoFailedInBatch();
      h.state.write((w) => {
        insertPlannedWorkstream(w, betaTask, planForStart(w.tx, betaTask), null);
      });
      h.shipper.checkBatch(batchId);
      expect(h.only(getBatch(h.store.db, batchId).notices).key).toBe('superseded-attempt');

      inbox.answer(failedCard(alpha, batchId).id, { choice: 'Ship without it' });
      await h.jobs.idle();

      const shipped = getBatch(h.store.db, batchId);
      expect(shipped.state).toBe('SHIPPED');
      expect(h.origin$('diff', '--name-only', 'main', shipped.branch ?? '')).toBe(
        'src/ui/gamma.txt',
      );
      expect(shipped.notices).toEqual([]);
    });

    it('reverts the commits of every run the task made in the batch, its merge run’s too', async () => {
      const { card, batchId } = await failedInItsMerge((run) => {
        commitAs(run, 'src/api/alpha-merge.txt', 'merge\n');
      });

      inbox.answer(card.id, { choice: 'Ship without it' });
      await h.jobs.idle();

      const shipped = getBatch(h.store.db, batchId);
      expect(shipped.state).toBe('SHIPPED');
      expect(h.origin$('diff', '--name-only', 'main', shipped.branch ?? '')).toBe(
        'src/ui/beta.txt',
      );
    });

    it('ships nothing and raises a card when the revert would bring conflict markers back', async () => {
      const { card, batchId, merge } = await failedInItsMerge((run) => {
        h.commit('src/api/merged.txt', '<<<<<<< ours\na\n=======\nb\n>>>>>>> theirs\n');
        commitAs(run, 'src/api/merged.txt', 'a\nb\n');
      });
      const tip = h.git$('rev-parse', 'HEAD');

      inbox.answer(card.id, { choice: 'Ship without it' });
      await h.jobs.idle();

      expect(getBatch(h.store.db, batchId).state).toBe('OPEN');
      expect(h.gh.prCreates()).toEqual([]);
      expect(h.git$('rev-parse', 'HEAD')).toBe(tip);
      expect(getWorkstream(h.store.db, merge).notice).toBeNull();
      const stopped = h.only(h.cards().filter((c) => c.title.includes('was not left out')));
      expect(stopped.title).toBe('Alpha was not left out: its commits resolved conflict markers');
      expect(stopped.body).toContain('- src/api/merged.txt');
      expect(stopped.options.map((o) => o.label)).toContain('Ship without it');
    });

    describe('when it stops between the answer and the job', () => {
      it('raises a card saying a waiting update paused the ship, and offers the answer again', async () => {
        let draining = false;
        h.close();
        h = createDeliveryHarness({}, { holdShips: () => draining });
        inbox = answering();
        const { card, batchId } = await failedInBatch('DONE', { 'src/api/alpha.txt': 'alpha\n' });
        const tip = h.git$('rev-parse', 'HEAD');

        expect(inbox.answer(card.id, { choice: 'Ship without it' }).state).toBe('RESOLVED');
        draining = true;
        await h.jobs.idle();

        expect(getBatch(h.store.db, batchId).state).toBe('OPEN');
        expect(h.git$('rev-parse', 'HEAD')).toBe(tip);
        const stopped = h.only(h.cards().filter((c) => c.title.includes('was not left out')));
        expect(stopped.title).toMatch(/waiting update/);
        expect(stopped.body).toMatch(/Nothing was shipped and the branch is unchanged/);
        expect(stopped.options.map((o) => o.label)).toContain('Ship without it');

        draining = false;
        expect(inbox.answer(stopped.id, { choice: 'Ship without it' }).state).toBe('RESOLVED');
        await h.jobs.idle();
        expect(getBatch(h.store.db, batchId).state).toBe('SHIPPED');
      });

      it('raises a card when the batch moved on, with no answer to give', async () => {
        const { card, batchId } = await failedInBatch('DONE', { 'src/api/alpha.txt': 'alpha\n' });
        inbox.answer(card.id, { choice: 'Ship without it' });
        h.state.write((w) =>
          transitionBatch(w, batchId, { to: 'ABANDONED', reason: 'abandoned by a test' }),
        );
        await h.jobs.idle();

        const stopped = h.only(h.cards().filter((c) => c.title.includes('was not left out')));
        expect(stopped.title).toMatch(/abandoned/);
        expect(stopped.options).toEqual([]);
      });

      it('raises a card when the daemon was stopping before the job began', async () => {
        const { card, batchId } = await failedInBatch('DONE', { 'src/api/alpha.txt': 'alpha\n' });
        inbox.answer(card.id, { choice: 'Ship without it' });
        await h.jobs.stop();

        expect(getBatch(h.store.db, batchId).state).toBe('OPEN');
        const stopped = h.only(h.cards().filter((c) => c.title.includes('was not left out')));
        expect(stopped.title).toMatch(/stopping/);
        expect(stopped.options.map((o) => o.label)).toContain('Ship without it');
      });

      it('does not say the branch is unchanged when Ship anyway got there first', async () => {
        const { card, batchId } = await failedInBatch('DONE', { 'src/api/alpha.txt': 'alpha\n' });
        inbox.answer(card.id, { choice: 'Ship without it' });
        h.shipper.shipAnyway(batchId);
        await h.jobs.idle();

        expect(getBatch(h.store.db, batchId).state).toBe('SHIPPED');
        const stopped = h.only(h.cards().filter((c) => c.title.includes('was not left out')));
        expect(stopped.title).toMatch(/the batch is shipping/);
        expect(stopped.body).toMatch(/Ship without it changed nothing/);
        expect(stopped.body).not.toMatch(/Nothing was shipped|branch is unchanged/);
        expect(stopped.options).toEqual([]);
      });

      it('raises no card for a second answer the first one already carried out', async () => {
        const { batchId, alpha, beta } = await twoFailedInBatch();
        const alphaCard = failedCard(alpha, batchId);
        const betaCard = failedCard(beta, batchId);

        expect(inbox.answer(alphaCard.id, { choice: 'Ship without it' }).state).toBe('RESOLVED');
        expect(inbox.answer(betaCard.id, { choice: 'Ship without it' }).state).toBe('RESOLVED');
        await h.jobs.idle();

        expect(getBatch(h.store.db, batchId).state).toBe('SHIPPED');
        for (const id of [alpha, beta])
          expect(getWorkstream(h.store.db, id).notice?.key).toBe('left-out');
        expect(h.cards().filter((c) => c.title.includes('was not left out'))).toEqual([]);
      });
    });

    describe('when the batch moves on during a job with nothing to revert', () => {
      /** A harness that runs `harness.moveOn` once, in the job, after its first await. */
      function movingOn() {
        const harness = { moveOn: (): void => undefined };
        h.close();
        h = createDeliveryHarness(
          {},
          {
            wrapGit: (git) => ({
              ...git,
              currentBranch: async (repo) => {
                const current = await git.currentBranch(repo);
                const { moveOn } = harness;
                harness.moveOn = () => undefined;
                moveOn();
                return current;
              },
            }),
          },
        );
        inbox = answering();
        return harness;
      }

      it('raises a card naming the state, with no answer to give', async () => {
        const harness = movingOn();
        const { card, batchId } = await failedInBatch('DONE');
        const tip = h.git$('rev-parse', 'HEAD');
        harness.moveOn = () => {
          h.state.write((w) =>
            transitionBatch(w, batchId, { to: 'ABANDONED', reason: 'abandoned by a test' }),
          );
        };

        expect(inbox.answer(card.id, { choice: 'Ship without it' }).state).toBe('RESOLVED');
        await h.jobs.idle();

        expect(h.git$('rev-parse', 'HEAD')).toBe(tip);
        const stopped = h.only(h.cards().filter((c) => c.title.includes('was not left out')));
        expect(stopped.title).toMatch(/the batch is abandoned/);
        expect(stopped.options).toEqual([]);
      });

      it('raises no card when the run was left out already and the batch went on to ship', async () => {
        const harness = movingOn();
        const { card, batchId, failed } = await failedInBatch('DONE');
        h.state.write((w) => setWorkstreamNotice(w, failed, leftOutNotices.nothingToRevert()));
        harness.moveOn = () => {
          h.state.write((w) => transitionBatch(w, batchId, { to: 'SHIPPING', reason: 'a test' }));
        };

        inbox.answer(card.id, { choice: 'Ship without it' });
        await h.jobs.idle();

        expect(h.cards().filter((c) => c.title.includes('was not left out'))).toEqual([]);
      });
    });

    describe('once the revert commit is on the branch', () => {
      /** A harness whose revert runs `after` once the real one has committed. */
      function revertThen(after: () => void) {
        h.close();
        h = createDeliveryHarness(
          {},
          {
            wrapGit: (git) => ({
              ...git,
              revertCommits: async (request) => {
                const reverted = await git.revertCommits(request);
                after();
                return reverted;
              },
            }),
          },
        );
        inbox = answering();
      }

      it('writes the notice and moves the batch when the daemon began stopping during the revert', async () => {
        revertThen(() => {
          void h.jobs.stop();
        });
        const { card, batchId, failed } = await failedInBatch('DONE', {
          'src/api/alpha.txt': 'alpha\n',
        });

        inbox.answer(card.id, { choice: 'Ship without it' });
        await h.jobs.idle();

        // The revert is on the branch, so the batch moved and the drawer says why; the ship itself
        // is what a restart resumes from SHIPPING.
        expect(getBatch(h.store.db, batchId).state).toBe('SHIPPING');
        expect(getWorkstream(h.store.db, failed).notice?.key).toBe('left-out');
      });

      it('says the revert is on the branch when the state write throws', async () => {
        const revertedAt: { sha: string } = { sha: 'unset' };
        revertThen(() => {
          revertedAt.sha = h.git$('rev-parse', 'HEAD');
          vi.spyOn(h.state, 'write').mockImplementationOnce(() => {
            throw new Error('database is locked');
          });
        });
        const { card, batchId } = await failedInBatch('DONE', { 'src/api/alpha.txt': 'alpha\n' });

        inbox.answer(card.id, { choice: 'Ship without it' });
        await h.jobs.idle();

        expect(getBatch(h.store.db, batchId).state).toBe('OPEN');
        const stopped = h.only(h.cards().filter((c) => c.title.includes('revert')));
        expect(stopped.title).toMatch(/revert is on the branch/i);
        expect(stopped.body).toContain(revertedAt.sha.slice(0, 9));
        expect(stopped.body).toContain('database is locked');
        expect(stopped.body).not.toMatch(/branch is unchanged/);
      });

      it('offers Ship without it again when the write threw, and that answer reverts nothing more', async () => {
        const reverts: string[] = [];
        h.close();
        h = createDeliveryHarness(
          {},
          {
            wrapGit: (git) => ({
              ...git,
              revertCommits: async (request) => {
                const before = h.git$('rev-parse', 'HEAD');
                const reverted = await git.revertCommits(request);
                reverts.push(reverted.kind);
                // The second request finds the first one's revert on the tip and changes nothing.
                if (reverts.length === 2) expect(h.git$('rev-parse', 'HEAD')).toBe(before);
                if (reverts.length === 1)
                  vi.spyOn(h.state, 'write').mockImplementationOnce(() => {
                    throw new Error('database is locked');
                  });
                return reverted;
              },
            }),
          },
        );
        inbox = answering();
        const { card, batchId, failed } = await failedInBatch('DONE', {
          'src/api/alpha.txt': 'alpha\n',
        });

        inbox.answer(card.id, { choice: 'Ship without it' });
        await h.jobs.idle();

        const stopped = h.only(h.cards().filter((c) => c.title.includes('revert')));
        expect(stopped.options.map((o) => o.label)).toContain('Ship without it');
        expect(stopped.body).not.toMatch(/do not answer Ship without it again|twice/i);
        expect(stopped.body).toMatch(/Ship without it again.* nothing more/i);
        expect(stopped.detail).toMatchObject({
          resolvesWhen: { event: 'batch_shipped', batchId },
        });

        expect(inbox.answer(stopped.id, { choice: 'Ship without it' }).state).toBe('RESOLVED');
        await h.jobs.idle();

        // The second answer leaves the reverted commits out of its work, so git is not asked again.
        expect(reverts).toEqual(['reverted']);
        expect(getWorkstream(h.store.db, failed).notice?.key).toBe('left-out');
        expect(getBatch(h.store.db, batchId).state).toBe('SHIPPED');
        expect(getInboxItem(h.store.db, stopped.id).state).not.toBe('OPEN');
      });

      const failNextWrite = (message: string): void => {
        vi.spyOn(h.state, 'write').mockImplementationOnce(() => {
          throw new Error(message);
        });
      };

      /**
       * A harness that records each revert asked of git, and whose first revert's state write throws.
       * `failJobWrite` makes the next job's state write throw, whether or not it reverts anything.
       */
      function revertsWithFailedWrite(ship: Parameters<typeof createDeliveryHarness>[1] = {}) {
        const asked: (readonly string[])[] = [];
        const armed = { job: false };
        h.close();
        h = createDeliveryHarness(
          {},
          {
            ...ship,
            wrapGit: (git) => ({
              ...git,
              currentBranch: async (repo) => {
                if (armed.job) failNextWrite('database is still locked');
                armed.job = false;
                return git.currentBranch(repo);
              },
              revertCommits: async (request) => {
                asked.push(request.shas);
                const reverted = await git.revertCommits(request);
                if (asked.length === 1) failNextWrite('database is locked');
                return reverted;
              },
            }),
          },
        );
        inbox = answering();
        return {
          asked,
          failJobWrite: () => {
            armed.job = true;
          },
        };
      }

      it('moves a run with two commits on one file past the second answer', async () => {
        revertsWithFailedWrite();
        const { card, batchId, failed } = await failedInBatch('DONE', {
          'src/api/alpha.txt': 'one\n',
        });
        commitAs(failed, 'src/api/alpha.txt', 'two\n');

        inbox.answer(card.id, { choice: 'Ship without it' });
        await h.jobs.idle();
        const revert = h.git$('rev-parse', 'HEAD');
        const stopped = h.only(h.cards().filter((c) => c.title.includes('revert')));

        inbox.answer(stopped.id, { choice: 'Ship without it' });
        await h.jobs.idle();

        expect(h.cards().filter((c) => c.title.includes('conflict'))).toEqual([]);
        expect(getBatch(h.store.db, batchId).state).toBe('SHIPPED');
        const notice = getWorkstream(h.store.db, failed).notice;
        expect(notice?.key).toBe('left-out');
        expect(notice?.line).toMatch(/its 2 commits were reverted/);
        expect(notice?.body).toContain(`Revert commit: ${revert}`);
        expect(notice?.body).not.toMatch(/no commits|reverted nothing/);
      });

      it('tells a run retried after the second answer that its commits are reverted', async () => {
        const { asked } = revertsWithFailedWrite({
          shipGate: (gate) => ({
            run: async (request) => ({ ...(await gate.run(request)), exitCode: 1 }),
          }),
        });
        const { card, batchId, failed } = await failedInBatch('DONE', {
          'src/api/alpha.txt': 'alpha\n',
        });
        inbox.answer(card.id, { choice: 'Ship without it' });
        await h.jobs.idle();
        const revert = h.git$('rev-parse', 'HEAD');
        const stopped = h.only(h.cards().filter((c) => c.title.includes('revert')));
        inbox.answer(stopped.id, { choice: 'Ship without it' });
        await h.jobs.idle();
        expect(getBatch(h.store.db, batchId).state).toBe('FAILED');

        retryWorkstream(h.state, failed);

        const notice = getWorkstream(h.store.db, failed).notice;
        expect(notice?.key).toBe('reverted-work');
        expect(notice?.body).toContain(`Revert commit: ${revert}`);
        expect(asked).toHaveLength(1);
      });

      it('reverts only the commits the first revert does not cover', async () => {
        const { asked } = revertsWithFailedWrite();
        const { card, batchId, failed } = await failedInBatch('DONE', {
          'src/api/alpha.txt': 'one\n',
        });
        inbox.answer(card.id, { choice: 'Ship without it' });
        await h.jobs.idle();
        const stopped = h.only(h.cards().filter((c) => c.title.includes('revert')));
        const later = commitAs(failed, 'src/api/later.txt', 'later\n');

        inbox.answer(stopped.id, { choice: 'Ship without it' });
        await h.jobs.idle();

        expect(asked).toHaveLength(2);
        expect(asked[1]).toEqual([later]);
        expect(getBatch(h.store.db, batchId).state).toBe('SHIPPED');
        // Newest first, on the batch's branch: the ship may have left the checkout on another.
        const reverts = h.git$('log', '--all', '--grep=leave out', '--format=%H').split('\n');
        expect(reverts).toHaveLength(2);
        expect(getWorkstream(h.store.db, failed).notice?.body).toContain(
          `Revert commit: ${reverts[0] ?? ''}`,
        );
      });

      it('keeps the revert on the card when the second answer stops as well', async () => {
        const { failJobWrite } = revertsWithFailedWrite();
        const { card, batchId, failed } = await failedInBatch('DONE', {
          'src/api/alpha.txt': 'one\n',
        });
        commitAs(failed, 'src/api/alpha.txt', 'two\n');
        inbox.answer(card.id, { choice: 'Ship without it' });
        await h.jobs.idle();
        const revert = h.git$('rev-parse', 'HEAD');
        const stopped = h.only(h.cards().filter((c) => c.title.includes('revert')));

        failJobWrite();
        inbox.answer(stopped.id, { choice: 'Ship without it' });
        await h.jobs.idle();

        expect(getBatch(h.store.db, batchId).state).toBe('OPEN');
        const again = h.only(h.cards().filter((c) => c.title.includes('revert')));
        expect(again.body).toContain(revert.slice(0, 9));
        expect(again.body).toContain('database is still locked');
        expect(again.body).not.toMatch(/branch is unchanged/);

        inbox.answer(again.id, { choice: 'Ship without it' });
        await h.jobs.idle();
        expect(getBatch(h.store.db, batchId).state).toBe('SHIPPED');
        expect(getWorkstream(h.store.db, failed).notice?.body).toContain(
          `Revert commit: ${revert}`,
        );
      });

      describe('while the revert card is open', () => {
        /** The first answer's revert is on the branch and its card is open; the notices were not written. */
        async function openRevertCard() {
          const { asked } = revertsWithFailedWrite();
          const made = await failedInBatch('DONE', { 'src/api/alpha.txt': 'alpha\n' });
          inbox.answer(made.card.id, { choice: 'Ship without it' });
          await h.jobs.idle();
          const revert = h.git$('rev-parse', 'HEAD');
          h.only(h.cards().filter((c) => c.title.includes('revert')));
          expect(getWorkstream(h.store.db, made.failed).notice).toBeNull();
          return { ...made, revert, asked };
        }

        it('tells a run retried from the drawer that its commits were reverted', async () => {
          const { failed, revert } = await openRevertCard();

          const retried = h.starter.retry(failed);

          expect(retried.notice?.key).toBe('reverted-work');
          expect(retried.notice?.body).toContain(`Revert commit: ${revert}`);
          const notes = listEvidence(h.store.db, failed).filter((e) => e.kind === 'builder');
          expect(notes).toHaveLength(1);
          expect(notes[0]?.summary).toContain(revert);
          expect(notes[0]?.summary).toContain('Redo the work');
        });

        it('tells a run again when it failed again without committing after the note', async () => {
          const { failed } = await openRevertCard();
          h.starter.retry(failed);
          h.settle(failed, 'FAILED');

          h.starter.retry(failed);

          // The note already told of the revert, and the run committed nothing after it: told again, once.
          const notes = listEvidence(h.store.db, failed).filter((e) => e.kind === 'builder');
          expect(notes).toHaveLength(2);
        });

        it('does not revert commits again when Ship without it is answered on another failed card', async () => {
          const { asked, failed, batchId, revert } = await openRevertCard();
          // The failed card of the same run as it stood before the revert: it names no revert.
          const plain = batchCardFields({ id: failed, batchId });
          if (!plain) throw new Error('a batch member gets card actions');
          const other = inbox.flag({
            projectId: h.project.id,
            workstreamId: failed,
            title: 'Workstream failed: Alpha again',
            body: 'The gate failed 4 times',
            ...plain,
          });

          inbox.answer(other.id, { choice: 'Ship without it' });
          await h.jobs.idle();

          expect(asked).toHaveLength(1);
          expect(getBatch(h.store.db, batchId).state).toBe('SHIPPED');
          expect(getWorkstream(h.store.db, failed).notice?.body).toContain(
            `Revert commit: ${revert}`,
          );
        });

        it('keeps the revert on the card a stopped answer on another failed card raises', async () => {
          const { failJobWrite } = revertsWithFailedWrite();
          const made = await failedInBatch('DONE', { 'src/api/alpha.txt': 'alpha\n' });
          inbox.answer(made.card.id, { choice: 'Ship without it' });
          await h.jobs.idle();
          const revert = h.git$('rev-parse', 'HEAD');
          const plain = batchCardFields({ id: made.failed, batchId: made.batchId });
          if (!plain) throw new Error('a batch member gets card actions');
          const other = inbox.flag({
            projectId: h.project.id,
            workstreamId: made.failed,
            title: 'Workstream failed: Alpha again',
            body: 'The gate failed 4 times',
            ...plain,
          });

          failJobWrite();
          inbox.answer(other.id, { choice: 'Ship without it' });
          await h.jobs.idle();

          const folded = h.only(h.cards().filter((c) => c.title.includes('revert')));
          expect(folded.detail).toMatchObject({ batchCard: { revert } });
        });

        /** A task started into the batch after the revert, failed with a commit on the branch. */
        function laterRunFailed(batchId: BatchId, path: string): WorkstreamId {
          const task = h.addTask('Gamma', { areas: ['ui'] });
          const run = h.state.write((w) =>
            insertPlannedWorkstream(w, task.id, planForStart(w.tx, task.id), batchId),
          );
          commitAs(run.id, path, 'gamma\n');
          h.settle(run.id, 'FAILED');
          return run.id;
        }

        const builderNotes = (run: WorkstreamId) =>
          listEvidence(h.store.db, run).filter((e) => e.kind === 'builder');

        it('tells only the runs the revert covers after a stop on a run it does not cover', async () => {
          const { failed, batchId, revert } = await openRevertCard();
          const later = laterRunFailed(batchId, 'src/ui/gamma.txt');
          // Another lane builds on its file, so reverting its commit conflicts and the answer stops.
          h.commit('src/ui/gamma.txt', 'built on\n');
          inbox.answer(failedCard(later, batchId).id, { choice: 'Ship without it' });
          await h.jobs.idle();
          const stopped = h.only(h.cards().filter((c) => c.title.includes('conflicts')));
          expect(stopped.detail).toMatchObject({ batchCard: { revert, workstreamId: later } });

          const retried = h.starter.retry(later);

          // Its commit is on the branch and the revert holds none of it.
          expect(retried.notice).toBeNull();
          expect(builderNotes(later)).toEqual([]);
          expect(h.starter.retry(failed).notice?.body).toContain(`Revert commit: ${revert}`);
          expect(builderNotes(failed)).toHaveLength(1);
        });

        it('tells the run it covers after a second answer on the revert card itself stops', async () => {
          const { failJobWrite } = revertsWithFailedWrite();
          const made = await failedInBatch('DONE', { 'src/api/alpha.txt': 'alpha\n' });
          inbox.answer(made.card.id, { choice: 'Ship without it' });
          await h.jobs.idle();
          const revert = h.git$('rev-parse', 'HEAD');
          const open = h.only(h.cards().filter((c) => c.title.includes('revert')));

          failJobWrite();
          inbox.answer(open.id, { choice: 'Ship without it' });
          await h.jobs.idle();
          h.only(h.cards().filter((c) => c.title.includes('revert')));

          expect(h.starter.retry(made.failed).notice?.body).toContain(`Revert commit: ${revert}`);
        });

        it('tells a run of a newer revert that undid the work it redid', async () => {
          const { failJobWrite } = revertsWithFailedWrite();
          const made = await failedInBatch('DONE', { 'src/api/alpha.txt': 'alpha\n' });
          inbox.answer(made.card.id, { choice: 'Ship without it' });
          await h.jobs.idle();
          const first = h.git$('rev-parse', 'HEAD');
          h.starter.retry(made.failed);
          commitAs(made.failed, 'src/api/redo.txt', 'redo\n');
          h.settle(made.failed, 'FAILED');

          const open = h.only(h.cards().filter((c) => c.title.includes('revert')));
          failJobWrite();
          inbox.answer(open.id, { choice: 'Ship without it' });
          await h.jobs.idle();
          const second = h.git$('rev-parse', 'HEAD');
          expect(second).not.toBe(first);
          h.only(h.cards().filter((c) => c.title.includes('revert')));

          const retried = h.starter.retry(made.failed);

          expect(retried.notice?.key).toBe('reverted-work');
          expect(retried.notice?.body).toContain(`Revert commit: ${second}`);
          expect(builderNotes(made.failed).at(-1)?.summary).toContain(second);
        });

        it('does not tell a run again of the revert it was told of once it committed', async () => {
          const { failed } = await openRevertCard();
          h.starter.retry(failed);
          commitAs(failed, 'src/api/redo.txt', 'redo\n');
          h.settle(failed, 'FAILED');

          h.starter.retry(failed);

          expect(builderNotes(failed)).toHaveLength(1);
        });

        it('tells each covered run of a revert that a later answer extended', async () => {
          const { failJobWrite } = revertsWithFailedWrite();
          const made = await failedInBatch('DONE', { 'src/api/alpha.txt': 'alpha\n' });
          inbox.answer(made.card.id, { choice: 'Ship without it' });
          await h.jobs.idle();
          const later = laterRunFailed(made.batchId, 'src/ui/gamma.txt');

          failJobWrite();
          inbox.answer(failedCard(later, made.batchId).id, { choice: 'Ship without it' });
          await h.jobs.idle();
          const second = h.git$('rev-parse', 'HEAD');
          h.only(h.cards().filter((c) => c.title.includes('revert')));

          expect(h.starter.retry(later).notice?.body).toContain(`Revert commit: ${second}`);
          expect(h.starter.retry(made.failed).notice?.body).toContain(`Revert commit: ${second}`);
        });

        it('closes the card when an answer on another card writes the notices', async () => {
          revertsWithFailedWrite({
            shipGate: (gate) => ({
              run: async (request) => ({ ...(await gate.run(request)), exitCode: 1 }),
            }),
          });
          const made = await failedInBatch('DONE', { 'src/api/alpha.txt': 'alpha\n' });
          inbox.answer(made.card.id, { choice: 'Ship without it' });
          await h.jobs.idle();
          const open = h.only(h.cards().filter((c) => c.title.includes('revert')));

          inbox.answer(failedCard(made.failed, made.batchId).id, { choice: 'Ship without it' });
          await h.jobs.idle();

          expect(getBatch(h.store.db, made.batchId).state).toBe('FAILED');
          expect(getInboxItem(h.store.db, open.id).state).not.toBe('OPEN');
        });
      });

      it('reverts as usual when the revert the card names is no longer on the branch', async () => {
        const { batchId, failed } = await failedInBatch('DONE', {
          'src/api/alpha.txt': 'alpha\n',
        });
        raise(
          inbox,
          h.project.id,
          leftOutCards.revertKept(
            getBatch(h.store.db, batchId),
            { workstreamId: failed, titles: ['Alpha'] },
            'a'.repeat(40),
            'a test',
            'OPEN',
          ),
        );
        const stale = h.only(h.cards().filter((c) => c.title.includes('revert')));

        inbox.answer(stale.id, { choice: 'Ship without it' });
        await h.jobs.idle();

        expect(getBatch(h.store.db, batchId).state).toBe('SHIPPED');
        const notice = getWorkstream(h.store.db, failed).notice;
        expect(notice?.body).not.toContain('a'.repeat(40));
        expect(notice?.line).toMatch(/its commit was reverted/);
      });

      it('says what a stopped second answer left, on a card that keeps the revert', async () => {
        const { batchId, failed } = await failedInBatch('DONE');
        const stopped = leftOutCards.conflict(
          getBatch(h.store.db, batchId),
          { workstreamId: failed, titles: ['Alpha'], revert: 'b'.repeat(40) },
          ['src/api/beta.txt'],
        );

        expect(stopped.body).not.toMatch(/branch is unchanged/);
        expect(stopped.body).toContain('b'.repeat(9));
        expect(stopped.body).not.toMatch(/put the commits of/);
        expect(stopped.options?.map((o) => o.label)).toEqual([
          'Ship anyway',
          'Ship without it',
          'Later',
        ]);
        expect(stopped.detail).toMatchObject({ batchCard: { revert: 'b'.repeat(40) } });
      });

      describe('when the second answer stops before it reverts anything', () => {
        /** The revert-kept card of a first answer whose write failed, and that revert's commit id. */
        async function keptCard(ship: Parameters<typeof createDeliveryHarness>[1] = {}) {
          revertsWithFailedWrite(ship);
          const made = await failedInBatch('DONE', { 'src/api/alpha.txt': 'alpha\n' });
          inbox.answer(made.card.id, { choice: 'Ship without it' });
          await h.jobs.idle();
          const revert = h.git$('rev-parse', 'HEAD');
          const kept = h.only(h.cards().filter((c) => c.title.includes('revert')));
          return { ...made, revert, kept };
        }

        /** What a card that says the revert is on the branch holds, whichever stop raised it. */
        function expectNamesRevert(card: { body: string; detail: unknown }, revert: string): void {
          expect(card.body).not.toMatch(/branch is unchanged/);
          expect(card.body).toContain(revert.slice(0, 9));
          expect(card.body).not.toMatch(/put the commits of/);
          expect(card.detail).toMatchObject({ batchCard: { revert } });
        }

        it('names the revert when the daemon is stopping', async () => {
          const { kept, revert, batchId } = await keptCard();

          inbox.answer(kept.id, { choice: 'Ship without it' });
          await h.jobs.stop();

          expect(getBatch(h.store.db, batchId).state).toBe('OPEN');
          const stopped = h.only(h.cards().filter((c) => c.title.includes('stopping')));
          expectNamesRevert(stopped, revert);
          expect(stopped.options.map((o) => o.label)).toContain('Ship without it');
        });

        it('names the revert when a waiting update paused the ship', async () => {
          let draining = false;
          const { kept, revert } = await keptCard({ holdShips: () => draining });

          inbox.answer(kept.id, { choice: 'Ship without it' });
          draining = true;
          await h.jobs.idle();

          const stopped = h.only(h.cards().filter((c) => c.title.includes('waiting update')));
          expectNamesRevert(stopped, revert);
        });

        it('names the revert when the checkout is on another branch', async () => {
          const { kept, revert } = await keptCard();
          h.git$('checkout', '-b', 'elsewhere');

          inbox.answer(kept.id, { choice: 'Ship without it' });
          await h.jobs.idle();

          const stopped = h.only(h.cards().filter((c) => c.title.includes('was not left out')));
          expectNamesRevert(stopped, revert);
        });

        it('names the revert when the batch went on to ship by another way', async () => {
          const { kept, revert, batchId } = await keptCard();

          inbox.answer(kept.id, { choice: 'Ship without it' });
          h.shipper.shipAnyway(batchId);
          await h.jobs.idle();

          const stopped = h.only(h.cards().filter((c) => c.title.includes('was not left out')));
          expect(stopped.body).toContain(revert.slice(0, 9));
          expect(stopped.body).not.toMatch(/Ship without it changed nothing/);
          expect(stopped.options).toEqual([]);
        });
      });

      it('words its answers for a branch that already holds the revert', async () => {
        revertsWithFailedWrite();
        const { card } = await failedInBatch('DONE', { 'src/api/alpha.txt': 'alpha\n' });

        inbox.answer(card.id, { choice: 'Ship without it' });
        await h.jobs.idle();

        const stopped = h.only(h.cards().filter((c) => c.title.includes('revert')));
        const said = new Map(stopped.options.map((o) => [o.label, o.description]));
        // Retry is not offered: no left-out notice exists yet to tell its session of the revert.
        expect([...said.keys()]).toEqual(['Ship anyway', 'Ship without it', 'Later']);
        expect(said.get('Ship anyway')).toMatch(/revert/i);
        expect(said.get('Ship anyway')).not.toMatch(/commits will be in the pull request/);
        expect(said.get('Ship without it')).not.toMatch(/^Reverts its commits/);
      });

      it('withdraws the other failed tasks’ cards when the write threw', async () => {
        revertThen(() => {
          vi.spyOn(h.state, 'write').mockImplementationOnce(() => {
            throw new Error('database is locked');
          });
        });
        const { batchId, alpha, beta } = await twoFailedInBatch();
        const alphaCard = failedCard(alpha, batchId);
        const betaCard = failedCard(beta, batchId);

        inbox.answer(alphaCard.id, { choice: 'Ship without it' });
        await h.jobs.idle();

        expect(getInboxItem(h.store.db, betaCard.id).state).not.toBe('OPEN');
        const open = h.cards().filter((c) => c.title.includes('revert'));
        expect(h.only(open).options.map((o) => o.label)).toContain('Ship without it');
      });

      it('says the revert is on the branch and offers no way to ship when the batch was abandoned', async () => {
        let batch: string | null = null;
        revertThen(() => {
          if (batch === null) throw new Error('batch unset');
          h.state.write((w) =>
            transitionBatch(w, batch as BatchId, { to: 'ABANDONED', reason: 'a test' }),
          );
        });
        const { card, batchId } = await failedInBatch('DONE', { 'src/api/alpha.txt': 'alpha\n' });
        batch = batchId;

        inbox.answer(card.id, { choice: 'Ship without it' });
        await h.jobs.idle();

        const stopped = h.only(h.cards().filter((c) => c.title.includes('revert')));
        expect(stopped.title).toMatch(/revert is on the branch/i);
        expect(stopped.body).not.toMatch(/branch is unchanged/);
        expect(stopped.body).toMatch(/abandoned/);
        expect(stopped.body).not.toMatch(/Ship anyway|answer Ship without it/);
        expect(stopped.options).toEqual([]);
      });

      it('does not say nothing was shipped when the batch went on to ship during the revert', async () => {
        let batch: string | null = null;
        revertThen(() => {
          if (batch === null) throw new Error('batch unset');
          h.state.write((w) =>
            transitionBatch(w, batch as BatchId, { to: 'SHIPPING', reason: 'a test' }),
          );
        });
        const { card, batchId } = await failedInBatch('DONE', { 'src/api/alpha.txt': 'alpha\n' });
        batch = batchId;

        inbox.answer(card.id, { choice: 'Ship without it' });
        await h.jobs.idle();

        const stopped = h.only(h.cards().filter((c) => c.title.includes('revert')));
        expect(stopped.body).toMatch(/shipping/);
        expect(stopped.body).not.toMatch(/nothing was shipped/i);
        expect(stopped.options).toEqual([]);
        expect(stopped.detail).toMatchObject({
          resolvesWhen: { event: 'batch_shipped', batchId },
        });
      });

      it('offers Ship without it again when the ship the card waited on fails', async () => {
        let batch: string | null = null;
        h.close();
        h = createDeliveryHarness(
          {},
          {
            shipGate: (gate) => ({
              run: async (request) => ({ ...(await gate.run(request)), exitCode: 1 }),
            }),
            wrapGit: (git) => ({
              ...git,
              revertCommits: async (request) => {
                const reverted = await git.revertCommits(request);
                if (batch === null) throw new Error('batch unset');
                h.state.write((w) =>
                  transitionBatch(w, batch as BatchId, { to: 'SHIPPING', reason: 'a test' }),
                );
                return reverted;
              },
            }),
          },
        );
        inbox = answering();
        const { card, batchId } = await failedInBatch('DONE', { 'src/api/alpha.txt': 'alpha\n' });
        batch = batchId;
        inbox.answer(card.id, { choice: 'Ship without it' });
        await h.jobs.idle();
        const revert = h.git$('rev-parse', 'HEAD');
        const waiting = h.only(h.cards().filter((c) => c.title.includes('revert')));
        expect(waiting.options).toEqual([]);

        h.shipper.resume(batchId);
        await h.jobs.idle();

        expect(getBatch(h.store.db, batchId).state).toBe('FAILED');
        const again = h.only(h.cards().filter((c) => c.title.includes('revert')));
        expect(again.id).toBe(waiting.id);
        expect(again.body).not.toMatch(/nothing to answer/i);
        expect(again.options.map((o) => o.label)).toEqual([
          'Ship anyway',
          'Ship without it',
          'Later',
        ]);
        expect(again.detail).toMatchObject({ batchCard: { batchId, revert } });
        expect(again.detail).toMatchObject({ resolvesWhen: { event: 'batch_shipped', batchId } });
      });

      it('offers Ship without it again when the ship the card waited on reopens the batch for a merge', async () => {
        let batch: string | null = null;
        h.close();
        h = createDeliveryHarness(
          {},
          {
            shipBaseUpdates: (real) => ({
              ...real,
              beforeGate: () =>
                Promise.resolve({
                  kind: 'conflicted',
                  base: 'origin/main',
                  paths: ['README.md'],
                  note: 'Conflict markers in README.md',
                }),
            }),
            wrapGit: (git) => ({
              ...git,
              revertCommits: async (request) => {
                const reverted = await git.revertCommits(request);
                if (batch === null) throw new Error('batch unset');
                h.state.write((w) =>
                  transitionBatch(w, batch as BatchId, { to: 'SHIPPING', reason: 'a test' }),
                );
                return reverted;
              },
            }),
          },
        );
        inbox = answering();
        const { card, batchId } = await failedInBatch('DONE', { 'src/api/alpha.txt': 'alpha\n' });
        batch = batchId;
        inbox.answer(card.id, { choice: 'Ship without it' });
        await h.jobs.idle();
        const waiting = h.only(h.cards().filter((c) => c.title.includes('revert')));
        expect(waiting.options).toEqual([]);

        h.shipper.resume(batchId);
        await h.jobs.idle();

        expect(getBatch(h.store.db, batchId).state).toBe('OPEN');
        const again = h.only(h.cards().filter((c) => c.title.includes('revert')));
        expect(again.id).toBe(waiting.id);
        expect(again.body).not.toMatch(/nothing to answer/i);
        expect(again.options.map((o) => o.label)).toContain('Ship without it');
      });

      describe('when the builder abandons the batch while the answer runs', () => {
        /** A harness whose `revert`th revert abandons the batch and then answers `stop`. */
        function abandonsDuringRevert(
          stop: () => Awaited<ReturnType<DeliveryHarness['git']['revertCommits']>>,
          revert = 1,
        ) {
          const on: { batchId: BatchId | null; reverts: number } = { batchId: null, reverts: 0 };
          h.close();
          h = createDeliveryHarness(
            {},
            {
              wrapGit: (git) => ({
                ...git,
                revertCommits: async (request) => {
                  on.reverts += 1;
                  if (on.reverts !== revert) {
                    const reverted = await git.revertCommits(request);
                    failNextWrite('database is locked');
                    return reverted;
                  }
                  if (on.batchId === null) throw new Error('batch unset');
                  h.shipper.abandon(on.batchId);
                  return stop();
                },
              }),
            },
          );
          inbox = answering();
          return on;
        }

        it.each([
          ['conflict', () => ({ kind: 'conflict', paths: ['src/api/alpha.txt'] }) as const],
          ['markers', () => ({ kind: 'markers', paths: ['src/api/alpha.txt'] }) as const],
          ['blocked', () => ({ kind: 'blocked', changed: ['src/api/alpha.txt'] }) as const],
          [
            'a thrown error',
            () => {
              throw new Error('git broke');
            },
          ],
        ])('raises no card offering an answer on a stop by %s', async (_, stop) => {
          const on = abandonsDuringRevert(stop);
          const { card, batchId } = await failedInBatch('DONE', { 'src/api/alpha.txt': 'alpha\n' });
          on.batchId = batchId;

          inbox.answer(card.id, { choice: 'Ship without it' });
          await h.jobs.idle();

          expect(getBatch(h.store.db, batchId).state).toBe('ABANDONED');
          const stopped = h.only(h.cards().filter((c) => c.title.includes('not left out')));
          expect(stopped.title).toMatch(/abandoned/);
          expect(stopped.body).not.toMatch(/answer Ship without it|Ship anyway/);
          expect(stopped.options).toEqual([]);
          expect(stopped.detail).toBeNull();
        });

        it('says the revert an earlier answer left stays, on a card with no answer', async () => {
          const on = abandonsDuringRevert(
            () => ({ kind: 'conflict', paths: ['src/api/later.txt'] }),
            2,
          );
          const { card, batchId, failed } = await failedInBatch('DONE', {
            'src/api/alpha.txt': 'one\n',
          });
          on.batchId = batchId;
          inbox.answer(card.id, { choice: 'Ship without it' });
          await h.jobs.idle();
          const revert = h.git$('rev-parse', 'HEAD');
          const first = h.only(h.cards().filter((c) => c.title.includes('revert')));
          commitAs(failed, 'src/api/later.txt', 'later\n');

          inbox.answer(first.id, { choice: 'Ship without it' });
          await h.jobs.idle();

          expect(getBatch(h.store.db, batchId).state).toBe('ABANDONED');
          const stopped = h.only(h.cards().filter((c) => c.title.includes('revert')));
          expect(stopped.title).toMatch(/revert is on the branch/i);
          expect(stopped.body).toContain(revert.slice(0, 9));
          expect(stopped.body).toMatch(/abandoned/);
          expect(stopped.options).toEqual([]);
          expect(stopped.detail).toBeNull();
        });
      });

      it('closes an answerable revert card when the batch is abandoned', async () => {
        revertsWithFailedWrite();
        const { card, batchId } = await failedInBatch('DONE', { 'src/api/alpha.txt': 'alpha\n' });
        inbox.answer(card.id, { choice: 'Ship without it' });
        await h.jobs.idle();
        const stopped = h.only(h.cards().filter((c) => c.title.includes('revert')));
        expect(stopped.options.map((o) => o.label)).toContain('Ship without it');

        h.shipper.abandon(batchId);

        expect(getInboxItem(h.store.db, stopped.id).state).not.toBe('OPEN');
        expect(h.cards().filter((c) => c.title.includes('revert'))).toEqual([]);
      });

      it('closes the other left-out cards when the batch is abandoned', async () => {
        const { batchId, failed } = await failedInBatch('DONE', { 'src/api/alpha.txt': 'a\n' });
        raise(
          inbox,
          h.project.id,
          leftOutCards.conflict(
            getBatch(h.store.db, batchId),
            { workstreamId: failed, titles: ['Alpha'] },
            ['src/api/alpha.txt'],
          ),
        );
        const open = h.only(h.cards().filter((c) => c.title.includes('conflicts')));

        h.shipper.abandon(batchId);

        expect(getInboxItem(h.store.db, open.id).state).not.toBe('OPEN');
      });

      it('shows its own title when a left-out card was open already', async () => {
        let reverts = 0;
        revertThen(() => {
          reverts += 1;
          vi.spyOn(h.state, 'write').mockImplementationOnce(() => {
            throw new Error('database is locked');
          });
        });
        const { card, batchId, failed } = await failedInBatch('DONE', {
          'src/api/alpha.txt': 'alpha\n',
        });
        // Another failed task's Ship without it stopped on a conflict and left its card open.
        raise(
          inbox,
          h.project.id,
          leftOutCards.conflict(
            getBatch(h.store.db, batchId),
            { workstreamId: failed, titles: ['Gamma'] },
            ['src/api/gamma.txt'],
          ),
        );
        const open = h.only(h.cards().filter((c) => c.title.includes('conflicts')));
        expect(open.options.map((o) => o.label)).toContain('Ship without it');

        inbox.answer(card.id, { choice: 'Ship without it' });
        await h.jobs.idle();

        const stopped = h.only(h.cards().filter((c) => c.title.includes('revert')));
        expect(stopped.id).toBe(open.id);
        expect(stopped.title).toMatch(/revert is on the branch/i);
        expect(stopped.options.map((o) => o.label)).toContain('Ship without it');
        expect(h.cards().filter((c) => c.title.includes('conflicts'))).toEqual([]);
        expect(reverts).toBe(1);
      });
    });

    it('lets a batch reopened after a left-out run ship by itself once the rest is done', async () => {
      const { batchId, failed } = await failedInBatch('WAITING_HUMAN');
      h.state.write((w) => setWorkstreamNotice(w, failed, leftOutNotices.nothingToRevert()));
      const beta = listWorkstreams(h.store.db, { batchId }).find(
        (w) => w.state === 'WAITING_HUMAN',
      );
      if (!beta) throw new Error('Beta waits');

      h.settle(beta.id, 'DONE');
      h.shipper.checkBatch(batchId);
      await h.jobs.idle();

      expect(getBatch(h.store.db, batchId).state).toBe('SHIPPED');
    });

    it('takes the left-out notice off a run that is retried, so the pull request counts its work', async () => {
      let gateFails = true;
      h.close();
      h = createDeliveryHarness(
        {},
        {
          shipGate: (gate) => ({
            run: async (request) => {
              const result = await gate.run(request);
              return gateFails ? { ...result, exitCode: 1 } : result;
            },
          }),
        },
      );
      inbox = answering();
      const { card, batchId, failed } = await failedInBatch('DONE', {
        'src/api/alpha.txt': 'alpha\n',
      });
      inbox.answer(card.id, { choice: 'Ship without it' });
      await h.jobs.idle();
      expect(getBatch(h.store.db, batchId).state).toBe('FAILED');
      expect(getWorkstream(h.store.db, failed).notice?.key).toBe('left-out');

      gateFails = false;
      retryWorkstream(h.state, failed);
      // No longer left out, but the revert is still on the branch, so the run says so.
      expect(getWorkstream(h.store.db, failed).notice?.key).toBe('reverted-work');
      commitAs(failed, 'src/api/alpha.txt', 'alpha again\n');

      h.settle(failed, 'DONE');
      h.shipper.checkBatch(batchId);
      await h.jobs.idle();
      const shipped = getBatch(h.store.db, batchId);
      expect(shipped.state).toBe('SHIPPED');
      const body = h.gh.body(shipped.prUrl ?? '');
      expect(body).toContain('### Alpha');
      expect(body).not.toContain('left out');
    });

    describe('a left-out run that is retried after its commits were reverted', () => {
      /** While set, the ship's base update answers that the merge left markers. */
      let baseConflicts = false;
      /** While set, the ship's gate fails, so a Ship without it leaves the batch FAILED. */
      let gateFails = false;

      /**
       * Ships without Alpha, then retries it with the batch's gate passing; returns what the retry left.
       * `failing` makes the failed run, Alpha's first by default.
       */
      async function leftOutThenRetried(
        failing: () => ReturnType<typeof failedInBatch> = () =>
          failedInBatch('DONE', { 'src/api/alpha.txt': 'alpha\n' }),
        retry = true,
      ) {
        gateFails = true;
        h.close();
        h = createDeliveryHarness(
          {},
          {
            shipGate: (gate) => ({
              run: async (request) => {
                const result = await gate.run(request);
                return gateFails ? { ...result, exitCode: 1 } : result;
              },
            }),
            // Only a batch in its own copy merges its base, and these commits are in the shared
            // checkout, so the update's answer stands in for that merge.
            shipBaseUpdates: (real) => ({
              ...real,
              beforeGate: (id, signal, options) =>
                baseConflicts
                  ? Promise.resolve({
                      kind: 'conflicted',
                      base: 'origin/main',
                      paths: ['README.md'],
                      note: 'Conflict markers in README.md',
                    })
                  : real.beforeGate(id, signal, options),
            }),
          },
        );
        inbox = answering();
        const { card, batchId, failed } = await failing();
        inbox.answer(card.id, { choice: 'Ship without it' });
        await h.jobs.idle();
        expect(getWorkstream(h.store.db, failed).notice?.key).toBe('left-out');
        gateFails = false;
        if (retry) retryWorkstream(h.state, failed);
        return { batchId, failed };
      }

      /**
       * Starts the failed run's task over, as Start with fresh does in a shared project: the batch holds
       * Beta too, so it is kept, and the new run joins it. Returns the new run.
       */
      async function startedOver(batchId: BatchId, failed: WorkstreamId) {
        const taskId = getWorkstream(h.store.db, failed).taskId;
        h.starter.startTask(taskId);
        await h.jobs.idle();
        const run = listWorkstreams(h.store.db, { batchId }).at(-1);
        if (!run || run.id === failed || run.taskId !== taskId)
          throw new Error('the new run joined the batch');
        return run.id;
      }

      /** The revert a run's left-out notice names. */
      function revertNamedBy(run: WorkstreamId): string {
        const notice = getWorkstream(h.store.db, run).notice;
        expect(notice?.key).toBe('left-out');
        const sha = /^Revert commit: ([0-9a-f]+)$/m.exec(notice?.body ?? '')?.[1];
        if (sha === undefined) throw new Error('the notice names a revert');
        return sha;
      }

      /**
       * Alpha left out, retried and told of that revert, then its new commit left out too, with the
       * ship's gate failing so the batch stays FAILED and open to a start. Returns both reverts.
       */
      async function leftOutTwice() {
        const { batchId, failed } = await leftOutThenRetried();
        const first = getWorkstream(h.store.db, failed).notice?.body ?? '';
        commitAs(failed, 'src/api/alpha-again.txt', 'alpha again\n');
        h.settle(failed, 'FAILED');
        gateFails = true;
        inbox.answer(failedCard(failed, batchId).id, { choice: 'Ship without it' });
        await h.jobs.idle();
        gateFails = false;
        expect(getBatch(h.store.db, batchId).state).toBe('FAILED');
        const latest = revertNamedBy(failed);
        expect(first).not.toContain(latest);
        return { batchId, failed, latest };
      }

      /** The paths the shipped batch's branch holds. */
      function branchFiles(batchId: BatchId): string[] {
        const branch = getBatch(h.store.db, batchId).branch;
        if (branch === null) throw new Error('the batch has a branch');
        return h.git$('ls-tree', '-r', '--name-only', branch).split('\n');
      }

      /**
       * Finishes the retried run with the branch and the base changing one line, so the ship's base
       * merge leaves markers and sends the task that just finished to merge; returns that new run.
       */
      async function finishedThenSentToMerge(batchId: BatchId, retried: WorkstreamId) {
        baseConflicts = true;
        h.settle(retried, 'DONE');
        h.shipper.checkBatch(batchId);
        await h.jobs.idle();
        baseConflicts = false;
        expect(getBatch(h.store.db, batchId).state).toBe('OPEN');
        const merge = listWorkstreams(h.store.db, { batchId }).at(-1);
        if (!merge) throw new Error('the batch has runs');
        expect(merge.id).not.toBe(retried);
        expect(merge.taskTitle).toBe('Alpha');
        expect(merge.nextAction.kind).toBe('merge');
        return merge.id;
      }

      /** The merge run commits the resolution and finishes, and the batch ships; returns the pull request body. */
      async function resolvedAndShipped(batchId: BatchId, merge: WorkstreamId) {
        commitAs(merge, 'README.md', '# ours and theirs\n');
        h.settle(merge, 'DONE');
        h.shipper.checkBatch(batchId);
        await h.jobs.idle();
        const shipped = getBatch(h.store.db, batchId);
        expect(shipped.state).toBe('SHIPPED');
        return h.gh.body(shipped.prUrl ?? '');
      }

      it('tells the session its commits were reverted', async () => {
        const { failed } = await leftOutThenRetried();

        const next = getWorkstream(h.store.db, failed).nextAction;
        if (next.kind !== 'fix') throw new Error(`expected a fix, got ${next.kind}`);
        const note = getEvidence(h.store.db, next.evidenceId);
        expect(note.kind).toBe('builder');
        expect(note.summary).toMatch(/reverted/i);
        expect(note.summary).toMatch(/Ship without it/);
        expect(note.summary).toMatch(/[0-9a-f]{40}/);
      });

      it('keeps the revert in the notice of a run left out again after a retry that committed nothing', async () => {
        const { batchId, failed } = await leftOutThenRetried();
        const first = getWorkstream(h.store.db, failed).notice?.body ?? '';
        const revert = /^Revert commit: ([0-9a-f]+)$/m.exec(first)?.[1];
        if (revert === undefined) throw new Error('the retried run keeps the revert');
        h.settle(failed, 'FAILED');
        gateFails = true;
        inbox.answer(failedCard(failed, batchId).id, { choice: 'Ship without it' });
        await h.jobs.idle();
        gateFails = false;
        expect(getBatch(h.store.db, batchId).state).toBe('FAILED');

        // Nothing new was reverted, but the revert from the first answer is still on the branch.
        expect(revertNamedBy(failed)).toBe(revert);
        retryWorkstream(h.state, failed);
        const next = getWorkstream(h.store.db, failed).nextAction;
        if (next.kind !== 'fix') throw new Error(`expected a fix, got ${next.kind}`);
        expect(getEvidence(h.store.db, next.evidenceId).summary).toContain(revert);
      });

      it('does not list the task as finished when the retry commits nothing', async () => {
        const { batchId, failed } = await leftOutThenRetried();

        h.settle(failed, 'DONE');
        h.shipper.checkBatch(batchId);
        await h.jobs.idle();

        const shipped = getBatch(h.store.db, batchId);
        expect(shipped.state).toBe('SHIPPED');
        // The diff has none of Alpha's work, so the body must not say it is done.
        expect(branchFiles(batchId)).not.toContain('src/api/alpha.txt');
        const body = h.gh.body(shipped.prUrl ?? '');
        expect(body).not.toContain('### Alpha');
        expect(body).toMatch(/Alpha \(done, .*reverted/);
        expect(body).toContain('### Beta');
      });

      it('still leaves the task out when a wait replaced the run’s notice', async () => {
        const { batchId, failed } = await leftOutThenRetried();
        h.state.write((w) =>
          setWorkstreamNotice(w, failed, {
            key: 'claim-wait',
            tone: 'info',
            line: 'Waiting for a claim',
            body: 'Another task holds it.',
          }),
        );

        h.settle(failed, 'DONE');
        h.shipper.checkBatch(batchId);
        await h.jobs.idle();

        const body = h.gh.body(getBatch(h.store.db, batchId).prUrl ?? '');
        expect(body).not.toContain('### Alpha');
        expect(body).toMatch(/Alpha \(done, .*reverted/);
      });

      it('lists the task as finished when the retry commits again', async () => {
        const { batchId, failed } = await leftOutThenRetried();
        commitAs(failed, 'src/api/alpha.txt', 'alpha again\n');

        h.settle(failed, 'DONE');
        h.shipper.checkBatch(batchId);
        await h.jobs.idle();

        const shipped = getBatch(h.store.db, batchId);
        expect(shipped.state).toBe('SHIPPED');
        expect(branchFiles(batchId)).toContain('src/api/alpha.txt');
        const body = h.gh.body(shipped.prUrl ?? '');
        expect(body).toContain('### Alpha');
        expect(body).not.toMatch(/reverted/);
      });

      it('does not list the task as finished when its only new commit is a merge run’s resolution', async () => {
        const { batchId, failed } = await leftOutThenRetried();

        const merge = await finishedThenSentToMerge(batchId, failed);
        const body = await resolvedAndShipped(batchId, merge);

        // The branch has the resolution, and none of Alpha's own work.
        expect(branchFiles(batchId)).not.toContain('src/api/alpha.txt');
        expect(body).not.toContain('### Alpha');
        expect(body).toMatch(/Alpha \(done, .*reverted/);
        expect(body).toContain('### Beta');
      });

      it('does not list the task as finished when its only new commit resolves conflict markers of its own gate’s base merge', async () => {
        const { batchId, failed } = await leftOutThenRetried();

        // The same run, not a new one, is queued to merge when its gate's base merge leaves markers.
        h.commit('README.md', MARKED_README);
        await commitAsTheToolRecords(failed, 'README.md', '# ours and theirs\n');
        h.settle(failed, 'DONE');
        h.shipper.checkBatch(batchId);
        await h.jobs.idle();

        const shipped = getBatch(h.store.db, batchId);
        expect(shipped.state).toBe('SHIPPED');
        expect(branchFiles(batchId)).toContain('README.md');
        expect(branchFiles(batchId)).not.toContain('src/api/alpha.txt');
        const body = h.gh.body(shipped.prUrl ?? '');
        expect(body).not.toContain('### Alpha');
        expect(body).toMatch(/Alpha \(done, .*reverted/);
        expect(body).toContain('### Beta');
      });

      it('lists the task as finished when it redoes the work after resolving conflict markers', async () => {
        const { batchId, failed } = await leftOutThenRetried();
        h.commit('README.md', MARKED_README);
        await commitAsTheToolRecords(failed, 'README.md', '# ours and theirs\n');
        await commitAsTheToolRecords(failed, 'src/api/alpha.txt', 'alpha again\n');

        h.settle(failed, 'DONE');
        h.shipper.checkBatch(batchId);
        await h.jobs.idle();

        const shipped = getBatch(h.store.db, batchId);
        expect(shipped.state).toBe('SHIPPED');
        expect(branchFiles(batchId)).toContain('src/api/alpha.txt');
        const body = h.gh.body(shipped.prUrl ?? '');
        expect(body).toContain('### Alpha');
        expect(body).not.toMatch(/reverted/);
      });

      it('tells a run again on Retry when its only commit since the note resolved conflict markers', async () => {
        const { failed } = await leftOutThenRetried();
        h.commit('README.md', MARKED_README);
        await commitAsTheToolRecords(failed, 'README.md', '# ours and theirs\n');
        h.settle(failed, 'FAILED');

        const retried = retryWorkstream(h.state, failed);

        const notes = listEvidence(h.store.db, failed).filter((e) => e.kind === 'builder');
        expect(notes).toHaveLength(2);
        expect(notes[1]?.summary).toContain('Redo the work');
        expect(retried.notice?.key).toBe('reverted-work');
      });

      it('does not tell a run again on Retry when it committed work besides the resolution', async () => {
        const { failed } = await leftOutThenRetried();
        h.commit('README.md', MARKED_README);
        await commitAsTheToolRecords(failed, 'README.md', '# ours and theirs\n');
        await commitAsTheToolRecords(failed, 'src/api/alpha.txt', 'alpha again\n');
        h.settle(failed, 'FAILED');

        retryWorkstream(h.state, failed);

        const notes = listEvidence(h.store.db, failed).filter((e) => e.kind === 'builder');
        expect(notes).toHaveLength(1);
      });

      it('still lists the task as finished when it committed again before it was sent to merge', async () => {
        const { batchId, failed } = await leftOutThenRetried();
        commitAs(failed, 'src/api/alpha.txt', 'alpha again\n');

        const merge = await finishedThenSentToMerge(batchId, failed);
        const body = await resolvedAndShipped(batchId, merge);

        expect(branchFiles(batchId)).toContain('src/api/alpha.txt');
        expect(body).toContain('### Alpha');
        expect(body).not.toMatch(/reverted/);
      });

      describe('and started over in the same batch', () => {
        it('tells the new run’s session the commits were reverted', async () => {
          const { batchId, failed } = await leftOutThenRetried(undefined, false);
          const run = await startedOver(batchId, failed);

          const next = getWorkstream(h.store.db, run).nextAction;
          if (next.kind !== 'fix') throw new Error(`expected a fix, got ${next.kind}`);
          const note = getEvidence(h.store.db, next.evidenceId);
          expect(note.kind).toBe('builder');
          expect(note.summary).toMatch(/reverted/i);
          expect(note.summary).toMatch(/[0-9a-f]{40}/);
        });

        it('does not list the task as finished when the new run commits nothing, though the old run was never retried', async () => {
          const { batchId, failed } = await leftOutThenRetried(undefined, false);
          const run = await startedOver(batchId, failed);

          h.settle(run, 'DONE');
          h.shipper.checkBatch(batchId);
          await h.jobs.idle();

          const shipped = getBatch(h.store.db, batchId);
          expect(shipped.state).toBe('SHIPPED');
          expect(branchFiles(batchId)).not.toContain('src/api/alpha.txt');
          const body = h.gh.body(shipped.prUrl ?? '');
          expect(body).not.toContain('### Alpha');
          expect(body).toMatch(/Alpha \(done, .*reverted/);
        });

        it('lists the task as finished when the new run commits the work again', async () => {
          const { batchId, failed } = await leftOutThenRetried(undefined, false);
          const run = await startedOver(batchId, failed);
          commitAs(run, 'src/api/alpha.txt', 'alpha again\n');

          h.settle(run, 'DONE');
          h.shipper.checkBatch(batchId);
          await h.jobs.idle();

          const shipped = getBatch(h.store.db, batchId);
          expect(shipped.state).toBe('SHIPPED');
          expect(branchFiles(batchId)).toContain('src/api/alpha.txt');
          const body = h.gh.body(shipped.prUrl ?? '');
          expect(body).toContain('### Alpha');
          expect(body).not.toMatch(/reverted/);
        });

        it('lists the task as finished when an earlier retry left a note and the new run redoes the work', async () => {
          const { batchId, failed } = await leftOutThenRetried();
          h.settle(failed, 'FAILED');
          const run = await startedOver(batchId, failed);
          commitAs(run, 'src/api/alpha.txt', 'alpha again\n');

          h.settle(run, 'DONE');
          h.shipper.checkBatch(batchId);
          await h.jobs.idle();

          const shipped = getBatch(h.store.db, batchId);
          expect(shipped.state).toBe('SHIPPED');
          expect(branchFiles(batchId)).toContain('src/api/alpha.txt');
          const body = h.gh.body(shipped.prUrl ?? '');
          expect(body).toContain('### Alpha');
          expect(body).not.toMatch(/reverted/);
        });

        it('reads the latest revert when a retried run was left out again, and commits nothing', async () => {
          const { batchId, failed, latest } = await leftOutTwice();
          const run = await startedOver(batchId, failed);

          const next = getWorkstream(h.store.db, run).nextAction;
          if (next.kind !== 'fix') throw new Error(`expected a fix, got ${next.kind}`);
          expect(getEvidence(h.store.db, next.evidenceId).summary).toContain(latest);

          h.settle(run, 'DONE');
          h.shipper.checkBatch(batchId);
          await h.jobs.idle();

          const shipped = getBatch(h.store.db, batchId);
          expect(shipped.state).toBe('SHIPPED');
          expect(branchFiles(batchId)).not.toContain('src/api/alpha-again.txt');
          const body = h.gh.body(shipped.prUrl ?? '');
          expect(body).not.toContain('### Alpha');
          expect(body).toMatch(/Alpha \(done, .*reverted/);
        });

        it('lists the task as finished when a run started after the second revert commits the work', async () => {
          const { batchId, failed } = await leftOutTwice();
          const run = await startedOver(batchId, failed);
          commitAs(run, 'src/api/alpha-third.txt', 'alpha third\n');

          h.settle(run, 'DONE');
          h.shipper.checkBatch(batchId);
          await h.jobs.idle();

          const shipped = getBatch(h.store.db, batchId);
          expect(shipped.state).toBe('SHIPPED');
          expect(branchFiles(batchId)).toContain('src/api/alpha-third.txt');
          const body = h.gh.body(shipped.prUrl ?? '');
          expect(body).toContain('### Alpha');
          expect(body).not.toMatch(/reverted/);
        });
      });

      it('counts a merge run’s commit when that run was the one left out, retried and told to redo the work', async () => {
        const { batchId, failed } = await leftOutThenRetried(async () => {
          const {
            batchId: id,
            merge,
            card,
          } = await failedInItsMerge((run) => {
            commitAs(run, 'src/api/alpha.txt', 'alpha merged\n');
          });
          return { batchId: id, failed: merge, card };
        });
        commitAs(failed, 'src/api/alpha.txt', 'alpha again\n');

        h.settle(failed, 'DONE');
        h.shipper.checkBatch(batchId);
        await h.jobs.idle();

        const shipped = getBatch(h.store.db, batchId);
        expect(shipped.state).toBe('SHIPPED');
        expect(branchFiles(batchId)).toContain('src/api/alpha.txt');
        const body = h.gh.body(shipped.prUrl ?? '');
        expect(body).toContain('### Alpha');
        expect(body).not.toMatch(/reverted/);
      });
    });

    it('never calls a finished run left out, whatever notice it still carries', async () => {
      const { batchId, failed } = await failedInBatch('DONE');
      h.state.write((w) => setWorkstreamNotice(w, failed, leftOutNotices.nothingToRevert()));
      h.settle(failed, 'DONE');
      h.shipper.checkBatch(batchId);
      await h.jobs.idle();

      const body = h.gh.body(getBatch(h.store.db, batchId).prUrl ?? '');
      expect(body).toContain('### Alpha');
      expect(body).not.toContain('left out');
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
